import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createInboxServer } from '../server/index.js';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createGroupManager } from '../server/groups.js';
import { recoverNetwork } from '../server/network.js';
import { createDiscoveryDirectory, directoryHosts, normalizeDirectory, probeDirectory, scanDirectories } from '../server/discovery-directory.js';

const adapter = (address = '127.0.0.1') => ({ id: `wifi:${address}`, name: 'wifi', interfaceName: 'wifi', address, netmask: '255.255.255.0', type: 'wifi', virtual: false });
const quiet = async () => ({ list: () => [], refresh() {}, async close() {} });
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-lan-recovery-')), managers = [];
  const create = async (name, extra = {}) => {
    const manager = await createGroupManager({ dataDir: path.join(dir, name), device: { id: randomUUID(), name, kind: 'desktop' }, listInterfaces: async () => [adapter()], discoveryFactory: quiet, monitorIntervalMs: 600000, networkPollMs: 600000, ...extra });
    managers.push(manager); return manager;
  };
  t.after(async () => { await Promise.all(managers.map(manager => manager.close())); await rm(dir, { recursive: true, force: true }); });
  return { create, dir };
}
async function join(host, peer, group) {
  const invite = await host.createInvite(group.id), ticket = await peer.joinAt(group.baseUrl, invite.code);
  await host.respondJoin(group.id, ticket.requestId, true); return (await peer.checkJoin(ticket)).group;
}

test('automatic network follows DHCP and survives restart; VPN-only remains offline', async t => {
  const live = Object.values(os.networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4');
  if (!live) return t.skip('No second IPv4 interface for a real rebind');
  const nextAddress = live.address;
  const { create } = await fixture(t); let links = [adapter()];
  let manager = await create('host', { listInterfaces: async () => links });
  const group = await manager.createGroup('恢复测试');
  await manager.authenticated(group.id, '/api/messages', { method: 'POST', body: { text: '保留历史' } });
  links = [adapter(nextAddress)]; await manager.refreshNetwork();
  assert.equal(manager.getNetwork().available, true); assert.equal(manager.getNetwork().selected.address, nextAddress);
  assert.equal((await manager.authenticated(group.id, '/api/state')).messages[0].text, '保留历史');
  await manager.close(); manager = await create('host', { listInterfaces: async () => links });
  assert.equal(manager.getNetwork().available, true); assert.equal(manager.listGroups()[0].key, group.key);
  links = [{ ...adapter('127.0.0.3'), name: 'vpn', virtual: true, type: 'vpn' }]; await manager.refreshNetwork();
  assert.equal(manager.getNetwork().available, false); assert.equal(manager.getNetwork().selected, null);
  links = [adapter(nextAddress)]; await manager.refreshNetwork(); assert.equal(manager.getNetwork().available, true);
  assert.equal(recoverNetwork(links, { mode: 'manual', interfaceName: 'wifi', address: '127.0.0.1' }, adapter()).address, '127.0.0.1');
});

test('directory recovers a joined group after occupied old port without multicast or new approval', async t => {
  const { create } = await fixture(t); let host = await create('host', { host: '127.0.0.1' });
  const peer = await create('peer', { host: '127.0.0.1' }), group = await host.createGroup('端口恢复');
  const joined = await join(host, peer, group); assert.notEqual(joined.key, group.key);
  await host.close();
  const occupied = http.createServer((_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise(resolve => occupied.listen(Number(new URL(group.baseUrl).port), '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { occupied.close(resolve); occupied.closeAllConnections(); }));
  host = await create('host', { host: '127.0.0.1' });
  assert.notEqual(host.listGroups()[0].baseUrl, group.baseUrl);
  const recovered = await peer.resolveGroup(group.id);
  assert.equal(recovered.online, true); assert.equal(recovered.key, joined.key); assert.equal(recovered.baseUrl, host.listGroups()[0].baseUrl);
  const message = await peer.authenticated(group.id, '/api/messages', { method: 'POST', body: { text: '无需扫码' } });
  assert.equal(message.text, '无需扫码');
  assert.equal(host.getHostedInbox(group.id).state().devices.length, 2);
});

test('directory exposes only public hints and bounds scans to current subnet with cancellation', async t => {
  const entry = { groupId: randomUUID(), hostDeviceId: randomUUID(), name: '群', port: 48888, key: 'secret', code: '123456' };
  const directory = await createDiscoveryDirectory({ address: '127.0.0.1', port: 0, getAnnouncements: () => [entry] });
  t.after(() => directory.close());
  const body = await (await fetch(`http://127.0.0.1:${directory.port}/api/discovery/groups`)).json();
  assert.equal(JSON.stringify(body).includes('secret'), false); assert.equal(JSON.stringify(body).includes('123456'), false);
  const records = await probeDirectory('127.0.0.1', { port: directory.port }); assert.equal(records[0].baseUrl, 'http://127.0.0.1:48888');
  assert.deepEqual(normalizeDirectory({ ...body, groups: [{ ...entry, port: 70000 }] }, '192.168.1.9'), []);
  const network = { address: '192.168.2.9', netmask: '255.255.0.0' };
  const hosts = directoryHosts(network); assert.ok(hosts.length <= 256); assert.ok(hosts.every(address => address.startsWith('192.168.2.')));
  assert.deepEqual(directoryHosts({ address: '8.8.8.8', netmask: '255.255.255.0' }), []);
  const narrow = directoryHosts({ address: '10.0.0.5', netmask: '255.255.255.248' }); assert.deepEqual(narrow, ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.6']);
  let active = 0, maximum = 0, count = 0; const controller = new AbortController();
  await scanDirectories(network, { signal: controller.signal, probe: async () => { active++; maximum = Math.max(maximum, active); count++; await new Promise(resolve => setTimeout(resolve, 1)); active--; controller.abort(); return []; } });
  assert.ok(maximum <= 16); assert.ok(count <= 16);
});

test('host removal cannot be bypassed and peer forget preserves other groups', async t => {
  const { create } = await fixture(t), host = await create('host'), peer = await create('peer');
  const first = await host.createGroup('第一群'), second = await host.createGroup('第二群');
  const joined = await join(host, peer, first); await join(host, peer, second);
  await host.removeMember(first.id, peer.device.id);
  const rejected = await fetch(joined.baseUrl + '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Room-Key': joined.key, 'X-Device-Id': peer.device.id }, body: JSON.stringify(peer.device) });
  assert.equal(rejected.status, 401);
  await peer.forgetGroup(first.id); assert.deepEqual(peer.listGroups().map(group => group.id), [second.id]);
  await assert.rejects(host.leaveGroup(first.id), error => error.status === 409);
  await peer.leaveGroup(second.id); assert.equal(peer.listGroups().length, 0); assert.equal(host.getHostedInbox(second.id).state().devices.length, 1);
});

async function legacyManager(t, setup) {
  const device = { id: randomUUID(), name: 'legacy-host', kind: 'desktop' };
  const group = { id: randomUUID(), name: 'Legacy', hostDeviceId: device.id, authVersion: 1, local: true };
  const dataDir = path.join(setup.dir, 'legacy');
  const inbox = await createInboxServer({ dataDir: path.join(dataDir, 'groups', group.id), host: '127.0.0.1', group });
  group.key = await inbox.ensureHostDevice(device); group.baseUrl = inbox.baseUrl;
  await inbox.close();
  await fs.writeFile(path.join(dataDir, 'groups.json'), JSON.stringify({ version: 1, device, groups: [group] }));
  return { manager: await setup.create('legacy'), group };
}

test('legacy credential upgrade and network rebind serialize without losing the new token', async t => {
  const setup = await fixture(t), { manager, group } = await legacyManager(t, setup);
  const inbox = manager.getHostedInbox(group.id), secure = inbox.secureMembers.bind(inbox), close = inbox.close.bind(inbox);
  let entered, release, closed = false;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  inbox.secureMembers = async () => { entered(); await gate; return secure(); };
  inbox.close = async (...args) => { closed = true; return close(...args); };
  const upgrading = manager.secureMembers(group.id); await started;
  const rebinding = manager.setNetwork({ mode: 'manual', id: adapter().id });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false, 'Rebind closed an inbox with migration in progress');
  release(); const upgraded = await upgrading; await rebinding;
  assert.equal(upgraded.authVersion, 2); assert.notEqual(upgraded.key, group.key);
  const current = manager.listGroups()[0]; assert.equal(current.key, upgraded.key); assert.equal(current.authVersion, 2);
  assert.equal((await manager.authenticated(group.id, '/api/state')).authVersion, 2);
  await manager.close(); const restored = await setup.create('legacy');
  assert.equal(restored.listGroups()[0].key, upgraded.key);
});

test('an upgraded inbox survives groups snapshot failure and startup repairs its token metadata', async t => {
  const setup = await fixture(t), { manager, group } = await legacyManager(t, setup);
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === path.join(setup.dir, 'legacy', 'groups.json')) throw Object.assign(new Error('snapshot ENOSPC'), { code: 'ENOSPC' });
    return rename(source, destination);
  };
  try { await assert.rejects(manager.secureMembers(group.id), error => error.status === 500); }
  finally { fs.rename = rename; }
  const current = manager.listGroups()[0]; assert.equal(current.authVersion, 2); assert.notEqual(current.key, group.key);
  assert.equal((await manager.authenticated(group.id, '/api/state')).authVersion, 2);
  const stale = JSON.parse(await fs.readFile(path.join(setup.dir, 'legacy', 'groups.json'), 'utf8'));
  assert.equal(stale.groups[0].authVersion, 1);
  await assert.rejects(manager.close(), /snapshot ENOSPC/);
  const restored = await setup.create('legacy');
  assert.equal(restored.listGroups()[0].key, current.key); assert.equal(restored.listGroups()[0].authVersion, 2);
  assert.equal((await restored.authenticated(group.id, '/api/state')).authVersion, 2);
});

test('concurrent joined-group resolution shares one authenticated probe', async t => {
  const { create } = await fixture(t), host = await create('host');
  let probes = 0, gate = null;
  const peer = await create('peer', { fetchImpl: async (url, options) => {
    if (url.endsWith('/api/group/probe')) { probes++; if (gate) await gate; }
    return fetch(url, options);
  } });
  const group = await host.createGroup('single flight'); await join(host, peer, group); probes = 0;
  let release; gate = new Promise(resolve => { release = resolve; });
  const resolutions = Array.from({ length: 8 }, () => peer.resolveGroup(group.id));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(probes, 1);
  release(); const resolved = await Promise.all(resolutions); assert.equal(probes, 1); assert.ok(resolved.every(value => value.online));
});

test('directory scanner includes all four ports and own announcements do not suppress fallback', async t => {
  const ports = new Set(), found = [], entry = { groupId: randomUUID(), hostDeviceId: randomUUID(), baseUrl: 'http://10.0.0.2:49000' };
  await scanDirectories({ address: '10.0.0.1', netmask: '255.255.255.252' }, { probe: async (_address, options) => {
    ports.add(options.port); return options.port === 47324 ? [entry] : [];
  }, onRecord: record => found.push(record) });
  assert.deepEqual([...ports], [47321, 47322, 47323, 47324]); assert.deepEqual(found, [entry]);
  const live = Object.values(os.networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4' && /^(10\.|192\.168\.|172\.)/.test(item.address));
  if (!live) return;
  const { create } = await fixture(t);
  const manager = await create('self-advertisement', { listInterfaces: async () => [{ ...adapter(live.address), netmask: '255.255.255.252' }], discoveryFactory: async options => ({ list: () => options.getAnnouncements().map(value => ({ ...value, baseUrl: `http://${live.address}:${value.port}`, seenAt: Date.now(), transport: 'mdns' })), refresh() {}, async close() {} }) });
  await manager.createGroup('local announcement');
  const get = http.get, requests = [];
  http.get = options => { requests.push(options); const request = new EventEmitter(); request.destroy = () => {}; queueMicrotask(() => request.emit('error', new Error('no directory'))); return request; };
  try {
    assert.ok(manager.listNearby().length > 0, 'Fixture must contain its own service');
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { http.get = get; }
  assert.ok(requests.length > 0, 'Own announcements suppressed the subnet fallback');
  assert.deepEqual([...new Set(requests.map(value => value.port))], [47321, 47322, 47323, 47324]);
});
