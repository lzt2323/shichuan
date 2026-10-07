import { createPeerIdentity, createPeerGenesis, createPeerReplica, createPeerJoinProof, canonical } from '../../../shared/peer-protocol.js';
import { bytesToHex } from '@noble/hashes/utils';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const PRIVATE_KEY = 'pickdrop-peer-identity-v1';
const uuid = /^[a-f0-9-]{36}$/i;
const origin = value => { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('设备地址无效'); return url.origin; };

/** All replica data lives in an atomic file store, only the Ed25519 secret lives
 * in SecureStore. The transport is replaceable for real multi-node tests. */
export function createMobilePeer({ credentials, records, transport, randomBytes, randomUUID, device, fetchImpl = globalThis.fetch, onChanged = () => {} }) {
  let identity, initialized, endpoint, active = false, starting, timer, epoch = 0, diagnostic = null;
  const limits = new Map(), departures = new Map();
  const replicas = new Map(), peers = new Map(), listeners = new Map(), syncing = new Map(), tails = new Map(), remoteKnown = new Map();
  const recordKey = id => 'peer_' + id;
  const serial = (id, work) => { const next = (tails.get(id) || Promise.resolve()).catch(() => {}).then(work); tails.set(id, next); return next; };
  async function initialize() {
    if (!initialized) initialized = (async () => {
      let key = await credentials.getItemAsync(PRIVATE_KEY);
      if (!key) { key = bytesToHex(randomBytes(32)); await credentials.setItemAsync(PRIVATE_KEY, key); }
      identity = createPeerIdentity(key);
    })().catch(error => { initialized = null; throw error; });
    return initialized;
  }
  const replica = id => { const value = replicas.get(id); if (!value) throw fail('群副本尚未载入', 404); return value; };
  async function change(id, work) {
    const local = replica(id), checkpoint = local.checkpoint(), oldPeers = new Map(peers.get(id) || []), oldDeparture = departures.get(id);
    try { const result = await work(local); await save(id); publish(id); return result; }
    catch (error) { local.restore(checkpoint); peers.set(id, oldPeers); if (oldDeparture) departures.set(id, oldDeparture); else departures.delete(id); throw error; }
  }
  async function save(id) {
    await records.setItemAsync(recordKey(id), JSON.stringify({ ...replica(id).snapshot(), pendingDeparture: departures.get(id), peers: [...(peers.get(id)?.values() || [])] }));
  }
  function publish(id) {
    const state = runtime.state(id);
    for (const listener of listeners.get(id) || []) listener(state);
    onChanged(id, state);
  }
  function rememberPeer(id, value) {
    if (!value || !uuid.test(value.deviceId || '') || value.deviceId === device().id) return;
    try {
      const baseUrl = origin(value.baseUrl);
      const list = peers.get(id) || new Map(); peers.set(id, list);
      // These remain untrusted address hints until the remote signed snapshot
      // validates. No private key, room credential or local path is sent.
      if (list.size >= 64 && !list.has(baseUrl)) list.delete(list.keys().next().value);
      list.set(baseUrl, { deviceId: value.deviceId, baseUrl, seenAt: value.seenAt || 0 });
    } catch { /* Bad discovery hints are ignored. */ }
  }
  async function request(baseUrl, path, body, headers = {}, signal) {
    if (signal?.aborted) throw Object.assign(new Error('操作已取消'), { name: 'AbortError' });
    const abort = new AbortController(); const cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, { once: true }); const timeout = setTimeout(() => abort.abort(), 5000);
    try {
      const response = await fetchImpl(origin(baseUrl) + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: abort.signal, redirect: 'error' });
      const value = await response.json(); if (!response.ok) throw fail(value.error || '设备暂时不可达', response.status); return value;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  }
  function validateIncoming(local, proof, data) {
    if (canonical(data.genesis) !== canonical(local.snapshot().genesis)) throw fail('群身份不匹配', 401);
    const candidate = createPeerReplica({ identity, device: device(), randomBytes, ...local.snapshot() });
    candidate.merge(data.events || []);
    return [...local.state().members, ...candidate.state().members].some(member => member.id === proof.senderDeviceId && member.publicKey === proof.senderPublicKey);
  }
  async function advertise() {
    if (!endpoint || !active) return;
    await transport.advertise?.([...replicas].filter(([id]) => runtime.state(id).devices.some(member => member.id === device().id)).map(([id, value]) => ({ groupId: id, hostDeviceId: device().id, name: value.state().name })));
  }
  async function handle(req) {
    if (!active) throw fail('手机节点已暂停，请返回应用', 503);
    const url = new URL(req.path, 'http://localhost');
    let body; try { body = req.body ? JSON.parse(req.body) : {}; } catch { throw fail('请求格式无效'); }
    if (url.pathname === '/api/peer/info') return { body: { protocol: 'pickdrop-peer-v1', device: device() } };
    if (url.pathname === '/api/discovery/groups') return { body: { protocol: 'pickdrop-directory-v1', groups: [...replicas].map(([id, value]) => ({ groupId: id, hostDeviceId: device().id, name: value.state().name, port: endpoint.port, peerProtocol: 'pickdrop-peer-v1' })) } };
    if (url.pathname === '/api/peer/sync' && req.method === 'POST') {
      const id = body.groupId;
      return serial(id, () => change(id, async local => {
        const payload = local.verifyProof(body, 'sync', { allowUnknown: true });
        const wasMember = local.state().members.some(member => member.id === body.senderDeviceId && member.publicKey === body.senderPublicKey);
        validateIncoming(local, body, payload);
        local.merge(payload.events || []);
        const stillMember = local.state().members.some(member => member.id === body.senderDeviceId && member.publicKey === body.senderPublicKey);
        if (!stillMember) return { body: local.proof('sync-result', { genesis: local.snapshot().genesis, events: [], accepted: (payload.events || []).map(event => event.eventId), needsMembership: !wasMember, revoked: wasMember }) };
        if (payload.endpoint?.deviceId === body.senderDeviceId) rememberPeer(id, { ...payload.endpoint, seenAt: Date.now() });
        const snapshot = local.snapshot(), known = new Set(payload.known || []), missing = snapshot.events.filter(event => !known.has(event.eventId));
        return { body: local.proof('sync-result', { genesis: snapshot.genesis, events: Array.isArray(payload.known) ? missing.slice(0, 128) : snapshot.events, known: snapshot.events.map(event => event.eventId), hasMore: missing.length > 128, peers: [...(peers.get(id)?.values() || [])], endpoint: { deviceId: device().id, baseUrl: endpoint.baseUrl } }) };
      }));
    }
    if (url.pathname.startsWith('/api/peer/files/') && req.method === 'GET') {
      let proof; try { proof = JSON.parse(req.headers['x-peer-proof'] || ''); } catch { throw fail('缺少设备授权', 401); }
      const local = replica(proof.groupId); const payload = local.verifyProof(proof, 'file');
      const id = decodeURIComponent(url.pathname.slice('/api/peer/files/'.length));
      if (payload.id !== id) throw fail('文件授权不匹配', 401);
      const message = local.state().messages.find(item => item.id === id && item.type === 'file' && !item.deleted);
      if (!message) throw fail('群中没有此文件', 404);
      const file = await transport.hasFile(message.sha256);
      if (!file || file.size !== message.size) throw fail('此设备尚未持有文件', 404);
      return { file: file.uri };
    }
    if (url.pathname === '/api/peer/pair/request' && req.method === 'POST') {
      const address = req.remoteAddress || 'unknown';
      for (const [key, value] of limits) if (value.until < Date.now()) limits.delete(key);
      const limit = limits.get(address) || { count: 0, until: Date.now() + 60000 };
      if (limits.size > 1024 || ++limit.count > 10) throw fail('尝试次数过多，请一分钟后重试', 429);
      limits.set(address, limit);
      for (const [id, local] of replicas) {
        try { return { body: { ...local.requestJoin(body), groupId: id, hostDeviceId: device().id, groupName: local.state().name } }; }
        catch (error) { if (error.status !== 404) throw error; }
      }
      throw fail('邀请码无效或已过期', 404);
    }
    if (url.pathname.startsWith('/api/peer/pair/status/')) {
      const requestId = url.pathname.split('/').at(-1);
      for (const [id, local] of replicas) {
        try { const result = local.checkJoin(requestId, req.headers['x-poll-token']); if (result.status !== 'approved') return { body: result }; const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0), snapshot = result.group.peer; return { body: { ...result, group: { ...result.group, baseUrl: endpoint.baseUrl, peer: { ...snapshot, events: snapshot.events.slice(offset, offset + 128), nextOffset: offset + 128, hasMore: offset + 128 < snapshot.events.length } } } }; }
        catch (error) { if (error.status !== 404) throw error; }
      }
      throw fail('加入申请不存在', 404);
    }
    throw fail('此节点不支持该请求', 404);
  }
  const runtime = {
    initialize,
    async restore(group) {
      await initialize(); if (replicas.has(group.id)) return;
      const raw = await records.getItemAsync(recordKey(group.id));
      if (!raw) throw fail('群副本丢失，请从在线成员重新加入');
      const saved = JSON.parse(raw); if (saved.pendingDeparture) departures.set(group.id, saved.pendingDeparture); if (saved.genesis?.groupId !== group.id) throw fail('群副本身份与记录不匹配');
      replicas.set(group.id, createPeerReplica({ identity, device: device(), randomBytes, genesis: saved.genesis, events: saved.events }));
      peers.set(group.id, new Map()); for (const peer of saved.peers || []) rememberPeer(group.id, peer);
      await advertise();
    },
    async accept(group, baseUrl) {
      await initialize();
      const data = group.peer; if (data?.genesis?.groupId !== group.id) throw fail('群副本身份不匹配', 401); if (!data?.genesis || !Array.isArray(data.events)) throw fail('群副本不完整');
      const local = createPeerReplica({ identity, device: device(), randomBytes, genesis: data.genesis, events: data.events });
      if (!local.state().members.some(member => member.id === device().id && member.publicKey === identity.publicKey)) throw fail('群尚未授权此设备', 401);
      replicas.set(group.id, local); peers.set(group.id, new Map());
      for (const peer of data.peers || []) rememberPeer(group.id, peer);
      if (baseUrl) rememberPeer(group.id, { deviceId: group.hostDeviceId || group.creatorDeviceId, baseUrl });
      await save(group.id); await advertise(); publish(group.id);
      return runtime.group(group.id, baseUrl);
    },
    async create(name) {
      await initialize(); await runtime.start();
      const id = randomUUID(), genesis = createPeerGenesis({ groupId: id, name, identity, device: device() });
      replicas.set(id, createPeerReplica({ identity, device: device(), randomBytes, genesis })); peers.set(id, new Map());
      await save(id); await advertise(); return runtime.group(id);
    },
    group(id, baseUrl) { const snap = replica(id).snapshot(); return { id, name: replica(id).state().name, mode: 'peer', authVersion: 3, creatorDeviceId: snap.genesis.creatorDeviceId, hostDeviceId: snap.genesis.creatorDeviceId, key: snap.genesis.creatorPublicKey, baseUrl: baseUrl || endpoint?.baseUrl || 'http://127.0.0.1' }; },
    state(id) {
      const value = replica(id).state();
      const online = new Set([...(active && endpoint ? [device().id] : []), ...[...(peers.get(id)?.values() || [])].filter(peer => Date.now() - peer.seenAt < 15000).map(peer => peer.deviceId)]);
      return { ...value, messages: value.messages.slice(-500).map((message, index) => ({ ...message, sequence: Math.max(0, value.messages.length - 500) + index + 1 })), networkWarning: diagnostic, pendingDeparture: departures.get(id), devices: value.members.map(member => ({ ...member, online: online.has(member.id) })), mode: 'snapshot', maxFileBytes: 8 * 1024 ** 3, history: { hasMore: value.messages.length > 500, before: value.messages.length ? String(Math.max(1, value.messages.length - 499)) : null, latest: String(value.messages.length), total: value.messages.length } };
    },
    history(id, before, limit = 100) { const messages = replica(id).state().messages.map((message, index) => ({ ...message, sequence: index + 1 })); const end = Math.min(messages.length, Math.max(0, Number(before) - 1 || messages.length)), start = Math.max(0, end - Math.max(1, Math.min(500, limit))); return { messages: messages.slice(start, end), history: { before: start < end ? String(start + 1) : null, hasMore: start > 0, latest: String(messages.length), total: messages.length } }; },
    async start() {
      active = true; const operationEpoch = epoch;
      await initialize(); if (!active || operationEpoch !== epoch) return;
      if (starting) return starting;
      starting = (async () => {
        const next = await transport.start(handle, message => { diagnostic = message; for (const id of replicas.keys()) publish(id); });
        if (!active || operationEpoch !== epoch) { await transport.stop(); return; }
        const changed = endpoint?.baseUrl !== next.baseUrl; endpoint = next;
        if (changed) await advertise();
        clearInterval(timer); timer = setInterval(() => { for (const id of replicas.keys()) void runtime.sync(id).catch(() => {}); }, 4000);
        for (const id of replicas.keys()) void runtime.sync(id).catch(() => {});
        return endpoint;
      })();
      try { return await starting; } finally { starting = null; }
    },
    async stop() { active = false; epoch++; clearInterval(timer); await starting?.catch(() => {}); await transport.stop(); endpoint = null; },
    isActive: () => Boolean(active && endpoint),
    endpoint: () => endpoint,
    discover(hints) { if (active) void runtime.start().catch(() => {}); for (const hint of hints || []) if (replicas.has(hint.groupId)) for (const baseUrl of [...(hint.candidateUrls || []), hint.baseUrl].filter(Boolean)) rememberPeer(hint.groupId, { deviceId: hint.hostDeviceId, baseUrl }); for (const id of replicas.keys()) void runtime.sync(id).catch(() => {}); },
    async sync(id) {
      if (!active || !endpoint || syncing.has(id)) return syncing.get(id);
      const operation = (async () => {
        const candidates = [...(peers.get(id)?.values() || [])], verified = new Set();
        await Promise.allSettled(candidates.slice(0, 16).map(async peer => {
          const knowledgeKey = id + ':' + peer.baseUrl; let authenticated = false;
          for (let page = 0; page < 16 && active && endpoint; page++) {
            const handshaking = !authenticated;
            const local = replica(id), snapshot = local.snapshot(), known = remoteKnown.get(knowledgeKey) || new Set();
            const missing = snapshot.events.filter(event => !known.has(event.eventId));
            let data;
            const remote = await request(peer.baseUrl, '/api/peer/sync?group=' + id, local.proof('sync', { genesis: snapshot.genesis, events: authenticated ? missing.slice(0, 128) : [], known: authenticated ? snapshot.events.map(event => event.eventId) : [], ...(authenticated ? { endpoint: { baseUrl: endpoint.baseUrl, deviceId: device().id } } : {}) }));
            await serial(id, () => change(id, async local => {
              data = local.verifyProof(remote, 'sync-result', { allowUnknown: true });
              if (!validateIncoming(local, remote, data)) throw fail('响应设备不是群成员', 403);
              local.merge(data.events || []);
              if (!local.state().members.some(member => member.id === remote.senderDeviceId && member.publicKey === remote.senderPublicKey)) throw fail('响应设备的群资格已撤销', 403);
              const pending = departures.get(id);
              if (pending && [...(data.known || []), ...(data.accepted || [])].includes(pending.eventId)) departures.set(id, { ...pending, acknowledged: true });
              rememberPeer(id, { ...peer, deviceId: remote.senderDeviceId, seenAt: Date.now() });
              for (const hint of data.peers || []) rememberPeer(id, { ...hint, seenAt: 0 });
              if (Array.isArray(data.known)) remoteKnown.set(knowledgeKey, new Set(data.known));
              else if (data.needsMembership && Array.isArray(data.accepted)) remoteKnown.set(knowledgeKey, new Set([...known, ...data.accepted]));
            }));
            verified.add(peer.baseUrl);
            authenticated = true;
            if (data.revoked || (!handshaking && data.needsMembership && !data.accepted?.length)) break;
            const acknowledged = remoteKnown.get(knowledgeKey) || new Set();
            if (!handshaking && !data.needsMembership && !data.hasMore && replica(id).snapshot().events.every(event => acknowledged.has(event.eventId))) break;
          }
        }));
        publish(id); return verified;
      })();
      syncing.set(id, operation); try { return await operation; } finally { syncing.delete(id); }
    },
    async connect(id, baseUrl) {
      const address = origin(baseUrl); await syncing.get(id);
      rememberPeer(id, { deviceId: replica(id).snapshot().genesis.creatorDeviceId, baseUrl: address });
      const verified = await runtime.sync(id);
      if (!verified?.has(address)) throw fail('该地址未返回有效群成员签名，请检查地址、端口与对方是否在线', 503);
    },
    subscribe(id, callback) { const set = listeners.get(id) || new Set(); listeners.set(id, set); set.add(callback); callback(runtime.state(id)); return () => set.delete(callback); },
    async append(id, type, payload) { const event = await serial(id, () => change(id, local => local.append(type, payload))); void runtime.sync(id).catch(() => {}); return event; },
    async renameDevice(id, name) { const member = replica(id).state().members.find(item => item.id === device().id); if (member) await runtime.append(id, 'member.add', { ...member, name }); },
    async message(id, text) { const item = { id: randomUUID(), type: 'text', text, senderId: device().id, senderName: device().name, createdAt: new Date().toISOString() }; await runtime.append(id, 'message', item); return item; },
    async addFile(id, uri, name, mime, cancelled = () => false) { const file = await transport.importFile(uri); if (cancelled()) throw fail('已取消'); const item = { id: randomUUID(), type: 'file', fileName: name, mime: mime || 'application/octet-stream', size: file.size, sha256: file.sha256, senderId: device().id, senderName: device().name, createdAt: new Date().toISOString() }; await runtime.append(id, 'message', item); return item; },
    async received(id, message, uri) { const file = await transport.importFile(uri); if (file.sha256 !== message.sha256 || file.size !== message.size) throw fail('文件校验失败'); return file; },
    async fileSources(id, messageId) {
      const message = replica(id).state().messages.find(item => item.id === messageId && !item.deleted); if (!message) throw fail('找不到这个文件', 404);
      const file = await transport.hasFile(message.sha256); if (file?.size === message.size) return { localUri: file.uri, sources: [] };
      await runtime.sync(id);
      const proof = replica(id).proof('file', { id: messageId });
      return { sources: [...(peers.get(id)?.values() || [])].sort((a, b) => b.seenAt - a.seenAt).map(peer => ({ url: peer.baseUrl + '/api/peer/files/' + messageId + '?group=' + id, headers: { 'X-Peer-Proof': JSON.stringify(proof) } })) };
    },
    async requestJoin(baseUrl, code, { signal, groupId } = {}) { await initialize(); const ticket = await request(baseUrl, '/api/peer/pair/request', createPeerJoinProof(identity, code, device()), {}, signal); if (!/^[a-f0-9]{32}$/.test(ticket.requestId || '') || !/^[a-f0-9]{64}$/.test(ticket.pollToken || '') || !uuid.test(ticket.groupId || '') || !uuid.test(ticket.hostDeviceId || '') || (groupId && groupId !== ticket.groupId)) throw fail('加入申请与邀请不匹配', 401); return { ...ticket, baseUrl: origin(baseUrl), mode: 'peer' }; },
    async checkJoin(ticket, { signal } = {}) {
      const route = '/api/peer/pair/status/' + ticket.requestId;
      const result = await request(ticket.baseUrl, route, undefined, { 'X-Poll-Token': ticket.pollToken }, signal);
      if (result.status !== 'approved') return result;
      if (result.group?.id !== ticket.groupId) throw fail('批准的群与邀请不匹配', 401);
      let snapshot = result.group.peer; const events = [...snapshot.events], genesis = canonical(snapshot.genesis);
      while (snapshot.hasMore) {
        if (!Number.isSafeInteger(snapshot.nextOffset) || snapshot.nextOffset !== events.length || events.length > 50000) throw fail('群副本分页无效');
        const page = await request(ticket.baseUrl, route + '?offset=' + snapshot.nextOffset, undefined, { 'X-Poll-Token': ticket.pollToken }, signal);
        if (page.status !== 'approved' || page.group?.id !== ticket.groupId || canonical(page.group.peer.genesis) !== genesis) throw fail('群副本在下载时发生身份变化', 401);
        snapshot = page.group.peer; events.push(...snapshot.events);
      }
      if (signal?.aborted) throw Object.assign(new Error('操作已取消'), { name: 'AbortError' });
      return { ...result, group: await runtime.accept({ ...result.group, hostDeviceId: ticket.hostDeviceId, peer: { ...snapshot, events } }, ticket.baseUrl) };
    },
    async invite(id) { await runtime.start(); const invite = replica(id).createInvite(); return { ...invite, groupId: id, link: `${endpoint.baseUrl}/#invite=${invite.code}&group=${id}&protocol=peer` }; },
    requests(id) { return replica(id).listJoinRequests(); },
    async respond(id, requestId, allow) { const result = await serial(id, () => change(id, local => local.respondJoin(requestId, allow))); void runtime.sync(id).catch(() => {}); return result; },
    async depart(id, type) {
      await serial(id, () => change(id, local => {
        if (!departures.has(id)) {
          const others = local.state().members.some(member => member.id !== device().id);
          const event = local.append(type, {});
          departures.set(id, { type, eventId: event.eventId, acknowledged: !others });
        }
      }));
      await runtime.sync(id);
      if (!departures.get(id)?.acknowledged) throw fail('退出或解散记录已保存，等待其他成员上线确认后重试；本机保留此群以继续同步', 409);
    },
    async forget(id) { await syncing.get(id); replicas.delete(id); departures.delete(id); peers.delete(id); listeners.delete(id); await records.deleteItemAsync?.(recordKey(id)); await advertise(); },
  };
  return runtime;
}
