import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInboxServer } from '../server/index.js';
import { createMobileClient } from '../apps/mobile/src/client.js';
import { normalizeService, discoveredInvite, assertDiscoveredTicket, createDiscoveryController, usableIPv4 } from '../apps/mobile/src/discovery-core.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const groupId = randomUUID(), hostDeviceId = randomUUID();
const record = (extra = {}) => ({ serviceId: `pickdrop-${groupId}|_pickdrop._tcp.`, addresses: ['192.168.1.9'], port: 47321, txt: { protocol: 'pickdrop', version: '1', groupId, hostDeviceId, name: '项目传输群' }, ...extra });
function adapter() {
  const listeners = new Map(), saved = [], starts = [], stops = [];
  return { starts, stops, saved, get count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
    async start(id) { starts.push(id); }, async stop(id) { stops.push(id); },
    addListener(event, handler) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(handler); saved.push({ event, handler }); return { remove: () => listeners.get(event).delete(handler) }; },
    emit(event, value) { for (const handler of listeners.get(event) || []) handler(value); },
  };
}
test('discovery validates DNS-SD metadata, unicast IPv4 and strips untrusted credentials', () => {
  const input = record(); input.txt.key = 'secret'; input.txt.invite = '123456';
  const result = normalizeService(input);
  assert.equal(result.baseUrl, 'http://192.168.1.9:47321'); assert.equal(result.name, '项目传输群');
  assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('123456'));
  for (const value of ['127.0.0.1', '0.0.0.0', '224.0.0.251', '255.255.255.255', '192.168.1.999', '010.1.1.1', 'example.com', '192.168.1.5/path']) assert.equal(usableIPv4(value), false);
  for (const value of ['192.168.1.1', '10.10.20.1', '169.254.4.5', '172.20.1.2']) assert.equal(usableIPv4(value), true);
  assert.equal(normalizeService(record({ addresses: ['::1'] })), null);
  assert.equal(normalizeService(record({ port: 70000 })), null);
  assert.equal(normalizeService(record({ txt: { ...input.txt, version: '2' } })), null);
  assert.equal(normalizeService(record({ txt: { ...input.txt, hostDeviceId: 'arbitrary' } })), null);
});
test('nearby invitation pins advertised group and checks host identity before approval polling', () => {
  const found = normalizeService(record());
  assert.equal(discoveredInvite(found, '012345'), `http://192.168.1.9:47321/#invite=012345&group=${groupId}`);
  assert.throws(() => discoveredInvite(found, '12345'), /6 位邀请码/);
  assert.doesNotThrow(() => assertDiscoveredTicket(found, { groupId, hostDeviceId }));
  assert.throws(() => assertDiscoveredTicket(found, { groupId, hostDeviceId: randomUUID() }), /身份/);
  assert.throws(() => assertDiscoveredTicket(found, { groupId: randomUUID(), hostDeviceId }), /身份/);
});
test('discovery ignores late native events after stop/restart and releases every subscription', async () => {
  const native = adapter(); let session = 0;
  const controller = createDiscoveryController(native, { sessionId: () => String(++session), timeoutMs: 50 });
  await controller.start(); native.emit('onService', { ...record(), sessionId: '1' }); assert.equal(controller.getSnapshot().devices.length, 1);
  const oldCallbacks = native.saved.slice();
  await controller.start(); assert.deepEqual(native.stops, ['1']); assert.equal(native.count, 4);
  oldCallbacks.find(item => item.event === 'onService').handler({ ...record(), sessionId: '1' }); assert.equal(controller.getSnapshot().devices.length, 0);
  native.emit('onService', { ...record(), sessionId: '2' }); assert.equal(controller.getSnapshot().status, 'ready');
  native.emit('onLost', { sessionId: '2', serviceId: record().serviceId }); assert.equal(controller.getSnapshot().devices.length, 0);
  controller.stop(); assert.equal(native.count, 0); assert.equal(controller.getSnapshot().status, 'idle'); assert.deepEqual(native.stops, ['1', '2']);
  controller.dispose();
});
test('empty, unavailable and permission denied states are explicit; denial is not overwritten by timeout', async () => {
  const web = createDiscoveryController(null); await web.start(); assert.equal(web.getSnapshot().status, 'unavailable'); assert.match(web.getSnapshot().message, /浏览器/); web.dispose();
  const native = adapter(), controller = createDiscoveryController(native, { sessionId: () => 'scan', timeoutMs: 10 });
  await controller.start(); await wait(20); assert.equal(controller.getSnapshot().status, 'empty'); assert.match(controller.getSnapshot().message, /同一网络/);
  await controller.start(); native.emit('onState', { sessionId: 'scan', state: 'permission-denied', message: '允许本地网络' }); await wait(20); assert.equal(controller.getSnapshot().status, 'permission-denied'); controller.dispose();
});
test('duplicate services are merged by both group and host identity', async () => {
  const native = adapter(), controller = createDiscoveryController(native, { sessionId: () => 's' }); await controller.start();
  native.emit('onService', { ...record(), sessionId: 's' }); native.emit('onService', { ...record({ serviceId: 'other-service' }), sessionId: 's' }); assert.equal(controller.getSnapshot().devices.length, 1);
  native.emit('onService', { ...record({ serviceId: 'foreign-host', txt: { ...record().txt, hostDeviceId: randomUUID() } }), sessionId: 's' }); assert.equal(controller.getSnapshot().devices.length, 2); controller.dispose();
});
test('a pending native start rejection cannot replace a newer scan state', async () => {
  const native = adapter(); let rejectFirst, count = 0;
  native.start = () => ++count === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : Promise.resolve();
  let id = 0; const controller = createDiscoveryController(native, { sessionId: () => String(++id) });
  const first = controller.start(); await controller.start(); rejectFirst(new Error('Old scan failed')); await first;
  assert.equal(controller.getSnapshot().status, 'scanning'); controller.dispose();
});

test('saved groups can move to a discovered address only after real HMAC proof, without leaking their key', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-mobile-discovery-')), hosts = [], clients = [];
  t.after(async () => { clients.forEach(client => client.close()); await Promise.all(hosts.map(server => server.close())); await rm(dir, { recursive: true, force: true }); });
  const group = { id: randomUUID(), hostDeviceId: randomUUID(), name: 'Nearby test' };
  const first = await createInboxServer({ dataDir: dir, host: '127.0.0.1', group }); hosts.push(first);
  const memory = new Map(), storage = { getItemAsync: async key => memory.get(key) || null, setItemAsync: async (key, value) => { memory.set(key, value); } };
  const mobile = createMobileClient({ storage, randomUUID }); clients.push(mobile); await mobile.init();
  const saved = await mobile.joinLink(`http://127.0.0.1:${first.port}/#key=${first.key}`);
  // A second listener with the same persisted identity models a changed LAN address.
  const second = await createInboxServer({ dataDir: dir, host: '127.0.0.1', group }); hosts.push(second);
  const nextAddress = `http://127.0.0.1:${second.port}`;
  const updated = await mobile.reconnectAt(saved.id, nextAddress); assert.equal(updated.baseUrl, nextAddress); assert.equal(updated.key, saved.key);
  await mobile.api(saved.id, '/api/state');
  const requests = [], rejected = createMobileClient({ storage, randomUUID, fetchImpl: async (url, options) => { requests.push({ url, headers: options.headers }); return new Response(JSON.stringify({ groupId: saved.id, hostDeviceId: saved.hostDeviceId, proof: '0'.repeat(64) }), { status: 200 }); } }); clients.push(rejected); await rejected.init();
  await assert.rejects(rejected.reconnectAt(saved.id, 'http://192.168.1.200:47321'), /身份校验失败/);
  assert.equal(rejected.getGroup(saved.id).baseUrl, nextAddress); assert.equal(requests.length, 1); assert.equal(requests[0].headers['X-Room-Key'], undefined);
  assert.ok(!JSON.stringify(requests).includes(saved.key));
});
