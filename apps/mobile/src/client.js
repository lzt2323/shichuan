import { createMobilePeer } from './peer-client.js';
import { mergeState } from '../../../shared/history.js';
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
    return { baseUrl: url.origin, code, ...(params.get('protocol') === 'peer' ? { mode: 'peer' } : {}), ...(groupId ? { groupId } : {}), legacy: false };
  }
  if (!KEY.test(key || '')) throw failure('请使用电脑端生成的完整邀请链接，六位邀请码需要主机地址');
  return { baseUrl: url.origin, key, legacy: true };
}
function validateGroup(group) {
  if (group?.mode === 'peer' && group.authVersion === 3 && UUID.test(group.id) && UUID.test(group.creatorDeviceId) && KEY.test(group.key)) return { id: group.id, name: String(group.name).slice(0, 40), mode: 'peer', authVersion: 3, creatorDeviceId: group.creatorDeviceId, hostDeviceId: group.creatorDeviceId, key: group.key, baseUrl: baseAddress(group.baseUrl).origin };
  if (!UUID.test(group?.id) || !KEY.test(group?.key) || typeof group.name !== 'string' || !group.name.trim() || (!group.legacy && !UUID.test(group.hostDeviceId))) throw failure('保存的群信息不完整，请重新配对');
  return { id: group.id, name: group.name.slice(0, 40), key: group.key, baseUrl: baseAddress(group.baseUrl).origin, ...(group.hostDeviceId ? { hostDeviceId: group.hostDeviceId } : {}), ...(group.legacy ? { legacy: true } : {}), ...(group.authVersion === 2 ? { authVersion: 2 } : {}), ...(group.membershipRevoked ? { membershipRevoked: true } : {}) };
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
export function createMobileClient({ storage, randomUUID, deviceName = '我的手机', kind = 'ios', fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, requestTimeoutMs = 10000, reconnectMs = 1500, peerOptions }) {
  let session, initialize, writes = Promise.resolve();
  const watches = new Set();
  let discovered = [];
  const peer = peerOptions ? createMobilePeer({ ...peerOptions, credentials: storage, randomUUID, device: () => client.device, fetchImpl }) : null;

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
  async function request(baseUrl, route, { method = 'GET', body, headers = {}, signal, timeoutMs = requestTimeoutMs } = {}) {
    checkAbort(signal);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
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
    let info;
    try { info = await request(group.baseUrl, '/api/group/probe', { method: 'POST', body: { challenge, ...(group.authVersion === 2 ? { deviceId: client.device.id, authVersion: 2 } : {}) }, signal }); } catch (error) { error.phase = 'probe'; throw error; }
    const proofKey = group.authVersion === 2 ? bytesToHex(sha256(utf8ToBytes(group.key))) : group.key;
    const expected = bytesToHex(hmac(sha256, utf8ToBytes(proofKey), utf8ToBytes(`${info.groupId}:${challenge}`)));
    // No room key is sent before the server proves possession. A saved LAN
    // address may now belong to a different machine after network changes.
    if ((group.authVersion === 2 && info.authVersion !== 2) || !UUID.test(info.groupId) || !UUID.test(info.hostDeviceId) || (!group.legacy && info.groupId !== group.id) || (group.hostDeviceId && info.hostDeviceId !== group.hostDeviceId) || info.proof !== expected) throw Object.assign(failure('群主机身份校验失败，正在继续定位原主机；请确认电脑已打开拾传', 401), { phase: 'probe' });
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
        for (const group of session.groups) if (group.mode === 'peer' && peer) await peer.restore(group);
        return snapshot();
      })().catch(error => { initialize = null; throw error; });
      return initialize;
    },
    get device() { if (!session) throw failure('手机身份尚未载入'); return { ...session.device }; },
    getSession() { if (!session) throw failure('手机身份尚未载入'); return snapshot(); },
    listGroups() { return session ? session.groups.map(group => ({ ...group, ...(group.mode === 'peer' && peer ? { name: peer.state(group.id).name } : {}) })) : []; },
    getGroup(id) { const group = session?.groups.find(item => item.id === id); if (!group) throw failure('找不到这个群，请重新加入', 404); return { ...group, ...(group.mode === 'peer' && peer ? { name: peer.state(id).name } : {}) }; },
    get peerSupported() { return Boolean(peer); },
    async setPeerActive(value) { await client.init(); if (peer) { if (value) await peer.start(); else await peer.stop(); } },
    async createGroup(name) { if (!peer) throw failure('去中心群需要更新后的 Android 客户端；Expo Go、网页和当前 iOS 预览不提供节点服务'); await client.init(); const group = await peer.create(name); return remember(group); },
    async renameGroup(id, name) { if (!peer || client.getGroup(id).mode !== 'peer') throw failure('旧群尚不支持此操作'); await peer.append(id, 'rename', { name }); return mutate(async () => { const groups = session.groups.map(g => g.id === id ? { ...g, name } : g); await persist({ ...session, groups }); }); },
    async dissolveGroup(id) { await peer.depart(id, 'dissolve'); },
    peerUpload(id, uri, name, mime, cancelled) { return peer.addFile(id, uri, name, mime, cancelled); },
    peerFileSources(id, messageId) { return peer.fileSources(id, messageId); },
    peerReceived(id, message, uri) { return peer.received(id, message, uri); },
    authHeaders(id) { const group = client.getGroup(id); return { 'X-Room-Key': group.key, 'X-Device-Id': client.device.id }; },
    verifyGroup(id, options = {}) { if (client.getGroup(id).mode === 'peer') { if (!peer) return Promise.reject(failure('此运行环境不支持去中心群')); return Promise.resolve({ groupId: id, hostDeviceId: client.getGroup(id).creatorDeviceId, proof: 'peer' }); } return authenticate(client.getGroup(id), options.signal); },
    async api(id, route, options = {}) {
      if (!route.startsWith('/api/') || route.startsWith('//') || route.includes('#')) throw failure('请求地址不正确');
      const group = client.getGroup(id);
      if (group.mode === 'peer') {
        if (!peer) throw failure('此运行环境不支持去中心群');
        if (route === '/api/join') return client.device;
        if (route === '/api/state') return peer.state(id);
        if (route.startsWith('/api/history')) { const params = new URL(route, 'http://localhost').searchParams; return peer.history(id, params.get('before'), Number(params.get('limit')) || 100); }
        if (route === '/api/messages' && options.method === 'POST') return peer.message(id, options.body.text);
        throw failure('去中心群不支持此旧接口', 404);
      }
      const deviceId = client.device.id;
      await authenticate(group, options.signal);
      const currentGroup = client.getGroup(id);
      if (currentGroup.key !== group.key || currentGroup.baseUrl !== group.baseUrl || currentGroup.hostDeviceId !== group.hostDeviceId) throw failure('群连接正在更新，请重试', 409);
      try { return await request(group.baseUrl, route, { ...options, headers: { ...options.headers, 'X-Room-Key': group.key, 'X-Device-Id': deviceId } }); }
      catch (error) { error.phase = 'authenticated-api'; error.authenticatedKey = group.key; throw error; }
    },
    setActiveGroup(id) { return mutate(async () => { if (id !== null) client.getGroup(id); await persist({ ...session, activeGroupId: id }); }); },
    removeGroup(id) { return mutate(async () => {
      const groups = session.groups.filter(g => g.id !== id);
      await persist({ ...session, groups, activeGroupId: session.activeGroupId === id ? groups[0]?.id || null : session.activeGroupId });
      for (const watch of watches) if (watch.groupId === id) watch.close();
      await storage.deleteItemAsync?.(GROUP_PREFIX + id);
      if (peer) await peer.forget(id);
    }); },
    rename(name) { return mutate(async () => {
      if (!String(name).trim()) throw failure('请输入设备名称');
      const device = { ...session.device, name: String(name).trim().slice(0, 40) };
      await persist({ ...session, device });
      await Promise.allSettled(session.groups.map(group => group.mode === 'peer' && peer ? peer.renameDevice(group.id, device.name) : client.api(group.id, '/api/join', { method: 'POST', body: device })));
      return { ...device };
    }); },
    updateDiscovery(records) {
      discovered = Array.isArray(records) ? records.slice(0, 100) : [];
      peer?.discover(discovered);
      for (const watch of watches) watch.refresh();
    },
    async resolveGroup(id, { signal } = {}) {
      const group = client.getGroup(id);
      if (group.mode === 'peer') { await peer?.sync(id); return group; }
      let hints = discovered;
      try {
        const directory = new URL(group.baseUrl);
        for (const port of [47321, 47322, 47323, 47324]) {
          directory.port = String(port);
          try {
            const result = await request(directory.origin, '/api/discovery/groups', { signal, timeoutMs: 450 });
            if (result.protocol !== 'pickdrop-directory-v1' || !Array.isArray(result.groups)) continue;
            hints = [...result.groups.slice(0, 100).filter(item => item && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535).map(item => ({ ...item, baseUrl: `${directory.protocol}//${directory.hostname}:${item.port}` })), ...hints];
            break;
          } catch (error) { if (signal?.aborted) throw error; }
        }
      } catch (error) { if (signal?.aborted) throw error; }
      const candidates = [...new Set(hints.filter(item => item && item.groupId === group.id && (!group.hostDeviceId || item.hostDeviceId === group.hostDeviceId)).flatMap(item => [...(item.candidateUrls || []), item.baseUrl]))];
      for (const baseUrl of candidates) {
        checkAbort(signal);
        if (baseUrl === group.baseUrl) continue;
        try { return await client.reconnectAt(id, baseUrl, { signal }); }
        catch (error) { if (signal?.aborted) throw error; }
      }
      return client.getGroup(id);
    },
    reconnectAt(id, baseUrl, options = {}) { return mutate(async () => {
      const existing = client.getGroup(id);
      if (existing.mode === 'peer') { if (!peer) throw failure('此运行环境不支持去中心群'); await peer.connect(id, baseUrl); checkAbort(options.signal); return existing; }
      const candidate = validateGroup({ ...existing, baseUrl: baseAddress(baseUrl).origin });
      // Challenge/proof is checked before credentials are sent or an address is saved.
      await authenticate(candidate, options.signal); checkAbort(options.signal);
      const groups = session.groups.map(group => group.id === id ? candidate : group);
      await persist({ ...session, groups });
      return { ...candidate };
    }); },
    async reconnectInvite(value, options = {}) {
      await client.init(); checkAbort(options.signal);
      const link = parseInviteLink(value);
      if (link.legacy || !link.groupId) return null;
      const existing = session.groups.find(group => group.id === link.groupId && !group.membershipRevoked);
      if (!existing) return null;
      // A QR is an address hint for an already paired group, even when its
      // invitation has expired. The saved group/host and key prove identity;
      // failure must never fall through to a fresh pairing request.
      return client.reconnectAt(existing.id, link.baseUrl, options);
    },
    requestJoinAt(baseUrl, code, options = {}) {
      if (!/^\d{6}$/.test(String(code).trim())) throw failure('请输入 6 位数字邀请码');
      return client.requestJoin(`${baseAddress(baseUrl).origin}/#invite=${String(code).trim()}`, options);
    },
    async requestJoin(value, { signal } = {}) {
      await client.init(); checkAbort(signal);
      const link = parseInviteLink(value);
      if (link.legacy) throw failure('旧版地址请使用兼容连接入口');
      if (link.mode === 'peer') { if (!peer) throw failure('去中心群需要更新后的 Android 客户端；当前环境仅支持旧版群'); await peer.start(); return peer.requestJoin(link.baseUrl, link.code, { signal, groupId: link.groupId }); }
      // Address + code can also target a peer node without a full invitation.
      let peerInfo; try { peerInfo = await request(link.baseUrl, '/api/peer/info', { signal, timeoutMs: 1500 }); } catch (error) { if (signal?.aborted) throw error; }
      if (peerInfo?.protocol === 'pickdrop-peer-v1') { if (!peer) throw failure('当前运行环境不支持去中心群', 501); await peer.start(); return peer.requestJoin(link.baseUrl, link.code, { signal, groupId: link.groupId }); }
      const ticket = await request(link.baseUrl, '/api/pair/request', { method: 'POST', body: { code: link.code, device: client.device }, signal });
      if ((link.groupId && ticket.groupId !== link.groupId) || !UUID.test(ticket.groupId) || !UUID.test(ticket.requestId) || !UUID.test(ticket.hostDeviceId) || !KEY.test(ticket.pollToken) || !Number.isFinite(ticket.expiresAt)) throw failure('邀请与主机群信息不匹配');
      return { ...ticket, baseUrl: link.baseUrl };
    },
    async checkJoin(ticket, { signal } = {}) {
      if (ticket?.mode === 'peer') { const result = await peer.checkJoin(ticket, { signal }); if (result.status === 'approved') return { ...result, group: await remember(result.group, signal) }; return result; }
      if (!UUID.test(ticket?.requestId) || !KEY.test(ticket?.pollToken) || !UUID.test(ticket?.groupId)) throw failure('加入申请不完整');
      checkAbort(signal);
      const result = await request(baseAddress(ticket.baseUrl).origin, `/api/pair/status/${ticket.requestId}`, { headers: { 'X-Poll-Token': ticket.pollToken }, signal });
      if (!['pending', 'approved', 'denied', 'expired', 'revoked'].includes(result.status)) throw failure('加入申请返回了未知状态');
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
          onStatus?.('pending'); await delay(intervalMs, signal); continue;
        }
        onStatus?.(result.status);
        if (result.status === 'approved') return result.group;
        if (result.status === 'revoked') throw failure('设备授权已失效，请重新申请加入', 401);
        if (result.status === 'denied') throw failure('加入申请被拒绝，请联系群内成员后重新邀请', 403);
        if (result.status === 'expired') throw failure('加入申请已过期，请重新获取邀请链接', 410);
        await delay(intervalMs, signal);
      }
    },
    async joinLink(value, options = {}) {
      await client.init(); checkAbort(options.signal); const link = parseInviteLink(value);
      const paired = await client.reconnectInvite(value, options);
      if (paired) return paired;
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
      if (group.mode === 'peer') return peer.invite(id);
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
    markRevoked(id, expectedKey) { return mutate(async () => { if (client.getGroup(id).key !== expectedKey) return; const groups = session.groups.map(group => group.id === id ? { ...group, membershipRevoked: true } : group); await persist({ ...session, groups }); }); },
    leaveGroup(id, options = {}) { if (client.getGroup(id).mode === 'peer') return peer.depart(id, 'member.leave'); return client.api(id, '/api/members/leave', { ...options, method: 'POST', body: {} }); },
    removeMember(id, deviceId, options = {}) { if (client.getGroup(id).mode === 'peer') return peer.append(id, 'member.remove', { deviceId }); return client.api(id, '/api/members/remove', { ...options, method: 'POST', body: { deviceId } }); },
    listJoinRequests(id, options = {}) { if (client.getGroup(id).mode === 'peer') return Promise.resolve(peer.requests(id)); return client.api(id, '/api/pair/requests', options); },
    respondJoin(id, requestId, allow, options = {}) { if (client.getGroup(id).mode === 'peer') return peer.respond(id, requestId, allow); return client.api(id, '/api/pair/respond', { ...options, method: 'POST', body: { requestId, allow } }); },
    watchGroup(id, { onState, onStatus, onError, active = true } = {}) {
      const initialGroup = client.getGroup(id);
      if (initialGroup.mode === 'peer') {
        if (!peer) { onStatus?.('offline'); onError?.(failure('此运行环境不支持去中心群')); return { groupId: id, setActive() {}, close() {} }; }
        let enabled = active, closed = false;
        const publishPeer = state => { if (!closed && enabled) { onState?.(state); const member = state.devices.some(item => item.id === client.device.id); onStatus?.(state.dissolved || !member ? 'offline' : peer.isActive() ? 'online' : 'paused'); if (state.dissolved || !member) onError?.(failure(state.dissolved ? '此群已解散，本机历史仍保留' : '已退出或被移除，本机历史仍保留', 403)); } };
        const unsubscribe = peer.subscribe(id, publishPeer);
        const refresh = () => { if (!closed && enabled) { publishPeer(peer.state(id)); void peer.sync(id).catch(onError); } };
        const watch = { groupId: id, refresh, setActive(value) { enabled = Boolean(value); if (enabled) peer.start().then(refresh).catch(onError); else onStatus?.('paused'); }, close() { closed = true; unsubscribe(); watches.delete(watch); } };
        watches.add(watch); if (enabled) peer.start().then(refresh).catch(onError); return watch;
      }
      let currentState = { messages: [], devices: [] };
      const publish = next => { currentState = mergeState(currentState, next); onState?.({ ...currentState, mode: next.mode }); };
      let closed = false, enabled = active && !initialGroup.membershipRevoked, generation = 0, socket, timer, handshakeTimer, controller, attempts = 0, connecting = false, connectedUrl, lastHints = '', revoked = Boolean(initialGroup.membershipRevoked);
      const current = epoch => !closed && enabled && epoch === generation;
      function stop() {
        generation++; connectedUrl = null; connecting = false; clearTimeout(timer); clearTimeout(handshakeTimer); controller?.abort(); controller = null;
        if (socket) { socket.onopen = socket.onclose = socket.onmessage = null; socket.onerror = () => {}; socket.close(); socket = null; }
      }
      function retry(epoch, error) {
        if (!current(epoch)) return;
        connectedUrl = null;
        if (error) onError?.(error);
        onStatus?.('offline');
        clearTimeout(timer); timer = setTimeout(connect, Math.min(15000, reconnectMs * 2 ** Math.min(attempts++, 4)));
      }
      async function connect() {
        stop(); if (closed || !enabled) return;
        const epoch = generation; controller = new AbortController(); onStatus?.('connecting');
        connecting = true;
        try {
          await client.resolveGroup(id, { signal: controller.signal });
          if (!current(epoch)) return;
          await client.api(id, '/api/join', { method: 'POST', body: client.device, signal: controller.signal });
          if (!current(epoch)) return;
          const state = await client.api(id, '/api/state', { signal: controller.signal });
          if (!current(epoch)) return; publish(state);
          const group = client.getGroup(id), url = new URL('/api/events', group.baseUrl);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('key', group.key); url.searchParams.set('device', client.device.id); url.searchParams.set('stream', '2');
          socket = new WebSocketImpl(url.toString());
          handshakeTimer = setTimeout(() => {
            if (!current(epoch)) return;
            const pending = socket; socket = null;
            pending.onopen = pending.onclose = pending.onmessage = null;
            pending.onerror = () => {}; pending.close();
            retry(epoch, failure('实时连接超时，正在重新连接', 408));
          }, requestTimeoutMs);
          socket.onopen = () => { if (current(epoch)) { clearTimeout(handshakeTimer); attempts = 0; connectedUrl = group.baseUrl; onStatus?.('online'); } };
          socket.onmessage = event => { if (!current(epoch)) return; try { const data = JSON.parse(String(event.data)); if (data.type === 'revoked') { void client.markRevoked(id, group.key).catch(() => {}); revoked = true; enabled = false; stop(); onStatus?.('offline'); onError?.(failure('已退出或被移除，请重新申请加入；待发草稿仍保留', 401)); return; } if (data.type === 'state') publish(data); } catch { onError?.(failure('收到无法读取的群消息')); } };
          socket.onclose = () => { clearTimeout(handshakeTimer); retry(epoch); };
          socket.onerror = () => { if (current(epoch)) socket?.close(); };
        } catch (error) { if (current(epoch)) { if (error.status === 401 && error.phase === 'authenticated-api') { void client.markRevoked(id, error.authenticatedKey).catch(() => {}); revoked = true; enabled = false; stop(); onStatus?.('offline'); onError?.(error); } else retry(epoch, error); } } finally { if (current(epoch)) connecting = false; }
      }
      const watch = { groupId: id, refresh() {
        if (closed || !enabled || connecting || connectedUrl) return;
        const group = client.getGroup(id);
        const hints = discovered.filter(item => item.groupId === group.id && item.hostDeviceId === group.hostDeviceId).flatMap(item => [...(item.candidateUrls || []), item.baseUrl]).sort().join(',');
        if (hints === lastHints) return; lastHints = hints;
        if (discovered.some(item => item.groupId === group.id && item.hostDeviceId === group.hostDeviceId && [...(item.candidateUrls || []), item.baseUrl].some(url => url !== group.baseUrl)) || (!connectedUrl && attempts > 0)) connect();
      }, setActive(value) { if (closed || revoked || enabled === Boolean(value)) return; enabled = Boolean(value); if (enabled) connect(); else { stop(); onStatus?.('paused'); } }, close() { if (closed) return; closed = true; stop(); watches.delete(watch); } };
      watches.add(watch); if (enabled) connect(); else if (revoked) { onStatus?.('offline'); onError?.(failure('设备授权已失效，请重新申请加入；待发草稿仍保留', 401)); } else onStatus?.('paused'); return watch;
    },
    close() { for (const watch of [...watches]) watch.close(); void peer?.stop(); },
  };
  return client;
}


/** The recipient is an identity, not an IP. A queued file may use a new verified endpoint. */
export function createVerifiedTransferGroup(client, group, deviceId, maxFileBytes) {
  const locked = { ...group };
  return { ...locked, deviceId, maxFileBytes, ...(locked.mode === 'peer' ? { peerUpload: (uri, name, mime, cancelled) => client.peerUpload(locked.id, uri, name, mime, cancelled), peerFileSources: messageId => client.peerFileSources(locked.id, messageId), peerReceived: (message, uri) => client.peerReceived(locked.id, message, uri) } : {}), verify: async () => {
    const sameIdentity = () => {
      const current = client.getGroup(locked.id);
      if (current.id !== locked.id || current.hostDeviceId !== locked.hostDeviceId || current.key !== locked.key) throw failure('群设备授权已更新，原草稿不能使用新的授权发送', 409);
      return current;
    };
    const before = sameIdentity();
    await client.verifyGroup(locked.id);
    const after = sameIdentity();
    if (before.baseUrl !== after.baseUrl) throw failure('群地址正在更新，请重试发送', 409);
    return { baseUrl: after.baseUrl };
  } };
}
