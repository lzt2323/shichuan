import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createInboxServer } from '../server/index.js';
import { createMobileClient, parseInviteLink } from '../apps/mobile/src/client.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 3500;
  while (!predicate()) { if (Date.now() > end) throw new Error('Condition did not arrive'); await pause(15); }
}
function memory() {
  const data = new Map();
  return { data, getItemAsync: async key => data.get(key) || null, setItemAsync: async (key, value) => { data.set(key, value); }, deleteItemAsync: async key => { data.delete(key); } };
}
async function setup(t, pairingOptions = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-mobile-')), inboxes = [], clients = [];
  t.after(async () => { clients.forEach(client => client.close()); await Promise.all(inboxes.map(inbox => inbox.close())); await fs.rm(dir, { recursive: true, force: true }); });
  return {
    async host(name = '设计小组') {
      const group = { id: randomUUID(), name, hostDeviceId: randomUUID() };
      const inbox = await createInboxServer({ dataDir: path.join(dir, group.id), host: '127.0.0.1', group, pairingOptions });
      inboxes.push(inbox); return { inbox, group, baseUrl: `http://127.0.0.1:${inbox.port}` };
    },
    async mobile(storage = memory(), extra = {}) {
      const client = createMobileClient({ storage, randomUUID, deviceName: '小林的手机', kind: 'ios', WebSocketImpl: WebSocket, reconnectMs: 20, ...extra });
      clients.push(client); await client.init(); return client;
    },
  };
}
const inviteLink = host => `${host.baseUrl}/#invite=${host.inbox.pairing.invite().code}&group=${host.group.id}`;
async function pair(client, host) {
  const ticket = await client.requestJoin(inviteLink(host));
  assert.equal((await client.checkJoin(ticket)).status, 'pending');
  await host.inbox.pairing.respond(ticket.requestId, true);
  return (await client.checkJoin(ticket)).group;
}

test('mobile identity persists before joining, two groups stay isolated across restart, members can approve', async t => {
  const env = await setup(t), a = await env.host('工作群'), b = await env.host('家庭群'), storage = memory();
  const mobile = await env.mobile(storage), id = mobile.device.id;
  assert.ok(storage.data.has('pickdrop-session-v2'));
  const ga = await pair(mobile, a), gb = await pair(mobile, b);
  assert.equal(mobile.getSession().activeGroupId, gb.id);
  await mobile.api(ga.id, '/api/messages', { method: 'POST', body: { text: '只有工作群能看到' } });
  assert.equal((await mobile.api(gb.id, '/api/state')).messages.length, 0);
  const restarted = await env.mobile(storage);
  assert.equal(restarted.device.id, id); assert.equal(restarted.listGroups().length, 2);
  assert.equal(restarted.getSession().activeGroupId, gb.id);
  const guest = await env.mobile();
  const invite = await restarted.createInvite(ga.id);
  assert.ok(invite.link.includes('#invite=')); assert.ok(!invite.link.includes(ga.key));
  const ticket = await guest.requestJoinAt(a.baseUrl, invite.code);
  const requests = await restarted.listJoinRequests(ga.id);
  assert.equal(requests[0].device.id, guest.device.id);
  await restarted.respondJoin(ga.id, ticket.requestId, true);
  const joined = await guest.waitForJoin(ticket, { intervalMs: 1 });
  assert.equal(joined.id, ga.id);
  await restarted.rename('小林的新手机');
  assert.equal((await restarted.api(ga.id, '/api/state')).devices.find(d => d.id === id).name, '小林的新手机');
  await restarted.removeGroup(gb.id);
  assert.equal(restarted.listGroups().length, 1);
  assert.equal(storage.data.has('pickdrop-group-v2-' + gb.id), false);
});

test('legacy single-group storage migrates offline without losing identity or its source; old links deduplicate', async t => {
  const env = await setup(t), host = await env.host(), storage = memory(), device = { id: randomUUID(), name: '旧手机', kind: 'android' };
  const source = JSON.stringify({ room: { baseUrl: host.baseUrl, key: host.inbox.key }, device });
  storage.data.set('pickdrop-connection-v1', source);
  const mobile = await env.mobile(storage);
  assert.equal(mobile.device.id, device.id); assert.equal(storage.data.get('pickdrop-connection-v1'), source);
  const migrated = mobile.listGroups()[0]; assert.equal(migrated.legacy, true);
  await mobile.api(migrated.id, '/api/join', { method: 'POST', body: mobile.device });
  const invite = await mobile.createInvite(migrated.id);
  assert.equal(invite.groupId, host.group.id);
  const group = await mobile.joinLink(`${host.baseUrl}/#key=${host.inbox.key}`);
  assert.equal(group.id, host.group.id); assert.equal(mobile.listGroups().length, 1);
  assert.equal((await env.mobile(storage)).device.id, device.id);
});

test('denied, expired and cancelled requests never add a group, and codes cannot be reused', async t => {
  let now = Date.now();
  const env = await setup(t, { now: () => now, ttl: 60000 }), host = await env.host(), mobile = await env.mobile();
  const link = inviteLink(host), denied = await mobile.requestJoin(link);
  await assert.rejects(mobile.requestJoin(link), /无效或已过期/);
  await host.inbox.pairing.respond(denied.requestId, false);
  await assert.rejects(mobile.waitForJoin(denied), /被拒绝/);
  const expired = await mobile.requestJoin(inviteLink(host)); now += 60001;
  await assert.rejects(mobile.waitForJoin(expired), /已过期/);
  const controller = new AbortController();
  await assert.rejects(mobile.joinLink(inviteLink(host), { signal: controller.signal, onStatus: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(mobile.listGroups().length, 0);
});

test('approved credentials survive a storage retry, concurrent joins do not overwrite one another', async t => {
  const env = await setup(t), a = await env.host('A'), b = await env.host('B'), storage = memory(), mobile = await env.mobile(storage);
  const ta = await mobile.requestJoin(inviteLink(a)), tb = await mobile.requestJoin(inviteLink(b));
  await a.inbox.pairing.respond(ta.requestId, true); await b.inbox.pairing.respond(tb.requestId, true);
  const set = storage.setItemAsync; let fail = true;
  storage.setItemAsync = async (key, value) => { if (key === 'pickdrop-session-v2' && fail) { fail = false; throw new Error('Keychain unavailable'); } return set(key, value); };
  await assert.rejects(mobile.checkJoin(ta), /Keychain unavailable/);
  assert.equal(mobile.listGroups().length, 0);
  await Promise.all([mobile.checkJoin(ta), mobile.checkJoin(tb)]);
  assert.equal(mobile.listGroups().length, 2);
  assert.equal((await env.mobile(storage)).listGroups().length, 2);
});

test('real WebSocket updates reconnect after AppState pause and foreground, and stop after close', async t => {
  const env = await setup(t), host = await env.host(), mobile = await env.mobile(), group = await pair(mobile, host);
  let state, status;
  const watch = mobile.watchGroup(group.id, { onState: value => { state = value; }, onStatus: value => { status = value; } });
  await until(() => status === 'online');
  await mobile.api(group.id, '/api/messages', { method: 'POST', body: { text: '实时消息' } });
  await until(() => state?.messages.length === 1);
  watch.setActive(false); assert.equal(status, 'paused');
  await until(() => !host.inbox.state().devices.find(d => d.id === mobile.device.id).online);
  await mobile.api(group.id, '/api/messages', { method: 'POST', body: { text: '后台的新消息' } });
  watch.setActive(true); await until(() => status === 'online' && state?.messages.length === 2);
  watch.close();
  await until(() => !host.inbox.state().devices.find(d => d.id === mobile.device.id).online);
  await pause(80); assert.equal(host.inbox.state().devices.find(d => d.id === mobile.device.id).online, false);
});

test('host proof failure never sends saved credentials to a replacement server', async t => {
  const env = await setup(t), host = await env.host(), storage = memory(), mobile = await env.mobile(storage), group = await pair(mobile, host);
  const requests = [];
  const replaced = await env.mobile(storage, { fetchImpl: async (url, options) => {
    requests.push({ url, headers: options.headers });
    return new Response(JSON.stringify({ groupId: group.id, hostDeviceId: group.hostDeviceId, proof: '0'.repeat(64) }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(replaced.api(group.id, '/api/state'), /身份校验失败/);
  assert.equal(requests.length, 1); assert.equal(requests[0].headers['X-Room-Key'], undefined);
  const bad = `${host.baseUrl}/#invite=${host.inbox.pairing.invite().code}&group=${randomUUID()}`;
  await assert.rejects(mobile.requestJoin(bad), /不匹配/);
});

test('timeouts and early cancellation are reported without orphan reconnects', async t => {
  const env = await setup(t), host = await env.host(), storage = memory(), mobile = await env.mobile(storage), group = await pair(mobile, host);
  const hanging = await env.mobile(storage, { requestTimeoutMs: 15, fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true })) });
  await assert.rejects(hanging.api(group.id, '/api/state'), /连接超时/);
  let failures = 0; const watch = hanging.watchGroup(group.id, { onError: () => { failures++; } });
  watch.setActive(false); await pause(60); assert.equal(failures, 0); watch.close();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mobile.api(group.id, '/api/state', { signal: controller.signal }), { name: 'AbortError' });
});

test('invitation parser accepts complete or host-plus-code links and rejects malformed credentials', () => {
  assert.deepEqual(parseInviteLink('http://192.168.1.5:1234/#invite=012345'), { baseUrl: 'http://192.168.1.5:1234', code: '012345', legacy: false });
  assert.throws(() => parseInviteLink('http://user:pass@localhost/#invite=123456'), /HTTP/);
  assert.throws(() => parseInviteLink('http://localhost/#invite=123456&group=garbage'), /不完整/);
  assert.throws(() => parseInviteLink('123456'), /完整邀请链接/);
});


test('a stalled WebSocket handshake times out and retries; closing cancels the retry loop', async t => {
  const env = await setup(t), host = await env.host(), storage = memory(), initial = await env.mobile(storage), group = await pair(initial, host);
  let opened = 0, closed = 0, errors = 0;
  class StalledSocket { constructor() { opened++; } close() { closed++; } }
  const mobile = await env.mobile(storage, { WebSocketImpl: StalledSocket, requestTimeoutMs: 25, reconnectMs: 10 });
  const watch = mobile.watchGroup(group.id, { onError: () => { errors++; } });
  await until(() => opened >= 2);
  assert.ok(closed >= 1); assert.ok(errors >= 1);
  watch.close(); const count = opened;
  await pause(90); assert.equal(opened, count);
});


test('approval polling keeps its consumed invitation through temporary network loss and remains cancellable', async t => {
  const env = await setup(t), host = await env.host();
  let failPoll = true, polls = 0;
  const mobile = await env.mobile(memory(), { fetchImpl: (url, options) => {
    if (url.includes('/api/pair/status/')) { polls++; if (failPoll) { failPoll = false; throw new TypeError('Network request failed'); } }
    return fetch(url, options);
  } });
  const ticket = await mobile.requestJoin(inviteLink(host)); await host.inbox.pairing.respond(ticket.requestId, true);
  const group = await mobile.waitForJoin(ticket, { intervalMs: 1 });
  assert.equal(group.id, host.group.id); assert.equal(polls, 2);
  failPoll = true; const another = await mobile.requestJoin(inviteLink(host)), controller = new AbortController();
  await assert.rejects(mobile.waitForJoin(another, { intervalMs: 1, signal: controller.signal, onStatus: () => controller.abort() }), { name: 'AbortError' });
});
