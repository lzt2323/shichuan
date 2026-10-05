import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadPreferences } from '../apps/tui/preferences.js';
import { createDaemon } from '../apps/tui/daemon.js';
import { locations } from '../apps/tui/common.js';

const exec = promisify(execFile);
const managerOptions = { discoveryFactory: async () => ({ list: () => [], refresh() {}, close() {} }), host: '127.0.0.1', monitorIntervalMs: 600000 };

test('cold preferences use Downloads and concurrent saves remain private and survive reload', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-pref-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config'), prefs = await loadPreferences(config, root);
  assert.equal(prefs.snapshot().downloadDirectory, path.join(root, 'Downloads', '拾传'));
  const a = path.join(root, 'A'), b = path.join(root, 'B');
  await Promise.all([prefs.remember(a), prefs.remember(b)]);
  assert.equal((await loadPreferences(config, root)).snapshot().downloadDirectory, b);
  assert.equal((await fs.stat(config)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(config, 'preferences.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(config), ['preferences.json']);
});

test('receive remembers accepted directory, rejects bad selections without changing it, and CLI defaults survive restart', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-pref-'));
  const env = { ...process.env, XDG_DATA_HOME: path.join(root, 'd'), XDG_STATE_HOME: path.join(root, 's'), XDG_CONFIG_HOME: path.join(root, 'c'), XDG_RUNTIME_DIR: path.join(root, 'r') };
  const paths = locations(env);
  let daemon = await createDaemon({ paths, managerOptions });
  t.after(async () => { await daemon.close(); await fs.rm(root, { recursive: true, force: true }); });
  const call = (method, params) => daemon.dispatch(method, params);
  assert.equal((await call('snapshot')).preferences.downloadDirectory, path.join(os.homedir(), 'Downloads', '拾传'));
  const group = await call('create', { name: '偏好测试' });
  const source = path.join(root, 'source.txt'); await fs.writeFile(source, 'saved path');
  async function waitTask(id) {
    for (let n = 0; n < 300; n++) {
      const task = (await call('status')).transfers.find(task => task.id === id);
      if (task && !['queued', 'running'].includes(task.status)) { assert.equal(task.status, 'done', task.error); return task; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('transfer timeout');
  }
  const [upload] = await call('send', { group: group.id, files: [source] }); await waitTask(upload.id);
  const messageId = (await call('messages', { group: group.id })).messages[0].id;
  const directory = path.join(root, '保存 目录');
  const [download] = await call('receive', { group: group.id, messageId, directory }); await waitTask(download.id);
  const preferencesFile = path.join(paths.config, 'preferences.json'), saved = await fs.readFile(preferencesFile, 'utf8');
  for (const params of [
    { messageId, directory: 'relative' }, { messageId, directory: source },
    { messageId: 'missing', directory: path.join(root, 'wrong') }, { messageId, directory: '' },
  ]) {
    await assert.rejects(call('receive', { group: group.id, ...params }));
    assert.equal((await call('status')).preferences.downloadDirectory, directory);
    assert.equal(await fs.readFile(preferencesFile, 'utf8'), saved);
  }
  // A full queue also rejects a new path without remembering it.
  daemon.transfers.running = true;
  try {
    for (let n = 0; n < 200; n++) daemon.transfers.add('download', group.id, { messageId, directory });
    await assert.rejects(call('receive', { group: group.id, messageId, directory: path.join(root, 'full') }), /队列已满/);
    assert.equal(await fs.readFile(preferencesFile, 'utf8'), saved);
  } finally { daemon.transfers.running = false; }
  await daemon.close();
  daemon = await createDaemon({ paths, managerOptions });
  assert.equal((await call('snapshot')).preferences.downloadDirectory, directory);
  const result = await exec(process.execPath, [path.resolve('apps/tui/cli.js'), 'receive', messageId, '--group', group.id, '--wait'], { cwd: root, env });
  const [received] = JSON.parse(result.stdout);
  assert.equal(received.status, 'done'); assert.equal(path.dirname(received.result), directory);
  assert.equal(await fs.readFile(received.result, 'utf8'), 'saved path');
});
