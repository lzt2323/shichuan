import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { safeFileName } from '../shared/protocol.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validMessage(message) {
  return message && UUID.test(message.id) && UUID.test(message.senderId) &&
    typeof message.senderName === 'string' && typeof message.createdAt === 'string' &&
    (message.type === 'text' ? typeof message.text === 'string' : message.type === 'file' &&
      typeof message.fileName === 'string' && safeFileName(message.fileName) === message.fileName &&
      Number.isSafeInteger(message.size) && message.size >= 0 && /^[a-f0-9]{64}$/i.test(message.sha256 || ''));
}

/** Payloads stay on disk. Indexed pages and inserts cost O(page size), not O(history). */
export async function openHistoryStore(dataDir, legacyMessages = [], { requireExisting = false } = {}) {
  if (!Array.isArray(legacyMessages) || !legacyMessages.every(validMessage)) throw new Error('群历史格式不正确，已保留原始文件');
  const file = path.join(dataDir, 'history.sqlite');
  const existing = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (requireExisting && (!existing || !existing.size)) throw Object.assign(new Error('群历史数据库缺失，已保留原文件，请从备份恢复'), { code: 'PICKDROP_STORAGE_INVALID' });
  const db = new DatabaseSync(file);
  try {
    await fs.chmod(file, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('群历史由更新版本创建，请升级拾传');
    if ((requireExisting || existing?.size) && (version !== 1 || !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get())) {
      throw Object.assign(new Error('群历史数据库结构损坏，已保留原文件，请从备份恢复'), { code: 'PICKDROP_STORAGE_INVALID' });
    }
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS files_by_state ON messages(kind, deleted, sequence);
      PRAGMA user_version=1;`);
    const insert = db.prepare('INSERT OR IGNORE INTO messages(id,kind,size,deleted,payload) VALUES(?,?,?,?,?)');
    if (legacyMessages.length) {
      // An interrupted migration can be retried without duplicating messages.
      await fs.copyFile(path.join(dataDir, 'history.json'), path.join(dataDir, 'history.pre-sqlite.json'), fs.constants?.COPYFILE_EXCL ?? 1).catch(error => { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; });
      db.exec('BEGIN IMMEDIATE');
      try { for (const message of legacyMessages) insert.run(message.id, message.type, message.size || 0, message.deleted ? 1 : 0, JSON.stringify(message)); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    let closed = false;
    const decode = row => row ? { ...JSON.parse(row.payload), sequence: Number(row.sequence) } : null;
    const count = db.prepare('SELECT COUNT(*) AS total, MAX(sequence) AS latest FROM messages');
    const newest = db.prepare('SELECT sequence,payload FROM messages ORDER BY sequence DESC LIMIT ?');
    const older = db.prepare('SELECT sequence,payload FROM messages WHERE sequence < ? ORDER BY sequence DESC LIMIT ?');
    const byId = db.prepare('SELECT sequence,payload FROM messages WHERE id=?');
    const update = db.prepare('UPDATE messages SET payload=?, deleted=? WHERE id=?');
    return {
      page({ before, limit = 100 } = {}) {
        limit = Math.max(1, Math.min(100, Number(limit) || 100));
        if (before != null && (!/^\d+$/.test(String(before)) || !Number.isSafeInteger(Number(before)))) throw Object.assign(new Error('历史游标不正确'), { status: 400 });
        const rows = before == null ? newest.all(limit + 1) : older.all(Number(before), limit + 1);
        const hasMore = rows.length > limit, messages = rows.slice(0, limit).reverse().map(decode), summary = count.get();
        return { messages, history: { hasMore, before: messages.length ? String(messages[0].sequence) : null,
          latest: summary.latest == null ? null : String(summary.latest), total: Number(summary.total) } };
      },
      get(id) { return decode(byId.get(id)); },
      add(message) {
        if (!validMessage(message)) throw new Error('消息格式不正确');
        insert.run(message.id, message.type, message.size || 0, message.deleted ? 1 : 0, JSON.stringify(message));
        return decode(byId.get(message.id));
      },
      markDeleted(id) {
        const message = decode(byId.get(id));
        if (!message || message.type !== 'file') return null;
        const next = { ...message, deleted: true, deletedAt: new Date().toISOString() };
        update.run(JSON.stringify(next), 1, id); return next;
      },
      files({ before, limit = 100 } = {}) {
        return db.prepare('SELECT sequence,payload FROM messages WHERE kind=\'file\' AND deleted=0 AND sequence < ? ORDER BY sequence DESC LIMIT ?')
          .all(before == null ? Number.MAX_SAFE_INTEGER : Number(before), Math.max(1, Math.min(100, Number(limit) || 100))).map(decode);
      },
      stats() { const row = db.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM messages WHERE kind='file' AND deleted=0").get(); return { files: Number(row.files), bytes: Number(row.bytes) }; },
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
}
