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
    async host(name = '设计小组', authVersion) {
      const group = { id: randomUUID(), name, hostDeviceId: randomUUID(), ...(authVersion ? { authVersion } : {}) };
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


test('a saved mobile group reconnects to a restarted real host endpoint without pairing again', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-mobile-resolver-'));
  const metadata = { id: randomUUID(), name: '恢复群', hostDeviceId: randomUUID() };
  let inbox = await createInboxServer({ dataDir: dir, host: '127.0.0.1', group: metadata });
  let spoofedOrigin; const errors = [];
  const mobile = createMobileClient({ storage: memory(), randomUUID, WebSocketImpl: WebSocket, reconnectMs: 20, requestTimeoutMs: 500, fetchImpl: async (url, options) => {
    if (spoofedOrigin && String(url) === spoofedOrigin + '/api/group/probe') return new Response(JSON.stringify({ error: '设备授权已失效，请重新申请加入' }), { status: 401 });
    return fetch(url, options);
  } });
  t.after(async () => { mobile.close(); await inbox.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await mobile.init();
  const group = await pair(mobile, { inbox, group: metadata, baseUrl: inbox.baseUrl });
  let online = false, lastState;
  mobile.watchGroup(group.id, { onStatus: status => { online = status === 'online'; }, onState: state => { lastState = state; }, onError: error => errors.push(error) });
  await until(() => online);
  const deviceId = mobile.device.id, key = group.key, oldUrl = inbox.baseUrl;
  await inbox.close(); spoofedOrigin = oldUrl; await until(() => !online);
  await until(() => errors.some(error => error.phase === 'probe' && error.status === 401));
  assert.equal(mobile.getGroup(group.id).key, key, 'untrusted probe errors must not erase credentials or stop recovery');
  inbox = await createInboxServer({ dataDir: dir, host: '127.0.0.1', group: metadata });
  assert.notEqual(inbox.baseUrl, oldUrl);
  mobile.updateDiscovery([{ groupId: group.id, hostDeviceId: group.hostDeviceId, baseUrl: inbox.baseUrl }]);
  await until(() => online && mobile.getGroup(group.id).baseUrl === inbox.baseUrl);
  assert.equal(mobile.device.id, deviceId); assert.equal(mobile.getGroup(group.id).key, key);
  await mobile.api(group.id, '/api/messages', { method: 'POST', body: { text: '自动恢复成功' } });
  await until(() => lastState.messages.some(message => message.text === '自动恢复成功'));
});


test('mobile v2 device credentials survive restart and leaving revokes only the caller', async t => {
  const env = await setup(t), host = await env.host('安全群', 2), storage = memory();
  await host.inbox.ensureHostDevice({ id: host.group.hostDeviceId, name: '主机', kind: 'desktop' });
  const first = await env.mobile(storage), second = await env.mobile();
  const a = await pair(first, host), b = await pair(second, host);
  assert.equal(a.authVersion, 2); assert.notEqual(a.key, b.key);
  const restored = await env.mobile(storage);
  assert.equal(restored.getGroup(a.id).authVersion, 2);
  await restored.api(a.id, '/api/state');
  await assert.rejects(restored.removeMember(a.id, second.device.id), error => error.status === 403);
  let connectionStatus, revokedError;
  const watch = restored.watchGroup(a.id, { onStatus: value => { connectionStatus = value; }, onError: error => { revokedError = error; } });
  await until(() => connectionStatus === 'online');
  await restored.leaveGroup(a.id);
  await until(() => revokedError?.status === 401);
  watch.setActive(false); watch.setActive(true); await pause(50);
  assert.equal(connectionStatus, 'offline', 'revoked watches must not resume automatic retries on foreground');
  await assert.rejects(restored.api(a.id, '/api/state'), error => error.status === 401 || error.status === 403);
  await second.api(b.id, '/api/state');
  assert.equal(restored.listGroups().length, 1, 'revocation must not silently erase saved groups or drafts');
});

test('an API request never sends newly paired credentials to an endpoint proved with the old credentials', async t => {
  const env = await setup(t), host = await env.host(), calls = [];
  let hold, release, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const mobile = await env.mobile(memory(), { fetchImpl: async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    const response = await fetch(url, options);
    if (hold && String(url) === host.baseUrl + '/api/group/probe') {
      hold = false; entered(); await new Promise(resolve => { release = resolve; });
    }
    return response;
  } });
  const original = await pair(mobile, host);
  const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-credential-race-'));
  const clone = await createInboxServer({ dataDir: cloneDir, host: '127.0.0.1', group: host.group });
  t.after(async () => { release?.(); await clone.close(); await fs.rm(cloneDir, { recursive: true, force: true }); });
  hold = true;
  const api = mobile.api(original.id, '/api/state');
  const rejected = assert.rejects(api, error => error.status === 409);
  await blocked;
  const updated = await pair(mobile, { inbox: clone, group: host.group, baseUrl: clone.baseUrl });
  assert.notEqual(updated.key, original.key);
  release(); await rejected;
  assert.ok(!calls.some(call => call.url === host.baseUrl + '/api/state' && call.headers['X-Room-Key'] === updated.key));
});


test('paired QR updates a changed address without consuming invitations or replacing authorization', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-mobile-qr-'));
  const metadata = { id: randomUUID(), name: '已配对群', hostDeviceId: randomUUID(), authVersion: 2 };
  let inbox = await createInboxServer({ dataDir: dir, host: '127.0.0.1', group: metadata });
  const storage = memory(), requests = [];
  const mobile = createMobileClient({ storage, randomUUID, fetchImpl: async (url, options) => { requests.push(String(url)); return fetch(url, options); } });
  t.after(async () => { mobile.close(); await inbox.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await mobile.init(); const group = await pair(mobile, { inbox, group: metadata, baseUrl: inbox.baseUrl });
  const identity = mobile.device.id; await inbox.close();
  inbox = await createInboxServer({ dataDir: dir, host: '127.0.0.1', group: metadata });
  requests.length = 0;
  const updated = await mobile.joinLink(`${inbox.baseUrl}/#invite=000000&group=${group.id}`);
  assert.deepEqual(updated, { ...group, baseUrl: inbox.baseUrl });
  assert.equal(mobile.device.id, identity);
  assert.equal(requests.some(url => url.includes('/api/pair/')), false);
  assert.deepEqual(JSON.parse(storage.data.get('pickdrop-group-v2-' + group.id)), updated);
});

test('paired QR for a replacement host never falls through to pairing or persists the hinted address', async t => {
  const env = await setup(t), host = await env.host(), storage = memory(), mobile = await env.mobile(storage);
  const group = await pair(mobile, host), previous = storage.data.get('pickdrop-group-v2-' + group.id);
  const replacement = await env.host();
  await assert.rejects(mobile.joinLink(`${replacement.baseUrl}/#invite=000000&group=${group.id}`), /身份校验失败/);
  assert.equal(storage.data.get('pickdrop-group-v2-' + group.id), previous);
  assert.equal(mobile.getGroup(group.id).key, group.key);
  assert.equal(replacement.inbox.pairing.list().length, 0);
  assert.equal(await mobile.reconnectInvite(inviteLink(replacement)), null);
});
