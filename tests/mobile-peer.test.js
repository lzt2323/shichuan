import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGroupManager } from '../server/groups.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createMobileClient } from '../apps/mobile/src/client.js';

const memory = () => { const values = new Map(); return { values, async getItemAsync(key) { return values.get(key) || null; }, async setItemAsync(key, value) { values.set(key, value); }, async deleteItemAsync(key) { values.delete(key); } }; };
async function phone(t, name, saved = {}) {
  const storage = saved.storage || memory(), records = saved.records || memory(), blobs = saved.blobs || new Map();
  let server, baseUrl;
  const transport = {
    async start(handler) {
      if (!server) {
        server = http.createServer(async (req, res) => {
          try {
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            const value = await handler({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
            if (value.file) { const bytes = blobs.get(value.file); res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); }
            else { res.writeHead(value.status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value.body)); }
          } catch (error) { res.writeHead(error.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
      }
      return { baseUrl, port: server.address().port };
    },
    async stop() { if (server) { const previous = server; server = null; previous.closeAllConnections(); await new Promise(resolve => previous.close(resolve)); } },
    async importFile(uri) { const bytes = Buffer.from(uri); const sha256 = createHash('sha256').update(bytes).digest('hex'); blobs.set(sha256, bytes); return { uri: sha256, sha256, size: bytes.length }; },
    async hasFile(hash) { return blobs.has(hash) ? { uri: hash, size: blobs.get(hash).length } : null; },
  };
  const client = createMobileClient({ storage, randomUUID, deviceName: name, kind: 'android', peerOptions: { records, transport, randomBytes } });
  await client.init(); await client.setPeerActive(true);
  t.after(async () => { client.close(); await transport.stop(); });
  return { client, storage, records, blobs, transport, get baseUrl() { return baseUrl; } };
}
async function join(host, guest, id) {
  const invite = await host.client.createInvite(id);
  const ticket = await guest.client.requestJoin(invite.link);
  assert.equal((await guest.client.checkJoin(ticket)).status, 'pending');
  await host.client.respondJoin(id, ticket.requestId, true);
  return (await guest.client.checkJoin(ticket)).group;
}

test('three mobile peers retain the same group and exchange messages with creator fully offline', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B'), c = await phone(t, 'C');
  const group = await a.client.createGroup('不依赖创建者');
  await join(a, b, group.id); await b.client.resolveGroup(group.id);
  await join(b, c, group.id); await c.client.resolveGroup(group.id);
  await a.client.setPeerActive(false);
  await b.client.api(group.id, '/api/messages', { method: 'POST', body: { text: 'A 已退出，B 继续发送' } });
  await c.client.resolveGroup(group.id);
  const state = await c.client.api(group.id, '/api/state');
  assert.equal(state.messages.at(-1).text, 'A 已退出，B 继续发送');
  assert.equal(c.client.getGroup(group.id).id, group.id);
  // No event log or unbounded roster is written to SecureStore.
  for (const [key, value] of c.storage.values) assert.ok(!value.includes('A 已退出'), key);
  assert.ok([...c.records.values.values()].some(value => value.includes('A 已退出')));
  await c.client.setPeerActive(false);
  const restarted = await phone(t, 'C restart', c);
  assert.equal((await restarted.client.api(group.id, '/api/state')).messages.at(-1).text, 'A 已退出，B 继续发送');
});

test('mobile files are supplied by holder, protected by signed proof, and become available again after holder returns', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B');
  const group = await a.client.createGroup('附件'); await join(a, b, group.id);
  const message = await a.client.peerUpload(group.id, 'file bytes', 'hello.txt', 'text/plain');
  await b.client.resolveGroup(group.id);
  const source = (await b.client.peerFileSources(group.id, message.id)).sources[0];
  assert.ok(source);
  assert.equal((await fetch(source.url)).status, 401);
  assert.equal(await (await fetch(source.url, { headers: source.headers })).text(), 'file bytes');
  // Signed file proofs are one-use, not reusable bearer URLs.
  assert.equal((await fetch(source.url, { headers: source.headers })).status, 409);
  await a.client.setPeerActive(false);
  const offline = (await b.client.peerFileSources(group.id, message.id)).sources[0];
  await assert.rejects(fetch(offline.url, { headers: offline.headers }));
  await a.client.setPeerActive(true);
  b.client.updateDiscovery([{ groupId: group.id, hostDeviceId: a.client.device.id, baseUrl: a.baseUrl }]);
  await b.client.resolveGroup(group.id);
  const sources = (await b.client.peerFileSources(group.id, message.id)).sources;
  const refreshed = sources.find(source => source.url.startsWith(a.baseUrl));
  assert.ok(refreshed);
  assert.equal(await (await fetch(refreshed.url, { headers: refreshed.headers })).text(), 'file bytes');
});

test('a runtime without native peer support rejects peer invitations explicitly', async () => {
  const client = createMobileClient({ storage: memory(), randomUUID }); await client.init();
  await assert.rejects(client.requestJoin(`http://127.0.0.1:1/#invite=123456&group=${randomUUID()}&protocol=peer`), /Android/);
  assert.equal(client.peerSupported, false);
});

test('a newly joined phone bootstraps a lagging member beyond 128 events after inviter exits', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B'), c = await phone(t, 'C');
  const group = await a.client.createGroup('分页'); await join(a, b, group.id);
  await b.client.resolveGroup(group.id); await a.client.setPeerActive(false);
  for (let index = 0; index < 130; index++) await b.client.api(group.id, '/api/messages', { method: 'POST', body: { text: 'page ' + index } });
  await join(b, c, group.id); await c.client.resolveGroup(group.id);
  assert.equal((await c.client.api(group.id, '/api/state')).messages.length, 130);
  await b.client.setPeerActive(false); await a.client.setPeerActive(true);
  c.client.updateDiscovery([{ groupId: group.id, hostDeviceId: a.client.device.id, baseUrl: a.baseUrl }]);
  await c.client.resolveGroup(group.id);
  assert.equal((await a.client.api(group.id, '/api/state')).messages.length, 130);
  await c.client.api(group.id, '/api/messages', { method: 'POST', body: { text: 'new phone independent' } });
  await c.client.resolveGroup(group.id);
  assert.equal((await a.client.api(group.id, '/api/state')).messages.at(-1).text, 'new phone independent');
});

test('failed durable approval rolls back membership and keeps the approval ticket retryable', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B'); const group = await a.client.createGroup('原子审批');
  const invite = await a.client.createInvite(group.id), ticket = await b.client.requestJoin(invite.link);
  const write = a.records.setItemAsync; a.records.setItemAsync = async () => { throw new Error('disk full'); };
  await assert.rejects(a.client.respondJoin(group.id, ticket.requestId, true), /disk full/);
  assert.equal((await b.client.checkJoin(ticket)).status, 'pending');
  assert.equal((await a.client.api(group.id, '/api/state')).devices.length, 1);
  a.records.setItemAsync = write; await a.client.respondJoin(group.id, ticket.requestId, true);
  assert.equal((await b.client.checkJoin(ticket)).status, 'approved');
});


test('real desktop group and mobile node sync both directions and desktop downloads phone-owned file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-mobile-desktop-'));
  const desktop = await createGroupManager({ dataDir: root, device: { id: randomUUID(), name: 'Windows', kind: 'desktop' }, host: '127.0.0.1', peerGroups: true, directoryPort: 0, discoveryFactory: async () => ({ list: () => [], refresh() {}, async close() {} }), monitorIntervalMs: 600000 });
  t.after(async () => { await desktop.close({ force: true }); await rm(root, { recursive: true, force: true }); });
  const mobile = await phone(t, 'Android'), group = await desktop.createGroup('跨平台群');
  const invite = await desktop.createInvite(group.id), ticket = await mobile.client.requestJoin(`${group.baseUrl}/#invite=${invite.code}&group=${group.id}&protocol=peer`);
  await desktop.respondJoin(group.id, ticket.requestId, true); await mobile.client.checkJoin(ticket);
  await mobile.client.resolveGroup(group.id);
  await mobile.client.api(group.id, '/api/messages', { method: 'POST', body: { text: '来自手机' } });
  await mobile.client.resolveGroup(group.id);
  assert.equal((await desktop.authenticated(group.id, '/api/state')).messages.at(-1).text, '来自手机');
  await desktop.authenticated(group.id, '/api/messages', { method: 'POST', body: { text: '来自桌面' } });
  await mobile.client.resolveGroup(group.id);
  assert.equal((await mobile.client.api(group.id, '/api/state')).messages.at(-1).text, '来自桌面');
  const file = await mobile.client.peerUpload(group.id, 'phone-owned bytes', 'phone.txt', 'text/plain');
  await mobile.client.resolveGroup(group.id);
  assert.equal((await readFile(await desktop.preparePeerFile(group.id, file.id))).toString(), 'phone-owned bytes');
});

test('discovery endpoint gets no history or peer addresses before fresh signed authentication', async t => {
  const a = await phone(t, 'A'); const group = await a.client.createGroup('秘密');
  await a.client.api(group.id, '/api/messages', { method: 'POST', body: { text: '必须留在已授权成员之间' } });
  const requests = [];
  const impostor = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks))); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { impostor.closeAllConnections(); impostor.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${impostor.address().port}`;
  a.client.updateDiscovery([{ groupId: group.id, hostDeviceId: randomUUID(), baseUrl }]);
  await a.client.resolveGroup(group.id);
  await assert.rejects(a.client.reconnectAt(group.id, baseUrl), error => error.status === 503);
  assert.ok(requests.length);
  for (const proof of requests) {
    assert.deepEqual(proof.payload.events, []); assert.deepEqual(proof.payload.known, []);
    assert.equal(proof.payload.peers, undefined); assert.equal(proof.payload.endpoint, undefined);
    assert.ok(!JSON.stringify(proof).includes('必须留在已授权成员之间'));
  }
});

test('offline leave persists one departure and retries after restart and peer return', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B');
  const group = await a.client.createGroup('退出持久化'); await join(a, b, group.id); await b.client.resolveGroup(group.id);
  await a.client.setPeerActive(false);
  await assert.rejects(b.client.leaveGroup(group.id), error => error.status === 409);
  await assert.rejects(b.client.leaveGroup(group.id), error => error.status === 409);
  const record = () => JSON.parse(b.records.values.get('peer_' + group.id));
  assert.equal(record().events.filter(event => event.type === 'member.leave').length, 1);
  assert.equal(record().pendingDeparture.acknowledged, false);
  await b.client.setPeerActive(false);
  const restarted = await phone(t, 'B restart', b);
  await a.client.setPeerActive(true);
  restarted.client.updateDiscovery([{ groupId: group.id, hostDeviceId: a.client.device.id, baseUrl: a.baseUrl }]);
  await restarted.client.resolveGroup(group.id);
  await restarted.client.leaveGroup(group.id);
  assert.equal(record().pendingDeparture.acknowledged, true);
  assert.equal(record().events.filter(event => event.type === 'member.leave').length, 1);
  assert.ok(!(await a.client.api(group.id, '/api/state')).devices.some(member => member.id === b.client.device.id));
});
