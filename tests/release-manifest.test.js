import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createManifest, expectedInstallers } from '../scripts/release-manifest.js';

test('unified release requires all platforms before checksums are generated', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = [...expectedInstallers('0.3.0'), 'ANDROID-BUILD.txt'];
  for (const name of files.slice(0, -1)) await writeFile(path.join(directory, name), name);
  await assert.rejects(createManifest(directory, '0.3.0'), { code: 'ENOENT' });
  await writeFile(path.join(directory, files.at(-1)), 'verified');
  await createManifest(directory, '0.3.0');
  const manifest = await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8');
  assert.equal(manifest.trim().split('\n').length, 6);
  assert.ok(manifest.includes(createHash('sha256').update(files[0]).digest('hex')));
  await writeFile(path.join(directory, 'PickDrop-0.2.1-Windows.exe'), 'stale');
  await assert.rejects(createManifest(directory, '0.3.0'), /Unexpected release files/);
  await rm(path.join(directory, 'PickDrop-0.2.1-Windows.exe'));
  await writeFile(path.join(directory, files[0]), '');
  await assert.rejects(createManifest(directory, '0.3.0'), /Empty or invalid/);
});
