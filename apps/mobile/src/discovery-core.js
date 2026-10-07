const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function usableIPv4(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split('.');
  if (parts.some(part => String(Number(part)) !== part)) return false;
  const octets = parts.map(Number);
  return octets.every(part => part >= 0 && part <= 255) && octets[0] > 0 && octets[0] !== 127 && octets[0] < 224;
}
/** mDNS is an untrusted hint. Whitelist fields and never accept keys or invite codes. */
export function normalizeService(value) {
  const txt = value?.txt;
  if (!txt || txt.protocol !== 'pickdrop' || txt.version !== '1' || !UUID.test(txt.groupId || '') || !UUID.test(txt.hostDeviceId || '')) return null;
  const address = Array.isArray(value.addresses) ? value.addresses.find(usableIPv4) : undefined;
  if (!address || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.serviceId !== 'string' || value.serviceId.length > 300) return null;
  const name = String(txt.name || '附近的传输群').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || '附近的传输群';
  return { candidateUrls: [...new Set(value.addresses.filter(usableIPv4))].map(ip => `http://${ip}:${value.port}`), serviceId: value.serviceId, groupId: txt.groupId.toLowerCase(), hostDeviceId: txt.hostDeviceId.toLowerCase(), name, address, port: value.port, baseUrl: `http://${address}:${value.port}` };
}
/** Owns one native scan. Session IDs reject delayed resolution after stop/restart. */
export function createDiscoveryController(adapter, { timeoutMs = 8000, sessionId = () => `${Date.now()}-${Math.random()}`, now = Date.now, refreshIntervalMs = 5000, hintTtlMs = 20000, pairedGroups = [] } = {}) {
  let active = null, timer, networkTimer, expiryTimer, subscriptions = [], snapshot = { status: adapter ? 'idle' : 'unavailable', devices: [], message: '' };
  const records = new Map(), lastSeen = new Map(), listeners = new Set();
  const identities = groups => new Set((Array.isArray(groups) ? groups : []).filter(group =>
    !group?.membershipRevoked && UUID.test(group?.id || '') && (!group.hostDeviceId || UUID.test(group.hostDeviceId))
  ).map(group => `${group.id.toLowerCase()}:${group.hostDeviceId?.toLowerCase() || '*'}`));
  let paired = identities(pairedGroups);
  const isPaired = group => paired.has(`${group.groupId}:${group.hostDeviceId}`) || paired.has(`${group.groupId}:*`);
  const emit = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(snapshot); };
  const clear = () => { clearTimeout(timer); clearTimeout(networkTimer); clearInterval(expiryTimer); subscriptions.forEach(item => item.remove()); subscriptions = []; };
  const stop = () => { const id = active; active = null; clear(); if (id) Promise.resolve(adapter.stop(id)).catch(() => {}); };
  const armEmptyTimer = () => {
    clearTimeout(timer); const id = active;
    timer = setTimeout(() => { if (active === id && id && !snapshot.devices.length && snapshot.status === 'scanning') emit({ status: 'empty', message: '暂未找到已配对的电脑。确认电脑已打开拾传，手机和电脑连接同一网络；网络隔离可能阻止自动恢复。' }); }, timeoutMs);
  };
  const publishDevices = () => {
    const unique = new Map();
    // Map insertion order is unrelated to freshness after an existing service updates.
    for (const group of [...records.values()].reverse().sort((a, b) => (lastSeen.get(b.serviceId) || 0) - (lastSeen.get(a.serviceId) || 0))) {
      const key = `${group.groupId}:${group.hostDeviceId}`, existing = unique.get(key);
      if (existing) { for (const url of group.candidateUrls) if (!existing.candidateUrls.includes(url)) existing.candidateUrls.push(url); }
      else unique.set(key, { ...group, candidateUrls: [...group.candidateUrls] });
    }
    const devices = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    emit({ devices, status: devices.length ? 'ready' : 'scanning', message: '' });
    if (devices.length) clearTimeout(timer); else armEmptyTimer();
  };
  const controller = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setPairedGroups(groups) {
      const next = identities(groups);
      if (next.size === paired.size && [...next].every(key => paired.has(key))) return;
      paired = next;
      for (const [id, group] of records) if (!isPaired(group)) { records.delete(id); lastSeen.delete(id); }
      if (!paired.size) controller.stop();
      else if (active) publishDevices();
    },
    async start() {
      stop(); records.clear(); lastSeen.clear();
      if (!adapter) { emit({ status: 'unavailable', devices: [], message: '已配对设备自动定位需要安装拾传手机客户端；浏览器和 Expo Go 可使用扫码或手动连接。' }); return; }
      if (!paired.size) { emit({ status: 'idle', devices: [], message: '' }); return; }
      const id = sessionId(); active = id; emit({ status: 'scanning', devices: [], message: '' });
      const listen = (event, callback) => subscriptions.push(adapter.addListener(event, value => { if (active === id && value.sessionId === id) callback(value); }));
      listen('onService', value => { const group = normalizeService(value); if (group && isPaired(group) && (records.has(group.serviceId) || records.size < 100)) { records.delete(group.serviceId); records.set(group.serviceId, group); lastSeen.set(group.serviceId, now()); publishDevices(); } });
      listen('onNetworkChanged', () => { clearTimeout(networkTimer); networkTimer = setTimeout(() => { if (active === id) controller.start(); }, 500); });
      listen('onLost', value => { records.delete(value.serviceId); lastSeen.delete(value.serviceId); publishDevices(); });
      listen('onState', value => { if (['error', 'permission-denied'].includes(value.state)) { emit({ status: value.state, message: value.message || '已配对设备自动定位暂不可用，请重试' }); clearTimeout(timer); } });
      expiryTimer = setInterval(() => {
        let changed = false;
        for (const [key, time] of lastSeen) if (key.startsWith('udp:') && now() - time > hintTtlMs) { lastSeen.delete(key); records.delete(key); changed = true; }
        if (changed) publishDevices();
      }, refreshIntervalMs);
      armEmptyTimer();
      try { await adapter.start(id); }
      catch (error) { if (active === id && snapshot.status !== 'permission-denied') emit({ status: 'error', message: error?.message || '无法自动定位已配对电脑，请检查网络后重试' }); }
    },
    stop() { stop(); emit({ status: adapter ? 'idle' : 'unavailable', devices: [] }); },
    dispose() { stop(); listeners.clear(); },
  };
  return controller;
}
