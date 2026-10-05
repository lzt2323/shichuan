import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createDaemon } from '../apps/tui/daemon.js';
import { rpc } from '../apps/tui/rpc.js';
import { locations, terminalText } from '../apps/tui/common.js';
import { TransferQueue } from '../apps/tui/transfers.js';

const fakeDiscovery = async () => ({ list: () => [], refresh() {}, close() {} });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-tui-'));
  const paths = locations({ XDG_DATA_HOME: path.join(root, 'd'), XDG_STATE_HOME: path.join(root, 's'), XDG_CONFIG_HOME: path.join(root, 'c'), XDG_RUNTIME_DIR: path.join(root, 'r') });
  const daemon = await createDaemon({ paths, managerOptions: { discoveryFactory: fakeDiscovery, host: '127.0.0.1', monitorIntervalMs: 600000 } });
  t.after(async () => { await daemon.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, daemon, call: (method, params) => rpc(method, params, { paths }) };
}
async function done(call, tasks) {
  for (let n = 0; n < 300; n++) {
    const status = await call('status'), found = tasks.map(({ id }) => status.transfers.find(t => t.id === id));
    if (found.every(t => !['queued', 'running'].includes(t.status))) return found;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('transfer timeout');
}

test('TUI daemon RPC isolates secrets, handles Unicode file roundtrip, and never overwrites downloads', async t => {
  const { root, daemon, call } = await fixture(t);
  const group = await call('create', { name: '多人传输群' }); assert.equal(group.key, undefined);
  await call('text', { group: group.id, text: '来自 Linux 的文字' });
  const bytes = randomBytes(1024 * 1024 + 19), source = path.join(root, '中文 空格.bin'); await fs.writeFile(source, bytes);
  const uploads = await done(call, await call('send', { group: group.id, files: [source] }));
  assert.equal(uploads[0].status, 'done', uploads[0].error);
  const state = await call('messages', { group: group.id }), message = state.messages.find(m => m.type === 'file');
  assert.equal(message.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(state.messages[0].text, '来自 Linux 的文字');
  const directory = path.join(root, 'downloads'); await fs.mkdir(directory); await fs.writeFile(path.join(directory, message.fileName), 'keep me');
  const received = await done(call, await call('receive', { group: group.id, messageId: message.id, directory }));
  assert.equal(received[0].status, 'done', received[0].error);
  assert.deepEqual(await fs.readFile(received[0].result), bytes);
  assert.equal(await fs.readFile(path.join(directory, message.fileName), 'utf8'), 'keep me');
  const encoded = JSON.stringify(await call('status'));
  assert.equal(encoded.includes(daemon.manager.listGroups()[0].key), false);
  assert.equal((await fs.stat(daemon.paths.socket)).mode & 0o777, 0o600);
  await assert.rejects(createDaemon({ paths: daemon.paths }), /已在运行/);
});

test('download checksum mismatch removes partial and never publishes corrupt bytes; retry and queued cancellation work', async t => {
  const { root, daemon, call } = await fixture(t), group = await call('create', { name: '校验测试' });
  const source = path.join(root, 'verify.bin'); await fs.writeFile(source, 'correct');
  const [sent] = await done(call, await call('send', { group: group.id, files: [source] })); assert.equal(sent.status, 'done', sent.error);
  const message = (await call('messages', { group: group.id })).messages[0];
  const stored = daemon.manager.getHostedInbox(group.id).fileFor(message.id).path;
  await fs.writeFile(stored, 'corrupt');
  const directory = path.join(root, 'bad'); const [failed] = await done(call, await call('receive', { group: group.id, messageId: message.id, directory }));
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /SHA-256/); assert.deepEqual(await fs.readdir(directory), []);
  await fs.writeFile(stored, 'correct'); await call('retry', { id: failed.id }); const [retried] = await done(call, [{ id: failed.id }]); assert.equal(retried.status, 'done');
  const queued = new TransferQueue({ manager: daemon.manager, fetchState: () => {} }); queued.running = true;
  const task = queued.add('upload', group.id, { source }); queued.cancel(task.id); assert.equal(queued.list()[0].status, 'cancelled'); queued.running = false; await queued.close();
});

test('terminal text removes ANSI, OSC clipboard, controls and bidi overrides', () => {
  assert.equal(terminalText('\x1b[31m红色\x1b[0m\x1b]52;c;c2VjcmV0\x07\u202efile\x07\n第二行'), '红色file\n第二行');
});

test('CLI help and non-running status do not launch background processes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-cli-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env, XDG_RUNTIME_DIR: root, XDG_STATE_HOME: root, XDG_DATA_HOME: root };
  const cli = path.resolve('apps/tui/cli.js');
  const result = spawnSync(process.execPath, [cli, 'status'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).running, false);
  assert.deepEqual(await fs.readdir(root), []);
  const help = spawnSync(process.execPath, [cli, '--help'], { env, encoding: 'utf8' }); assert.equal(help.status, 0); assert.match(help.stdout, /后台/);
});

test('two independent TUI daemons pair through existing protocol and exchange text without exposing poll tokens', async t => {
  const a = await fixture(t), b = await fixture(t);
  const group = await a.call('create', { name: '跨设备群' });
  const invite = await a.daemon.manager.createInvite(group.id);
  const baseUrl = a.daemon.manager.listGroups()[0].baseUrl;
  const joining = await b.call('join', { address: baseUrl, code: invite.code });
  assert.equal(joining.pollToken, undefined); assert.equal(joining.status, 'pending');
  const requests = await a.daemon.manager.listJoinRequests(group.id);
  assert.equal(requests[0].device.id, b.daemon.manager.device.id);
  await a.call('respond', { group: group.id, requestId: joining.id, allow: true });
  for (let n = 0; n < 150 && !b.daemon.manager.listGroups().length; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(b.daemon.manager.listGroups().length, 1);
  await b.call('text', { group: group.id, text: '另一台终端已加入' });
  const state = await a.call('messages', { group: group.id }); assert.equal(state.messages[0].text, '另一台终端已加入');
  assert.equal(state.messages[0].senderId, b.daemon.manager.device.id);
});

test('daemon recovers an abandoned startup lock and concurrent close awaits complete shutdown', async t => {
  const { daemon, root } = await fixture(t); await daemon.close();
  // Represents the legacy crash window: public lock created but owner not written.
  await fs.mkdir(daemon.paths.lock); await fs.writeFile(path.join(daemon.paths.lock, 'partial'), '');
  const past = new Date(Date.now() - 60000); await fs.utimes(daemon.paths.lock, past, past);
  const recovered = await createDaemon({ paths: daemon.paths, managerOptions: { discoveryFactory: fakeDiscovery, host: '127.0.0.1' } });
  const group = await recovered.dispatch('create', { name: '重启恢复' }); assert.ok(group.id);
  await Promise.all([recovered.close(), recovered.close()]);
  await assert.rejects(fs.stat(recovered.paths.socket), { code: 'ENOENT' });
  await assert.rejects(fs.stat(recovered.paths.lock), { code: 'ENOENT' });
  assert.equal((await fs.readdir(path.join(root, 'r/pickdrop'))).some(name => name.endsWith('.tmp')), false);
});

test('invitation expected group ID is validated before accepting a ticket', async t => {
  const a = await fixture(t), b = await fixture(t), group = await a.call('create', { name: '正确的群' });
  const invite = await a.daemon.manager.createInvite(group.id), baseUrl = a.daemon.manager.listGroups()[0].baseUrl;
  const wrong = '00000000-0000-4000-8000-000000000001';
  await assert.rejects(b.call('join', { link: `${baseUrl}/#invite=${invite.code}&group=${wrong}` }), /群|匹配|目标/);
  assert.equal((await b.call('status')).joins.length, 0);
  assert.equal(b.daemon.manager.listGroups().length, 0);
});

test('compact progress bar preserves percentages on narrow terminals', async () => {
  const { progressLabel } = await import('../apps/tui/common.js');
  assert.match(progressLabel({ bytes: 68, total: 100, status: 'running' }, 80), /█.*░.*68%/);
  assert.equal(progressLabel({ bytes: 68, total: 100, status: 'running' }, 12), '68%');
  assert.equal(progressLabel({ bytes: 0, total: 0, status: 'queued' }, 12), '等待');
});
