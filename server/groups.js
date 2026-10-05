import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createInboxServer } from './index.js';
import { createLanDiscovery } from './discovery.js';
import { chooseNetwork, isPublicIPv4, listNetworkInterfaces, publicEndpoint as endpoint } from './network.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function origin(value) {
  let url; try { url = new URL(value); } catch { throw fail(400, '请输入完整电脑地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail(400, '电脑地址不正确');
  return url.origin;
}

export async function createGroupManager({ dataDir, device, discoveryFactory = createLanDiscovery, host, pairingOptions = {}, discoveryWaitMs = 600, fetchImpl, monitorIntervalMs = 5000, networkPollMs = 3000, listInterfaces = listNetworkInterfaces } = {}) {
  if (!dataDir || !uuid.test(device?.id)) throw new Error('dataDir and a valid device are required');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(dataDir, 'groups.json'), groups = new Map(), hosted = new Map(), events = new EventEmitter();
  let saved;
  try { saved = JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  device = { ...device, ...(saved?.device || {}) };
  let interfaces = await listInterfaces(), selection = saved?.network?.selection || { mode: 'auto' };
  // An explicit host is retained for CLI/test callers. The interactive defaults
  // never listen on all interfaces, and loopback is never a public invitation.
  let explicitHost = host && host !== '0.0.0.0' ? host : null;
  let selected = explicitHost ? { id: `explicit:${host}`, name: 'explicit', interfaceName: 'explicit', address: host, type: 'unknown', virtual: !isPublicIPv4(host), connected: true } : saved?.network?.selected || chooseNetwork(interfaces, selection);
  const available = () => Boolean(selected && (explicitHost || interfaces.some(item => item.name === selected.name && item.address === selected.address)));
  let networkAvailable = available(), switching = false, networkWrites = Promise.resolve();
  let writeQueue = Promise.resolve(), closed = false, discovery;
  let leasedTransfers = 0;
  const active = new Set(), resolving = new Map();
  const changed = () => events.emit('groups-changed');
  const networkChanged = () => { events.emit('network-changed', networkState()); changed(); };
  const transferCount = () => leasedTransfers + [...hosted.values()].reduce((sum, inbox) => sum + inbox.activeTransfers(), 0);
  const networkState = () => ({ selection: { ...selection }, selected: selected ? { ...selected, connected: networkAvailable } : null, interfaces: interfaces.map(item => ({ ...item })), available: networkAvailable, switching, transferBusy: transferCount() > 0 });
  const persist = () => {
    const snapshot = JSON.stringify({ version: 1, device, network: { selection, selected }, groups: [...groups.values()].map(({ online, ...group }) => group) });
    const operation = writeQueue.catch(() => {}).then(async () => {
      const tmp = `${statePath}.${randomUUID()}.tmp`;
      try { await fs.writeFile(tmp, snapshot, { mode: 0o600 }); await fs.rename(tmp, statePath); }
      finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    });
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
    const result = await request(baseUrl, '/api/group/probe', { method: 'POST', body: { challenge } });
    const expected = createHmac('sha256', group.key).update(`${group.id}:${challenge}`).digest('hex');
    return result.groupId === group.id && result.hostDeviceId === group.hostDeviceId && typeof result.proof === 'string' && /^[a-f0-9]{64}$/.test(result.proof) && timingSafeEqual(Buffer.from(expected), Buffer.from(result.proof));
  }
  async function useCandidate(group, baseUrl) {
    if (closed || switching || !networkAvailable || group.local || !baseUrl) return false;
    try { if (!await authenticate(group, baseUrl)) return false; } catch { return false; }
    if (closed || switching || !networkAvailable) return false;
    const different = group.baseUrl !== baseUrl || !group.online;
    group.baseUrl = baseUrl; group.online = true;
    if (different) { await persist(); changed(); }
    return true;
  }
  async function startHosted(group) {
    const inbox = await createInboxServer({ dataDir: path.join(dataDir, 'groups', group.id), host: selected?.address || '127.0.0.1', listen: networkAvailable, group: { id: group.id, name: group.name, hostDeviceId: group.hostDeviceId }, pairingOptions: { ...pairingOptions, onRequestsChanged: () => events.emit('requests-changed', group.id) } });
    hosted.set(group.id, inbox);
    Object.assign(group, { key: inbox.key, baseUrl: inbox.baseUrl || group.baseUrl || null, online: networkAvailable, local: true });
    try { await inbox.registerDevice(device); }
    catch (error) { hosted.delete(group.id); await inbox.close(); throw error; }
  }
  async function startDiscovery() {
    if (!networkAvailable) { discovery = { list: () => [], refresh() {}, async close() {} }; return; }
    discovery = await discoveryFactory({
      interfaceAddress: selected.address,
      getAnnouncements: () => [...hosted].filter(([, inbox]) => inbox.port).map(([id, inbox]) => ({ groupId: id, hostDeviceId: device.id, name: groups.get(id)?.name || '传输群', port: inbox.port, address: selected.address })),
      onRecord: record => {
        events.emit('nearby-changed');
        const group = groups.get(record.groupId);
        if (!group || group.local || group.hostDeviceId !== record.hostDeviceId || switching) return;
        if (!resolving.has(group.id)) {
          const operation = track(useCandidate(group, record.baseUrl)); resolving.set(group.id, operation);
          operation.finally(() => resolving.delete(group.id)).catch(() => {});
        }
      },
      onError: error => events.emit('discovery-error', error),
    });
  }
  for (const group of saved?.groups || []) {
    if (!uuid.test(group.id) || !uuid.test(group.hostDeviceId) || !/^[a-f0-9]{64}$/.test(group.key)) throw new Error('Invalid saved group');
    groups.set(group.id, { ...group, online: false });
  }
  try {
    for (const group of groups.values()) if (group.local) await startHosted(group);
    if (!saved) {
      const legacy = path.join(dataDir, 'inbox');
      if (await fs.stat(path.join(legacy, 'room-key')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) {
        const group = { id: randomUUID(), name: '我的传输群', local: true, hostDeviceId: device.id };
        await fs.cp(legacy, path.join(dataDir, 'groups', group.id), { recursive: true, errorOnExist: true, force: false });
        await startHosted(group); groups.set(group.id, group);
      }
    }
    await persist(); await startDiscovery();
  } catch (error) { await Promise.allSettled([...hosted.values()].map(inbox => inbox.close())); throw error; }
  async function resolveGroup(groupId) {
    const group = groups.get(groupId); if (!group) throw fail(404, '找不到这个群');
    if (group.local || !networkAvailable || switching) return { ...group, online: group.local ? networkAvailable : false };
    if (resolving.has(groupId)) await resolving.get(groupId);
    const candidates = [...new Set([...discovery.list().filter(r => r.groupId === group.id && r.hostDeviceId === group.hostDeviceId).map(r => r.baseUrl), group.baseUrl])];
    for (const baseUrl of candidates) if (await useCandidate(group, baseUrl)) return { ...group };
    if (group.online) { group.online = false; changed(); }
    return { ...group };
  }
  async function authenticated(groupId, route, options = {}) {
    const group = await resolveGroup(groupId);
    if (!group.online) throw fail(503, '群主机或所选网络离线，请检查网络设置');
    return request(group.baseUrl, route, { ...options, headers: { ...options.headers, 'X-Room-Key': group.key, 'X-Device-Id': device.id } });
  }
  async function rebind({ force = false } = {}) {
    switching = true; for (const inbox of hosted.values()) inbox.pauseTransfers(); networkChanged();
    await discovery.close(); await Promise.all([...active]);
    await Promise.all([...hosted.values()].map(inbox => inbox.close({ force }))); hosted.clear();
    for (const group of groups.values()) { group.online = false; if (group.local) await startHosted(group); }
    await startDiscovery(); switching = false; await persist(); networkChanged();
  }
  const serializedNetwork = operation => { const work = networkWrites.catch(() => {}).then(operation); networkWrites = work; return work; };
  async function refreshNetwork() {
    if (closed || explicitHost) return networkState();
    return serializedNetwork(async () => {
      const next = await listInterfaces(), old = JSON.stringify(interfaces); interfaces = next;
      const nextAvailable = available();
      if (networkAvailable !== nextAvailable) {
        networkAvailable = nextAvailable;
        try { await rebind({ force: !nextAvailable }); }
        catch (error) { switching = false; networkAvailable = false; networkChanged(); events.emit('network-error', error); }
      } else if (JSON.stringify(next) !== old) networkChanged();
      return networkState();
    });
  }
  let monitoring = false;
  const monitor = setInterval(() => {
    if (monitoring || closed || switching) return;
    monitoring = true;
    track(Promise.allSettled([...groups.keys()].map(resolveGroup))).finally(() => { monitoring = false; });
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
    listNearby() { discovery.refresh(); return discovery.list().map(record => ({ ...record })); },
    publicEndpoint(groupId) {
      const group = groups.get(groupId); if (!group) throw fail(404, '找不到这个群');
      if (group.local) { const inbox = hosted.get(groupId); if (!networkAvailable) throw fail(503, '所选网络已断开'); return endpoint(selected?.address, inbox?.port); }
      const url = new URL(group.baseUrl); if (!isPublicIPv4(url.hostname)) throw fail(503, '群主机尚无可分享的局域网地址'); return url.origin;
    },
    async createGroup(name) {
      if (switching) throw fail(409, '正在切换网络，请稍后再建群');
      if (typeof name !== 'string' || !name.trim()) throw fail(400, '请输入群名称');
      const group = { id: randomUUID(), name: name.trim().slice(0, 40), local: true, hostDeviceId: device.id };
      await startHosted(group); groups.set(group.id, group);
      try { await persist(); } catch (error) { groups.delete(group.id); await hosted.get(group.id).close(); hosted.delete(group.id); throw error; }
      discovery.refresh(); changed(); return { ...group };
    },
    async joinAt(baseUrl, code, expectedGroupId) {
      if (expectedGroupId !== undefined && !uuid.test(expectedGroupId)) throw fail(400, '邀请中的群编号不正确');
      code = String(code).trim(); if (!/^\d{6}$/.test(code)) throw fail(400, '请输入 6 位数字邀请码');
      baseUrl = origin(baseUrl);
      const ticket = await request(baseUrl, '/api/pair/request', { method: 'POST', body: { code, device } });
      if (!uuid.test(ticket.groupId) || !uuid.test(ticket.hostDeviceId) || !uuid.test(ticket.requestId) || !/^[a-f0-9]{64}$/.test(ticket.pollToken)) throw fail(502, '主机返回了无效加入申请');
      if (expectedGroupId && ticket.groupId !== expectedGroupId) throw fail(400, '邀请链接与目标群不匹配');
      return { ...ticket, baseUrl };
    },
    async joinWithCode(code) {
      code = String(code).trim(); if (!/^\d{6}$/.test(code)) throw fail(400, '请输入 6 位数字邀请码');
      if (!networkAvailable) throw fail(503, '所选网络已断开，请先选择网络');
      discovery.refresh(); if (discoveryWaitMs) await sleep(discoveryWaitMs);
      const candidates = [...new Set([...discovery.list().map(r => r.baseUrl), ...[...hosted.values()].map(inbox => inbox.baseUrl).filter(Boolean)])].slice(0, 128);
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
      if (!uuid.test(ticket?.requestId) || !/^[a-f0-9]{64}$/.test(ticket?.pollToken)) throw fail(400, '加入申请不正确');
      const result = await request(ticket.baseUrl, `/api/pair/status/${ticket.requestId}`, { headers: { 'X-Poll-Token': ticket.pollToken } });
      if (result.status !== 'approved') return result;
      const incoming = result.group;
      if (incoming.id !== ticket.groupId || incoming.hostDeviceId !== ticket.hostDeviceId || !uuid.test(incoming.hostDeviceId) || !/^[a-f0-9]{64}$/.test(incoming.key)) throw fail(400, '群信息不正确');
      if (groups.get(incoming.id)?.local) return { status: 'approved', group: { ...groups.get(incoming.id) } };
      const group = { id: incoming.id, name: incoming.name, hostDeviceId: incoming.hostDeviceId, key: incoming.key, baseUrl: ticket.baseUrl, local: false, online: true };
      if (!await authenticate(group, group.baseUrl)) throw fail(401, '群主机身份验证失败');
      const previous = groups.get(group.id); groups.set(group.id, group);
      try { await persist(); } catch (error) { if (previous) groups.set(group.id, previous); else groups.delete(group.id); throw error; }
      changed();
      return { status: 'approved', group: { ...group } };
    },
    async createInvite(groupId) {
      const invite = await authenticated(groupId, '/api/pair/invite', { method: 'POST', body: {} });
      let baseUrl = null; try { baseUrl = manager.publicEndpoint(groupId); } catch { /* Explicit loopback test hosts can still use the code. */ }
      return { ...invite, baseUrl, link: baseUrl ? `${baseUrl}/#invite=${invite.code}&group=${groupId}` : null };
    },
    listJoinRequests: groupId => authenticated(groupId, '/api/pair/requests'),
    respondJoin: (groupId, requestId, allow) => authenticated(groupId, '/api/pair/respond', { method: 'POST', body: { requestId, allow } }),
    resolveGroup,
    authenticated,
    async updateDevice(name) {
      if (typeof name !== 'string' || !name.trim()) throw fail(400, '请输入设备名称');
      device.name = name.trim().slice(0, 40); await persist();
      await Promise.allSettled([...groups.keys()].map(groupId => authenticated(groupId, '/api/join', { method: 'POST', body: device })));
      changed(); return { ...device };
    },
    getHostedInbox: groupId => hosted.get(groupId) || null,
    async close() {
      if (closed) return; closed = true; clearInterval(monitor); clearInterval(networkMonitor); await networkWrites.catch(() => {}); await discovery.close();
      await Promise.allSettled([...active]);
      await Promise.all([...hosted.values()].map(inbox => inbox.close())); await writeQueue;
    },
  };
  return manager;
}
