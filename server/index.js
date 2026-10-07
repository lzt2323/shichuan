import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { safeFileName } from '../shared/protocol.js';
import { createGroupPairing } from './pairing.js';
import { openHistoryStore, validMessage } from './history-store.js';
import { readJsonWithBackup, writeJsonWithBackup } from './persistence.js';

const publicDir = fileURLToPath(new URL('../apps/desktop/public/', import.meta.url));
const staticFiles = new Map([
  ['/', [path.join(publicDir, 'index.html'), 'text/html; charset=utf-8']],
  ['/app.js', [path.join(publicDir, 'app.js'), 'text/javascript; charset=utf-8']],
  ['/clipboard-images.js', [path.join(publicDir, 'clipboard-images.js'), 'text/javascript; charset=utf-8']],
  ['/history.js', [fileURLToPath(new URL('../shared/history.js', import.meta.url)), 'text/javascript; charset=utf-8']],
  ['/styles.css', [path.join(publicDir, 'styles.css'), 'text/css; charset=utf-8']],
  ['/protocol.js', [fileURLToPath(new URL('../shared/protocol.js', import.meta.url)), 'text/javascript; charset=utf-8']],
]);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > 64 * 1024) throw fail(413, '消息过长');
  }
  try { return JSON.parse(body); } catch { throw fail(400, '请求格式不正确'); }
}

export async function createInboxServer({ dataDir, port = 0, host = '0.0.0.0', listen = true, maxFileBytes = 8 * 1024 ** 3, group, pairingOptions = {}, peer } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const filesDir = path.join(dataDir, 'files');
  await fs.mkdir(filesDir, { recursive: true, mode: 0o700 });
  let key;
  try { key = (await fs.readFile(path.join(dataDir, 'room-key'), 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = randomBytes(32).toString('hex');
    await fs.writeFile(path.join(dataDir, 'room-key'), key, { mode: 0o600, flag: 'wx' });
  }
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid room key');
  const statePath = path.join(dataDir, 'history.json');
  const saved = await readJsonWithBackup(statePath, value => value && Array.isArray(value.devices) &&
    value.devices.every(d => uuidPattern.test(d?.id) && typeof d.name === 'string') &&
    (value.messages === undefined || Array.isArray(value.messages) && value.messages.every(validMessage)) &&
    (!value.auth || [1, 2].includes(value.auth.version) && value.auth.credentials && typeof value.auth.credentials === 'object'), { recover: false }) || { devices: [] };
  const history = await openHistoryStore(dataDir, saved.messages || [], { requireExisting: saved.version === 2 });
  try {
  // Only abandoned app-owned upload directories are swept; committed files are retained.
  for (const entry of await fs.readdir(filesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !uuidPattern.test(entry.name)) continue;
    const record = peer ? peer.state().messages.find(m => m.id === entry.name) : history.get(entry.name);
    if (record && !record.deleted) continue;
    const folder = path.join(filesDir, entry.name), info = await fs.stat(folder);
    if (record?.deleted || Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) await fs.rm(folder, { recursive: true, force: true });
  }
  const devices = new Map(saved.devices.map(d => [d.id, { ...d, online: false }]));
  const connections = new Map(), deviceRequests = new Map();
  let auth = saved.auth || { version: group?.authVersion === 2 ? 2 : 1, credentials: {} };
  const hostCredentialPath = path.join(dataDir, 'host-credential');
  let hostCredential = await fs.readFile(hostCredentialPath, 'utf8').then(value => value.trim(), error => { if (error.code === 'ENOENT') return null; throw error; });
  if (hostCredential && !/^[a-f0-9]{64}$/.test(hostCredential)) throw new Error('Invalid host credential');
  let memberWrites = Promise.resolve();
  const memberOperation = operation => {
    const work = memberWrites.catch(() => {}).then(operation); memberWrites = work; return work;
  };
  const tokenHash = token => createHash('sha256').update(token).digest('hex');
  const validCredential = (deviceId, token) => {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    const expected = auth.credentials[deviceId];
    return typeof expected === 'string' && expected.length === 64 && timingSafeEqual(Buffer.from(expected), Buffer.from(tokenHash(token)));
  };
  let writeQueue = Promise.resolve();
  let closing = false, closePromise;
  const activeUploads = new Set(), activeDownloads = new Set();
  let transfersPaused = false, cleanupBusy = false, activeTransferRequests = 0;
  const summary = () => ({ devices: peer ? peer.state().members.map(member => ({ ...member, online: Boolean(connections.get(member.id)?.size) || peer.peers().some(p => p.deviceId === member.id && p.online) })) : [...devices.values()], maxFileBytes, authVersion: peer ? 3 : auth.version });
  const state = () => ({ ...(peer ? { messages: peer.state().messages, history: { hasMore: false, before: null, total: peer.state().messages.length } } : history.page()), ...summary() });
  const persist = () => {
    const snapshot = { version: 2, auth: structuredClone(auth), devices: [...devices.values()].map(d => ({ ...d, online: false })) };
    const operation = writeQueue.catch(() => {}).then(() => writeJsonWithBackup(statePath, snapshot));
    writeQueue = operation;
    return operation;
  };
  const validKey = candidate => typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate), Buffer.from(key));
  const broadcast = (messages = []) => {
    if (closing) return;
    let legacy;
    const delta = JSON.stringify({ type: 'state', mode: 'delta', messages, ...summary(), history: history.page({ limit: 1 }).history });
    for (const client of wss.clients) if (client.readyState === 1) {
      // A stalled receiver must reconnect to a bounded snapshot instead of accumulating an unlimited send queue.
      if (client.bufferedAmount > 4 * 1024 * 1024) { client.close(1013, 'reconnect to resume'); continue; }
      client.send(client.deltaStream ? delta : (legacy ||= JSON.stringify({ type: 'state', ...state() })));
    }
  };
  const deviceFor = req => {
    const device = devices.get(req.headers['x-device-id']);
    if (!device) throw fail(400, '请先连接设备');
    return device;
  };
  const authorize = (deviceId, credential) => peer ? deviceId === group.hostDeviceId && validCredential(deviceId, credential) : auth.version === 2 ? devices.has(deviceId) && validCredential(deviceId, credential) : validKey(credential);
  const checkRequest = req => {
    if (!authorize(req.headers['x-device-id'], req.headers['x-room-key'])) throw fail(401, '设备授权已失效，请重新申请加入');
  };
  const fileFor = id => {
    const message = peer ? peer.state().messages.find(m => m.id === id) : history.get(id);
    return message?.type === 'file' && !message.deleted ? { message, path: path.join(filesDir, id, message.fileName) } : null;
  };

  const registerDeviceNow = async body => {
    if (!uuidPattern.test(body?.id) || typeof body.name !== 'string' || !body.name.trim()) throw fail(400, '设备信息不正确');
    const device = { id: body.id, name: body.name.trim().slice(0, 40), kind: ['desktop', 'ios', 'android', 'web'].includes(body.kind) ? body.kind : 'web', online: !!connections.get(body.id)?.size };
    const previous = devices.get(body.id);
    devices.set(body.id, device);
    try { await persist(); } catch (error) { if (previous) devices.set(body.id, previous); else devices.delete(body.id); throw error; }
    broadcast(); return device;
  };
  const registerDevice = body => memberOperation(async () => {
    if (auth.version === 2 && body?.id !== group.hostDeviceId && !auth.credentials[body?.id]) throw fail(401, '请先申请加入');
    return registerDeviceNow(body);
  });
  async function createHostCredential() {
    if (!hostCredential) {
      const candidate = randomBytes(32).toString('hex');
      await fs.writeFile(hostCredentialPath, candidate, { mode: 0o600, flag: 'wx' }); hostCredential = candidate;
    }
    return hostCredential;
  }
  const ensureHostDevice = body => memberOperation(async () => {
    if (!group || body?.id !== group.hostDeviceId) throw fail(403, '仅群主机可设置主机身份');
    if (auth.version !== 2) { await registerDeviceNow(body); return key; }
    const token = await createHostCredential(), previous = auth.credentials[body.id];
    auth.credentials[body.id] = tokenHash(token);
    try { await registerDeviceNow(body); } catch (error) { if (previous) auth.credentials[body.id] = previous; else delete auth.credentials[body.id]; throw error; }
    return token;
  });
  const approveDevice = (body, actorRequest, reset = false) => memberOperation(async () => {
    if (actorRequest) checkRequest(actorRequest);
    if (auth.version !== 2) { await registerDeviceNow(body); return key; }
    const existing = devices.has(body.id) || auth.credentials[body.id];
    if (existing && (!reset || actorRequest?.headers['x-device-id'] !== group.hostDeviceId || body.id === group.hostDeviceId)) throw fail(409, '此设备已加入，只有群创建者可明确批准重置授权');
    const previousCredential = auth.credentials[body.id];
    const token = randomBytes(32).toString('hex'); auth.credentials[body.id] = tokenHash(token);
    try { await registerDeviceNow(body); } catch (error) { if (previousCredential) auth.credentials[body.id] = previousCredential; else delete auth.credentials[body.id]; throw error; }
    if (existing) disconnectDevice(body.id);
    return token;
  });
  const pairing = group ? createGroupPairing({ ...pairingOptions, group, key, registerDevice, approveDevice,
    authVersion: () => auth.version, hasDevice: id => devices.has(id), credentialFor: validCredential,
    proofFor: (id, challenge) => {
      const secret = auth.credentials[id];
      if (!secret || !devices.has(id)) throw fail(401, '设备授权已失效，请重新申请加入');
      return createHmac('sha256', secret).update(`${group.id}:${challenge}`).digest('hex');
    },
  }) : null;
  function disconnectDevice(id, exceptRequest) {
    for (const client of connections.get(id) || []) { if (client.readyState === 1) client.send(JSON.stringify({ type: 'revoked' })); client.close(1008, 'membership revoked');
      const timer = setTimeout(() => client.terminate(), 1000); timer.unref(); client.once('close', () => clearTimeout(timer)); }
    for (const { req, res } of deviceRequests.get(id) || []) if (req !== exceptRequest) { req.destroy(); res.destroy(); }
    pairing?.invalidateDevice(id);
  }
  const removeDevice = (id, req) => memberOperation(async () => {
    checkRequest(req);
    if (auth.version !== 2) throw fail(409, '请先升级群设备授权，再移除设备');
    if (id === group.hostDeviceId) throw fail(409, '不能移除群主机，请使用解散群');
    if (!uuidPattern.test(id)) throw fail(400, '设备编号不正确');
    const previous = devices.get(id), credential = auth.credentials[id];
    if (!previous) return { removed: true, deviceId: id };
    devices.delete(id); delete auth.credentials[id];
    try { await persist(); } catch (error) { devices.set(id, previous); if (credential) auth.credentials[id] = credential; throw error; }
    disconnectDevice(id, req); broadcast(); return { removed: true, deviceId: id };
  });
  const secureMembers = () => memberOperation(async () => {
    if (!group) throw fail(400, '此服务没有群主机');
    if (auth.version === 2) return { authVersion: 2, key: hostCredential };
    const token = await createHostCredential(), previousAuth = auth, previousDevices = new Map(devices);
    const hostDevice = devices.get(group.hostDeviceId);
    if (!hostDevice) throw fail(409, '群主机尚未注册');
    auth = { version: 2, credentials: { [group.hostDeviceId]: tokenHash(token) } };
    devices.clear(); devices.set(group.hostDeviceId, hostDevice);
    try { await persist(); } catch (error) { auth = previousAuth; devices.clear(); for (const [id, device] of previousDevices) devices.set(id, device); throw error; }
    for (const id of previousDevices.keys()) disconnectDevice(id);
    broadcast(); return { authVersion: 2, key: token };
  });

  async function deleteFiles(ids, req) {
    if (peer) {
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !uuidPattern.test(id))) throw fail(400, '请选择文件');
      if (activeTransferRequests || activeUploads.size || activeDownloads.size) throw fail(409, '有文件正在传输');
      if (req) checkRequest(req);
      for (const id of ids) await fs.rm(path.join(filesDir, id), { recursive: true, force: true });
      return { removed: ids.length, ...history.stats() };
    }
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !uuidPattern.test(id))) throw fail(400, '请选择 1 至 100 个文件');
    if (closing || activeTransferRequests || activeUploads.size || activeDownloads.size) throw fail(409, '有文件正在传输，请稍后清理');
    return memberOperation(async () => {
      if (req) checkRequest(req);
      if (activeTransferRequests || activeUploads.size || activeDownloads.size) throw fail(409, '有文件正在传输，请稍后清理');
      cleanupBusy = true;
      const changed = [];
      try {
        for (const id of new Set(ids)) {
          const record = history.get(id); if (!record || record.type !== 'file') continue;
          // Tombstone first: a crash cannot leave a downloadable record pointing at a removed original.
          const updated = history.markDeleted(id); changed.push(updated);
          await fs.rm(path.join(filesDir, id), { recursive: true, force: true });
        }
      } finally { cleanupBusy = false; if (changed.length) broadcast(changed); }
      return { removed: changed.length, ...history.stats() };
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Room-Key, X-Device-Id, X-Poll-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (peer && await peer.handle(req, res, url)) return;
      if (!peer && route === '/api/peer/info') throw fail(404, '此群使用旧版协议');
      if (req.method === 'GET' && staticFiles.has(route)) {
        const [file, mime] = staticFiles.get(route);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; connect-src 'self' http: https: ws: wss:; img-src 'self' data: blob: http: https:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
        await pipeline(createReadStream(file), res); return;
      }
      if (pairing && route === '/api/group/probe' && req.method === 'POST') { const body = await readJson(req); return json(res, 200, pairing.probe(body.challenge, body.deviceId, body.authVersion)); }
      if (peer && (route === '/api/pair/request' || route.startsWith('/api/pair/status/'))) throw fail(409, '此群需要新版点对点签名配对');
      if (pairing && route === '/api/pair/request' && req.method === 'POST') {
        const body = await readJson(req);
        return json(res, 202, pairing.request(body.code, body.device, req.socket.remoteAddress, body.reset === true));
      }
      if (pairing && route.startsWith('/api/pair/status/') && req.method === 'GET') return json(res, 200, pairing.status(route.slice('/api/pair/status/'.length), req.headers['x-poll-token'], req.socket.remoteAddress));
      checkRequest(req);
      const requestingId = req.headers['x-device-id'];
      if (auth.version === 2) {
        const record = { req, res }, requests = deviceRequests.get(requestingId) || new Set();
        requests.add(record); deviceRequests.set(requestingId, requests);
        const forget = () => { requests.delete(record); if (!requests.size) deviceRequests.delete(requestingId); };
        res.once('close', forget); res.once('finish', forget);
      }
      if (group && route === '/api/members/remove' && req.method === 'POST') {
        if (requestingId !== group.hostDeviceId) throw fail(403, '仅群主机可移除设备');
        return json(res, 200, await removeDevice((await readJson(req)).deviceId, req));
      }
      if (group && route === '/api/members/leave' && req.method === 'POST') return json(res, 200, await removeDevice(requestingId, req));
      if ((route === '/api/files' && req.method === 'POST') || (route.startsWith('/api/files/') && req.method === 'GET')) {
        if (closing || transfersPaused || cleanupBusy) throw fail(503, '正在切换网络，请稍后重试');
        activeTransferRequests++;
        let released = false;
        const release = () => { if (!released) { released = true; activeTransferRequests--; } };
        res.once('finish', release); res.once('close', release);
      }
      if (route === '/api/state' && req.method === 'GET') return json(res, 200, state());
      if (peer && route === '/api/history' && req.method === 'GET') return json(res, 200, state());
      if (route === '/api/history' && req.method === 'GET') return json(res, 200, history.page({ before: url.searchParams.get('before'), limit: url.searchParams.get('limit') || 100 }));
      if (route.startsWith('/api/messages/') && req.method === 'GET') {
        const message = peer ? peer.state().messages.find(m => m.id === route.slice('/api/messages/'.length)) : history.get(route.slice('/api/messages/'.length));
        if (!message) throw fail(404, '找不到这条消息');
        return json(res, 200, message);
      }
      if (route === '/api/storage' && req.method === 'GET') return json(res, 200, history.stats());
      if (route === '/api/storage/files' && req.method === 'GET') {
        if (!group || requestingId !== group.hostDeviceId) throw fail(403, '仅群主机可管理原文件');
        return json(res, 200, { files: history.files({ before: url.searchParams.get('before') }), ...history.stats() });
      }
      if (route === '/api/storage/delete-files' && req.method === 'POST') {
        if (!group || requestingId !== group.hostDeviceId) throw fail(403, '仅群主机可清理原文件');
        const body = await readJson(req);
        return json(res, 200, await deleteFiles(body.ids, req));
      }
      if (route === '/api/qr' && req.method === 'GET') {
        const link = url.searchParams.get('link');
        if (!link || link.length > 1000) throw fail(400, '二维码地址不正确');
        return json(res, 200, { image: await QRCode.toDataURL(link, { width: 280, margin: 2, color: { dark: '#194e42', light: '#ffffff' } }) });
      }
      if (route === '/api/join' && req.method === 'POST') {
        const body = await readJson(req);
        if (auth.version === 2 && body.id !== requestingId) throw fail(403, '不能修改其他设备身份');
        return json(res, 200, await memberOperation(async () => { checkRequest(req); return registerDeviceNow(body); }));
      }
      if (pairing && route.startsWith('/api/pair/')) {
        deviceFor(req);
        if (route === '/api/pair/invite' && req.method === 'POST') return json(res, 201, pairing.invite());
        if (route === '/api/pair/requests' && req.method === 'GET') return json(res, 200, pairing.list());
        if (route === '/api/pair/respond' && req.method === 'POST') {
          const body = await readJson(req); checkRequest(req);
          return json(res, 200, await pairing.respond(body.requestId, body.allow, req));
        }
      }
      if (route === '/api/messages' && req.method === 'POST') {
        const device = deviceFor(req), body = await readJson(req); checkRequest(req);
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10000) throw fail(400, '请输入 10000 字以内的内容');
        const message = { id: randomUUID(), type: 'text', text: body.text.trim(), senderId: device.id, senderName: device.name, createdAt: new Date().toISOString() };
        await memberOperation(async () => {
          checkRequest(req); if (peer) await peer.appendMessage(message); else Object.assign(message, history.add(message));
        });
        broadcast([message]); return json(res, 201, message);
      }
      if (route === '/api/files' && req.method === 'POST') {
        if (closing || transfersPaused || cleanupBusy) throw fail(503, '正在切换网络，请稍后重试');
        const device = deviceFor(req);
        const declaredLength = Number(req.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxFileBytes) throw fail(413, '文件超过当前大小上限');
        const id = randomUUID(), fileName = safeFileName(url.searchParams.get('name'));
        const dir = path.join(filesDir, id), partial = path.join(dir, '.uploading');
        await fs.mkdir(dir, { mode: 0o700 });
        let size = 0;
        const hash = createHash('sha256');
        const meter = new Transform({ transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > maxFileBytes) return callback(fail(413, '文件超过当前大小上限'));
          hash.update(chunk); callback(null, chunk);
        } });
        const upload = (async () => {
          try {
            await pipeline(req, meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
            checkRequest(req);
            await fs.rename(partial, path.join(dir, fileName));
            checkRequest(req);
            const message = { id, type: 'file', fileName, size, mime: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100), sha256: hash.digest('hex'), senderId: device.id, senderName: device.name, createdAt: new Date().toISOString() };
            await memberOperation(async () => {
              checkRequest(req); if (peer) await peer.appendMessage(message); else Object.assign(message, history.add(message));
            });
            broadcast([message]); json(res, 201, message);
          } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
        })();
        activeUploads.add(upload);
        try { await upload; } finally { activeUploads.delete(upload); }
        return;
      }
      if (route.startsWith('/api/files/') && req.method === 'GET') {
        if (closing || transfersPaused || cleanupBusy) throw fail(503, '正在切换网络，请稍后重试');
        const record = fileFor(route.slice('/api/files/'.length));
        if (!record) throw fail(404, '找不到这个文件');
        if (peer) await peer.prepareFile(record.message.id);
        const stat = await fs.stat(record.path).catch(() => { throw fail(404, '文件已从磁盘移除'); });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(record.message.fileName)}`, 'X-Content-SHA256': record.message.sha256, 'Cache-Control': 'no-store' });
        const download = pipeline(createReadStream(record.path), res); activeDownloads.add(download);
        try { await download; } finally { activeDownloads.delete(download); } return;
      }
      throw fail(404, '找不到这个页面');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : '操作失败，请检查磁盘空间和网络连接' });
      else if (!res.destroyed) res.destroy();
    }
  });
  server.requestTimeout = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const device = devices.get(url.searchParams.get('device'));
    if (url.pathname !== '/api/events' || !authorize(url.searchParams.get('device'), url.searchParams.get('key')) || !device) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => {
      client.isAlive = true; client.deltaStream = url.searchParams.get('stream') === '2';
      const set = connections.get(device.id) || new Set();
      set.add(client); connections.set(device.id, set); device.online = true;
      client.on('pong', () => { client.isAlive = true; });
      client.on('error', () => {});
      client.on('close', () => {
        set.delete(client);
        const currentDevice = devices.get(device.id);
        if (!set.size && currentDevice) currentDevice.online = false;
        broadcast();
      });
      if (client.deltaStream) client.send(JSON.stringify({ type: 'state', mode: 'snapshot', ...state() }));
      broadcast();
    });
  });
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!client.isAlive) { client.terminate(); continue; }
      client.isAlive = false; client.ping();
    }
  }, 15000);
  heartbeat.unref();
  if (listen) {
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
    catch (error) { clearInterval(heartbeat); wss.close(); history.close(); throw error; }
  }
  const actualPort = server.address()?.port || null;
  const bindAddress = host === '0.0.0.0' ? '127.0.0.1' : host;
  const baseUrl = actualPort ? `http://${bindAddress}:${actualPort}` : null;
  const addresses = !actualPort ? [] : host === '0.0.0.0' ? Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.')).map(x => `http://${x.address}:${actualPort}`) : host.startsWith('127.') ? [] : [baseUrl];
  return {
    port: actualPort, key, baseUrl, addresses,
    activeTransfers: () => Math.max(activeTransferRequests, activeUploads.size + activeDownloads.size),
    pauseTransfers(value = true) { transfersPaused = Boolean(value); },
    pairingLinks: addresses.map(address => `${address}/#key=${key}`),
    fileFor, state, registerDevice, pairing, ensureHostDevice,
    renameGroup(name) { if (group) group.name = name; },
    refreshPeerState() { broadcast(peer ? peer.state().messages : []); },
    exportMessages() { const all=[];let before;do {const page=history.page({before,limit:100});all.unshift(...page.messages);if(!page.history.hasMore)break;before=page.history.before;}while(before);return all; },
    storage: () => history.stats(), listFiles: options => history.files(options), deleteFiles,
    getAuthVersion: () => auth.version,
    secureMembers,
    async close({ force = false } = {}) {
      if (closePromise) return closePromise;
      closePromise = (async () => {
      closing = true; clearInterval(heartbeat);
      for (const client of wss.clients) client.terminate();
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); if (force) server.closeAllConnections(); });
      await Promise.allSettled([...activeUploads, ...activeDownloads]);
      await memberWrites.catch(() => {}); await writeQueue.catch(() => {});
      wss.close(); history.close();
      })();
      return closePromise;
    },
  };
  } catch (error) { history.close(); throw error; }
}


// The desktop UI has its own loopback-only origin. Group services may go offline
// or change interfaces without taking the network selector itself away.
export async function createDesktopUiServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const record = staticFiles.get(new URL(req.url, 'http://localhost').pathname);
      if (req.method !== 'GET' || !record) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': record[1], 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; connect-src 'self' http: https: ws: wss:; img-src 'self' data: blob: http: https:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'" });
      await pipeline(createReadStream(record[0]), res);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: ({ force = false } = {}) => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); if (force) server.closeAllConnections(); }) };
}
