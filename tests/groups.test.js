import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { createGroupManager } from '../server/groups.js';
import { createInboxServer } from '../server/index.js';

function network() {
  const peers = new Set();
  const factory = async ({ getAnnouncements, onRecord }) => {
    const peer = { getAnnouncements, onRecord }; peers.add(peer);
    const list = () => [...peers].flatMap(p => p.getAnnouncements().map(r => ({ ...r, baseUrl: `http://127.0.0.1:${r.port}` })));
    return { list, refresh() { for (const target of peers) for (const record of list()) target.onRecord(record); }, close() { peers.delete(peer); } };
  };
  return { factory, announce(record) { for (const peer of peers) peer.onRecord(record); } };
}
async function setup(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-groups-')), bus = network(), managers = [];
  async function manager(dir, options = {}) {
    const instance = await createGroupManager({ dataDir: path.join(root, dir), device: { id: randomUUID(), name: dir, kind: 'desktop' }, discoveryFactory: bus.factory, host: '127.0.0.1', discoveryWaitMs: 0, monitorIntervalMs: 600000, ...extra, ...options });
    managers.push(instance); return instance;
  }
  t.after(async () => { await Promise.all(managers.map(m => m.close())); await fs.rm(root, { force: true, recursive: true }); });
  return { root, bus, manager };
}
async function pair(host, guest, group) {
  const invite = await host.createInvite(group.id); assert.match(invite.code, /^\d{6}$/);
  const ticket = await guest.joinWithCode(invite.code);
  assert.equal((await guest.checkJoin(ticket)).status, 'pending');
  const requests = await host.listJoinRequests(group.id);
  assert.equal(requests.length, 1); assert.equal(requests[0].device.id, guest.device.id);
  assert.equal('pollToken' in requests[0], false);
  await host.respondJoin(group.id, ticket.requestId, true);
  return (await guest.checkJoin(ticket)).group;
}
function api(group, route, deviceId, options = {}) {
  return fetch(group.baseUrl + route, { ...options, headers: { 'X-Room-Key': group.key, 'X-Device-Id': deviceId, ...options.headers } });
}

test('independent groups isolate membership, messages, files and authorization; members may approve', async t => {
  const { manager } = await setup(t), host = await manager('host'), guest = await manager('guest'), third = await manager('third');
  const a = await host.createGroup('工作群'), b = await host.createGroup('家庭群');
  assert.notEqual(a.key, b.key); assert.notEqual(a.baseUrl, b.baseUrl);
  const joinedA = await pair(host, guest, a);
  const joinedB = await pair(host, guest, b);
  assert.equal(guest.listGroups().length, 2);
  assert.equal((await api(b, '/api/state', guest.device.id, { headers: { 'X-Room-Key': a.key } })).status, 401);
  const text = await api(joinedA, '/api/messages', guest.device.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '工作群专属消息' }) });
  assert.equal(text.status, 201);
  const bytes = randomBytes(1024 * 1024 + 3);
  const upload = await api(joinedA, '/api/files?name=真实文件.bin', guest.device.id, { method: 'POST', body: bytes });
  assert.equal(upload.status, 201); const file = await upload.json();
  assert.deepEqual(Buffer.from(await (await api(joinedA, '/api/files/' + file.id, guest.device.id)).arrayBuffer()), bytes);
  assert.equal((await api(joinedB, '/api/files/' + file.id, guest.device.id)).status, 404);
  assert.equal((await (await api(joinedB, '/api/state', guest.device.id)).json()).messages.length, 0);
  await pair(guest, third, joinedA); // A remote member can invite AND approve.
  assert.equal(host.getHostedInbox(a.id).state().devices.length, 3);
  assert.equal(host.getHostedInbox(b.id).state().devices.length, 2);
  assert.equal(guest.getHostedInbox(a.id), null);
});

test('short codes are single-use; approval secrets, denial, expiry and rate limits are enforced', async t => {
  let now = Date.now();
  const { manager } = await setup(t, { pairingOptions: { now: () => now } });
  const host = await manager('host'), guest = await manager('guest'), group = await host.createGroup('测试群');
  const invite = await host.createInvite(group.id), ticket = await guest.joinWithCode(invite.code);
  assert.equal(ticket.key, undefined);
  assert.equal((await fetch(group.baseUrl + '/api/state')).status, 401);
  assert.equal((await fetch(group.baseUrl + `/api/pair/status/${ticket.requestId}`, { headers: { 'X-Poll-Token': randomBytes(32).toString('hex') } })).status, 404);
  await assert.rejects(guest.joinWithCode(invite.code), e => e.status === 404);
  await host.respondJoin(group.id, ticket.requestId, false);
  assert.deepEqual(await guest.checkJoin(ticket), { status: 'denied' });
  assert.equal(guest.listGroups().length, 0);
  const next = await host.createInvite(group.id), pending = await guest.joinWithCode(next.code);
  now += 300001;
  assert.deepEqual(await guest.checkJoin(pending), { status: 'expired' });
  await assert.rejects(host.respondJoin(group.id, pending.requestId, true), e => e.status === 410);
  const expired = await host.createInvite(group.id); now += 300001;
  await assert.rejects(guest.joinWithCode(expired.code), e => e.status === 404);
  for (let index = 0; index < 10; index++) await fetch(group.baseUrl + '/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'invalid', device: guest.device }) });
  const response = await fetch(group.baseUrl + '/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '000000', device: guest.device }) });
  assert.equal(response.status, 429);
});

test('groups and device identity survive restart; discovery recovers new addresses and rejects impostors', async t => {
  const { manager, bus, root } = await setup(t);
  let host = await manager('host'), guest = await manager('guest');
  const group = await host.createGroup('长期群'), hostId = host.device.id, guestId = guest.device.id;
  await pair(host, guest, group);
  await api(group, '/api/messages', guestId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '重启保留' }) });
  await host.close();
  assert.equal((await guest.resolveGroup(group.id)).online, false);
  host = await manager('host');
  const restarted = host.listGroups()[0]; assert.equal(restarted.id, group.id); assert.equal(restarted.key, group.key); assert.equal(host.device.id, hostId);
  assert.equal(host.getHostedInbox(group.id).state().messages[0].text, '重启保留');
  const resolved = await guest.resolveGroup(group.id);
  assert.equal(resolved.baseUrl, restarted.baseUrl); assert.equal(resolved.online, true);
  const fake = await createInboxServer({ dataDir: path.join(root, 'impostor'), host: '127.0.0.1', group: { id: group.id, name: group.name, hostDeviceId: hostId } });
  t.after(() => fake.close());
  bus.announce({ groupId: group.id, hostDeviceId: hostId, baseUrl: fake.baseUrl });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(guest.listGroups()[0].baseUrl, restarted.baseUrl);
  await guest.close(); guest = await manager('guest');
  assert.equal(guest.device.id, guestId); assert.equal(guest.listGroups()[0].key, group.key);
  assert.equal((await guest.resolveGroup(group.id)).online, true);
});

test('legacy inbox migration preserves original files and key without deleting the source', async t => {
  const { root, manager } = await setup(t);
  const legacy = await createInboxServer({ dataDir: path.join(root, 'legacy', 'inbox'), host: '127.0.0.1' });
  const originalKey = legacy.key, id = randomUUID(); await legacy.registerDevice({ id, name: '旧设备', kind: 'desktop' });
  const response = await api(legacy, '/api/files?name=legacy.txt', id, { method: 'POST', body: 'old bytes' });
  const file = await response.json(); await legacy.close();
  const migrated = await manager('legacy'), group = migrated.listGroups()[0];
  assert.equal(group.key, originalKey); assert.equal(await fs.readFile(migrated.getHostedInbox(group.id).fileFor(file.id).path, 'utf8'), 'old bytes');
  assert.equal(await fs.readFile(path.join(root, 'legacy', 'inbox', 'room-key'), 'utf8'), originalKey);
});
