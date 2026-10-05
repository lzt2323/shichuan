import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = path.join(root, '.build/desktop');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, 'apps'), { recursive: true });
for (const dir of ['server', 'shared', 'apps/desktop']) {
  await cp(path.join(root, dir), path.join(stage, dir), { recursive: true });
}
for (const file of ['LICENSE', 'README.md']) await cp(path.join(root, file), path.join(stage, file));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, description: pkg.description,
  type: pkg.type, main: pkg.main, author: 'PickDrop contributors',
  license: 'MIT', dependencies: pkg.dependencies,
}, null, 2));

// Install only desktop production dependencies into a conventional node_modules.
// This avoids packaging pnpm links or any of the mobile development toolchain.
await new Promise((resolve, reject) => {
  const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['install', '--prod', '--ignore-scripts', '--ignore-workspace', '--config.node-linker=hoisted', '--no-frozen-lockfile'],
    { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Desktop dependencies failed: ${code}`)));
});
console.log('Desktop production files prepared.');
