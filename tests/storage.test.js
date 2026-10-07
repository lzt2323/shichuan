import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import WebSocket from 'ws';
import { openHistoryStore } from '../server/history-store.js';
import { createInboxServer } from '../server/index.js';
import { readJsonWithBackup, writeJsonWithBackup } from '../server/persistence.js';
import { cleanCache, cacheStats } from '../server/cache.js';
import { mergeState, prependHistory } from '../shared/history.js';

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-storage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
const senderId = randomUUID();
const message = text => ({ id: randomUUID(), type: 'text', senderId, senderName: '手机', createdAt: new Date().toISOString(), text });

test('legacy history migrates once, keeps a recovery copy, and supports bounded indexed pages', async t => {
  const dir = await directory(t), legacy = Array.from({ length: 245 }, (_, i) => message(`record-${i}`));
  await fs.writeFile(path.join(dir, 'history.json'), JSON.stringify({ messages: legacy, devices: [] }));
  let store = await openHistoryStore(dir, legacy);
  assert.equal(store.page().messages.length, 100);
  assert.equal(store.page().messages[0].text, 'record-145');
  const second = store.page({ before: store.page().history.before });
  assert.equal(second.messages[0].text, 'record-45');
  assert.equal(store.page({ before: second.history.before }).messages.length, 45);
  assert.equal(store.get(legacy[0].id).text, 'record-0');
  store.close(); store = await openHistoryStore(dir, legacy);
  assert.equal(store.page().history.total, 245); store.close();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'history.pre-sqlite.json'), 'utf8')).messages, legacy);
});

test('metadata backup restores a damaged primary without silently creating new identity', async t => {
  const dir = await directory(t), file = path.join(dir, 'groups.json');
  await writeJsonWithBackup(file, { id: 'original' });
  await writeJsonWithBackup(file, { id: 'next' });
  await fs.writeFile(file, '{broken');
  assert.deepEqual(await readJsonWithBackup(file, value => !!value.id), { id: 'original' });
  assert.ok((await fs.readdir(dir)).some(name => name.startsWith('groups.json.damaged-')));
  await fs.writeFile(file, '{broken'); await fs.writeFile(file + '.bak', '{}');
  await assert.rejects(readJsonWithBackup(file, value => !!value.id), { code: 'PICKDROP_STORAGE_INVALID' });
});

test('cache cleaning respects active files, external symlinks, expiry and size budget', async t => {
  const dir = await directory(t), root = path.join(dir, 'received'); await fs.mkdir(root);
  const old = path.join(root, 'old'), active = path.join(root, 'active'), fresh = path.join(root, 'fresh');
  for (const file of [old, active, fresh]) await fs.writeFile(file, '12345');
  const ago = new Date(Date.now() - 9 * 86400000); await fs.utimes(old, ago, ago); await fs.utimes(active, ago, ago);
  const external = path.join(dir, 'user-saved-photo'); await fs.writeFile(external, 'original');
  await fs.symlink(external, path.join(root, 'shortcut'));
  const result = await cleanCache(root, { protectedPaths: new Set([active]), maxBytes: 10 });
  assert.equal(result.removedBytes, 5); assert.equal((await cacheStats(root)).bytes, 10);
  await cleanCache(root, { clear: true, protectedPaths: new Set([active]) });
  assert.equal(await fs.readFile(active, 'utf8'), '12345');
  assert.equal(await fs.readFile(external, 'utf8'), 'original');
});

test('delta merge retains older pages, updates deleted cards, and bounds client memory', () => {
  const entries = Array.from({ length: 700 }, (_, i) => ({ id: String(i), sequence: i + 1 }));
  let state = { messages: entries.slice(500, 600), history: { before: '501', hasMore: true } };
  state = prependHistory(state, { messages: entries.slice(400, 500), history: { before: '401', hasMore: true } });
  state = mergeState(state, { mode: 'delta', messages: [{ ...entries[550], deleted: true }, ...entries.slice(600)], history: { latest: '700', total: 700 } });
  assert.equal(state.messages.length, 300); assert.equal(state.messages.find(m => m.id === '550').deleted, true);
  state = mergeState(state, { mode: 'delta', messages: entries.slice(0, 400) });
  assert.equal(state.messages.length, 500); assert.equal(state.history.before, '201');
});

test('large history sends bounded snapshots and single-message deltas, original deletion is host-only', async t => {
  const dir = await directory(t), host = { id: randomUUID(), name: 'Host', kind: 'desktop' };
  const history = await openHistoryStore(dir);
  // More than the former 16 MiB WebSocket limit, without retaining it in a server array.
  for (let i = 0; i < 1800; i++) history.add(message('x'.repeat(10000)));
  history.close();
  const server = await createInboxServer({ dataDir: dir, host: '127.0.0.1', group: { id: randomUUID(), hostDeviceId: host.id, name: 'Test', authVersion: 2 } });
  t.after(() => server.close());
  const key = await server.ensureHostDevice(host);
  const headers = { 'X-Room-Key': key, 'X-Device-Id': host.id };
  const call = (route, body) => fetch(server.baseUrl + route, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const initial = await (await call('/api/state')).json();
  assert.equal(initial.messages.length, 100); assert.equal(initial.history.total, 1800);
  const ws = new WebSocket(`${server.baseUrl.replace('http:', 'ws:')}/api/events?stream=2&device=${host.id}&key=${key}`, { maxPayload: 2 * 1024 * 1024 });
  const frames = []; ws.on('message', data => frames.push(JSON.parse(data))); t.after(() => ws.terminate());
  await once(ws, 'open');
  const posted = await (await call('/api/messages', { text: 'incremental' })).json();
  for (let tries = 0; !frames.some(frame => frame.messages?.some(m => m.id === posted.id)) && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(frames[0].mode, 'snapshot'); assert.equal(frames[0].messages.length, 100);
  assert.equal(frames.find(frame => frame.mode === 'delta' && frame.messages.some(m => m.id === posted.id)).messages.length, 1);
  const upload = await fetch(server.baseUrl + '/api/files?name=photo.png', { method: 'POST', headers, body: 'image' });
  const file = await upload.json(); assert.equal(file.sha256, createHash('sha256').update('image').digest('hex'));
  assert.equal((await call('/api/messages/' + file.id)).status, 200);
  assert.equal((await call('/api/storage/delete-files', { ids: [file.id] })).status, 200);
  assert.equal((await call('/api/files/' + file.id)).status, 404);
  assert.equal((await (await call('/api/messages/' + file.id)).json()).deleted, true);
  const metadata = JSON.parse(await fs.readFile(path.join(dir, 'history.json'), 'utf8'));
  assert.equal(metadata.messages, undefined); // No full-history rewriting during message writes.
  await server.close(); await server.close(); // shutdown is idempotent, including socket callbacks.
});

test('missing SQLite after migration isolates the group and preserves every original file', async t => {
  const dir = await directory(t), host = { id: randomUUID(), name: 'Host', kind: 'desktop' };
  const group = { id: randomUUID(), hostDeviceId: host.id, name: 'Must preserve originals', authVersion: 2 };
  let server = await createInboxServer({ dataDir: dir, host: '127.0.0.1', group });
  t.after(async () => { await server?.close(); });
  const key = await server.ensureHostDevice(host);
  const response = await fetch(server.baseUrl + '/api/files?name=original.png', { method: 'POST', headers: { 'X-Room-Key': key, 'X-Device-Id': host.id }, body: 'original bytes' });
  const uploaded = await response.json(); assert.equal(response.status, 201);
  const original = server.fileFor(uploaded.id).path;
  await server.close(); server = null;
  const ago = new Date(Date.now() - 2 * 86400000);
  await fs.utimes(path.dirname(original), ago, ago);
  const metadata = JSON.parse(await fs.readFile(path.join(dir, 'history.json'), 'utf8'));
  assert.equal(metadata.version, 2); assert.equal(metadata.messages, undefined);
  await fs.rm(path.join(dir, 'history.sqlite'));
  await assert.rejects(createInboxServer({ dataDir: dir, host: '127.0.0.1', group }), /历史|数据库|SQLite|sqlite/);
  assert.equal(await fs.readFile(original, 'utf8'), 'original bytes');
  await assert.rejects(fs.stat(path.join(dir, 'history.sqlite')), { code: 'ENOENT' });
});

test('damaged group metadata never restores a forgotten remote credential from its backup', async t => {
  const { createGroupManager } = await import('../server/groups.js');
  const dir = await directory(t), device = { id: randomUUID(), name: 'Client', kind: 'desktop' };
  const forgotten = { id: randomUUID(), name: 'Forgotten', hostDeviceId: randomUUID(), key: 'a'.repeat(64), authVersion: 2, local: false, baseUrl: 'http://127.0.0.1:59999' };
  const file = path.join(dir, 'groups.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, device, groups: [forgotten] }));
  const options = { dataDir: dir, device, host: '127.0.0.1', monitorIntervalMs: 600000,
    discoveryFactory: async () => ({ list: () => [], refresh() {}, async close() {} }) };
  const manager = await createGroupManager(options);
  try { await manager.forgetGroup(forgotten.id); assert.equal(manager.listGroups().length, 0); }
  finally { await manager.close(); }
  assert.equal(JSON.parse(await fs.readFile(file + '.bak', 'utf8')).groups[0].key, forgotten.key);
  await fs.writeFile(file, '{broken');
  await assert.rejects(createGroupManager(options), { code: 'PICKDROP_STORAGE_INVALID' });
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('cache cleaning skips a linked root and linked app-owned ancestor without touching user originals', async t => {
  const dir = await directory(t), external = path.join(dir, 'user-photos'), cache = path.join(dir, 'received');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'photo.png'), 'USER ORIGINAL');
  await fs.mkdir(path.join(external, 'group'));
  await fs.writeFile(path.join(external, 'group', 'another.png'), 'SECOND ORIGINAL');
  await fs.symlink(external, cache);
  assert.equal((await cleanCache(cache, { clear: true })).removedFiles, 0);
  assert.equal((await cleanCache(path.join(cache, 'group'), { clear: true, boundary: dir })).removedFiles, 0);
  assert.equal(await fs.readFile(path.join(external, 'photo.png'), 'utf8'), 'USER ORIGINAL');
  assert.equal(await fs.readFile(path.join(external, 'group', 'another.png'), 'utf8'), 'SECOND ORIGINAL');
  await assert.rejects(cleanCache(external, { clear: true, boundary: path.join(dir, 'unrelated') }), /应用目录/);
});

test('deleting an original never lifts a network pause that begins during disk cleanup', async t => {
  const dir = await directory(t), host = { id: randomUUID(), name: 'Host', kind: 'desktop' };
  const server = await createInboxServer({ dataDir: dir, host: '127.0.0.1', group: { id: randomUUID(), hostDeviceId: host.id, name: 'Pause test', authVersion: 2 } });
  t.after(() => server.close());
  const key = await server.ensureHostDevice(host), headers = { 'X-Room-Key': key, 'X-Device-Id': host.id };
  const upload = name => fetch(server.baseUrl + '/api/files?name=' + name, { method: 'POST', headers, body: name });
  const message = await (await upload('first')).json(), folder = path.dirname(server.fileFor(message.id).path);
  const originalRm = fs.rm; let started, continueRemove;
  const blocked = new Promise(resolve => { started = resolve; }), resume = new Promise(resolve => { continueRemove = resolve; });
  const mocked = t.mock.method(fs, 'rm', async (file, options) => { if (file === folder) { started(); await resume; } return originalRm(file, options); });
  let deletion;
  try {
    deletion = server.deleteFiles([message.id]); await blocked;
    server.pauseTransfers(true); continueRemove(); await deletion;
  } finally { continueRemove(); await deletion?.catch(() => {}); mocked.mock.restore(); }
  const response = await upload('must-stay-paused'); assert.equal(response.status, 503); await response.arrayBuffer();
  server.pauseTransfers(false);
  const allowed = await upload('after-resume'); assert.equal(allowed.status, 201); await allowed.arrayBuffer();
});

test('missing authorization primary with an existing backup fails closed rather than recreating credentials', async t => {
  const dir = await directory(t), file = path.join(dir, 'history.json');
  await writeJsonWithBackup(file, { credential: 'old-member-token' });
  await writeJsonWithBackup(file, { credential: 'revoked' });
  await fs.rm(file);
  await assert.rejects(readJsonWithBackup(file, () => true, { recover: false }), { code: 'PICKDROP_STORAGE_INVALID' });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(file + '.bak', 'utf8')).credential, 'old-member-token');
  assert.equal(await readJsonWithBackup(path.join(dir, 'new-group.json'), () => true, { recover: false }), undefined);
});
