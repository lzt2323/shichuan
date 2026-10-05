import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { installLauncher, uninstallLauncher } from '../apps/tui/launcher.js';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-launch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('launcher works from another directory with spaces and apostrophes in runtime, app and arguments', async t => {
  const root = await temporary(t), app = path.join(root, "app's folder"), binDirectory = path.join(root, "user's bin");
  await fs.mkdir(app);
  const nodePath = path.join(app, "node's runtime"), cliPath = path.join(app, 'entry point.cjs');
  await fs.symlink(process.execPath, nodePath);
  await fs.writeFile(cliPath, 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));');
  const result = await installLauncher({ binDirectory, nodePath, cliPath, searchPath: '/usr/bin' });
  assert.equal(result.onPath, false);
  const run = spawnSync('sh', ['-c', `${result.pathCommand}\nexec pickdrop 'a b' "c'd"`], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { args: ['a b', "c'd"], cwd: await fs.realpath(root) });
  assert.equal((await fs.stat(result.destination)).mode & 0o777, 0o755);
  const updated = await installLauncher({ binDirectory, searchPath: binDirectory });
  assert.equal(updated.onPath, true);
  const help = spawnSync(updated.destination, ['--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /pickdrop open/);
  assert.equal((await uninstallLauncher({ binDirectory })).removed, true);
  assert.equal((await uninstallLauncher({ binDirectory })).removed, false);
});

test('launcher refuses to overwrite or remove unrelated files, directories and symlinks', async t => {
  const root = await temporary(t), destination = path.join(root, 'pickdrop');
  await fs.writeFile(destination, '#!/bin/sh\necho unrelated\n');
  await assert.rejects(installLauncher({ binDirectory: root }), /拒绝覆盖/);
  await assert.rejects(uninstallLauncher({ binDirectory: root }), /拒绝删除/);
  assert.equal(await fs.readFile(destination, 'utf8'), '#!/bin/sh\necho unrelated\n');
  await fs.unlink(destination); await fs.symlink('missing', destination);
  await assert.rejects(installLauncher({ binDirectory: root }), /拒绝覆盖/);
  await assert.rejects(uninstallLauncher({ binDirectory: root }), /拒绝删除/);
  await fs.unlink(destination); await fs.mkdir(destination);
  await assert.rejects(installLauncher({ binDirectory: root }), /拒绝覆盖/);
  await assert.rejects(uninstallLauncher({ binDirectory: root }), /拒绝删除/);
});

test('CLI installs into isolated custom directory and stop/open do not start a daemon without a TTY', async t => {
  const root = await temporary(t), cli = path.resolve('apps/tui/cli.js'), binDirectory = path.join(root, 'bin');
  const env = { ...process.env, XDG_RUNTIME_DIR: root, XDG_STATE_HOME: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root };
  const installed = spawnSync(process.execPath, [cli, 'install', '--bin-dir', binDirectory], { env, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr); assert.match(installed.stdout, /export PATH=/);
  for (const command of ['stop', 'stop', 'open']) {
    const result = spawnSync(path.join(binDirectory, 'pickdrop'), [command], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(await fs.readdir(root), ['bin']);
  const removed = spawnSync(process.execPath, [cli, 'uninstall', '--bin-dir', binDirectory], { env, encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stderr);
});
