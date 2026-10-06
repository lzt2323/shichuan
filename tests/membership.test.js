import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createInboxServer } from '../server/index.js';

async function setup(t, version = 2) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-members-'));
  const device = { id: randomUUID(), name: 'host', kind: 'desktop' };
  const group = { id: randomUUID(), name: 'test', hostDeviceId: device.id, authVersion: version };
  let inbox = await createInboxServer({ dataDir, host: '127.0.0.1', group });
  let key = await inbox.ensureHostDevice(device);
  t.after(async () => { await inbox.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const call = (route, id = device.id, token = key, body, method = body === undefined ? 'GET' : 'POST') => fetch(inbox.baseUrl + route, {
    method, headers: { 'X-Room-Key': token, 'X-Device-Id': id, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function pair(guest = { id: randomUUID(), name: 'guest', kind: 'android' }) {
    const invite = await (await call('/api/pair/invite', device.id, key, {})).json();
    const request = await fetch(inbox.baseUrl + '/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invite.code, device: guest }) });
    assert.equal(request.status, 202); const ticket = await request.json();
    assert.equal((await call('/api/pair/respond', device.id, key, { requestId: ticket.requestId, allow: true })).status, 200);
    const result = await status(ticket); return { guest, ticket, group: result.group };
  }
  async function status(ticket) { return (await fetch(inbox.baseUrl + '/api/pair/status/' + ticket.requestId, { headers: { 'X-Poll-Token': ticket.pollToken } })).json(); }
  return { dataDir, device, group, call, pair, status, get inbox() { return inbox; }, get key() { return key; }, async restart() { await inbox.close(); inbox = await createInboxServer({ dataDir, host: '127.0.0.1', group }); key = await inbox.ensureHostDevice(device); }, async secure() { const result = await inbox.secureMembers(); key = result.key; return result; } };
}

test('v2 credentials bind each HTTP endpoint and websocket to one device, persisted as hashes', async t => {
  const s = await setup(t), { guest, group } = await s.pair();
  assert.equal(group.authVersion, 2); assert.notEqual(group.key, s.key); assert.notEqual(group.key, s.inbox.key);
  for (const [route, body] of [['/api/state'], ['/api/qr?link=http://localhost'], ['/api/files/missing'], ['/api/join', guest], ['/api/messages', { text: 'forged' }], ['/api/files?name=forged.txt', {}], ['/api/pair/invite', {}], ['/api/pair/requests'], ['/api/pair/respond', { requestId: randomUUID(), allow: true }], ['/api/members/leave', {}], ['/api/members/remove', { deviceId: s.device.id }]]) {
    assert.equal((await s.call(route, s.device.id, group.key, body)).status, 401, route);
    assert.equal((await s.call(route, guest.id, s.inbox.key, body)).status, 401, route + ' shared key');
  }
  assert.equal((await s.call('/api/join', guest.id, group.key, { ...guest, id: s.device.id })).status, 403);
  const ws = new WebSocket(s.inbox.baseUrl.replace('http:', 'ws:') + `/api/events?device=${s.device.id}&key=${group.key}`);
  ws.on('error', () => {}); const [error] = await once(ws, 'error'); assert.match(error.message, /401/);
  const disk = await fs.readFile(path.join(s.dataDir, 'history.json'), 'utf8');
  assert.equal(disk.includes(group.key), false); assert.equal(disk.includes(s.key), false);
  assert.equal((await fs.stat(path.join(s.dataDir, 'host-credential'))).mode & 0o777, 0o600);
  assert.equal((await s.call('/api/state', guest.id, group.key)).status, 200);
  const challenge = randomBytes(32).toString('hex');
  const proof = await (await fetch(s.inbox.baseUrl + '/api/group/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge, deviceId: guest.id, authVersion: 2 }) })).json();
  const secret = createHash('sha256').update(group.key).digest('hex');
  assert.equal(proof.proof, createHmac('sha256', secret).update(`${group.id}:${challenge}`).digest('hex'));
  await s.restart(); assert.equal((await s.call('/api/state', guest.id, group.key)).status, 200);
});

test('host removal revokes sockets, tokens and approved tickets across restart, retaining history', async t => {
  const s = await setup(t), { guest, group, ticket } = await s.pair();
  assert.equal((await s.call('/api/messages', guest.id, group.key, { text: 'retained' })).status, 201);
  assert.equal((await s.call('/api/members/remove', guest.id, group.key, { deviceId: s.device.id })).status, 403);
  assert.equal((await s.call('/api/members/remove', s.device.id, s.key, { deviceId: s.device.id })).status, 409);
  const ws = new WebSocket(s.inbox.baseUrl.replace('http:', 'ws:') + `/api/events?device=${guest.id}&key=${group.key}`);
  ws.on('error', () => {}); await once(ws, 'open'); const closed = once(ws, 'close');
  assert.equal((await s.call('/api/members/remove', s.device.id, s.key, { deviceId: guest.id })).status, 200); await closed;
  assert.equal((await s.call('/api/state', guest.id, group.key)).status, 401);
  assert.deepEqual(await s.status(ticket), { status: 'revoked' });
  assert.equal((await s.call('/api/join', guest.id, group.key, guest)).status, 401);
  assert.equal(s.inbox.state().messages[0].text, 'retained'); assert.equal(s.inbox.state().devices.length, 1);
  await s.restart(); assert.equal((await s.call('/api/state', guest.id, group.key)).status, 401);
  const renewed = await s.pair(guest); assert.notEqual(renewed.group.key, group.key);
  assert.equal((await s.call('/api/members/leave', guest.id, renewed.group.key, {})).status, 200);
  assert.equal((await s.call('/api/state', guest.id, renewed.group.key)).status, 401);
});

test('pairing cannot replace an existing identity and concurrent approval cannot mint two credentials', async t => {
  const s = await setup(t), { guest, group } = await s.pair();
  const invite = await (await s.call('/api/pair/invite', s.device.id, s.key, {})).json();
  const duplicate = await fetch(s.inbox.baseUrl + '/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invite.code, device: guest }) });
  assert.equal(duplicate.status, 409);
  assert.equal((await s.call('/api/state', guest.id, group.key)).status, 200);
  const incoming = { id: randomUUID(), name: 'race', kind: 'desktop' };
  const tickets = [];
  for (let i = 0; i < 2; i++) {
    const invitation = await (await s.call('/api/pair/invite', s.device.id, s.key, {})).json();
    tickets.push(await (await fetch(s.inbox.baseUrl + '/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invitation.code, device: incoming }) })).json());
  }
  const approvals = await Promise.all(tickets.map(ticket => s.call('/api/pair/respond', s.device.id, s.key, { requestId: ticket.requestId, allow: true })));
  assert.deepEqual(approvals.map(result => result.status).sort(), [200, 409]);
});

test('legacy migration closes shared-key access without deleting messages and rolls back disk failures', async t => {
  const s = await setup(t, 1), { guest, group } = await s.pair();
  assert.equal((await s.call('/api/messages', guest.id, group.key, { text: 'legacy' })).status, 201);
  const originalRename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' }); };
  try { await assert.rejects(s.secure(), /simulated disk failure/); } finally { fs.rename = originalRename; }
  assert.equal(s.inbox.getAuthVersion(), 1); assert.equal(s.inbox.state().devices.length, 2);
  assert.equal((await s.call('/api/state', guest.id, group.key)).status, 200);
  await s.secure(); assert.equal(s.inbox.getAuthVersion(), 2);
  assert.equal((await s.call('/api/state', guest.id, group.key)).status, 401);
  assert.equal(s.inbox.state().messages[0].text, 'legacy');
  const approved = await s.pair(guest);
  fs.rename = async () => { throw Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' }); };
  try { assert.equal((await s.call('/api/members/remove', s.device.id, s.key, { deviceId: guest.id })).status, 500); } finally { fs.rename = originalRename; }
  assert.equal((await s.call('/api/state', guest.id, approved.group.key)).status, 200);
  await s.restart(); assert.equal((await s.call('/api/state', guest.id, approved.group.key)).status, 200);
});

test('revocation cancels an in-progress upload without publishing a file message', async t => {
  const { default: http } = await import('node:http');
  const s = await setup(t), { guest, group } = await s.pair();
  const upload = http.request(s.inbox.baseUrl + '/api/files?name=partial.bin', { method: 'POST', headers: { 'X-Room-Key': group.key, 'X-Device-Id': guest.id, 'Content-Type': 'application/octet-stream' } });
  upload.on('error', () => {}); const cancelled = new Promise(resolve => upload.once('close', resolve));
  upload.write(Buffer.alloc(65536));
  for (let attempt = 0; attempt < 50 && s.inbox.activeTransfers() === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(s.inbox.activeTransfers(), 1);
  assert.equal((await s.call('/api/members/remove', s.device.id, s.key, { deviceId: guest.id })).status, 200);
  await cancelled;
  for (let attempt = 0; attempt < 50 && s.inbox.activeTransfers(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(s.inbox.activeTransfers(), 0); assert.equal(s.inbox.state().messages.length, 0);
  assert.deepEqual(await fs.readdir(path.join(s.dataDir, 'files')), []);
});

test('revocation interrupts an in-progress download', async t => {
  const { default: http } = await import('node:http');
  const s = await setup(t), { guest, group } = await s.pair();
  const bytes = Buffer.alloc(8 * 1024 * 1024, 7);
  const upload = await fetch(s.inbox.baseUrl + '/api/files?name=large.bin', { method: 'POST', headers: { 'X-Room-Key': s.key, 'X-Device-Id': s.device.id }, body: bytes });
  assert.equal(upload.status, 201); const file = await upload.json();
  const download = http.get(s.inbox.baseUrl + '/api/files/' + file.id, { headers: { 'X-Room-Key': group.key, 'X-Device-Id': guest.id } });
  download.on('error', () => {});
  const [response] = await once(download, 'response'); response.on('error', () => {});
  const closed = new Promise(resolve => response.once('close', resolve));
  response.pause();
  assert.equal((await s.call('/api/members/remove', s.device.id, s.key, { deviceId: guest.id })).status, 200);
  response.resume(); await closed;
  assert.equal(response.complete, false);
  assert.equal(s.inbox.state().messages.length, 1);
});
