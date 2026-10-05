import os from 'node:os';
import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

const marker = '#!/bin/sh\n# PickDrop managed launcher v1\n';
export const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
export const defaultBinDirectory = () => path.join(os.homedir(), '.local', 'bin');

export async function installLauncher({ binDirectory = defaultBinDirectory(), nodePath = process.execPath, cliPath = fileURLToPath(new URL('./cli.js', import.meta.url)), searchPath = process.env.PATH || '' } = {}) {
  binDirectory = path.resolve(binDirectory);
  const destination = path.join(binDirectory, 'pickdrop');
  const contents = `${marker}exec ${shellQuote(nodePath)} ${shellQuote(cliPath)} "$@"\n`;
  await fs.mkdir(binDirectory, { recursive: true, mode: 0o755 });
  let handle;
  try { handle = await fs.open(destination, 'wx', 0o755); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`拒绝覆盖已有命令：${destination}`);
    handle = await fs.open(destination, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const existing = await handle.stat();
      if (!existing.isFile() || (process.getuid && existing.uid !== process.getuid()) || !(await handle.readFile('utf8')).startsWith(marker)) throw new Error(`拒绝覆盖已有命令：${destination}`);
    } catch (error) { await handle.close(); throw error; }
  }
  try {
    const bytes = Buffer.from(contents);
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.truncate(bytes.length);
    await handle.chmod(0o755);
  } finally { await handle.close(); }
  const onPath = searchPath.split(path.delimiter).some(entry => entry && path.resolve(entry) === binDirectory);
  return { destination, binDirectory, onPath, pathCommand: `export PATH=${shellQuote(binDirectory)}:"$PATH"` };
}

export async function uninstallLauncher({ binDirectory = defaultBinDirectory() } = {}) {
  const destination = path.join(path.resolve(binDirectory), 'pickdrop');
  let stat;
  try { stat = await fs.lstat(destination); }
  catch (error) { if (error.code === 'ENOENT') return { destination, removed: false }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || !(await fs.readFile(destination, 'utf8')).startsWith(marker)) throw new Error(`拒绝删除其他命令：${destination}`);
  await fs.unlink(destination);
  return { destination, removed: true };
}
