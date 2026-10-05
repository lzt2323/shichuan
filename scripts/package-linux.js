import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const arch = process.argv.find(arg => arg.startsWith('--arch='))?.split('=')[1] || process.arch;
if (!['x64', 'arm64'].includes(arch)) throw new Error('Linux architecture must be x64 or arm64');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const name = `PickDrop-${pkg.version}-Linux-${arch}-TUI`, stage = path.join(root, 'dist', name), app = path.join(stage, 'app');
await fs.rm(stage, { recursive: true, force: true }); await fs.mkdir(app, { recursive: true });
for (const dir of ['server', 'shared', 'apps/tui', 'apps/desktop/public']) await fs.cp(path.join(root, dir), path.join(app, dir), { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'pickdrop-linux', version: pkg.version, type: 'module', private: true }));

// Copy the installed locked dependency closure. pnpm symlinks never escape the
// archive; name/version collisions are installed under their requesting package.
const top = new Map(), copying = new Set();
async function resolvePackage(name, base) {
  const req = createRequire(path.join(base, 'package.json'));
  let file;
  try { file = req.resolve(`${name}/package.json`); }
  catch { file = req.resolve(name); }
  let dir = path.dirname(file);
  for (;;) { try { const data = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); if (data.name === name) return { dir: await fs.realpath(dir), data }; } catch {} const parent = path.dirname(dir); if (parent === dir) throw new Error(`Cannot find ${name}`); dir = parent; }
}
async function dependency(name, base, destination = app) {
  const { dir, data } = await resolvePackage(name, base), identity = `${name}@${data.version}`;
  let target;
  if (!top.has(name)) { top.set(name, identity); target = path.join(app, 'node_modules', name); }
  else if (top.get(name) === identity) { target = path.join(app, 'node_modules', name); }
  else target = path.join(destination, 'node_modules', name);
  if (copying.has(target)) return; copying.add(target);
  await fs.cp(dir, target, { recursive: true, dereference: true, filter: source => path.basename(source) !== 'node_modules' });
  const needed = { ...data.dependencies };
  for (const [peer, version] of Object.entries(data.peerDependencies || {})) if (!data.peerDependenciesMeta?.[peer]?.optional && !peer.startsWith('@types/')) needed[peer] = version;
  for (const child of Object.keys(needed)) await dependency(child, dir, target);
  for (const child of Object.keys(data.optionalDependencies || {})) { try { await dependency(child, dir, target); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; } }
}
for (const name of Object.keys(pkg.dependencies)) await dependency(name, root);
const tui = JSON.parse(await fs.readFile(path.join(root, 'apps/tui/package.json'), 'utf8'));
for (const name of Object.keys(tui.dependencies)) await dependency(name, path.join(root, 'apps/tui'));

const nodeVersion = process.env.PICKDROP_NODE_VERSION || process.version;
if (!/^v24\.\d+\.\d+$/.test(nodeVersion)) throw new Error('Build with Node 24 or set PICKDROP_NODE_VERSION=v24.x.y');
const runtime = `node-${nodeVersion}-linux-${arch}`, filename = `${runtime}.tar.xz`, base = `https://nodejs.org/dist/${nodeVersion}/`;
async function download(url) { const response = await fetch(url); if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`); return Buffer.from(await response.arrayBuffer()); }
const sums = (await download(base + 'SHASUMS256.txt')).toString(), expected = sums.split('\n').find(line => line.endsWith('  ' + filename))?.split(' ')[0];
if (!expected) throw new Error('Official Node checksum missing');
const archive = await download(base + filename);
if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Node runtime checksum mismatch');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-package-'));
try {
  const downloaded = path.join(temporary, filename); await fs.writeFile(downloaded, archive);
  await fs.mkdir(path.join(stage, 'runtime'));
  execFileSync('tar', ['-xJf', downloaded, '-C', path.join(stage, 'runtime'), '--strip-components=1', `${runtime}/bin/node`, `${runtime}/LICENSE`, `${runtime}/README.md`]);
  await fs.writeFile(path.join(stage, 'pickdrop'), '#!/bin/sh\nset -eu\nPICKDROP_INSTALL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$PICKDROP_INSTALL_DIR/runtime/bin/node" "$PICKDROP_INSTALL_DIR/app/apps/tui/cli.js" "$@"\n', { mode: 0o755 });
  await fs.copyFile(path.join(root, 'docs/linux.md'), path.join(stage, 'README.md'));
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  await fs.writeFile(path.join(stage, 'BUILD-INFO.json'), JSON.stringify({ version: pkg.version, architecture: arch, platform: 'linux', nodeVersion, nodeArchiveSHA256: expected, dependencies: [...top.values()], generatedAt: new Date().toISOString() }, null, 2));
  if (process.platform === 'linux' && process.arch === arch) {
    const launcher = path.join(stage, 'pickdrop'), smoke = path.join(temporary, 'smoke'); await fs.mkdir(smoke);
    const env = { ...process.env, XDG_DATA_HOME: path.join(smoke, 'data'), XDG_STATE_HOME: path.join(smoke, 'state'), XDG_CONFIG_HOME: path.join(smoke, 'config'), XDG_RUNTIME_DIR: path.join(smoke, 'run') };
    const run = args => { const result = spawnSync(launcher, args, { env, encoding: 'utf8', timeout: 30000 }); if (result.status !== 0) throw new Error(`Packaged smoke ${args.join(' ')}: ${result.stderr || result.error}`); return result.stdout; };
    run(['--help']); if (!run(['status']).includes('false')) throw new Error('status started a background daemon');
    try { run(['start']); const created = JSON.parse(run(['create', 'Linux package smoke'])); run(['message', 'Packaged runtime works', '--group', created.id]); if (!run(['messages', '--group', created.id]).includes('Packaged runtime works')) throw new Error('Packaged protocol smoke failed'); }
    finally { run(['stop']); }
    // Wait for service shutdown before removing isolated fixture directories.
    for (let n = 0; n < 100; n++) { if (!(await fs.stat(path.join(smoke, 'run/pickdrop/daemon.sock')).catch(() => null))) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  } else console.log('Cross-build: native runtime smoke must run on matching Linux architecture in CI.');
  const output = path.join(root, 'dist', `${name}.tar.gz`);
  execFileSync('tar', ['-czf', output, '-C', path.dirname(stage), name]);
  console.log(output);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
