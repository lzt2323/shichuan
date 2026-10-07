import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createInboxServer } from './index.js';
import { openPeerStore } from './peer-store.js';
import { createPeerIdentity, createPeerGenesis, createPeerJoinProof, createPeerReplica, PEER_PROTOCOL } from '../shared/peer-protocol.js';
import { readJsonWithBackup, writeJsonWithBackup } from './persistence.js';
import { createLanDiscovery } from './discovery.js';
import { createDiscoveryDirectory, DIRECTORY_PORT, probeDirectory, scanDirectories, manualGroupCandidates } from './discovery-directory.js';
import { recoverNetwork, chooseNetwork, isPublicIPv4, listNetworkInterfaces, publicEndpoint as endpoint } from './network.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function origin(value) {
  let url; try { url = new URL(value); } catch { throw fail(400, '请输入完整电脑地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail(400, '电脑地址不正确');
  return url.origin;
}

export async function createGroupManager({ dataDir, device, discoveryFactory = createLanDiscovery, host, pairingOptions = {}, discoveryWaitMs = 600, fetchImpl, monitorIntervalMs = 5000, networkPollMs = 3000, directoryPort = DIRECTORY_PORT, listInterfaces = listNetworkInterfaces, peerGroups = false } = {}) {
  if (!dataDir || !uuid.test(device?.id)) throw new Error('dataDir and a valid device are required');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(dataDir, 'groups.json'), groups = new Map(), hosted = new Map(), peerStores = new Map(), events = new EventEmitter();
  const identityPath = path.join(dataDir, 'peer-identity.json');
  let peerIdentity = await readJsonWithBackup(identityPath, value => /^[a-f0-9]{64}$/.test(value?.privateKey), { recover: false });
  if (!peerIdentity) { peerIdentity = createPeerIdentity(randomBytes(32).toString('hex')); await writeJsonWithBackup(identityPath, peerIdentity); }
  else peerIdentity = createPeerIdentity(peerIdentity.privateKey);
  const saved = await readJsonWithBackup(statePath, value => value && uuid.test(value.device?.id) && Array.isArray(value.groups) && value.groups.every(g => uuid.test(g?.id) && uuid.test(g?.hostDeviceId) && /^[a-f0-9]{64}$/.test(g.key)), { recover: false });
  device = { ...device, ...(saved?.device || {}) };
  let interfaces = await listInterfaces(), selection = saved?.network?.selection || { mode: 'auto' };
  // An explicit host is retained for CLI/test callers. The interactive defaults
  // never listen on all interfaces, and loopback is never a public invitation.
  let explicitHost = host && host !== '0.0.0.0' ? host : null;
  let selected = explicitHost ? { id: `explicit:${host}`, name: 'explicit', interfaceName: 'explicit', address: host, type: 'unknown', virtual: !isPublicIPv4(host), connected: true } : recoverNetwork(interfaces, selection, saved?.network?.selected);
  const available = () => Boolean(selected && (explicitHost || interfaces.some(item => item.name === selected.name && item.address === selected.address)));
  let networkAvailable = available(), switching = false, networkWrites = Promise.resolve(), lastDiscoveryError = null;
  const discoveryError = error => { lastDiscoveryError = error?.message || String(error); events.emit('discovery-error', error); };
  let writeQueue = Promise.resolve(), closed = false, discovery, directory, directoryScan, directoryAbort, lastDirectoryScan = 0;
  const directoryRecords = new Map();
  let leasedTransfers = 0;
  const active = new Set(), resolving = new Map();
  const changed = () => events.emit('groups-changed');
  const networkChanged = () => { events.emit('network-changed', networkState()); changed(); };
  const transferCount = () => leasedTransfers + [...hosted.values()].reduce((sum, inbox) => sum + inbox.activeTransfers(), 0);
  const networkState = () => ({ selection: { ...selection }, selected: selected ? { ...selected, connected: networkAvailable } : null, interfaces: interfaces.map(item => ({ ...item })), available: networkAvailable, switching, transferBusy: transferCount() > 0, discoveryError: lastDiscoveryError });
  const persist = () => {
    const snapshot = structuredClone({ version: 1, device, network: { selection, selected }, groups: [...groups.values()].map(({ online, storageError, ...group }) => group) });
    const operation = writeQueue.catch(() => {}).then(() => writeJsonWithBackup(statePath, snapshot));
    writeQueue = operation; return operation;
  };
  const track = promise => { active.add(promise); promise.then(() => active.delete(promise), () => active.delete(promise)); return promise; };
  async function request(baseUrl, route, { method = 'GET', body, headers = {}, signal } = {}) {
    if (!networkAvailable || switching) throw fail(503, '所选网络已断开，请到网络设置重新选择');
    const url = origin(baseUrl) + route;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoingHeaders = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers };
    if (fetchImpl) {
      const response = await fetchImpl(url, { method, headers: outgoingHeaders, body: payload, redirect: 'error', signal: signal || AbortSignal.timeout(3000) });
      const result = await response.json(); if (!response.ok) throw fail(response.status, result.error || '群连接失败'); return result;
    }
    // Binding the source address makes an explicit selection affect outbound
    // validation and pairing as well as hosted listeners and advertisements.
    return new Promise((resolve, reject) => {
      const transport = url.startsWith('https:') ? https : http;
      const req = transport.request(url, { method, headers: outgoingHeaders, localAddress: selected.address, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000), timeout: 3000 }, res => {
        let data = '', bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) { req.destroy(fail(413, '群消息过大')); return; } data += chunk; });
        res.on('error', reject);
        res.on('end', () => { try { const result = JSON.parse(data); if (res.statusCode < 200 || res.statusCode >= 300) reject(fail(res.statusCode, result.error || '群连接失败')); else resolve(result); } catch { reject(fail(502, '主机返回了无效数据')); } });
      });
      req.on('timeout', () => req.destroy(fail(408, '群连接超时'))); req.on('error', reject);
      if (payload !== undefined) req.write(payload); req.end();
    });
  }
  async function authenticate(group, baseUrl) {
    const challenge = randomBytes(32).toString('hex');
    const result = await request(baseUrl, '/api/group/probe', { method: 'POST', body: { challenge, ...(group.authVersion === 2 ? { deviceId: device.id, authVersion: 2 } : {}) } });
    const proofKey = group.authVersion === 2 ? createHash('sha256').update(group.key).digest('hex') : group.key;
    const expected = createHmac('sha256', proofKey).update(`${group.id}:${challenge}`).digest('hex');
    return (group.authVersion !== 2 || result.authVersion === 2) && result.groupId === group.id && result.hostDeviceId === group.hostDeviceId && typeof result.proof === 'string' && /^[a-f0-9]{64}$/.test(result.proof) && timingSafeEqual(Buffer.from(expected), Buffer.from(result.proof));
  }
  async function useCandidate(group, baseUrl) {
    if (closed || switching || !networkAvailable || group.local || !baseUrl) return false;
    try { if (!await authenticate(group, baseUrl)) return false; } catch { return false; }
    if (closed || switching || !networkAvailable || groups.get(group.id) !== group) return false;
    const different = group.baseUrl !== baseUrl || !group.online;
    group.baseUrl = baseUrl; group.online = true;
    if (different) { await persist(); changed(); }
    return true;
  }
  async function startHosted(group) {
    let peer;
    if (group.mode === 'peer') {
      peer = await openPeerStore({ dataDir: path.join(dataDir, 'groups', group.id), identity: peerIdentity, device, genesis: group.peer?.genesis, events: group.peer?.events, request, localAddress: () => selected?.address, acquireTransfer: () => { if(switching||!networkAvailable)throw fail(503,'网络正在切换或已断开');leasedTransfers++;let released=false;return()=>{if(!released){released=true;leasedTransfers--;}}; }, endpoint: () => hosted.get(group.id)?.baseUrl, onChange: state => { group.name = state.name; group.dissolved=state.dissolved; events.emit('requests-changed', group.id); changed(); } });
      for (const hint of group.peerEndpoints || []) peer.remember(hint);
      await peer.initialize(); group.name=peer.state().name; peerStores.set(group.id, peer); delete group.peer;
    }
    const options = { dataDir: path.join(dataDir, 'groups', group.id), host: selected?.address || '127.0.0.1', listen: networkAvailable, port: group.preferredPort || 0, group: { id: group.id, name: group.name, hostDeviceId: group.mode === 'peer' ? device.id : group.hostDeviceId, authVersion: group.mode === 'peer' ? 2 : group.authVersion }, peer, pairingOptions: { ...pairingOptions, onRequestsChanged: () => events.emit('requests-changed', group.id) } };
    let inbox;
    try { inbox = await createInboxServer(options); }
    catch (error) { if (error.code !== 'EADDRINUSE' || !options.port) throw error; inbox = await createInboxServer({ ...options, port: 0 }); }
    hosted.set(group.id, inbox); peer?.bindInbox(inbox);
    try {
      const key = await inbox.ensureHostDevice(device);
      Object.assign(group, { key, authVersion: peer ? 3 : inbox.getAuthVersion(), ...(peer ? { hostDeviceId: device.id, canManage: group.creatorDeviceId === device.id } : {}), baseUrl: inbox.baseUrl || group.baseUrl || null, online: networkAvailable, local: true, ...(inbox.port ? { preferredPort: inbox.port } : {}) });
    } catch (error) { hosted.delete(group.id); await inbox.close(); throw error; }
  }
  async function restoreHosted(group) {
    try { await startHosted(group); delete group.storageError; }
    catch (error) {
      // One damaged group's data must not make all other groups unusable.
      group.online = false; group.storageError = error.message;
      events.emit('storage-error', { groupId: group.id, message: error.message });
    }
  }
  const announcements = () => [...hosted].filter(([, inbox]) => inbox.port).map(([id, inbox]) => ({ groupId: id, hostDeviceId: device.id, name: groups.get(id)?.name || '传输群', port: inbox.port, address: selected.address, directoryPort: directory?.port, ...(groups.get(id)?.mode === 'peer' ? { peerProtocol: PEER_PROTOCOL } : {}) }));
  function nearbyRecords() {
    for (const [key, record] of directoryRecords) if (Date.now() - record.seenAt > 20000) directoryRecords.delete(key);
    return [...(discovery?.list() || []), ...directoryRecords.values()];
  }
  function rememberRecord(record) {
    if (closed || switching || !networkAvailable) return;
    if (record.transport === 'directory') {
      if (directoryRecords.size >= 1024) directoryRecords.delete(directoryRecords.keys().next().value);
      directoryRecords.set(`${record.groupId}:${record.baseUrl}`, record);
    }
    events.emit('nearby-changed');
    const group = groups.get(record.groupId);
    if (group?.mode === 'peer' && record.hostDeviceId !== device.id && peerStores.has(group.id)) { const peer = peerStores.get(group.id); peer.remember({ deviceId: record.hostDeviceId, baseUrl: record.baseUrl }); track(peer.sync(record.baseUrl)); return; }
    if (!group || group.local || group.hostDeviceId !== record.hostDeviceId) return;
        if (!resolving.has(group.id)) {
      const operation = track((async () => {
        if (await useCandidate(group, record.baseUrl) && record.directoryPort) {
          const url = new URL(record.baseUrl); url.port = String(record.directoryPort); group.directoryUrl = url.origin; await persist();
        }
      })()); resolving.set(group.id, operation);
      operation.finally(() => resolving.delete(group.id)).catch(() => {});
    }
  }
  function scanNearbyDirectories() {
    if (closed || switching || !networkAvailable || directoryScan || Date.now() - lastDirectoryScan < 15000) return directoryScan;
    lastDirectoryScan = Date.now(); directoryAbort = new AbortController();
    const operation = scanDirectories(selected, { signal: directoryAbort.signal, onRecord: rememberRecord });
    directoryScan = operation;
    operation.catch(error => discoveryError(error)).finally(() => { if (directoryScan === operation) directoryScan = null; });
    return operation;
  }
  async function startDiscovery() {
    lastDiscoveryError = null;
    if (!networkAvailable) { discovery = { list: () => [], refresh() {}, async close() {} }; return; }
    directory = await createDiscoveryDirectory({ address: selected.address, getAnnouncements: announcements, port: directoryPort, onError: error => discoveryError(error) });
    discovery = await discoveryFactory({ interfaceAddress: selected.address, getAnnouncements: announcements, onRecord: rememberRecord, onChanged: () => events.emit('nearby-changed'), onError: error => discoveryError(error) });
  }
  for (const group of saved?.groups || []) {
    if (!uuid.test(group.id) || !uuid.test(group.hostDeviceId) || !/^[a-f0-9]{64}$/.test(group.key)) throw new Error('Invalid saved group');
    groups.set(group.id, { ...group, online: false });
  }
  try {
    for (const group of groups.values()) if (group.local) await restoreHosted(group);
    if (!saved) {
      const legacy = path.join(dataDir, 'inbox');
      if (await fs.stat(path.join(legacy, 'room-key')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) {
        const group = { id: randomUUID(), name: '我的传输群', local: true, hostDeviceId: device.id };
        await fs.cp(legacy, path.join(dataDir, 'groups', group.id), { recursive: true, errorOnExist: true, force: false });
        await startHosted(group); groups.set(group.id, group);
      }
    }
    await persist(); await startDiscovery();
  } catch (error) { await directory?.close(); await Promise.allSettled([...hosted.values()].map(inbox => inbox.close())); throw error; }
  async function resolveGroup(groupId) {
    const group = groups.get(groupId); if (!group) throw fail(404, '找不到这个群');
    if(group.mode==='peer' && peerStores.get(groupId)?.state().dissolved)return {...group,online:false,storageError:'此群已被创建者解散，等待通知其他设备'};
    if (group.local || !networkAvailable || switching) return { ...group, online: group.local ? networkAvailable && hosted.has(group.id) : false };
    if (resolving.has(groupId)) { await resolving.get(groupId); return { ...group }; }
    const operation = track((async () => {
      const candidates = [...new Set([group.baseUrl, ...nearbyRecords().filter(r => r.groupId === group.id && r.hostDeviceId === group.hostDeviceId).map(r => r.baseUrl)])].filter(Boolean).slice(0, 16);
      for (const baseUrl of candidates) if (await useCandidate(group, baseUrl)) return;
      if (group.baseUrl) {
        const url = new URL(group.directoryUrl || group.baseUrl);
        const ports = [...new Set([...(group.directoryUrl ? [Number(url.port)] : []), DIRECTORY_PORT, DIRECTORY_PORT + 1, DIRECTORY_PORT + 2, DIRECTORY_PORT + 3])];
        const records = (await Promise.all(ports.map(port => probeDirectory(url.hostname, { port, localAddress: selected.address })))).flat();
        for (const record of records.filter(r => r.groupId === group.id && r.hostDeviceId === group.hostDeviceId)) {
          if (await useCandidate(group, record.baseUrl)) return;
        }
      }
      discovery.refresh();
      if (group.online && groups.get(groupId) === group) { group.online = false; changed(); }
      scanNearbyDirectories();
    })());
    resolving.set(groupId, operation);
    try { await operation; } finally { if (resolving.get(groupId) === operation) resolving.delete(groupId); }
    return { ...group };
  }
  async function authenticated(groupId, route, options = {}) {
    const group = await resolveGroup(groupId);
    if (!group.online) throw fail(503, group.storageError || '群主机或所选网络离线，请检查网络设置');
    return request(group.baseUrl, route, { ...options, headers: { ...options.headers, 'X-Room-Key': group.key, 'X-Device-Id': device.id } });
  }
  async function rebind({ force = false } = {}) {
    switching = true; for (const inbox of hosted.values()) inbox.pauseTransfers(); networkChanged();
    directoryAbort?.abort(); await directoryScan?.catch(() => {}); directoryRecords.clear();
    await directory?.close(); directory = null; await discovery.close(); await Promise.allSettled([...active]);
    await Promise.all([...peerStores.values()].map(peer => peer.close())); peerStores.clear();
    await Promise.all([...hosted.values()].map(inbox => inbox.close({ force }))); hosted.clear();
    for (const group of groups.values()) { group.online = false; if (group.local) await restoreHosted(group); }
    await startDiscovery(); switching = false; await persist(); networkChanged();
  }
  const serializedNetwork = operation => { const work = networkWrites.catch(() => {}).then(operation); networkWrites = work; return work; };
  async function refreshNetwork() {
    if (closed || explicitHost) return networkState();
    return serializedNetwork(async () => {
      const next = await listInterfaces(), old = JSON.stringify(interfaces), previous = selected; interfaces = next;
      selected = recoverNetwork(next, selection, previous);
      const addressChanged = previous?.address !== selected?.address || previous?.name !== selected?.name;
      const nextAvailable = available();
      if (networkAvailable !== nextAvailable || addressChanged) {
        networkAvailable = nextAvailable;
        try { await rebind({ force: !nextAvailable || addressChanged }); }
        catch (error) { switching = false; networkAvailable = false; networkChanged(); events.emit('network-error', error); }
      } else if (JSON.stringify(next) !== old) networkChanged();
      return networkState();
    });
  }
  let monitoring = false;
  const monitor = setInterval(() => {
    if (monitoring || closed || switching) return;
    monitoring = true;
    track(Promise.allSettled([...groups.keys()].map(async id => { await resolveGroup(id); await peerStores.get(id)?.syncAll(); }))).finally(() => { monitoring = false; });
  }, monitorIntervalMs); monitor.unref();
  const networkMonitor = setInterval(() => refreshNetwork().catch(error => events.emit('network-error', error)), networkPollMs); networkMonitor.unref();
  const manager = {
    events,
    get device() { return { ...device }; },
    getNetwork: networkState,
    refreshNetwork,
    setNetwork(nextSelection) { return serializedNetwork(async () => {
      if (closed) throw fail(503, '服务已关闭');
      const nextInterfaces = await listInterfaces(), next = chooseNetwork(nextInterfaces, nextSelection);
      for (const inbox of hosted.values()) inbox.pauseTransfers();
      if (transferCount()) { for (const inbox of hosted.values()) inbox.pauseTransfers(false); throw fail(409, '有文件正在传输，请完成或取消后再切换网络'); }
      const previous = { selected, selection, interfaces, explicitHost, networkAvailable };
      interfaces = nextInterfaces; selected = next; selection = nextSelection.mode === 'auto' ? { mode: 'auto' } : { mode: 'manual', interfaceName: next.name, address: next.address }; explicitHost = null; networkAvailable = available();
      try { await rebind(); return networkState(); }
      catch (error) {
        // Restore the old choice if it still exists. Never select another card.
        selected = previous.selected; selection = previous.selection; interfaces = previous.interfaces; explicitHost = previous.explicitHost; networkAvailable = available();
        try { await rebind({ force: true }); } catch { switching = false; networkAvailable = false; networkChanged(); }
        throw error;
      }
    }); },
    acquireTransfer() {
      if (switching || !networkAvailable) throw fail(503, '正在切换网络或所选网络已断开');
      leasedTransfers++; let released = false;
      return () => { if (!released) { released = true; leasedTransfers--; } };
    },
    listGroups: () => [...groups.values()].map(group => ({ ...group })),
    listNearby() { discovery.refresh(); scanNearbyDirectories();
      const unique = new Map(); for (const record of nearbyRecords()) unique.set(`${record.groupId}:${record.baseUrl}`, record);
      return [...unique.values()].map(record => ({ ...record })); },
    publicEndpoint(groupId) {
      const group = groups.get(groupId); if (!group) throw fail(404, '找不到这个群');
      if (group.local) { const inbox = hosted.get(groupId); if (!networkAvailable) throw fail(503, '所选网络已断开'); return endpoint(selected?.address, inbox?.port); }
      const url = new URL(group.baseUrl); if (!isPublicIPv4(url.hostname)) throw fail(503, '群主机尚无可分享的局域网地址'); return url.origin;
    },
    createGroup(name) { return serializedNetwork(async () => {
      if (closed) throw fail(503, '服务已关闭');
      if (switching) throw fail(409, '正在切换网络，请稍后再建群');
      if (typeof name !== 'string' || !name.trim()) throw fail(400, '请输入群名称');
      const group = { id: randomUUID(), name: name.trim().slice(0, 40), local: true, hostDeviceId: device.id, authVersion: 2 };
      if (peerGroups) { group.mode = 'peer'; group.authVersion = 3; group.creatorDeviceId = device.id; group.canManage = true; group.peer = { genesis: createPeerGenesis({ groupId: group.id, name: group.name, identity: peerIdentity, device }), events: [] }; }
      await startHosted(group); groups.set(group.id, group);
      try { await persist(); } catch (error) { groups.delete(group.id); await hosted.get(group.id).close(); hosted.delete(group.id); throw error; }
      discovery.refresh(); changed(); return { ...group };
    }); },
    async joinAt(baseUrl, code, expectedGroupId) {
      if (expectedGroupId !== undefined && !uuid.test(expectedGroupId)) throw fail(400, '邀请中的群编号不正确');
      code = String(code).trim(); if (!/^\d{6}$/.test(code)) throw fail(400, '请输入 6 位数字邀请码');
      const candidates = await manualGroupCandidates(baseUrl, { localAddress: selected?.address, expectedGroupId });
      let lastError;
      for (const candidate of candidates) {
        let info;
        try { info = await request(candidate, `/api/peer/info${expectedGroupId ? `?group=${expectedGroupId}` : ''}`); }
        catch (error) { lastError = error; if (![404,401].includes(error.status)) continue; }
        if (info?.protocol === PEER_PROTOCOL) {
          try {
            if (expectedGroupId && info.groupId && info.groupId !== expectedGroupId) throw fail(400, '邀请链接与目标群不匹配');
            const ticket = await request(candidate, '/api/peer/pair/request', { method: 'POST', body: createPeerJoinProof(peerIdentity, code, device) });
            if (expectedGroupId && ticket.groupId !== expectedGroupId) throw fail(400,'邀请链接与目标群不匹配');
            return { ...ticket, baseUrl: candidate, peerProtocol: PEER_PROTOCOL };
          } catch (error) { lastError=error; continue; }
        }
        try { return await manager.joinLegacyAt(candidate, code, expectedGroupId); } catch (error) { lastError = error; }
      }
      throw lastError || fail(404, '无法连接对方设备');
    },
    async joinLegacyAt(baseUrl, code, expectedGroupId) {
      baseUrl = origin(baseUrl);
      const ticket = await request(baseUrl, '/api/pair/request', { method: 'POST', body: { code, device, reset: true } });
      if (!uuid.test(ticket.groupId) || !uuid.test(ticket.hostDeviceId) || !uuid.test(ticket.requestId) || !/^[a-f0-9]{64}$/.test(ticket.pollToken)) throw fail(502, '主机返回了无效加入申请');
      if (expectedGroupId && ticket.groupId !== expectedGroupId) throw fail(400, '邀请链接与目标群不匹配');
      return { ...ticket, baseUrl };
    },
    async joinWithCode(code) {
      code = String(code).trim(); if (!/^\d{6}$/.test(code)) throw fail(400, '请输入 6 位数字邀请码');
      if (!networkAvailable) throw fail(503, '所选网络已断开，请先选择网络');
      discovery.refresh(); if (discoveryWaitMs) await sleep(discoveryWaitMs);
      const candidates = [...new Set([...nearbyRecords().map(r => r.baseUrl), ...[...hosted.values()].map(inbox => inbox.baseUrl).filter(Boolean)])].slice(0, 128);
      let limited = false;
      for (let offset = 0; offset < candidates.length; offset += 8) {
        const results = await Promise.all(candidates.slice(offset, offset + 8).map(async baseUrl => {
          try { return await manager.joinAt(baseUrl, code); }
          catch (error) { if (error.status === 429) limited = true; return null; }
        }));
        const ticket = results.find(Boolean); if (ticket) return ticket;
      }
      throw fail(limited ? 429 : 404, limited ? '尝试次数过多，请一分钟后重试' : '未找到邀请码，请确认所选网络，或填写对方电脑地址');
    },
    async checkJoin(ticket) {
      if (ticket?.peerProtocol === PEER_PROTOCOL) {
        const result = await request(ticket.baseUrl, `/api/peer/pair/status/${ticket.requestId}?offset=0`, { headers: { 'X-Poll-Token': ticket.pollToken } });
        while(result.status==='approved' && result.group.peer.hasMore){const offset=result.group.peer.nextOffset;const page=await request(ticket.baseUrl,`/api/peer/pair/status/${ticket.requestId}?offset=${offset}`,{headers:{'X-Poll-Token':ticket.pollToken}});if(page.status!=='approved')return page;if(page.group.id!==result.group.id||JSON.stringify(page.group.peer.genesis)!==JSON.stringify(result.group.peer.genesis)||page.group.peer.nextOffset<=offset)throw fail(401,'配对历史分页不匹配');result.group.peer.events.push(...page.group.peer.events);result.group.peer.hasMore=page.group.peer.hasMore;result.group.peer.nextOffset=page.group.peer.nextOffset;}
        if (result.status !== 'approved') return result;
        if (result.group?.id !== ticket.groupId || result.group?.mode !== 'peer') throw fail(401, '批准的群与邀请不匹配');
        const verified = createPeerReplica({ identity: peerIdentity, device, ...result.group.peer, randomBytes });
        if (verified.state().id !== result.group.id || !verified.state().members.some(member => member.id === device.id && member.publicKey === peerIdentity.publicKey)) throw fail(401, '批准记录未授权本机身份');
        result.group.creatorDeviceId = result.group.peer.genesis.creatorDeviceId;
        const existing = groups.get(result.group.id);
        if (existing?.mode === 'peer') { const peer = peerStores.get(existing.id); peer.remember({deviceId:ticket.hostDeviceId,baseUrl:ticket.baseUrl}); await peer.sync(ticket.baseUrl); return {status:'approved',group:{...existing}}; }
        const group = { ...result.group, local: true, hostDeviceId: device.id, peerEndpoints: [{ deviceId: ticket.hostDeviceId, baseUrl: ticket.baseUrl }] };
        await startHosted(group); groups.set(group.id, group); await persist(); discovery.refresh(); changed(); await peerStores.get(group.id).sync(ticket.baseUrl);
        return {status:'approved',group:{...group}};
      }
      if (!uuid.test(ticket?.requestId) || !/^[a-f0-9]{64}$/.test(ticket?.pollToken)) throw fail(400, '加入申请不正确');
      const result = await request(ticket.baseUrl, `/api/pair/status/${ticket.requestId}`, { headers: { 'X-Poll-Token': ticket.pollToken } });
      if (result.status !== 'approved') return result;
      const incoming = result.group;
      if (incoming.id !== ticket.groupId || incoming.hostDeviceId !== ticket.hostDeviceId || !uuid.test(incoming.hostDeviceId) || !/^[a-f0-9]{64}$/.test(incoming.key)) throw fail(400, '群信息不正确');
      if (groups.get(incoming.id)?.local) return { status: 'approved', group: { ...groups.get(incoming.id) } };
      const group = { id: incoming.id, name: incoming.name, hostDeviceId: incoming.hostDeviceId, key: incoming.key, authVersion: incoming.authVersion === 2 ? 2 : 1, baseUrl: ticket.baseUrl, local: false, online: true };
      if (!await authenticate(group, group.baseUrl)) throw fail(401, '群主机身份验证失败');
      const previous = groups.get(group.id); groups.set(group.id, group);
      try { await persist(); } catch (error) { if (previous) groups.set(group.id, previous); else groups.delete(group.id); throw error; }
      changed();
      return { status: 'approved', group: { ...group } };
    },
    async createInvite(groupId) {
      if (peerStores.has(groupId)) { const invite = peerStores.get(groupId).createInvite(); let baseUrl = null; try { baseUrl = manager.publicEndpoint(groupId); } catch {} return { ...invite, baseUrl, peerProtocol: PEER_PROTOCOL, link: baseUrl ? `${baseUrl}/#invite=${invite.code}&group=${groupId}&protocol=peer` : null }; }
      const invite = await authenticated(groupId, '/api/pair/invite', { method: 'POST', body: {} });
      let baseUrl = null; try { baseUrl = manager.publicEndpoint(groupId); } catch { /* Explicit loopback test hosts can still use the code. */ }
      return { ...invite, baseUrl, link: baseUrl ? `${baseUrl}/#invite=${invite.code}&group=${groupId}` : null };
    },
    listJoinRequests: groupId => peerStores.has(groupId) ? Promise.resolve(peerStores.get(groupId).listJoinRequests()) : authenticated(groupId, '/api/pair/requests'),
    respondJoin: (groupId, requestId, allow) => peerStores.has(groupId) ? peerStores.get(groupId).respondJoin(requestId, allow) : authenticated(groupId, '/api/pair/respond', { method: 'POST', body: { requestId, allow } }),
    resolveGroup,
    authenticated,
    async updateDevice(name) {
      if (typeof name !== 'string' || !name.trim()) throw fail(400, '请输入设备名称');
      device.name = name.trim().slice(0, 40); await persist();
      await Promise.allSettled([...groups.keys()].map(groupId => authenticated(groupId, '/api/join', { method: 'POST', body: device })));
      changed(); return { ...device };
    },
    secureMembers(groupId) { return serializedNetwork(async () => {
      if (closed) throw fail(503, '服务已关闭');
      const group = groups.get(groupId), inbox = hosted.get(groupId);
      if (!group || !inbox || !group.local) throw fail(403, '只有群主机可以升级群凭据');
      const secured = await inbox.secureMembers();
      Object.assign(group, secured);
      try { await persist(); } catch { throw fail(500, '群授权已升级，但本机保存失败；请重新打开群或重启恢复'); } finally { changed(); }
      return { ...group };
    }); },
    removeMember(groupId, deviceId) {
      if (!uuid.test(deviceId)) throw fail(400, '设备编号不正确');
      if (peerStores.has(groupId)) return peerStores.get(groupId).append('member.remove', { deviceId });
      return authenticated(groupId, '/api/members/remove', { method: 'POST', body: { deviceId } });
    },
    async leaveGroup(groupId) {
      const group = groups.get(groupId); if (!group) throw fail(404, '找不到这个群');
      if (group.mode === 'peer') { const peer = peerStores.get(groupId); if(peer.state().members.some(m=>m.id===device.id))await peer.append('member.leave', {});group.pendingDeparture='leave';await persist();const acknowledged=await peer.syncAll();if(!acknowledged && peer.state().members.length)throw fail(409,'退出记录已保存，尚未获得其他成员同步确认；保留此群等待同步后重试，或仅从本机忘记');return manager.forgetGroup(groupId); }
      if (group.local) throw fail(409, '群主机不能退出托管的群');
      await authenticated(groupId, '/api/members/leave', { method: 'POST', body: {} });
      return manager.forgetGroup(groupId);
    },
    async forgetGroup(groupId) {
      const group = groups.get(groupId); if (!group) throw fail(404, '找不到这个群');
      if (group.local && group.mode !== 'peer') throw fail(409, '群主机不能忘记托管的群');
      groups.delete(groupId);
      try { await persist(); } catch (error) { groups.set(groupId, group); throw error; }
      if (group.mode === 'peer') { await hosted.get(groupId)?.close({ force: true }); hosted.delete(groupId); await peerStores.get(groupId)?.close(); peerStores.delete(groupId); discovery.refresh(); }
      changed(); return { id: groupId };
    },
    getHostedInbox: groupId => hosted.get(groupId) || null,
    getPeerStore: groupId => peerStores.get(groupId) || null,
    preparePeerFile: (groupId, id, options) => { const peer = peerStores.get(groupId); if (!peer) throw fail(400, '不是点对点群'); return peer.prepareFile(id, options); },
    async renameGroup(groupId, name) {
      const group = groups.get(groupId); if (!group) throw fail(404, '找不到群'); if (typeof name !== 'string' || !name.trim()) throw fail(400, '请输入群名'); name = name.trim().slice(0,40);
      if (peerStores.has(groupId)) await peerStores.get(groupId).append('rename', {name}); else { if (!group.local) throw fail(403, '只有创建者可改名'); hosted.get(groupId)?.renameGroup(name); }
      group.name = name; await persist(); changed(); return {...group};
    },
    async deleteGroup(groupId) {
      const group = groups.get(groupId); if (!group) throw fail(404, '找不到群');
      if (peerStores.has(groupId)) { const peer=peerStores.get(groupId);if(group.creatorDeviceId!==device.id)throw fail(403,'Only creator may dissolve group');if(!peer.state().dissolved)await peer.append('dissolve', {});group.pendingDeparture='dissolve';await persist();const acknowledged=await peer.syncAll();if(!acknowledged && peer.state().members.some(m=>m.id!==device.id))throw fail(409,'解散记录已保存，尚未获得其他成员同步确认；保留此群等待同步后重试，尚未完成全群通知');return manager.forgetGroup(groupId); }
      if (!group.local) return manager.forgetGroup(groupId);
      if (hosted.get(groupId)?.activeTransfers()) throw fail(409, '有文件正在传输'); groups.delete(groupId); await persist(); await hosted.get(groupId)?.close(); hosted.delete(groupId); discovery.refresh(); changed(); return {id:groupId};
    },
    upgradeGroup(groupId) { return serializedNetwork(async () => {
      const group=groups.get(groupId); if(!group?.local)throw fail(403,'请在原托管设备升级'); if(group.mode==='peer')return {...group};
      const inbox=hosted.get(groupId); if(inbox.activeTransfers())throw fail(409,'有文件正在传输');
      const oldMessages=inbox.exportMessages(), previous={...group};
      const genesis=createPeerGenesis({groupId,name:group.name,identity:peerIdentity,device}), staged=createPeerReplica({identity:peerIdentity,device,genesis,randomBytes});
      for(const message of oldMessages)staged.append('message',{...message,senderId:device.id,senderName:`${message.senderName}（旧记录导入）`,legacySenderId:message.senderId});
      const peerPath=path.join(dataDir,'groups',groupId,'peer.json');
      await writeJsonWithBackup(peerPath,staged.snapshot());
      await inbox.close();hosted.delete(groupId);
      try {Object.assign(group,{mode:'peer',creatorDeviceId:device.id,authVersion:3,canManage:true});await startHosted(group);await persist();}
      catch(error){await hosted.get(groupId)?.close({force:true});hosted.delete(groupId);await peerStores.get(groupId)?.close();peerStores.delete(groupId);for(const key of Object.keys(group))delete group[key];Object.assign(group,previous);await startHosted(group);throw error;}
      discovery.refresh();changed();return {...group};
    }); },
    async reconnectGroup(groupId,address) {
      const group=groups.get(groupId);if(!group)throw fail(404,'找不到群');
      const candidates=await manualGroupCandidates(address,{localAddress:selected?.address,expectedGroupId:groupId});
      for(const candidate of candidates){if(group.mode==='peer' ? await peerStores.get(groupId).sync(candidate) : await useCandidate(group,candidate)) { await persist();changed();return {...group}; }}
      throw fail(503,'地址无法连接或设备身份不匹配');
    },
    async close({ force = false } = {}) {
      if (closed) return; closed = true; clearInterval(monitor); clearInterval(networkMonitor); await networkWrites.catch(() => {}); directoryAbort?.abort(); await directoryScan?.catch(() => {}); await directory?.close(); await discovery.close();
      await Promise.allSettled([...active]);
      await Promise.all([...peerStores.values()].map(peer => peer.close())); await Promise.all([...hosted.values()].map(inbox => inbox.close({ force }))); await writeQueue;
    },
  };
  return manager;
}
