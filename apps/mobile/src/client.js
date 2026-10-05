import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

// Transport and persistence are injected so the exact mobile protocol is also
// exercised against the real server by Node integration tests.
const SESSION_KEY = 'pickdrop-session-v2';
const LEGACY_KEY = 'pickdrop-connection-v1';
const GROUP_PREFIX = 'pickdrop-group-v2-';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[a-f0-9]{64}$/;
const failure = (message, status) => Object.assign(new Error(message), { status });
const abortError = () => Object.assign(new Error('操作已取消'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
function baseAddress(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw failure('请粘贴电脑端完整邀请链接'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('邀请链接必须是有效的 HTTP 或 HTTPS 地址');
  return url;
}
export function parseInviteLink(value) {
  const url = baseAddress(value), params = new URLSearchParams(url.hash.slice(1));
  const code = params.get('invite'), groupId = params.get('group'), key = params.get('key');
  if (code !== null) {
    if (!/^\d{6}$/.test(code) || (groupId !== null && !UUID.test(groupId))) throw failure('邀请链接不完整，请重新获取二维码');
    return { baseUrl: url.origin, code, ...(groupId ? { groupId } : {}), legacy: false };
  }
  if (!KEY.test(key || '')) throw failure('请使用电脑端生成的完整邀请链接，六位邀请码需要主机地址');
  return { baseUrl: url.origin, key, legacy: true };
}
function validateGroup(group) {
  if (!UUID.test(group?.id) || !KEY.test(group?.key) || typeof group.name !== 'string' || !group.name.trim() || (!group.legacy && !UUID.test(group.hostDeviceId))) throw failure('保存的群信息不完整，请重新配对');
  return { id: group.id, name: group.name.slice(0, 40), key: group.key, baseUrl: baseAddress(group.baseUrl).origin, ...(group.hostDeviceId ? { hostDeviceId: group.hostDeviceId } : {}), ...(group.legacy ? { legacy: true } : {}) };
}
function delay(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(finish, ms);
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(abortError()); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}
export function createMobileClient({ storage, randomUUID, deviceName = '我的手机', kind = 'ios', fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, requestTimeoutMs = 10000, reconnectMs = 1500 }) {
  let session, initialize, writes = Promise.resolve();
  const watches = new Set();
  const snapshot = () => ({ ...session, device: { ...session.device }, groups: session.groups.map(group => ({ ...group })) });
  async function persist(next) {
    // Each credential is a small SecureStore value; a growing history is never
    // written to keychain, and the manifest is committed after its group records.
    for (const group of next.groups) await storage.setItemAsync(GROUP_PREFIX + group.id, JSON.stringify(group));
    await storage.setItemAsync(SESSION_KEY, JSON.stringify({ version: 2, device: next.device, groupIds: next.groups.map(group => group.id), activeGroupId: next.activeGroupId }));
    session = next;
  }
  const mutate = operation => {
    const work = writes.catch(() => {}).then(async () => { await client.init(); return operation(); });
    writes = work; return work;
  };
  async function request(baseUrl, route, { method = 'GET', body, headers = {}, signal } = {}) {
    checkAbort(signal);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
    try {
      const response = await fetchImpl(baseUrl + route, { method, redirect: 'error', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      let data;
      try { data = await response.json(); } catch { throw failure('主机返回的数据不完整，请重试', response.status); }
      if (!response.ok) throw failure(data.error || '连接失败，请检查电脑是否在线', response.status);
      checkAbort(signal); return data;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut) throw failure('连接超时，请确认手机和电脑在同一网络', 408);
      if (error instanceof TypeError) throw failure('暂时无法连接电脑，请检查网络和电脑地址', 503);
      throw error;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  async function authenticate(group, signal) {
    const challenge = (randomUUID() + randomUUID()).replace(/-/g, '');
    const info = await request(group.baseUrl, '/api/group/probe', { method: 'POST', body: { challenge }, signal });
    const expected = bytesToHex(hmac(sha256, utf8ToBytes(group.key), utf8ToBytes(`${info.groupId}:${challenge}`)));
    // No room key is sent before the server proves possession. A saved LAN
    // address may now belong to a different machine after network changes.
    if (!UUID.test(info.groupId) || !UUID.test(info.hostDeviceId) || (!group.legacy && info.groupId !== group.id) || (group.hostDeviceId && info.hostDeviceId !== group.hostDeviceId) || info.proof !== expected) throw failure('电脑身份校验失败，请重新扫描该群邀请二维码', 401);
    return info;
  }
  async function remember(group, signal) {
    return mutate(async () => {
      checkAbort(signal); const nextGroup = validateGroup(group);
      // A legacy link and a fresh invitation to the same host/key are one group.
      const groups = session.groups.filter(item => item.id !== nextGroup.id && !(item.baseUrl === nextGroup.baseUrl && item.key === nextGroup.key));
      await persist({ ...session, groups: [...groups, nextGroup], activeGroupId: nextGroup.id });
      return { ...nextGroup };
    });
  }
  const client = {
    init() {
      if (session) return Promise.resolve(snapshot());
      if (!initialize) initialize = (async () => {
        const value = await storage.getItemAsync(SESSION_KEY);
        if (value) {
          const saved = JSON.parse(value);
          if (saved.version !== 2 || !UUID.test(saved.device?.id) || !Array.isArray(saved.groupIds)) throw failure('手机连接记录无法读取，请检查安全存储');
          const groups = await Promise.all(saved.groupIds.map(async id => {
            if (!UUID.test(id)) throw failure('群记录无法读取');
            const value = await storage.getItemAsync(GROUP_PREFIX + id);
            if (!value) throw failure('群凭据缺失，请重新配对');
            const group = validateGroup(JSON.parse(value));
            if (group.id !== id) throw failure('群记录不匹配');
            return group;
          }));
          session = { device: saved.device, groups, activeGroupId: groups.some(g => g.id === saved.activeGroupId) ? saved.activeGroupId : groups[0]?.id || null };
        } else {
          const legacy = await storage.getItemAsync(LEGACY_KEY);
          let previous;
          if (legacy) { try { previous = JSON.parse(legacy); } catch { throw failure('旧版连接记录无法读取，原记录已保留'); } }
          const device = UUID.test(previous?.device?.id) ? { ...previous.device } : { id: randomUUID(), name: deviceName, kind };
          let groups = [];
          if (previous?.room) {
            const link = parseInviteLink(`${previous.room.baseUrl}/#key=${previous.room.key}`);
            groups = [{ id: randomUUID(), name: '我的传输群', baseUrl: link.baseUrl, key: link.key, legacy: true }];
          }
          await persist({ device, groups, activeGroupId: groups[0]?.id || null });
          // Keep the v1 source until a successful v2 commit; retaining it also
          // lets an old build reopen without losing its original connection.
        }
        return snapshot();
      })().catch(error => { initialize = null; throw error; });
      return initialize;
    },
    get device() { if (!session) throw failure('手机身份尚未载入'); return { ...session.device }; },
    getSession() { if (!session) throw failure('手机身份尚未载入'); return snapshot(); },
    listGroups() { return session ? session.groups.map(group => ({ ...group })) : []; },
    getGroup(id) { const group = session?.groups.find(item => item.id === id); if (!group) throw failure('找不到这个群，请重新加入', 404); return { ...group }; },
    authHeaders(id) { const group = client.getGroup(id); return { 'X-Room-Key': group.key, 'X-Device-Id': client.device.id }; },
    verifyGroup(id, options = {}) { return authenticate(client.getGroup(id), options.signal); },
    async api(id, route, options = {}) {
      if (!route.startsWith('/api/') || route.startsWith('//') || route.includes('#')) throw failure('请求地址不正确');
      const group = client.getGroup(id);
      await authenticate(group, options.signal);
      return request(group.baseUrl, route, { ...options, headers: { ...options.headers, ...client.authHeaders(id) } });
    },
    setActiveGroup(id) { return mutate(async () => { if (id !== null) client.getGroup(id); await persist({ ...session, activeGroupId: id }); }); },
    removeGroup(id) { return mutate(async () => {
      const groups = session.groups.filter(g => g.id !== id);
      await persist({ ...session, groups, activeGroupId: session.activeGroupId === id ? groups[0]?.id || null : session.activeGroupId });
      for (const watch of watches) if (watch.groupId === id) watch.close();
      await storage.deleteItemAsync?.(GROUP_PREFIX + id);
    }); },
    rename(name) { return mutate(async () => {
      if (!String(name).trim()) throw failure('请输入设备名称');
      const device = { ...session.device, name: String(name).trim().slice(0, 40) };
      await persist({ ...session, device });
      await Promise.allSettled(session.groups.map(group => client.api(group.id, '/api/join', { method: 'POST', body: device })));
      return { ...device };
    }); },
    reconnectAt(id, baseUrl, options = {}) { return mutate(async () => {
      const existing = client.getGroup(id);
      const candidate = validateGroup({ ...existing, baseUrl: baseAddress(baseUrl).origin });
      // Challenge/proof is checked before credentials are sent or an address is saved.
      await authenticate(candidate, options.signal); checkAbort(options.signal);
      const groups = session.groups.map(group => group.id === id ? candidate : group);
      await persist({ ...session, groups });
      return { ...candidate };
    }); },
    requestJoinAt(baseUrl, code, options = {}) {
      if (!/^\d{6}$/.test(String(code).trim())) throw failure('请输入 6 位数字邀请码');
      return client.requestJoin(`${baseAddress(baseUrl).origin}/#invite=${String(code).trim()}`, options);
    },
    async requestJoin(value, { signal } = {}) {
      await client.init(); checkAbort(signal);
      const link = parseInviteLink(value);
      if (link.legacy) throw failure('旧版地址请使用兼容连接入口');
      const ticket = await request(link.baseUrl, '/api/pair/request', { method: 'POST', body: { code: link.code, device: client.device }, signal });
      if ((link.groupId && ticket.groupId !== link.groupId) || !UUID.test(ticket.groupId) || !UUID.test(ticket.requestId) || !UUID.test(ticket.hostDeviceId) || !KEY.test(ticket.pollToken) || !Number.isFinite(ticket.expiresAt)) throw failure('邀请与主机群信息不匹配');
      return { ...ticket, baseUrl: link.baseUrl };
    },
    async checkJoin(ticket, { signal } = {}) {
      if (!UUID.test(ticket?.requestId) || !KEY.test(ticket?.pollToken) || !UUID.test(ticket?.groupId)) throw failure('加入申请不完整');
      checkAbort(signal);
      if (ticket.expiresAt <= Date.now()) return { status: 'expired' };
      const result = await request(baseAddress(ticket.baseUrl).origin, `/api/pair/status/${ticket.requestId}`, { headers: { 'X-Poll-Token': ticket.pollToken }, signal });
      if (!['pending', 'approved', 'denied', 'expired'].includes(result.status)) throw failure('加入申请返回了未知状态');
      if (result.status !== 'approved') return result;
      if (result.group?.id !== ticket.groupId || result.group?.hostDeviceId !== ticket.hostDeviceId) throw failure('批准的群与邀请不匹配');
      const group = validateGroup({ ...result.group, baseUrl: ticket.baseUrl });
      await authenticate(group, signal);
      return { status: 'approved', group: await remember(group, signal) };
    },
    async waitForJoin(ticket, { signal, onStatus, intervalMs = 1200 } = {}) {
      while (true) {
        checkAbort(signal);
        let result;
        try { result = await client.checkJoin(ticket, { signal }); }
        catch (error) {
          // The invitation has already been consumed. Retain its private ticket
          // through temporary network loss or suspension so foregrounding can
          // receive an approval instead of requiring another invitation.
          if (error.status !== 408 && !(error.status >= 500)) throw error;
          if (ticket.expiresAt <= Date.now()) throw failure('加入申请已过期，请重新获取邀请链接', 410);
          onStatus?.('pending'); await delay(intervalMs, signal); continue;
        }
        onStatus?.(result.status);
        if (result.status === 'approved') return result.group;
        if (result.status === 'denied') throw failure('加入申请被拒绝，请联系群内成员后重新邀请', 403);
        if (result.status === 'expired') throw failure('加入申请已过期，请重新获取邀请链接', 410);
        await delay(intervalMs, signal);
      }
    },
    async joinLink(value, options = {}) {
      await client.init(); checkAbort(options.signal); const link = parseInviteLink(value);
      if (!link.legacy) { const ticket = await client.requestJoin(value, options); options.onStatus?.('pending'); return client.waitForJoin(ticket, options); }
      const metadata = await authenticate({ ...link, legacy: true }, options.signal);
      const headers = { 'X-Room-Key': link.key, 'X-Device-Id': client.device.id };
      await request(link.baseUrl, '/api/join', { method: 'POST', body: client.device, headers, signal: options.signal });
      await request(link.baseUrl, '/api/state', { headers, signal: options.signal });
      const previous = session.groups.find(group => group.baseUrl === link.baseUrl && group.key === link.key);
      const group = { id: metadata.groupId, name: previous?.name || '我的传输群', baseUrl: link.baseUrl, key: link.key, hostDeviceId: metadata.hostDeviceId };
      return remember(group, options.signal);
    },
    async createInvite(id, options = {}) {
      const group = client.getGroup(id);
      // Offline v1 migrations retain their local ID. Resolve the server's actual
      // group ID before composing any new short-lived invitation.
      let groupId = group.id;
      if (group.legacy) {
        const info = await authenticate(group, options.signal);
        if (!UUID.test(info.groupId)) throw failure('电脑端尚未支持短期邀请，请更新电脑端');
        groupId = info.groupId;
      }
      const invite = await client.api(id, '/api/pair/invite', { ...options, method: 'POST', body: {} });
      return { ...invite, groupId, link: `${group.baseUrl}/#invite=${invite.code}&group=${groupId}` };
    },
    listJoinRequests(id, options = {}) { return client.api(id, '/api/pair/requests', options); },
    respondJoin(id, requestId, allow, options = {}) { return client.api(id, '/api/pair/respond', { ...options, method: 'POST', body: { requestId, allow } }); },
    watchGroup(id, { onState, onStatus, onError, active = true } = {}) {
      client.getGroup(id);
      let closed = false, enabled = active, generation = 0, socket, timer, handshakeTimer, controller, attempts = 0;
      const current = epoch => !closed && enabled && epoch === generation;
      function stop() {
        generation++; clearTimeout(timer); clearTimeout(handshakeTimer); controller?.abort(); controller = null;
        if (socket) { socket.onopen = socket.onclose = socket.onmessage = null; socket.onerror = () => {}; socket.close(); socket = null; }
      }
      function retry(epoch, error) {
        if (!current(epoch)) return;
        if (error) onError?.(error);
        onStatus?.('offline');
        clearTimeout(timer); timer = setTimeout(connect, Math.min(15000, reconnectMs * 2 ** Math.min(attempts++, 4)));
      }
      async function connect() {
        stop(); if (closed || !enabled) return;
        const epoch = generation; controller = new AbortController(); onStatus?.('connecting');
        try {
          await client.api(id, '/api/join', { method: 'POST', body: client.device, signal: controller.signal });
          if (!current(epoch)) return;
          const state = await client.api(id, '/api/state', { signal: controller.signal });
          if (!current(epoch)) return; onState?.(state);
          const group = client.getGroup(id), url = new URL('/api/events', group.baseUrl);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('key', group.key); url.searchParams.set('device', client.device.id);
          socket = new WebSocketImpl(url.toString());
          handshakeTimer = setTimeout(() => {
            if (!current(epoch)) return;
            const pending = socket; socket = null;
            pending.onopen = pending.onclose = pending.onmessage = null;
            pending.onerror = () => {}; pending.close();
            retry(epoch, failure('实时连接超时，正在重新连接', 408));
          }, requestTimeoutMs);
          socket.onopen = () => { if (current(epoch)) { clearTimeout(handshakeTimer); attempts = 0; onStatus?.('online'); } };
          socket.onmessage = event => { if (!current(epoch)) return; try { const data = JSON.parse(String(event.data)); if (data.type === 'state') onState?.(data); } catch { onError?.(failure('收到无法读取的群消息')); } };
          socket.onclose = () => { clearTimeout(handshakeTimer); retry(epoch); };
          socket.onerror = () => { if (current(epoch)) socket?.close(); };
        } catch (error) { if (current(epoch)) retry(epoch, error); }
      }
      const watch = { groupId: id, setActive(value) { if (closed || enabled === Boolean(value)) return; enabled = Boolean(value); if (enabled) connect(); else { stop(); onStatus?.('paused'); } }, close() { if (closed) return; closed = true; stop(); watches.delete(watch); } };
      watches.add(watch); if (enabled) connect(); else onStatus?.('paused'); return watch;
    },
    close() { for (const watch of [...watches]) watch.close(); },
  };
  return client;
}
