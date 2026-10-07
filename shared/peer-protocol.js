import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export const PEER_PROTOCOL = 'pickdrop-peer-v1';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const bytes = value => utf8ToBytes(canonical(value));
const digest = value => bytesToHex(sha256(bytes(value)));
const randomDefault = count => globalThis.crypto.getRandomValues(new Uint8Array(count));
const sign = (value, identity) => bytesToHex(ed25519.sign(bytes(value), hexToBytes(identity.privateKey)));
function verify(value, signature, publicKey) {
  try { return hex(publicKey) && typeof signature === 'string' && signature.length === 128 && ed25519.verify(hexToBytes(signature), bytes(value), hexToBytes(publicKey)); } catch { return false; }
}
export function createPeerIdentity(privateKey) {
  const secret = privateKey || bytesToHex(randomDefault(32));
  if (!hex(secret)) throw fail('Invalid peer private key');
  return { privateKey: secret, publicKey: bytesToHex(ed25519.getPublicKey(hexToBytes(secret))) };
}
export function createPeerGenesis({ groupId, name, identity, device }) {
  if (!uuid(groupId) || !uuid(device?.id) || !String(name).trim()) throw fail('Invalid peer group');
  const body = { protocol: PEER_PROTOCOL, groupId, name: name.trim().slice(0, 40), creatorDeviceId: device.id, creatorPublicKey: identity.publicKey, creator: { id: device.id, name: device.name, kind: device.kind || 'desktop', publicKey: identity.publicKey } };
  return { ...body, signature: sign(body, identity) };
}
export function createPeerJoinProof(identity, code, device) {
  const body = { protocol: PEER_PROTOCOL, operation: 'join', code: String(code), device: { id: device.id, name: device.name, kind: device.kind || 'desktop' }, publicKey: identity.publicKey };
  return { ...body, signature: sign(body, identity) };
}
export function createPeerReplica({ identity, device, genesis, events = [], now = Date.now, randomBytes = randomDefault }) {
  const { signature, ...genesisBody } = genesis || {};
  if (genesisBody.protocol !== PEER_PROTOCOL || !uuid(genesisBody.groupId) || !verify(genesisBody, signature, genesisBody.creatorPublicKey) || genesisBody.creator?.publicKey !== genesisBody.creatorPublicKey || genesisBody.creator?.id !== genesisBody.creatorDeviceId) throw fail('Invalid group genesis', 401);
  if (identity && createPeerIdentity(identity.privateKey).publicKey !== identity.publicKey) throw fail('Invalid local identity');
  const stored = new Map(), invitations = new Map(), tickets = new Map(), replays = new Map();
  const ancestors = ids => { const result = new Set(), todo = [...ids]; while (todo.length) { const id = todo.pop(); if (result.has(id)) continue; const event = stored.get(id); if (!event) throw fail('Missing event parent'); result.add(id); todo.push(...event.parents); } return result; };
  const sorted = subset => [...stored.values()].filter(e => !subset || subset.has(e.eventId)).sort((a, b) => a.clock - b.clock || a.eventId.localeCompare(b.eventId));
  function projection(subset) {
    const ordered = sorted(subset), members = new Map([[genesis.creatorDeviceId, clone(genesis.creator)]]), removed = new Map();
    for (const e of ordered) if (e.type === 'member.remove' || e.type === 'member.leave') { const id = e.type === 'member.leave' ? e.authorDeviceId : e.payload.deviceId; const targets = removed.get(id) || []; targets.push(e); removed.set(id, targets); }
    const grantChoices = new Map();
    for (const e of ordered.filter(e => e.type === 'member.add')) {
      const entries = grantChoices.get(e.payload.id) || []; entries.push(e); grantChoices.set(e.payload.id, entries);
    }
    for (const [id, entries] of grantChoices) {
      const administrative = entries.filter(e => e.authorPublicKey === genesis.creatorPublicKey);
      const selected = administrative.at(-1) || entries.at(-1);
      const conflict = !administrative.length && new Set(entries.map(e => e.payload.publicKey)).size > 1;
      grantChoices.set(id, { selected, publicKey: selected.payload.publicKey, conflict });
    }
    const allowed = e => {
      if ((removed.get(e.authorDeviceId) || []).some(r => (r.type !== 'member.leave' || r.authorPublicKey === e.authorPublicKey) && r.eventId !== e.eventId && !ancestors(r.parents).has(e.eventId) && !ancestors(e.parents).has(r.eventId))) return false;
      const choice = grantChoices.get(e.authorDeviceId);
      if (choice?.conflict) return false;
      return !choice || choice.publicKey === e.authorPublicKey || ancestors(choice.selected.parents).has(e.eventId);
    };
    const grants = ordered.filter(e => e.type === 'member.add'), grantValidity = new Map();
    const hasAuthorization = e => e.authorDeviceId === genesis.creatorDeviceId && e.authorPublicKey === genesis.creatorPublicKey || grants.some(g => g.payload.id === e.authorDeviceId && g.payload.publicKey === e.authorPublicKey && ancestors(e.parents).has(g.eventId) && validGrant(g));
    const validGrant = e => { if (grantValidity.has(e.eventId)) return grantValidity.get(e.eventId); const value = allowed(e) && hasAuthorization(e); grantValidity.set(e.eventId, value); return value; };
    let name = genesis.name, dissolved = false; const messages = new Map(), conflicts = new Set();
    for (const e of ordered) {
      if (!allowed(e) && !['member.remove', 'member.leave'].includes(e.type)) continue;
      if (e.type === 'member.add') {
        if (!validGrant(e)) continue;
        const choice = grantChoices.get(e.payload.id);
        if (choice?.conflict || choice?.publicKey !== e.payload.publicKey) continue;
        // A removed identity is never revived by an old or concurrent grant.
        const removals = (removed.get(e.payload.id) || []).filter(r => r.type !== 'member.leave' || r.authorPublicKey === e.payload.publicKey);
        if (removals.every(r => ancestors(e.parents).has(r.eventId))) members.set(e.payload.id, clone(e.payload));
      } else if (e.type === 'rename') name = e.payload.name;
      else if (e.type === 'dissolve') dissolved = true;
      else if (e.type === 'message' && hasAuthorization(e)) { const previous = messages.get(e.payload.id); if (previous && canonical(previous.payload) !== canonical(e.payload)) conflicts.add(e.payload.id); else messages.set(e.payload.id, { payload: clone(e.payload), eventId: e.eventId }); }
    }
    for (const [id, allRemovals] of removed) {
      const removals = allRemovals.filter(r => r.type !== 'member.leave' || r.authorPublicKey === members.get(id)?.publicKey);
      if (!removals.length) continue;
      const grants = ordered.filter(e => e.type === 'member.add' && e.payload.id === id && validGrant(e));
      if (!grants.some(e => removals.every(r => ancestors(e.parents).has(r.eventId)))) members.delete(id);
    }
    return { id: genesis.groupId, name, members: [...members.values()], messages: [...messages].filter(([id]) => !conflicts.has(id)).map(([,value]) => ({...value.payload,peerEventId:value.eventId})), dissolved };
  }
  function validate(event) {
    if (!event || event.groupId !== genesis.groupId || !Array.isArray(event.parents) || event.parents.length > 256 || !Number.isSafeInteger(event.clock) || event.clock < 1 || !uuid(event.authorDeviceId)) throw fail('Invalid peer event');
    const { eventId, signature: sig, ...body } = event;
    if (digest({ ...body, signature: sig }) !== eventId || !verify(body, sig, event.authorPublicKey)) throw fail('Invalid event signature', 401);
    const past = ancestors(event.parents), parentState = projection(past);
    const member = parentState.members.find(m => m.id === event.authorDeviceId && m.publicKey === event.authorPublicKey);
    if (!member || parentState.dissolved) throw fail('Event author is not an active member', 403);
    const expected = Math.max(0, ...event.parents.map(id => stored.get(id).clock)) + 1;
    if (event.clock !== expected) throw fail('Invalid causal clock');
    const p = event.payload;
    if (event.type === 'message') {
      if (!uuid(p?.id) || p.senderId !== event.authorDeviceId || typeof p.senderName !== 'string' || typeof p.createdAt !== 'string' || !['text', 'file'].includes(p.type)) throw fail('Invalid message');
      if (p.type === 'text' && (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 10000)) throw fail('Invalid text');
      if (p.type === 'file' && (!hex(p.sha256) || !Number.isSafeInteger(p.size) || p.size < 0 || typeof p.fileName !== 'string' || !p.fileName || /[\\/\x00]/.test(p.fileName))) throw fail('Invalid file');
    } else if (event.type === 'member.add') {
      if (!uuid(p?.id) || !hex(p.publicKey) || typeof p.name !== 'string' || !p.name.trim()) throw fail('Invalid member');
      const previous = parentState.members.find(m => m.id === p.id);
      if (event.authorPublicKey !== genesis.creatorPublicKey && sorted(past).some(e => e.type === 'member.add' && e.payload.id === p.id && e.authorPublicKey === genesis.creatorPublicKey && e.payload.publicKey !== p.publicKey)) throw fail('Only creator may reset the granted identity', 403);
      if (sorted(past).some(e => (e.type === 'member.remove' && e.payload.deviceId === p.id)) && event.authorPublicKey !== genesis.creatorPublicKey) throw fail('Only creator may restore a removed member', 403);
      if (previous && previous.publicKey !== p.publicKey && event.authorDeviceId !== genesis.creatorDeviceId) throw fail('Only creator may replace an existing identity', 403);
      if (p.id === genesis.creatorDeviceId && p.publicKey !== genesis.creatorPublicKey) throw fail('Cannot replace creator key', 403);
    } else if (event.type === 'member.remove') {
      if (event.authorPublicKey !== genesis.creatorPublicKey || !uuid(p?.deviceId) || p.deviceId === genesis.creatorDeviceId) throw fail('Only creator may remove members', 403);
    } else if (event.type === 'rename' || event.type === 'dissolve') {
      if (event.authorPublicKey !== genesis.creatorPublicKey) throw fail('Only creator may manage the group', 403);
      if (event.type === 'rename' && (typeof p?.name !== 'string' || !p.name.trim() || p.name.length > 40)) throw fail('Invalid group name');
    } else if (event.type !== 'member.leave') throw fail('Unsupported event type');
  }
  function merge(incoming) {
    if (!Array.isArray(incoming) || incoming.length > 50000) throw fail('Invalid event batch');
    const added = [];
    try {
      const todo = new Map(incoming.map(e => [e?.eventId, e]));
      for (const [id, event] of todo) if (stored.has(id)) { if (canonical(stored.get(id)) !== canonical(event)) throw fail('Conflicting event'); todo.delete(id); }
      while (todo.size) {
        let progressed = false;
        for (const [id, event] of todo) {
          if (!Array.isArray(event?.parents)) throw fail('Invalid event parents');
          if (event.parents.some(parent => !stored.has(parent))) continue;
          validate(event); stored.set(id, clone(event)); added.push(id); todo.delete(id); progressed = true;
        }
        if (!progressed) throw fail('Missing or cyclic event ancestry');
      }
      return added.length;
    } catch (error) { for (const id of added) stored.delete(id); throw error; }
  }
  merge(events);
  const api = {
    checkpoint: () => ({ events: sorted().map(clone), invitations: [...invitations].map(clone), tickets: [...tickets].map(clone), replays: [...replays] }),
    restore(checkpoint) { stored.clear(); merge(checkpoint.events); for (const [map, entries] of [[invitations, checkpoint.invitations], [tickets, checkpoint.tickets], [replays, checkpoint.replays]]) { map.clear(); for (const [key,value] of entries) map.set(key,value); } },
    snapshot: () => ({ genesis: clone(genesis), events: sorted().map(clone) }), state: () => projection(), merge,
    append(type, payload) {
      if (!identity || !device) throw fail('Replica is read only', 403);
      const parents = [...stored.keys()].filter(id => ![...stored.values()].some(e => e.parents.includes(id)));
      const body = { groupId: genesis.groupId, authorDeviceId: device.id, authorPublicKey: identity.publicKey, clock: Math.max(0, ...parents.map(id => stored.get(id).clock)) + 1, parents, nonce: bytesToHex(randomBytes(16)), type, payload: clone(payload) };
      const signed = { ...body, signature: sign(body, identity) }, event = { ...signed, eventId: digest(signed) }; merge([event]); return clone(event);
    },
    proof(operation, payload) {
      const body = { protocol: PEER_PROTOCOL, groupId: genesis.groupId, senderDeviceId: device.id, senderPublicKey: identity.publicKey, operation, payload, timestamp: now(), nonce: bytesToHex(randomBytes(24)) };
      return { ...body, signature: sign(body, identity) };
    },
    verifyProof(proof, operation, { allowUnknown = false } = {}) {
      const { signature: sig, ...body } = proof || {};
      if (body.protocol !== PEER_PROTOCOL || body.groupId !== genesis.groupId || body.operation !== operation || !Number.isFinite(body.timestamp) || Math.abs(now() - body.timestamp) > 120000 || typeof body.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(body.nonce) || !verify(body, sig, body.senderPublicKey)) throw fail('Invalid peer proof', 401);
      const state = projection(); if (state.dissolved && !['sync', 'sync-result'].includes(operation)) throw fail('Group has been dissolved', 410);
      if (!allowUnknown && !state.members.some(m => m.id === body.senderDeviceId && m.publicKey === body.senderPublicKey)) throw fail('Peer is not an active member', 403);
      for (const [key, until] of replays) if (until < now()) replays.delete(key);
      const key = `${body.senderPublicKey}:${body.nonce}`; if (replays.has(key)) throw fail('Replayed peer proof', 409);
      if (replays.size > 10000) throw fail('Too many peer requests', 429); replays.set(key, now() + 120000);
      return body.payload;
    },
    createInvite() {
      if(projection().dissolved)throw fail('Group has been dissolved',410);
      if (!projection().members.some(m => m.id === device.id && m.publicKey === identity.publicKey)) throw fail('Not a member', 403);
      for (const [code, value] of invitations) if (value.expiresAt < now()) invitations.delete(code);
      if (invitations.size >= 20) throw fail('Too many invitations', 429);
      let code; do { const b = randomBytes(4); code = String(((b[0] * 16777216 + b[1] * 65536 + b[2] * 256 + b[3]) >>> 0) % 1000000).padStart(6, '0'); } while (invitations.has(code));
      const invite = { code, expiresAt: now() + 300000 }; invitations.set(code, invite); return { ...invite };
    },
    requestJoin(proof) {
      const { signature: sig, ...body } = proof || {};
      if (body.protocol !== PEER_PROTOCOL || body.operation !== 'join' || !uuid(body.device?.id) || typeof body.device?.name !== 'string' || !verify(body, sig, body.publicKey)) throw fail('Invalid join identity', 401);
      const invite = invitations.get(body.code); if (!invite || invite.expiresAt < now()) throw fail('邀请码无效或已过期', 404);
      invitations.delete(body.code);
      for (const [id, ticket] of tickets) if (ticket.expiresAt + 3600000 < now()) tickets.delete(id);
      if (tickets.size >= 100) throw fail('Too many join requests', 429);
      const requestId = bytesToHex(randomBytes(16)), pollToken = bytesToHex(randomBytes(32));
      const existing = projection().members.find(m => m.id === body.device.id);
      const ticket = { requestId, pollToken, device: body.device, publicKey: body.publicKey, reset: Boolean(existing && existing.publicKey !== body.publicKey), status: 'pending', expiresAt: now() + 300000 };
      tickets.set(requestId, ticket); return { requestId, pollToken, expiresAt: ticket.expiresAt, groupId: genesis.groupId, groupName: projection().name, hostDeviceId: device.id, peerProtocol: PEER_PROTOCOL };
    },
    listJoinRequests: () => [...tickets.values()].filter(t => t.status === 'pending' && t.expiresAt > now()).map(({ pollToken, ...t }) => ({ ...clone(t), id: t.requestId })),
    respondJoin(requestId, allow) {
      const ticket = tickets.get(requestId); if (!ticket || ticket.expiresAt < now()) throw fail('加入申请已过期', 410);
      if (ticket.status !== 'pending') throw fail('加入申请已处理', 409);
      if (typeof allow !== 'boolean') throw fail('Invalid decision');
      if (allow) { api.append('member.add', { ...ticket.device, publicKey: ticket.publicKey }); ticket.status = 'approved'; ticket.approvedEvents = [...stored.keys()]; } else ticket.status = 'denied';
      return { status: ticket.status };
    },
    checkJoin(requestId, pollToken) {
      const ticket = tickets.get(requestId); if (!ticket || ticket.pollToken !== pollToken) throw fail('找不到加入申请', 404);
      if (ticket.status === 'approved' && !projection().members.some(m => m.id === ticket.device.id && m.publicKey === ticket.publicKey)) return {status:'revoked'};
      if (ticket.status === 'approved') return { status: 'approved', group: { id: genesis.groupId, name: projection().name, creatorDeviceId: genesis.creatorDeviceId, mode: 'peer', authVersion: 3, peer: { genesis: clone(genesis), events: sorted().filter(e => ticket.approvedEvents?.includes(e.eventId)).map(clone) } } };
      return { status: ticket.expiresAt <= now() ? 'expired' : ticket.status };
    },
  };
  return api;
}
