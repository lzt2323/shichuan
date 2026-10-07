import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (process.platform !== 'darwin') throw new Error('Mac archiving requires macOS.');
// Packaging can succeed with a stale Electron linker signature. Never publish
// that bundle: Gatekeeper reports it as damaged, not merely unnotarized.
await new Promise((resolve, reject) => {
  const child = spawn('codesign', ['--verify', '--deep', '--strict', '--verbose=2',
    'dist/mac-arm64/PickDrop.app'],
  { cwd: new URL('../', import.meta.url), stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Mac signature verification failed: ${code}`)));
});
await new Promise((resolve, reject) => {
  const child = spawn('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent',
    'dist/mac-arm64/PickDrop.app', `dist/PickDrop-${version}-Mac-AppleSilicon.zip`],
  { cwd: new URL('../', import.meta.url), stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Mac archive failed: ${code}`)));
});
