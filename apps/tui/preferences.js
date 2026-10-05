import os from 'node:os';
import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from './common.js';

export async function loadPreferences(configDirectory, home = os.homedir()) {
  await privateDirectory(configDirectory);
  const file = path.join(configDirectory, 'preferences.json');
  let downloadDirectory = path.join(home, 'Downloads', '拾传');
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error('偏好设置必须是当前用户拥有的普通文件');
      const saved = JSON.parse(await handle.readFile('utf8'));
      if (typeof saved.downloadDirectory === 'string' && path.isAbsolute(saved.downloadDirectory)) downloadDirectory = saved.downloadDirectory;
      await handle.chmod(0o600);
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let pending = Promise.resolve();
  return {
    snapshot: () => ({ downloadDirectory }),
    remember(directory) {
      const update = pending.then(async () => {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify({ downloadDirectory: directory }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, file);
          downloadDirectory = directory;
        } finally { await fs.rm(temporary, { force: true }); }
      });
      pending = update.catch(() => {});
      return update;
    },
  };
}

export async function validateDownloadDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw new Error('请选择绝对下载路径');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('请选择保存文件的目录');
  // Probe the actual operation, including ACLs and read-only mounts.
  const probe = path.join(directory, `.pickdrop-write-${randomUUID()}`);
  const handle = await fs.open(probe, 'wx', 0o600);
  try { await handle.close(); } finally { await fs.rm(probe, { force: true }); }
  return path.normalize(directory);
}
