import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Keep a last-known-good copy; never silently replace damaged user data. */
export async function readJsonWithBackup(file, validate = () => true, { recover = true } = {}) {
  const read = async target => {
    const value = JSON.parse(await fs.readFile(target, 'utf8'));
    if (!validate(value)) throw new Error('数据格式不正确');
    return value;
  };
  try { return await read(file); }
  catch (error) {
    if (error.code === 'ENOENT') {
      // A surviving backup means this is damaged existing storage, not a first
      // launch. In particular, never reset authorization around old data.
      try { await fs.access(file + '.bak'); }
      catch (backupError) { if (backupError.code === 'ENOENT') return undefined; throw backupError; }
      if (recover) return await read(file + '.bak');
    }
    // Authorization metadata must fail closed: an older backup can contain a
    // revoked credential. It is retained for explicit recovery, not auto-login.
    if (!recover) throw Object.assign(new Error(`无法读取 ${file}，原文件已保留，请从备份恢复`), { code: 'PICKDROP_STORAGE_INVALID', cause: error });
    try {
      const value = await read(file + '.bak');
      await fs.copyFile(file, `${file}.damaged-${Date.now()}`);
      await fs.copyFile(file + '.bak', file);
      return value;
    } catch {
      throw Object.assign(new Error(`无法读取 ${file}，原文件已保留，请从备份恢复`), { code: 'PICKDROP_STORAGE_INVALID', cause: error });
    }
  }
}

export async function writeJsonWithBackup(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    // Backup is the previous committed state. A failed write never destroys it.
    try { await fs.copyFile(file, file + '.bak'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}
