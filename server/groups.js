import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createInboxServer } from './index.js';
import { createLanDiscovery } from './discovery.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function createGroupManager({ dataDir, device, discoveryFactory = createLanDiscovery, host = '0.0.0.0', pairingOptions = {}, discoveryWaitMs = 600, fetchImpl = fetch, monitorIntervalMs = 5000 } = {}) {
  if (!dataDir || !uuid.test(device?.id)) throw new Error('dataDir and a valid device are required');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(dataDir, 'groups.json'), groups = new Map(), hosted = new Map(), events = new EventEmitter();
  let saved;
  try { saved = JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Identity is stable across app restarts even if callers generate a fresh default.
  device = { ...device, ...(saved?.device || {}) };
  let writeQueue = Promise.resolve(), closed = false, discovery;
  const active = new Set(), resolving = new Map();
  const changed = () => events.emit('groups-changed');
  const persist = () => {
    const snapshot = JSON.stringify({ version: 1, device, groups: [...groups.values()].map(({ online, ...group }) => group) });
    const operation = writeQueue.catch(() => {}).then(async () => {
      const tmp = `${statePath}.${randomUUID()}.tmp`;
      try { await fs.writeFile(tmp, snapshot, { mode: 0o600 }); await fs.rename(tmp, statePath); }
      finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    });
    writeQueue = operation; return operation;
  };
  const track = promise => { active.add(promise); promise.then(() => active.delete(promise), () => active.delete(promise)); return promise; };
  async function request(baseUrl, route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetchImpl(baseUrl + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2200) });
    const result = await response.json();
    if (!response.ok) throw fail(response.status, result.error || '群连接失败');
    return result;
  }
  async function authenticate(group, baseUrl) {
    const challenge = randomBytes(32).toString('hex');
    const result = await request(baseUrl, '/api/group/probe', { method: 'POST', body: { challenge } });
    const expected = createHmac('sha256', group.key).update(`${group.id}:${challenge}`).digest('hex');
    return result.groupId === group.id && result.hostDeviceId === group.hostDeviceId && typeof result.proof === 'string' && /^[a-f0-9]{64}$/.test(result.proof) && timingSafeEqual(Buffer.from(expected), Buffer.from(result.proof));
  }
  async function useCandidate(group, baseUrl) {
    if (closed || group.local) return false;
    try { if (!await authenticate(group, baseUrl)) return false; } catch { return false; }
    if (closed) return false;
    const different = group.baseUrl !== baseUrl || !group.online;
    group.baseUrl = baseUrl; group.online = true;
    if (different) { await persist(); changed(); }
    return true;
  }
  async function startHosted(group) {
    const inbox = await createInboxServer({ dataDir: path.join(dataDir, 'groups', group.id), host, group: { id: group.id, name: group.name, hostDeviceId: group.hostDeviceId }, pairingOptions: { ...pairingOptions, onRequestsChanged: () => events.emit('requests-changed', group.id) } });
    hosted.set(group.id, inbox);
    Object.assign(group, { key: inbox.key, baseUrl: inbox.baseUrl, online: true, local: true });
    try { await inbox.registerDevice(device); }
    catch (error) { hosted.delete(group.id); await inbox.close(); throw error; }
  }
  for (const group of saved?.groups || []) {
    if (!uuid.test(group.id) || !uuid.test(group.hostDeviceId) || !/^[a-f0-9]{64}$/.test(group.key)) throw new Error('Invalid saved group');
    groups.set(group.id, { ...group, online: false });
  }
  try {
    for (const group of groups.values()) if (group.local) await startHosted(group);
    // Non-destructive legacy migration: copy first, persist the index, retain source.
    if (!saved) {
      const legacy = path.join(dataDir, 'inbox');
      if (await fs.stat(path.join(legacy, 'room-key')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) {
        const group = { id: randomUUID(), name: '我的传输群', local: true, hostDeviceId: device.id };
        await fs.cp(legacy, path.join(dataDir, 'groups', group.id), { recursive: true, errorOnExist: true, force: false });
        await startHosted(group); groups.set(group.id, group);
      }
    }
    await persist();
    discovery = await discoveryFactory({
      getAnnouncements: () => [...hosted].map(([id, inbox]) => ({ groupId: id, hostDeviceId: device.id, port: inbox.port })),
      onRecord: record => {
        const group = groups.get(record.groupId);
        if (!group || group.local || group.hostDeviceId !== record.hostDeviceId) return;
        // One resolution per group at a time bounds unsolicited LAN work.
        if (!resolving.has(group.id)) {
          const operation = track(useCandidate(group, record.baseUrl)); resolving.set(group.id, operation);
          operation.finally(() => resolving.delete(group.id)).catch(() => {});
        }
      },
      onError: error => events.emit('discovery-error', error),
    });
  } catch (error) { await Promise.allSettled([...hosted.values()].map(inbox => inbox.close())); throw error; }
  async function resolveGroup(groupId) {
    const group = groups.get(groupId); if (!group) throw fail(404, '找不到这个群');
    if (group.local) return { ...group };
    if (resolving.has(groupId)) await resolving.get(groupId);
    const candidates = [...new Set([...discovery.list().filter(r => r.groupId === group.id && r.hostDeviceId === group.hostDeviceId).map(r => r.baseUrl), group.baseUrl])];
    for (const baseUrl of candidates) if (await useCandidate(group, baseUrl)) return { ...group };
    if (group.online) { group.online = false; changed(); }
    return { ...group };
  }
  async function authenticated(groupId, route, options = {}) {
    const group = await resolveGroup(groupId);
    if (!group.online) throw fail(503, '群主机离线，等待它回到同一局域网');
    return request(group.baseUrl, route, { ...options, headers: { 'X-Room-Key': group.key, 'X-Device-Id': device.id, ...options.headers } });
  }
  let monitoring = false;
  const monitor = setInterval(() => {
    if (monitoring || closed) return;
    monitoring = true;
    track(Promise.allSettled([...groups.keys()].map(resolveGroup))).finally(() => { monitoring = false; });
  }, monitorIntervalMs); monitor.unref();
  return {
    events,
    get device() { return { ...device }; },
    listGroups: () => [...groups.values()].map(group => ({ ...group })),
    async createGroup(name) {
      if (typeof name !== 'string' || !name.trim()) throw fail(400, '请输入群名称');
      const group = { id: randomUUID(), name: name.trim().slice(0, 40), local: true, hostDeviceId: device.id };
      await startHosted(group); groups.set(group.id, group);
      try { await persist(); } catch (error) { groups.delete(group.id); await hosted.get(group.id).close(); hosted.delete(group.id); throw error; }
      discovery.refresh(); changed(); return { ...group };
    },
    async joinWithCode(code) {
      code = String(code).trim();
      if (!/^\d{6}$/.test(code)) throw fail(400, '请输入 6 位数字邀请码');
      discovery.refresh(); if (discoveryWaitMs) await sleep(discoveryWaitMs);
      const candidates = [...new Set([...discovery.list().map(r => r.baseUrl), ...[...hosted.values()].map(inbox => inbox.baseUrl)])].slice(0, 128);
      let limited = false;
      // Bound concurrency, so a large LAN cannot produce an unbounded fan-out.
      for (let offset = 0; offset < candidates.length; offset += 8) {
        const results = await Promise.all(candidates.slice(offset, offset + 8).map(async baseUrl => {
          try { return { ...await request(baseUrl, '/api/pair/request', { method: 'POST', body: { code, device } }), baseUrl }; }
          catch (error) { if (error.status === 429) limited = true; return null; }
        }));
        const ticket = results.find(Boolean); if (ticket) return ticket;
      }
      throw fail(limited ? 429 : 404, limited ? '尝试次数过多，请一分钟后重试' : '未找到邀请码，请确认双方在同一局域网且邀请码未过期');
    },
    async checkJoin(ticket) {
      if (!uuid.test(ticket?.requestId) || !/^[a-f0-9]{64}$/.test(ticket?.pollToken)) throw fail(400, '加入申请不正确');
      const result = await request(ticket.baseUrl, `/api/pair/status/${ticket.requestId}`, { headers: { 'X-Poll-Token': ticket.pollToken } });
      if (result.status !== 'approved') return result;
      const incoming = result.group;
      if (incoming.id !== ticket.groupId || !uuid.test(incoming.hostDeviceId) || !/^[a-f0-9]{64}$/.test(incoming.key)) throw fail(400, '群信息不正确');
      if (groups.get(incoming.id)?.local) return { status: 'approved', group: { ...groups.get(incoming.id) } };
      const group = { id: incoming.id, name: incoming.name, hostDeviceId: incoming.hostDeviceId, key: incoming.key, baseUrl: ticket.baseUrl, local: false, online: true };
      groups.set(group.id, group); await persist(); changed();
      return { status: 'approved', group: { ...group } };
    },
    createInvite: groupId => authenticated(groupId, '/api/pair/invite', { method: 'POST', body: {} }),
    listJoinRequests: groupId => authenticated(groupId, '/api/pair/requests'),
    respondJoin: (groupId, requestId, allow) => authenticated(groupId, '/api/pair/respond', { method: 'POST', body: { requestId, allow } }),
    resolveGroup,
    async updateDevice(name) {
      if (typeof name !== 'string' || !name.trim()) throw fail(400, '请输入设备名称');
      device.name = name.trim().slice(0, 40); await persist();
      await Promise.allSettled([...groups.keys()].map(groupId => authenticated(groupId, '/api/join', { method: 'POST', body: device })));
      changed(); return { ...device };
    },
    getHostedInbox: groupId => hosted.get(groupId) || null,
    async close() {
      if (closed) return; closed = true; clearInterval(monitor); await discovery.close();
      await Promise.allSettled([...active]);
      await Promise.all([...hosted.values()].map(inbox => inbox.close())); await writeQueue;
    },
  };
}
