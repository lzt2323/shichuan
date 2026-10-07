import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadVerified, verifyLocalFile } from '../shared/download.js';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-download-'));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  return { destination: path.join(directory, 'temp'), url: `http://127.0.0.1:${server.address().port}` };
}

test('verified download saves expected bytes and cache verification detects same-size corruption', async t => {
  const bytes = Buffer.from('真实文件数据');
  const f = await fixture(t, (_req, res) => res.end(bytes));
  const progress = [];
  await downloadVerified({ ...f, size: bytes.length, sha256: digest(bytes), onProgress: n => progress.push(n) });
  assert.deepEqual(await fs.readFile(f.destination), bytes);
  assert.equal(progress.at(-1), bytes.length);
  assert.equal(await verifyLocalFile(f.destination, { size: bytes.length, sha256: digest(bytes) }), true);
  await fs.writeFile(f.destination, Buffer.alloc(bytes.length));
  assert.equal(await verifyLocalFile(f.destination, { size: bytes.length, sha256: digest(bytes) }), false);
  assert.equal(await verifyLocalFile(f.destination + '.missing', { size: bytes.length, sha256: digest(bytes) }), false);
});

test('existing destinations remain untouched and no network request starts', async t => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => { requests++; res.end('new'); });
  await fs.writeFile(f.destination, 'original');
  await assert.rejects(downloadVerified({ ...f, size: 3, sha256: digest('new') }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'original'); assert.equal(requests, 0);
});

for (const [name, response, size, sha256, expected] of [
  ['oversized', 'too many bytes', 1, digest('x'), /超出/],
  ['truncated', 'x', 2, digest('xx'), /不完整/],
  ['checksum mismatch', 'x', 1, digest('y'), /不完整/],
]) test(`${name} response removes the owned temporary file`, async t => {
  const f = await fixture(t, (_req, res) => res.end(response));
  await assert.rejects(downloadVerified({ ...f, size, sha256 }), expected);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('cancellation and inactivity timeout remove partial downloads', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200); res.write('x'); });
  const controller = new AbortController();
  await assert.rejects(downloadVerified({ ...f, size: 2, sha256: digest('xx'), signal: controller.signal, onProgress: () => controller.abort() }), /abort/i);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  await assert.rejects(downloadVerified({ ...f, size: 2, sha256: digest('xx'), timeoutMs: 20 }), /无响应/);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('HTTP errors never leave a file and invalid metadata never makes a request', async t => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => { requests++; res.writeHead(404); res.end(); });
  await assert.rejects(downloadVerified({ ...f, size: 0, sha256: digest('') }), /404/);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  await assert.rejects(downloadVerified({ ...f, size: -1, sha256: digest('') }), /记录无效/);
  assert.equal(requests, 1);
});

test('unresponsive holder has a bounded header wait but active transfers may run longer', async t => {
  const stalled = await fixture(t, () => {});
  await assert.rejects(downloadVerified({ ...stalled, size: 1, sha256: digest('x'), responseTimeoutMs: 20 }), /连接超时/);
  await assert.rejects(fs.stat(stalled.destination), { code: 'ENOENT' });
  const active = await fixture(t, (_req, res) => { res.writeHead(200); res.write('x'); setTimeout(() => res.end('y'), 100); });
  await downloadVerified({ ...active, size: 2, sha256: digest('xy'), responseTimeoutMs: 50 });
  assert.equal(await fs.readFile(active.destination, 'utf8'), 'xy');
});
