import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function expectedInstallers(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
  return [
    `PickDrop-${version}-Mac-AppleSilicon.zip`,
    `PickDrop-${version}-Windows.exe`,
    `PickDrop-${version}-Android-arm64-preview.apk`,
    `PickDrop-${version}-Linux-x64-TUI.tar.gz`,
    `PickDrop-${version}-Linux-arm64-TUI.tar.gz`,
  ];
}

export async function createManifest(directory, version) {
  const required = [...expectedInstallers(version), 'ANDROID-BUILD.txt'];
  const entries = await readdir(directory);
  const unexpected = entries.filter(name => ![...required, 'SHA256SUMS.txt'].includes(name));
  if (unexpected.length) throw new Error(`Unexpected release files: ${unexpected.join(', ')}`);
  const lines = [];
  for (const name of required.sort()) {
    const file = path.join(directory, name);
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) throw new Error(`Empty or invalid release file: ${name}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${name}`);
  }
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  return lines;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lines = await createManifest(path.resolve(process.argv[2] || 'release-assets'), version);
  console.log(`Verified ${lines.length - 1} installers and Android build report for ${version}.`);
}
