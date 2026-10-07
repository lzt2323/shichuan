import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const executablePath = process.env.PICKDROP_TEST_EXECUTABLE || createRequire(import.meta.url)('electron');
const dir = await mkdtemp(path.join(tmpdir(), 'pickdrop-quit-smoke-'));
const children = [], sockets = [], stderr = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
  const instance = await electron.launch({ executablePath, args: process.env.PICKDROP_TEST_EXECUTABLE ? [] : [root], cwd: root,
    env: { ...process.env, PICKDROP_USER_DATA: dir }, timeout: 30000 });
  const child = instance.process(); children.push(child);
  child.stderr?.on('data', chunk => stderr.push(chunk.toString()));
  const page = await instance.firstWindow();
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true');
  return { instance, page, bootstrap: await page.evaluate(() => window.pickdrop.bootstrap()) };
}
async function stalled(url, request) {
  const target = new URL(url);
  const socket = net.connect({ host: target.hostname, port: Number(target.port) }); sockets.push(socket);
  socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(request); return socket;
}
async function quit(instance, activateDuringQuit = false) {
  const child = instance.process();
  let timeout;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  await instance.evaluate(({ app }, activate) => {
    setTimeout(() => {
      app.quit();
      if (activate) { app.emit('second-instance'); app.emit('activate'); app.quit(); }
    }, 10);
  }, activateDuringQuit);
  try {
    const result = await Promise.race([exited, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Ordinary app.quit did not exit within 8 seconds')), 8000);
    })]);
    assert.equal(result.code, 0); assert.equal(result.signal, null);
  } finally { clearTimeout(timeout); }
}
try {
  const first = await start(), { room, device } = first.bootstrap;
  // An authenticated upload keeps its request body open indefinitely.
  const host = new URL(room.baseUrl);
  await stalled(room.baseUrl, `POST /api/files?name=unfinished.txt HTTP/1.1\r\nHost: ${host.host}\r\nX-Room-Key: ${room.key}\r\nX-Device-Id: ${device.id}\r\nContent-Type: application/octet-stream\r\nContent-Length: 1000000\r\n\r\npartial`);
  // Incomplete headers exercise UI-server shutdown independently of uploads.
  await stalled(first.page.url(), 'GET / HTTP/1.1\r\nHost: localhost\r\nX-Stalled: ');
  await pause(200);
  await quit(first.instance, true);
  assert.ok(sockets.every(socket => socket.destroyed), 'Quit must close every stalled socket');
  // Reopen immediately in the same user directory, without forced app.exit.
  const second = await start();
  assert.equal(second.bootstrap.group.id, first.bootstrap.group.id);
  const response = await fetch(second.bootstrap.room.baseUrl + '/api/state', {
    headers: { 'X-Room-Key': second.bootstrap.room.key, 'X-Device-Id': device.id },
  });
  const state = await response.json();
  assert.ok(!state.messages.some(message => message.fileName === 'unfinished.txt'));
  const preferences = JSON.parse(await readFile(path.join(dir, 'preferences.json'), 'utf8'));
  assert.ok(preferences.windows[first.bootstrap.group.id], 'Closed-window preferences must flush before exit');
  await quit(second.instance);
  assert.ok(!stderr.some(line => /ERR_CONNECTION_REFUSED|statement.*finalized|SQLITE_BUSY/.test(line)), stderr.join(''));
  console.log('Desktop ordinary quit/reopen passed: stalled upload and HTTP headers closed, activation blocked during quit, partial file absent, preferences flushed, immediate restart connected.');
} finally {
  for (const socket of sockets) socket.destroy();
  // Only kill processes launched by this isolated smoke, and only on failure.
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await stopped;
    }
  }
  await rm(dir, { recursive: true, force: true });
}
