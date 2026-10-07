import path from 'node:path';
import { promises as fs } from 'node:fs';

export const CACHE_POLICY = { maxBytes: 512 * 1024 * 1024, maxAgeDays: 7 };
// Traversal never follows symlinks. This module only receives app-owned roots.
async function safeDirectory(folder, boundary) {
  const base = path.resolve(boundary), target = path.resolve(folder), relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('缓存路径不在应用目录内');
  // Check every app-owned component. Ancestors outside the trusted boundary may
  // be normal OS aliases (for example /var on macOS), so do not inspect those.
  const components = relative ? relative.split(path.sep) : [];
  let current = base;
  for (let index = 0; index <= components.length; index++) {
    if (index) current = path.join(current, components[index - 1]);
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

export async function cacheEntries(root, { boundary = root } = {}) {
  const result = [];
  async function walk(folder) {
    if (!await safeDirectory(folder, boundary)) return;
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) continue; result.push({ path: file, bytes: stat.size, usedAt: stat.mtimeMs, partial: /(?:\.part|\.partial|\.uploading)$/.test(entry.name) }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  await walk(root); return result;
}
export async function cacheStats(root, options) {
  const entries = await cacheEntries(root, options);
  return { bytes: entries.reduce((total, entry) => total + entry.bytes, 0), files: entries.filter(entry => !entry.partial).length, ...CACHE_POLICY };
}
export async function cleanCache(root, { clear = false, protectedPaths = new Set(), now = Date.now(), boundary = root, ...policy } = {}) {
  const { maxBytes, maxAgeDays } = { ...CACHE_POLICY, ...policy };
  const entries = (await cacheEntries(root, { boundary })).sort((a, b) => a.usedAt - b.usedAt);
  let bytes = entries.reduce((sum, item) => sum + item.bytes, 0), removedBytes = 0, removedFiles = 0;
  for (const item of entries) {
    if ([...protectedPaths].some(p => item.path === p || item.path.startsWith(p + path.sep))) continue;
    if (!(clear || item.usedAt < now - (item.partial ? 1 : maxAgeDays) * 86400000 || bytes > maxBytes)) continue;
    if (!await safeDirectory(path.dirname(item.path), boundary)) continue;
    // A save/drag may have pinned this path while directory checks awaited IO.
    if ([...protectedPaths].some(p => item.path === p || item.path.startsWith(p + path.sep))) continue;
    await fs.rm(item.path, { force: true }); bytes -= item.bytes; removedBytes += item.bytes; removedFiles++;
  }
  return { ...await cacheStats(root, { boundary }), removedBytes, removedFiles };
}
