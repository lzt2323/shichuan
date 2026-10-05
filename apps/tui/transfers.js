import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID, createHash } from 'node:crypto';
import { safeFileName } from '../../shared/protocol.js';

export class TransferQueue {
  constructor({ manager, onChange = () => {}, fetchState }) { this.manager = manager; this.onChange = onChange; this.fetchState = fetchState; this.tasks = new Map(); this.running = false; }
  list() { return [...this.tasks.values()].map(({ controller, source, directory, ...task }) => task); }
  add(type, groupId, values) {
    const task = { id: randomUUID(), type, groupId, ...values, name: type === 'upload' ? path.basename(values.source) : values.messageId, status: 'queued', bytes: 0, total: 0, createdAt: Date.now() };
    // Keep a bounded history, but never drop a running or queued transfer.
    if (this.tasks.size >= 200) { const old = [...this.tasks.values()].find(t => ['done', 'failed', 'cancelled'].includes(t.status)); if (old) this.tasks.delete(old.id); else throw new Error('传输队列已满'); }
    this.tasks.set(task.id, task); this.onChange(); void this.pump(); return { id: task.id };
  }
  cancel(id) { const task = this.tasks.get(id); if (!task) throw new Error('找不到传输任务'); if (!['queued', 'running'].includes(task.status)) return; task.status = 'cancelled'; task.controller?.abort(); this.onChange(); }
  retry(id) { const task = this.tasks.get(id); if (!task || !['failed', 'cancelled'].includes(task.status)) throw new Error('只能重试失败或取消的传输'); task.bytes = 0; task.error = undefined; task.status = 'queued'; this.onChange(); void this.pump(); }
  async close() { for (const task of this.tasks.values()) this.cancel(task.id); while (this.running) await new Promise(r => setTimeout(r, 20)); }
  async pump() {
    if (this.running) return; this.running = true;
    try {
      for (;;) {
        const task = [...this.tasks.values()].find(t => t.status === 'queued'); if (!task) break;
        task.status = 'running'; task.controller = new AbortController(); this.onChange();
        let release;
        try {
          release = this.manager.acquireTransfer?.();
          const group = await this.manager.resolveGroup(task.groupId);
          if (!group.online) throw new Error('群主机离线，请恢复网络后重试');
          task.controller.signal.throwIfAborted();
          const headers = { 'X-Room-Key': group.key, 'X-Device-Id': this.manager.device.id };
          if (task.type === 'upload') await this.upload(task, group, headers);
          else await this.download(task, group, headers);
          if (task.status !== 'cancelled') task.status = 'done';
        } catch (error) { if (task.status !== 'cancelled') { task.status = 'failed'; task.error = error.message; } }
        finally { release?.(); task.controller = undefined; this.onChange(); }
      }
    } finally { this.running = false; }
  }
  meter(task, hash) {
    let last = 0;
    return new Transform({ transform: (chunk, _encoding, callback) => {
      task.bytes += chunk.length; hash.update(chunk);
      if (Date.now() - last > 100) { last = Date.now(); this.onChange(); }
      callback(null, chunk);
    } });
  }
  async upload(task, group, headers) {
    const file = await fs.open(task.source, 'r');
    try {
      const stat = await file.stat(); if (!stat.isFile()) throw new Error('请选择普通文件；目录请先压缩');
      task.total = stat.size;
      const url = new URL('/api/files', group.baseUrl); url.searchParams.set('name', path.basename(task.source));
      const hash = createHash('sha256');
      let responsePromise;
      const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers: { ...headers, 'Content-Length': stat.size, 'Content-Type': 'application/octet-stream' }, signal: task.controller.signal, localAddress: this.manager.getNetwork?.().selected?.address });
      request.setTimeout(120000, () => request.destroy(new Error('传输两分钟无响应，请重试')));
      responsePromise = new Promise((resolve, reject) => {
        request.on('error', reject);
        request.on('response', response => {
          let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; if (data.length > 65536) request.destroy(new Error('服务器响应过大')); });
          response.on('error', reject); response.on('end', () => { try { const result = JSON.parse(data); if (response.statusCode !== 201) throw new Error(result.error || '上传失败'); resolve(result); } catch (error) { reject(error); } });
        });
      });
      // Attach rejection immediately while streaming to avoid unhandled rejections.
      const result = await Promise.all([responsePromise, pipeline(file.createReadStream({ autoClose: false }), this.meter(task, hash), request, { signal: task.controller.signal })]);
      const message = result[0];
      if (message.size !== task.bytes || message.sha256 !== hash.digest('hex')) throw new Error('上传校验失败，请检查群内文件后重新发送');
      task.messageId = message.id; task.result = '已上传到群主机';
    } finally { await file.close(); }
  }
  async download(task, group, headers) {
    const state = await this.fetchState(group), message = state.messages.find(m => m.id === task.messageId && m.type === 'file');
    if (!message || !/^[a-f0-9]{64}$/.test(message.sha256) || !Number.isSafeInteger(message.size) || message.size < 0) throw new Error('文件记录无效或已不存在');
    task.name = safeFileName(message.fileName); task.total = message.size;
    await fs.mkdir(task.directory, { recursive: true, mode: 0o700 });
    const partial = path.join(task.directory, `.pickdrop-${randomUUID()}.partial`);
    try {
      const url = new URL('/api/files/' + encodeURIComponent(message.id), group.baseUrl);
      const response = await new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).get(url, { headers, signal: task.controller.signal, localAddress: this.manager.getNetwork?.().selected?.address }, resolve);
        request.setTimeout(120000, () => request.destroy(new Error('下载两分钟无响应，请重试')));
        request.on('error', reject);
      });
      if (response.statusCode !== 200) { response.resume(); throw new Error(`下载失败 (${response.statusCode})`); }
      const hash = createHash('sha256');
      const meter = this.meter(task, hash);
      meter.on('data', () => { if (task.bytes > message.size) meter.destroy(new Error('下载大小超出文件记录')); });
      await pipeline(response, meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: task.controller.signal });
      if (task.bytes !== message.size || hash.digest('hex') !== message.sha256) throw new Error('SHA-256 校验失败，已丢弃下载');
      task.controller.signal.throwIfAborted();
      const ext = path.extname(task.name), stem = path.basename(task.name, ext);
      for (let n = 0; n < 10000; n++) {
        const destination = path.join(task.directory, n ? `${stem} (${n})${ext}` : task.name);
        // Atomic no-clobber publication, also protects against concurrent receivers.
        try { await fs.link(partial, destination); task.result = destination; return; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      throw new Error('同名文件过多，请选择其他目录');
    } finally { await fs.rm(partial, { force: true }); }
  }
}
