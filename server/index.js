import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { safeFileName } from '../shared/protocol.js';
import { createGroupPairing } from './pairing.js';

const publicDir = fileURLToPath(new URL('../apps/desktop/public/', import.meta.url));
const staticFiles = new Map([
  ['/', [path.join(publicDir, 'index.html'), 'text/html; charset=utf-8']],
  ['/app.js', [path.join(publicDir, 'app.js'), 'text/javascript; charset=utf-8']],
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

export async function createInboxServer({ dataDir, port = 0, host = '0.0.0.0', listen = true, maxFileBytes = 8 * 1024 ** 3, group, pairingOptions = {} } = {}) {
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
  let saved = { messages: [], devices: [] };
  try { saved = JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const messages = saved.messages;
  const devices = new Map(saved.devices.map(d => [d.id, { ...d, online: false }]));
  const connections = new Map();
  let writeQueue = Promise.resolve();
  let closing = false;
  const activeUploads = new Set(), activeDownloads = new Set();
  let transfersPaused = false, activeTransferRequests = 0;
  const state = () => ({ messages, devices: [...devices.values()], maxFileBytes });
  const persist = () => {
    const snapshot = JSON.stringify({ messages, devices: [...devices.values()].map(d => ({ ...d, online: false })) });
    const operation = writeQueue.catch(() => {}).then(async () => {
      const tmp = `${statePath}.${randomUUID()}.tmp`;
      try { await fs.writeFile(tmp, snapshot, { mode: 0o600 }); await fs.rename(tmp, statePath); }
      finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    });
    writeQueue = operation;
    return operation;
  };
  const validKey = candidate => typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate), Buffer.from(key));
  const broadcast = () => {
    const payload = JSON.stringify({ type: 'state', ...state() });
    for (const client of wss.clients) if (client.readyState === 1) client.send(payload);
  };
  const deviceFor = req => {
    const device = devices.get(req.headers['x-device-id']);
    if (!device) throw fail(400, '请先连接设备');
    return device;
  };
  const fileFor = id => {
    const message = messages.find(m => m.id === id && m.type === 'file');
    return message ? { message, path: path.join(filesDir, id, message.fileName) } : null;
  };

  const registerDevice = async body => {
    if (!uuidPattern.test(body.id) || typeof body.name !== 'string' || !body.name.trim()) throw fail(400, '设备信息不正确');
    const device = { id: body.id, name: body.name.trim().slice(0, 40), kind: ['desktop', 'ios', 'android', 'web'].includes(body.kind) ? body.kind : 'web', online: !!connections.get(body.id)?.size };
    const previous = devices.get(body.id);
    devices.set(body.id, device);
    try { await persist(); } catch (error) { if (previous) devices.set(body.id, previous); else devices.delete(body.id); throw error; }
    broadcast(); return device;
  };
  const pairing = group ? createGroupPairing({ ...pairingOptions, group, key, registerDevice }) : null;

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
      if (req.method === 'GET' && staticFiles.has(route)) {
        const [file, mime] = staticFiles.get(route);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; connect-src 'self' http: https: ws: wss:; img-src 'self' data: blob: http: https:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
        await pipeline(createReadStream(file), res); return;
      }
      if (pairing && route === '/api/group/probe' && req.method === 'POST') return json(res, 200, pairing.probe((await readJson(req)).challenge));
      if (pairing && route === '/api/pair/request' && req.method === 'POST') {
        const body = await readJson(req);
        return json(res, 202, pairing.request(body.code, body.device, req.socket.remoteAddress));
      }
      if (pairing && route.startsWith('/api/pair/status/') && req.method === 'GET') return json(res, 200, pairing.status(route.slice('/api/pair/status/'.length), req.headers['x-poll-token'], req.socket.remoteAddress));
      if (!validKey(req.headers['x-room-key'])) throw fail(401, '配对信息不正确，请重新连接');
      if ((route === '/api/files' && req.method === 'POST') || (route.startsWith('/api/files/') && req.method === 'GET')) {
        if (closing || transfersPaused) throw fail(503, '正在切换网络，请稍后重试');
        activeTransferRequests++;
        let released = false;
        const release = () => { if (!released) { released = true; activeTransferRequests--; } };
        res.once('finish', release); res.once('close', release);
      }
      if (route === '/api/state' && req.method === 'GET') return json(res, 200, state());
      if (route === '/api/qr' && req.method === 'GET') {
        const link = url.searchParams.get('link');
        if (!link || link.length > 1000) throw fail(400, '二维码地址不正确');
        return json(res, 200, { image: await QRCode.toDataURL(link, { width: 280, margin: 2, color: { dark: '#194e42', light: '#ffffff' } }) });
      }
      if (route === '/api/join' && req.method === 'POST') {
        return json(res, 200, await registerDevice(await readJson(req)));
      }
      if (pairing && route.startsWith('/api/pair/')) {
        deviceFor(req);
        if (route === '/api/pair/invite' && req.method === 'POST') return json(res, 201, pairing.invite());
        if (route === '/api/pair/requests' && req.method === 'GET') return json(res, 200, pairing.list());
        if (route === '/api/pair/respond' && req.method === 'POST') {
          const body = await readJson(req);
          return json(res, 200, await pairing.respond(body.requestId, body.allow));
        }
      }
      if (route === '/api/messages' && req.method === 'POST') {
        const device = deviceFor(req), body = await readJson(req);
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10000) throw fail(400, '请输入 10000 字以内的内容');
        const message = { id: randomUUID(), type: 'text', text: body.text.trim(), senderId: device.id, senderName: device.name, createdAt: new Date().toISOString() };
        messages.push(message);
        try { await persist(); } catch (error) { messages.splice(messages.indexOf(message), 1); throw error; }
        broadcast(); return json(res, 201, message);
      }
      if (route === '/api/files' && req.method === 'POST') {
        if (closing || transfersPaused) throw fail(503, '正在切换网络，请稍后重试');
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
            await fs.rename(partial, path.join(dir, fileName));
            const message = { id, type: 'file', fileName, size, mime: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100), sha256: hash.digest('hex'), senderId: device.id, senderName: device.name, createdAt: new Date().toISOString() };
            messages.push(message);
            try { await persist(); } catch (error) { messages.splice(messages.indexOf(message), 1); throw error; }
            broadcast(); json(res, 201, message);
          } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
        })();
        activeUploads.add(upload);
        try { await upload; } finally { activeUploads.delete(upload); }
        return;
      }
      if (route.startsWith('/api/files/') && req.method === 'GET') {
        if (closing || transfersPaused) throw fail(503, '正在切换网络，请稍后重试');
        const record = fileFor(route.slice('/api/files/'.length));
        if (!record) throw fail(404, '找不到这个文件');
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
    if (url.pathname !== '/api/events' || !validKey(url.searchParams.get('key')) || !device) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => {
      client.isAlive = true;
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
    catch (error) { clearInterval(heartbeat); wss.close(); throw error; }
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
    fileFor, state, registerDevice, pairing,
    async close({ force = false } = {}) {
      closing = true; clearInterval(heartbeat);
      for (const client of wss.clients) client.terminate();
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); if (force) server.closeAllConnections(); });
      await Promise.allSettled([...activeUploads, ...activeDownloads]);
      await writeQueue;
      wss.close();
    },
  };
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
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}
