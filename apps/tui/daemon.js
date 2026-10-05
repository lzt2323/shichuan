import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createGroupManager } from '../../server/groups.js';
import { locations, privateDirectory, groupBy, completePath } from './common.js';
import { TransferQueue } from './transfers.js';
import { loadPreferences, validateDownloadDirectory } from './preferences.js';

const publicGroup = ({ key, ...group }) => group;
export async function createDaemon({ paths = locations(), managerOptions = {} } = {}) {
  await Promise.all([paths.data, paths.state, paths.runtime].map(privateDirectory));
  const preferences = await loadPreferences(paths.config);
  // Publish the lock only after its owner file is fully written. A crash
  // between mkdir and writing pid can no longer strand an empty public lock.
  const claim = `${paths.lock}.${randomUUID()}.tmp`;
  await fs.mkdir(claim, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(claim, 'pid'), String(process.pid), { mode: 0o600 });
    try { await fs.rename(claim, paths.lock); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      const pid = Number(await fs.readFile(path.join(paths.lock, 'pid'), 'utf8').catch(() => ''));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); throw new Error('后台服务已在运行'); }
        catch (check) { if (check.code !== 'ESRCH') throw check; }
      } else {
        const info = await fs.stat(paths.lock);
        if (Date.now() - info.mtimeMs < 30000) throw new Error('后台锁正在初始化，请 30 秒后重试');
      }
      await fs.rm(paths.lock, { recursive: true });
      // rename refuses to replace a concurrently published nonempty owner lock.
      await fs.rename(claim, paths.lock);
    }
  } finally { await fs.rm(claim, { recursive: true, force: true }); }
  let manager;
  try { manager = await createGroupManager({ dataDir: paths.data, device: { id: randomUUID(), name: os.hostname(), kind: 'desktop' }, ...managerOptions }); }
  catch (error) { await fs.rm(paths.lock, { recursive: true, force: true }); throw error; }
  let closingPromise, closed = false, refreshing = false, lastError = null;
  const states = new Map(), sockets = new Map(), tickets = new Map(), joins = new Map(), requests = new Map();
  async function api(group, route, { body, method = 'GET' } = {}) {
    return manager.authenticated(group.id, route, { method, body });
  }
  const transfers = new TransferQueue({ manager, fetchState: group => api(group, '/api/state') });
  async function connectedGroup(query) {
    const group = await manager.resolveGroup(groupBy(manager.listGroups(), query).id);
    if (!group.online) throw new Error('群主机离线，请确认电脑与手机处于可互通的局域网');
    return group;
  }
  async function refresh() {
    if (refreshing || closed) return; refreshing = true;
    try {
      await Promise.allSettled(manager.listGroups().map(async stored => {
        const group = await manager.resolveGroup(stored.id);
        if (closed) return;
        let socket = sockets.get(group.id);
        if (!group.online) { socket?.close(); sockets.delete(group.id); return; }
        if (!socket || socket.baseUrl !== group.baseUrl || socket.readyState > 1) {
          socket?.close();
          await api(group, '/api/join', { method: 'POST', body: manager.device });
          if (closed) return;
          const url = new URL('/api/events', group.baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('key', group.key); url.searchParams.set('device', manager.device.id);
          socket = new WebSocket(url, { followRedirects: false, handshakeTimeout: 5000, localAddress: manager.getNetwork?.().selected?.address, maxPayload: 16 * 1024 * 1024 }); socket.baseUrl = group.baseUrl;
          socket.on('error', () => {});
          socket.on('message', bytes => { try { const state = JSON.parse(bytes.toString()); if (state.type === 'state') states.set(group.id, state); } catch {} });
          sockets.set(group.id, socket);
          states.set(group.id, await api(group, '/api/state'));
        }
        requests.set(group.id, await manager.listJoinRequests(group.id));
      }));
      for (const [id, ticket] of tickets) {
        if (closed) break;
        try { const result = await manager.checkJoin(ticket); joins.set(id, { id, groupName: ticket.groupName, status: result.status }); if (result.status !== 'pending') tickets.delete(id); }
        catch (error) { joins.set(id, { id, groupName: ticket.groupName, status: 'pending', error: error.message }); }
      }
    } finally { refreshing = false; }
  }
  manager.events.on('discovery-error', () => { lastError = '自动发现暂不可用，可使用完整邀请链接；检查组播、防火墙及网络权限'; });
  const interval = setInterval(() => { void refresh(); }, 1500); interval.unref();
  const network = () => manager.getNetwork?.() || { interfaces: Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => entries.filter(x => !x.internal && x.family === 'IPv4').map(x => ({ name, address: x.address }))) };
  async function dispatch(method, p = {}) {
    if (closed) throw new Error('后台服务正在停止');
    switch (method) {
      case 'status': return { device: manager.device, groups: manager.listGroups().map(publicGroup), network: network(), transfers: transfers.list(), joins: [...joins.values()], preferences: preferences.snapshot(), discoveryError: lastError, pid: process.pid };
      case 'snapshot': {
        const groups = manager.listGroups(), group = p.group ? groupBy(groups, p.group) : groups[0];
        return { ...await dispatch('status'), selectedGroupId: group?.id, state: group ? states.get(group.id) || { messages: [], devices: [] } : { messages: [], devices: [] }, requests: group ? requests.get(group.id) || [] : [] };
      }
      case 'create': { const group = await manager.createGroup(p.name); void refresh(); return publicGroup(group); }
      case 'nearby': return manager.listNearby?.() || [];
      case 'networks': return network();
      case 'network': {
        if (transfers.list().some(t => ['queued', 'running'].includes(t.status))) throw new Error('请等待传输完成，或先取消传输再切换网络');
        if (!manager.setNetwork) throw new Error('当前服务不支持网络选择');
        return manager.setNetwork(p.selection);
      }
      case 'join': {
        let ticket;
        if (p.link) {
          const url = new URL(p.link);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('邀请链接格式不正确');
          const hash = new URLSearchParams(url.hash.slice(1)), code = hash.get('invite');
          if (!/^\d{6}$/.test(code || '')) throw new Error('请粘贴包含 6 位邀请码的完整邀请链接');
          if (!manager.joinAt) throw new Error('当前服务不支持链接加入');
          ticket = await manager.joinAt(url.origin, code, hash.get('group') || undefined);
          if (hash.get('group') && hash.get('group') !== ticket.groupId) throw new Error('邀请与目标群不匹配');
        } else if (p.address) { ticket = await manager.joinAt(p.address, p.code, p.expectedGroupId); }
        else ticket = await manager.joinWithCode(p.code);
        tickets.set(ticket.requestId, ticket); const result = { id: ticket.requestId, groupName: ticket.groupName, status: 'pending' }; joins.set(ticket.requestId, result); return result;
      }
      case 'invite': return manager.createInvite((await connectedGroup(p.group)).id);
      case 'respond': return manager.respondJoin((await connectedGroup(p.group)).id, p.requestId, p.allow);
      case 'messages': { const group = await connectedGroup(p.group); return api(group, '/api/state'); }
      case 'text': { const group = await connectedGroup(p.group); return api(group, '/api/messages', { method: 'POST', body: { text: p.text } }); }
      case 'send': {
        const group = groupBy(manager.listGroups(), p.group);
        if (!Array.isArray(p.files) || !p.files.length || p.files.length > 100) throw new Error('请选择 1 至 100 个文件');
        for (const source of p.files) { if (!path.isAbsolute(source) || !(await fs.stat(source)).isFile()) throw new Error('只能发送普通文件，目录请先压缩'); }
        return p.files.map(source => transfers.add('upload', group.id, { source }));
      }
      case 'receive': {
        const group = await connectedGroup(p.group), state = await api(group, '/api/state');
        const messages = state.messages.filter(m => m.type === 'file' && (p.all || m.id === p.messageId));
        if (!messages.length) throw new Error('找不到文件；请指定文件 ID 或使用 --all');
        const directory = await validateDownloadDirectory(p.directory ?? preferences.snapshot().downloadDirectory);
        const tasks = [];
        try {
          for (const message of messages) tasks.push(transfers.add('download', group.id, { messageId: message.id, directory }));
          if (p.directory !== undefined) await preferences.remember(directory);
          return tasks;
        } catch (error) { for (const task of tasks) transfers.cancel(task.id); throw error; }
      }
      case 'cancel': transfers.cancel(p.id); return { ok: true };
      case 'retry': transfers.retry(p.id); return { ok: true };
      case 'browse': return completePath(p.value, p.cwd);
      case 'stop': setTimeout(() => void close(), 30); return { stopped: true };
      default: throw new Error('未知操作');
    }
  }
  const server = http.createServer(async (req, res) => {
    let body = '';
    try {
      if (req.method !== 'POST' || req.url !== '/rpc') throw new Error('仅支持本机 RPC');
      for await (const chunk of req) { body += chunk; if (body.length > 256 * 1024) throw new Error('请求过大'); }
      const { method, params } = JSON.parse(body), result = await dispatch(method, params);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result }));
    } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  server.requestTimeout = 10000;
  async function close() {
    if (closingPromise) return closingPromise;
    closed = true; clearInterval(interval);
    closingPromise = (async () => {
      // Stop accepting local work first. Abort transfer streams and sockets before
      // waiting for bounded host requests, so a lost network cannot hold exit open.
      const listenerClosed = new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await transfers.close(); for (const socket of sockets.values()) socket.terminate();
      while (refreshing) await new Promise(resolve => setTimeout(resolve, 20));
      for (const socket of sockets.values()) socket.terminate();
      await manager.close(); await listenerClosed;
      await fs.rm(paths.socket, { force: true }); await fs.rm(paths.lock, { recursive: true, force: true });
    })();
    return closingPromise;
  }
  try { await fs.rm(paths.socket, { force: true }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, resolve); }); await fs.chmod(paths.socket, 0o600); }
  catch (error) { await manager.close(); await fs.rm(paths.lock, { recursive: true, force: true }); throw error; }
  void refresh();
  return { dispatch, close, manager, paths, transfers };
}
