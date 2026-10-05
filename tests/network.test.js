import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
const { createNetworkTransferScope } = createRequire(import.meta.url)('../apps/desktop/network-transfers.cjs');
import { WebSocketServer } from 'ws';
import { normalizeInterfaces, chooseNetwork, publicEndpoint } from '../server/network.js';
import { createLanDiscovery, discoveryTxt, parseDiscoveredService, restrictServiceAddress } from '../server/discovery.js';
import { createGroupManager } from '../server/groups.js';
import { createDesktopUiServer } from '../server/index.js';
import { createDesktopNetworkProxy } from '../server/desktop-proxy.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const physical = { id: 'wifi:127.0.0.1', name: 'wifi', interfaceName: 'wifi', address: '127.0.0.1', type: 'wifi', virtual: false, connected: true };
const vpn = { ...physical, id: 'vpn:127.0.0.1', name: 'vpn', interfaceName: 'vpn', type: 'vpn', virtual: true };
const quietDiscovery = async () => ({ list: () => [], refresh() {}, async close() {} });
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-network-'));
  const manager = await createGroupManager({ dataDir: dir, device: { id: randomUUID(), name: '测试设备', kind: 'desktop' }, listInterfaces: async () => [physical, vpn], discoveryFactory: quietDiscovery, networkPollMs: 600000, monitorIntervalMs: 600000, ...options });
  t.after(async () => { await manager.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return manager;
}

test('connected adapters are classified, physical links win auto mode, and manual selection is exact', () => {
  const adapter = address => [{ family: 'IPv4', address, internal: false, netmask: '255.255.255.0' }];
  const list = normalizeInterfaces({ utun4: adapter('100.64.0.2'), en0: adapter('192.168.1.6'), eth1: adapter('10.0.0.3'), docker0: adapter('172.17.0.1'), lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }, { platform: 'darwin', hardware: { en0: 'Wi-Fi' } });
  assert.equal(list.length, 4); assert.equal(list[0].type, 'wifi'); assert.equal(chooseNetwork(list).name, 'en0');
  assert.equal(list.find(item => item.name === 'utun4').virtual, true);
  assert.equal(chooseNetwork(list, { mode: 'manual', id: 'utun4:100.64.0.2' }).type, 'vpn');
  assert.throws(() => chooseNetwork(list, { mode: 'manual', interfaceName: 'en0', address: '192.168.1.99' }), /已断开/);
  assert.throws(() => publicEndpoint('127.0.0.1', 1234), /局域网地址/);
  assert.throws(() => publicEndpoint('0.0.0.0', 1234), /局域网地址/);
  assert.equal(publicEndpoint('192.168.1.6', 1234), 'http://192.168.1.6:1234');
});

test('network switching preserves group identity/history and waits for transfers; disconnect never chooses VPN', async t => {
  let adapters = [physical, vpn];
  const manager = await fixture(t, { listInterfaces: async () => adapters });
  const group = await manager.createGroup('网络测试');
  await manager.authenticated(group.id, '/api/messages', { method: 'POST', body: { text: '切换后仍在' } });
  const release = manager.acquireTransfer();
  await assert.rejects(manager.setNetwork({ mode: 'manual', id: vpn.id }), /文件正在传输/); release();
  await manager.setNetwork({ mode: 'manual', id: physical.id });
  const rebound = manager.listGroups()[0]; assert.equal(rebound.id, group.id); assert.equal(rebound.key, group.key); assert.notEqual(rebound.baseUrl, group.baseUrl);
  assert.equal((await manager.authenticated(group.id, '/api/state')).messages[0].text, '切换后仍在');
  await assert.rejects(fetch(group.baseUrl + '/api/state'));
  adapters = [vpn]; await manager.refreshNetwork();
  assert.equal(manager.getNetwork().available, false); assert.equal(manager.getNetwork().selected.name, 'wifi'); assert.equal(manager.listGroups()[0].online, false);
  await assert.rejects(manager.joinAt('http://127.0.0.1:1234', '123456'), /网络已断开/);
  adapters = [physical, vpn]; await manager.refreshNetwork();
  assert.equal(manager.getNetwork().available, true); assert.equal(manager.listGroups()[0].key, group.key);
  assert.equal((await manager.authenticated(group.id, '/api/state')).messages.length, 1);
});

test('a LAN-hosted group binds exactly its selected IP and invitations never use UI loopback', async t => {
  const adapter = normalizeInterfaces(os.networkInterfaces())[0]; if (!adapter) return t.skip('No connected IPv4 adapter in this runner');
  const manager = await fixture(t, { listInterfaces: async () => [adapter] });
  const group = await manager.createGroup('真实地址'), invite = await manager.createInvite(group.id);
  assert.equal(new URL(group.baseUrl).hostname, adapter.address); assert.equal(new URL(invite.link).hostname, adapter.address);
  assert.equal(new URL(invite.link).hash.includes('key='), false); assert.equal(manager.publicEndpoint(group.id), group.baseUrl);
  assert.equal(new URL(invite.link).hash.includes(`group=${group.id}`), true);
  const port = new URL(group.baseUrl).port; await assert.rejects(fetch(`http://127.0.0.1:${port}/api/state`));
  const ui = await createDesktopUiServer(); t.after(() => ui.close());
  assert.equal(new URL(ui.baseUrl).hostname, '127.0.0.1'); assert.equal((await fetch(ui.baseUrl)).status, 200);
  assert.equal((await fetch(ui.baseUrl + '/api/state')).status, 404);
});

test('mDNS publishes only selected IPv4 and public TXT; fragmented DNS-SD records resolve and expire', async t => {
  const entry = { groupId: randomUUID(), hostDeviceId: randomUUID(), port: 47888, name: '研发群', key: 'secret', code: '123456' };
  assert.deepEqual(Object.keys(discoveryTxt(entry)).sort(), ['groupId', 'hostDeviceId', 'name', 'protocol', 'version'].sort());
  const service = { host: 'test.local', records: () => [{ type: 'PTR', ttl: 120, name: '_pickdrop._tcp.local', data: 'test._pickdrop._tcp.local' }, { type: 'A', name: 'test.local', data: '10.8.0.2' }, { type: 'AAAA', data: '::1' }] };
  restrictServiceAddress(service, '192.168.1.6'); assert.deepEqual(service.records().filter(rr => rr.type === 'A').map(rr => rr.data), ['192.168.1.6']); assert.equal(service.records().some(rr => rr.type === 'AAAA'), false);
  let instance, clock = Date.now();
  class FakeBonjour {
    constructor(options) { this.options = options; this.server = { mdns: new EventEmitter() }; instance = this; }
    publish(config) { this.config = config; return { host: config.host, records: () => [], stop() {} }; }
    find() { return { update() {}, stop() {} }; }
    unpublishAll(callback) { callback(); } destroy(callback) { callback(); }
  }
  const found = [], discovery = await createLanDiscovery({ getAnnouncements: () => [entry], onRecord: record => found.push(record), interfaceAddress: '192.168.1.6', BonjourImpl: FakeBonjour, udp: false, now: () => clock });
  t.after(() => discovery.close()); assert.equal(instance.options.interface, '192.168.1.6'); assert.equal(instance.config.type, 'pickdrop');
  const name = `pickdrop-${entry.groupId}._pickdrop._tcp.local`, host = `pickdrop-${entry.groupId}.local`;
  const emit = answers => instance.server.mdns.emit('response', { answers, additionals: [] }, { address: '192.168.1.20' });
  emit([{ name: '_pickdrop._tcp.local', type: 'PTR', ttl: 30, data: name }]);
  emit([{ name, type: 'SRV', ttl: 30, data: { target: host, port: entry.port } }]);
  emit([{ name, type: 'TXT', ttl: 30, data: Object.entries(discoveryTxt(entry)).map(([key, value]) => Buffer.from(`${key}=${value}`)) }, { name: host, type: 'A', ttl: 30, data: '192.168.1.20' }]);
  assert.equal(found[0].groupId, entry.groupId); assert.equal(found[0].baseUrl, 'http://192.168.1.20:47888'); assert.equal(found[0].name, '研发群');
  assert.deepEqual(parseDiscoveredService({ txt: { ...discoveryTxt(entry), version: '9' }, port: 80, addresses: ['192.168.1.1'] }), []);
  assert.deepEqual(parseDiscoveredService({ txt: discoveryTxt(entry), port: 80, addresses: ['127.0.0.1'] }), []);
  clock += 36000; assert.equal(discovery.list().length, 0);
});

async function proxyFixture(t) {
  const address = normalizeInterfaces(os.networkInterfaces())[0]?.address || '127.0.0.1';
  let count = 0, seenAddress, leases = 0;
  const upstream = http.createServer((req, res) => { count++; seenAddress = req.socket.remoteAddress; if (req.url === '/api/files/slow') { res.writeHead(200); res.write('part'); } else if (req.url === '/api/files/abort') { res.writeHead(200, { 'Content-Length': 100 }); res.write('part'); setTimeout(() => res.destroy(), 10); } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true })); } });
  const wss = new WebSocketServer({ server: upstream }); wss.on('connection', ws => ws.send('bound-websocket'));
  await new Promise(resolve => upstream.listen(0, address, resolve));
  const baseUrl = `http://${address}:${upstream.address().port}`;
  const group = { id: randomUUID(), baseUrl, online: true, local: true };
  const manager = { getNetwork: () => ({ selected: { address }, available: true, switching: false }), listGroups: () => [group], resolveGroup: async () => group, acquireTransfer() { leases++; let released = false; return () => { if (!released) { released = true; leases--; } }; } };
  const proxy = await createDesktopNetworkProxy(manager);
  t.after(async () => { await proxy.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => upstream.close(resolve)); wss.close(); });
  return { proxy, baseUrl, address, wss, count: () => count, seenAddress: () => seenAddress, leases: () => leases };
}
function viaProxy(proxy, target) { return new Promise((resolve, reject) => { const request = http.get({ host: '127.0.0.1', port: Number(proxy.address.split(':')[1]), path: target }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); }); request.on('error', reject); }); }

test('desktop proxy binds selected source, permits only joined origins, and releases cancelled file leases', async t => {
  const f = await proxyFixture(t);
  assert.equal((await viaProxy(f.proxy, f.baseUrl + '/api/state')).status, 200); assert.equal(f.seenAddress(), f.address);
  assert.equal((await viaProxy(f.proxy, 'http://127.0.0.1:9/secret')).status, 503); assert.equal(f.count(), 1);
  const request = http.get({ host: '127.0.0.1', port: Number(f.proxy.address.split(':')[1]), path: f.baseUrl + '/api/files/slow' });
  request.on('error', () => {});
  await new Promise(resolve => request.on('response', res => { res.once('data', () => { assert.equal(f.leases(), 1); request.destroy(); resolve(); }); }));
  await sleep(25); assert.equal(f.leases(), 0);
});

test('desktop proxy forwards bound WebSocket upgrades and tears down both sockets', async t => {
  const f = await proxyFixture(t), socket = net.connect(Number(f.proxy.address.split(':')[1]), '127.0.0.1');
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  const key = randomBytes(16).toString('base64');
  socket.write(`GET ${f.baseUrl.replace('http:', 'ws:')}/api/events HTTP/1.1\r\nHost: ${new URL(f.baseUrl).host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
  let bytes = ''; await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('WebSocket proxy timeout')), 3000); socket.on('data', data => { bytes += data.toString(); if (bytes.includes('bound-websocket')) { clearTimeout(timeout); resolve(); } }); });
  assert.match(bytes, /101 Switching Protocols/);
  const closed = new Promise(resolve => socket.once('close', resolve)); f.proxy.disconnect(); await closed;
});


test('real incoming upload reserves the network before disk awaits and cancellation allows switching', async t => {
  const manager = await fixture(t), group = await manager.createGroup('上传锁');
  const request = http.request(group.baseUrl + '/api/files?name=slow.bin', { method: 'POST', headers: { 'X-Room-Key': group.key, 'X-Device-Id': manager.device.id, 'Content-Length': 1024 } });
  request.on('error', () => {}); request.write('first');
  try {
    for (let i = 0; i < 100 && !manager.getNetwork().transferBusy; i++) await sleep(5);
    assert.equal(manager.getNetwork().transferBusy, true);
    await assert.rejects(manager.setNetwork({ mode: 'manual', id: vpn.id }), /文件正在传输/);
  } finally { request.destroy(); }
  for (let i = 0; i < 100 && manager.getNetwork().transferBusy; i++) await sleep(5);
  assert.equal(manager.getNetwork().transferBusy, false);
  await manager.setNetwork({ mode: 'manual', id: vpn.id }); assert.equal(manager.getNetwork().selected.name, 'vpn');
});

test('proxy survives aborted upstream HTTP bodies, releases leases, and closes abrupt WS peers', async t => {
  const f = await proxyFixture(t);
  await new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port: Number(f.proxy.address.split(':')[1]), path: f.baseUrl + '/api/files/abort' }, res => { res.on('aborted', resolve); res.on('error', resolve); res.resume(); });
    request.on('error', resolve);
  });
  await sleep(20); assert.equal(f.leases(), 0); assert.equal((await viaProxy(f.proxy, f.baseUrl + '/api/state')).status, 200);
  const socket = net.connect(Number(f.proxy.address.split(':')[1]), '127.0.0.1'); socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`GET ${f.baseUrl.replace('http:', 'ws:')}/api/events HTTP/1.1\r\nHost: ${new URL(f.baseUrl).host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  await new Promise(resolve => socket.once('data', resolve));
  const closed = new Promise(resolve => socket.once('close', resolve)); for (const ws of f.wss.clients) ws.terminate(); await closed;
});

test('CONNECT forwards only a known origin and closes when the upstream disconnects', async t => {
  const f = await proxyFixture(t), socket = net.connect(Number(f.proxy.address.split(':')[1]), '127.0.0.1'); socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`CONNECT ${new URL(f.baseUrl).host} HTTP/1.1\r\nHost: ${new URL(f.baseUrl).host}\r\n\r\n`);
  const response = await new Promise(resolve => socket.once('data', data => resolve(data.toString()))); assert.match(response, /200 Connection Established/);
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(`GET /api/files/abort HTTP/1.1\r\nHost: ${new URL(f.baseUrl).host}\r\n\r\n`); socket.resume(); await closed; assert.equal(f.seenAddress(), f.address);
});


test('desktop native downloads abort on adapter loss and release leases without waiting for the socket timeout', async t => {
  const manager = await fixture(t), scope = createNetworkTransferScope();
  const upstream = http.createServer((_req, res) => { res.writeHead(200); res.write('partial file'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const lease = manager.acquireTransfer(), operation = scope.begin();
  const response = await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${upstream.address().port}/large-file`, { signal: operation.signal, timeout: 3600000 }, resolve); request.on('error', reject);
  });
  const transfer = pipeline(response, new Writable({ write(_chunk, _encoding, done) { done(); } }), { signal: operation.signal }).finally(() => { operation.release(); lease(); });
  const rejected = assert.rejects(transfer, error => error.name === 'AbortError' || error.code === 'ECONNRESET');
  scope.networkChanged({ available: true, switching: false }); assert.equal(operation.signal.aborted, false);
  assert.equal(manager.getNetwork().transferBusy, true);
  scope.networkChanged({ available: false, switching: true }); await rejected;
  assert.equal(scope.size, 0); assert.equal(manager.getNetwork().transferBusy, false);
  await manager.setNetwork({ mode: 'manual', id: vpn.id });
  assert.equal(manager.getNetwork().selected.name, 'vpn');
});
