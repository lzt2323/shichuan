import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

// Terminal data is untrusted even when it came from a paired peer. Remove OSC/CSI
// and all control bytes (including C1), preserving only printable text and LF.
export function terminalText(value) {
  return String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
export function locations(env = process.env, home = os.homedir()) {
  const data = path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'pickdrop');
  const state = path.join(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'pickdrop');
  const config = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'pickdrop');
  const runtime = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'pickdrop') : path.join(state, 'run');
  // Darwin and Linux both limit Unix socket paths; never fall back to public /tmp.
  const socket = path.join(runtime, 'daemon.sock');
  if (Buffer.byteLength(socket) > 100) throw new Error('运行目录路径太长，请将 XDG_RUNTIME_DIR 设置为较短的私有目录');
  return { data, state, config, runtime, socket, lock: path.join(runtime, 'daemon.lock'), log: path.join(state, 'daemon.log') };
}
export async function privateDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('拾传目录必须由当前用户拥有，且不能是符号链接');
  await fs.chmod(dir, 0o700);
}
export function groupBy(groups, query) {
  if (!query && groups.length === 1) return groups[0];
  const exact = groups.filter(g => g.id === query || g.name === query);
  const matches = exact.length ? exact : groups.filter(g => query && g.id.startsWith(query));
  if (matches.length !== 1) throw new Error(matches.length ? '群名称不唯一，请使用完整群 ID' : '请使用 --group 指定群名称或 ID');
  return matches[0];
}
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function expandPath(value, cwd = process.cwd()) {
  const input = String(value);
  return path.resolve(cwd, input === '~' ? os.homedir() : input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input);
}
export async function completePath(value, cwd) {
  const full = expandPath(value || './', cwd), trailing = /\/$/.test(value), dir = trailing ? full : path.dirname(full), prefix = trailing ? '' : path.basename(full);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter(e => e.name.startsWith(prefix)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 100).map(e => ({ name: e.name, path: path.join(dir, e.name), directory: e.isDirectory() }));
}

export function progressLabel(task, columns = 80) {
  const ratio = task.total > 0 ? Math.max(0, Math.min(1, task.bytes / task.total)) : task.status === 'done' ? 1 : 0;
  const percent = `${Math.floor(ratio * 100)}%`;
  if (columns < 18) return task.status === 'queued' ? '等待' : percent;
  const cells = Math.max(4, Math.min(16, columns - 18)), completed = Math.floor(cells * ratio);
  return `${'█'.repeat(completed)}${'░'.repeat(cells - completed)} ${task.status === 'queued' ? '等待' : percent}`;
}
