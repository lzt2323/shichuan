import { randomInt, randomBytes, randomUUID, createHmac } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Codes and approval tickets deliberately stay in memory and expire on restart.
// Every registered device with the group key has the same invitation/approval rights.
export function createGroupPairing({ group, key, registerDevice, now = Date.now, ttl = 300000, onRequestsChanged = () => {} }) {
  const invites = new Map(), requests = new Map(), limits = new Map();
  function prune() {
    for (const [code, invite] of invites) if (invite.expiresAt <= now()) invites.delete(code);
    for (const [id, request] of requests) if (request.expiresAt + ttl <= now()) requests.delete(id);
    for (const [ip, limit] of limits) if (limit.until <= now()) limits.delete(ip);
  }
  function rate(ip) {
    prune();
    let limit = limits.get(ip);
    if (!limit) { limit = { count: 0, until: now() + 60000 }; limits.set(ip, limit); }
    if (++limit.count > 10) throw fail(429, '尝试次数过多，请一分钟后重试');
  }
  const publicRequest = request => ({ id: request.id, requestId: request.id, device: request.device, createdAt: request.createdAt, expiresAt: request.expiresAt, status: request.expiresAt <= now() ? 'expired' : request.status });
  return {
    probe(challenge) {
      if (typeof challenge !== 'string' || !/^[a-f0-9]{64}$/.test(challenge)) throw fail(400, '验证请求不正确');
      return { groupId: group.id, hostDeviceId: group.hostDeviceId, proof: createHmac('sha256', key).update(`${group.id}:${challenge}`).digest('hex') };
    },
    invite() {
      prune();
      if (invites.size >= 20) throw fail(429, '有效邀请码过多，请稍后再试');
      let code;
      do { code = String(randomInt(1000000)).padStart(6, '0'); } while (invites.has(code));
      const result = { code, expiresAt: now() + ttl };
      invites.set(code, result); return result;
    },
    request(code, device, ip) {
      rate(ip);
      if (!uuid.test(device?.id) || typeof device?.name !== 'string' || !device.name.trim()) throw fail(400, '设备信息不正确');
      const invite = invites.get(code);
      if (!invite || invite.expiresAt <= now()) throw fail(404, '邀请码无效或已过期');
      invites.delete(code); // Reserve exactly once, before waiting for approval.
      const request = { id: randomUUID(), pollToken: randomBytes(32).toString('hex'), device: { id: device.id, name: device.name.trim().slice(0, 40), kind: ['desktop', 'ios', 'android', 'web'].includes(device.kind) ? device.kind : 'web' }, status: 'pending', createdAt: now(), expiresAt: now() + ttl };
      requests.set(request.id, request); onRequestsChanged();
      return { status: 'pending', requestId: request.id, pollToken: request.pollToken, groupId: group.id, groupName: group.name, hostDeviceId: group.hostDeviceId, expiresAt: request.expiresAt };
    },
    status(id, token, ip) {
      prune();
      const request = requests.get(id);
      if (!request || typeof token !== 'string' || token !== request.pollToken) { rate(ip); throw fail(404, '找不到加入申请'); }
      const status = request.expiresAt <= now() ? 'expired' : request.status === 'approving' ? 'pending' : request.status;
      return status === 'approved' ? { status, group: { ...group, key } } : { status };
    },
    list() { prune(); return [...requests.values()].filter(r => r.status === 'pending' && r.expiresAt > now()).map(publicRequest); },
    async respond(id, allow) {
      const request = requests.get(id);
      if (!request || request.expiresAt <= now()) throw fail(410, '加入申请已过期');
      if (request.status !== 'pending') throw fail(409, '加入申请已处理');
      if (typeof allow !== 'boolean') throw fail(400, '审批结果不正确');
      // Reserve the decision before asynchronous disk I/O to avoid concurrent approval races.
      request.status = allow ? 'approving' : 'denied';
      try { if (allow) { await registerDevice(request.device); request.status = 'approved'; } }
      catch (error) { request.status = 'pending'; throw error; }
      onRequestsChanged(); return { status: request.status };
    },
  };
}
