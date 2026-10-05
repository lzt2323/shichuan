import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createInboxServer } from '../server/index.js';
import { safeFileName, parseRoomLink } from '../shared/protocol.js';

async function setup(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-test-'));
  const server = await createInboxServer({ dataDir, host: '127.0.0.1', ...options });
  t.after(async () => { await server.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const headers = { 'X-Room-Key': server.key };
  async function request(route, opts = {}) { return fetch(server.baseUrl + route, { ...opts, headers: { ...headers, ...opts.headers } }); }
  async function join(name = '我的手机') {
    const id = randomUUID();
    const response = await request('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name, kind: 'android' }) });
    assert.equal(response.status, 200); return id;
  }
  return { server, dataDir, headers, request, join };
}

test('pairing key protects history, downloads, uploads and websocket connections', async t => {
  const { server, request } = await setup(t);
  assert.equal((await fetch(server.baseUrl + '/api/state')).status, 401);
  assert.equal((await request('/api/state', { headers: { 'X-Room-Key': 'x'.repeat(64) } })).status, 401);
  assert.equal((await fetch(server.baseUrl + '/api/files', { method: 'POST', body: 'secret' })).status, 401);
  const badSocket = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/events?key=bad&device=${randomUUID()}`);
  const [error] = await once(badSocket, 'error'); assert.match(error.message, /401/);
  const config = parseRoomLink(`${server.baseUrl}/#key=${server.key}`);
  assert.equal(config.key, server.key);
  assert.throws(() => parseRoomLink('file:///etc/passwd'));
});

test('binary streaming retains bytes and SHA-256, with independent copies of same-named files', async t => {
  const { server, request, join } = await setup(t);
  const id = await join(), payload = randomBytes(3 * 1024 * 1024 + 7);
  const results = [];
  for (let i = 0; i < 2; i++) {
    const response = await request('/api/files?name=' + encodeURIComponent('照片_文件.bin'), { method: 'POST', headers: { 'X-Device-Id': id }, body: payload });
    assert.equal(response.status, 201); results.push(await response.json());
  }
  assert.notEqual(results[0].id, results[1].id);
  for (const message of results) {
    assert.equal(message.sha256, createHash('sha256').update(payload).digest('hex'));
    const response = await request('/api/files/' + message.id);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
    assert.equal(path.basename(server.fileFor(message.id).path), '照片_文件.bin');
  }
});

test('joined devices receive actual text and file updates over websocket', async t => {
  const { server, request, join } = await setup(t);
  const phone = await join('iPhone'), desktop = await join('Mac');
  const socket = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/events?key=${server.key}&device=${desktop}`);
  const updates = []; socket.on('message', data => updates.push(JSON.parse(data)));
  await once(socket, 'open'); t.after(() => socket.terminate());
  const response = await request('/api/messages', { method: 'POST', headers: { 'X-Device-Id': phone, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '<script>alert(1)</script>\n中文消息' }) });
  assert.equal(response.status, 201);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(updates.at(-1).messages.at(-1).senderName, 'iPhone');
  assert.equal(updates.at(-1).messages.at(-1).text, '<script>alert(1)</script>\n中文消息');
  assert.equal(updates.at(-1).devices.find(d => d.id === desktop).online, true);
});

test('path traversal, reserved names and very long Unicode names remain inside inbox', async t => {
  const { server, request, join } = await setup(t); const id = await join();
  for (const input of ['../../etc/passwd', '..\\..\\CON', '文'.repeat(300) + '.pdf', '...']) {
    const response = await request('/api/files?name=' + encodeURIComponent(input), { method: 'POST', headers: { 'X-Device-Id': id }, body: 'hello' });
    assert.equal(response.status, 201); const message = await response.json();
    assert.equal(message.fileName, safeFileName(input));
    assert.ok(Buffer.byteLength(message.fileName) <= 200);
    assert.ok(server.fileFor(message.id).path.includes(path.sep + 'files' + path.sep));
  }
  assert.equal((await request('/api/files/../../history.json')).status, 404);
});

test('limits reject oversized uploads and cancel cleans unfinished files', async t => {
  const { server, request, join, dataDir } = await setup(t, { maxFileBytes: 1024 }); const id = await join();
  assert.equal((await request('/api/files?name=big.bin', { method: 'POST', headers: { 'X-Device-Id': id }, body: Buffer.alloc(2048) })).status, 413);
  const req = http.request(`${server.baseUrl}/api/files?name=cancel.bin`, { method: 'POST', headers: { 'X-Room-Key': server.key, 'X-Device-Id': id, 'Content-Type': 'application/octet-stream' } });
  req.on('error', () => {}); req.write(Buffer.alloc(100));
  await new Promise(resolve => setTimeout(resolve, 40)); req.destroy();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(server.state().messages.length, 0);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'files')), []);
});

test('history and files survive server restart while online statuses reset', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-persist-'));
  let server = await createInboxServer({ dataDir, host: '127.0.0.1' }); const originalKey = server.key, id = randomUUID();
  try {
    await fetch(server.baseUrl + '/api/join', { method: 'POST', headers: { 'X-Room-Key': server.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: '手机', kind: 'ios' }) });
    const response = await fetch(server.baseUrl + '/api/files?name=keep.txt', { method: 'POST', headers: { 'X-Room-Key': server.key, 'X-Device-Id': id }, body: 'persistent' });
    const message = await response.json(); await server.close();
    server = await createInboxServer({ dataDir, host: '127.0.0.1' });
    assert.equal(server.key, originalKey); assert.equal(server.state().devices[0].online, false);
    assert.equal(await fs.readFile(server.fileFor(message.id).path, 'utf8'), 'persistent');
  } finally { await server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});
