const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function usableIPv4(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  return octets.every(part => part >= 0 && part <= 255) && octets[0] > 0 && octets[0] !== 127 && octets[0] < 224;
}
/** mDNS is an untrusted hint. Whitelist fields and never accept keys or invite codes. */
export function normalizeService(value) {
  const txt = value?.txt;
  if (!txt || txt.protocol !== 'pickdrop' || txt.version !== '1' || !UUID.test(txt.groupId || '') || !UUID.test(txt.hostDeviceId || '')) return null;
  const address = Array.isArray(value.addresses) ? value.addresses.find(usableIPv4) : undefined;
  if (!address || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.serviceId !== 'string' || value.serviceId.length > 300) return null;
  const name = String(txt.name || '附近的传输群').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || '附近的传输群';
  return { serviceId: value.serviceId, groupId: txt.groupId.toLowerCase(), hostDeviceId: txt.hostDeviceId.toLowerCase(), name, address, port: value.port, baseUrl: `http://${address}:${value.port}` };
}
export function discoveredInvite(group, code) {
  if (!UUID.test(group?.groupId || '') || !UUID.test(group?.hostDeviceId || '') || !usableIPv4(group?.address) || !Number.isInteger(group.port) || group.port < 1 || group.port > 65535 || !/^\d{6}$/.test(code)) throw new Error('请重新选择附近的群，并输入 6 位邀请码');
  return `http://${group.address}:${group.port}/#invite=${code}&group=${group.groupId}`;
}
export function assertDiscoveredTicket(group, ticket) {
  if (group.groupId.toLowerCase() !== String(ticket.groupId).toLowerCase() || group.hostDeviceId.toLowerCase() !== String(ticket.hostDeviceId).toLowerCase()) throw new Error('电脑的身份与发现信息不一致，请刷新附近设备后重试');
}

/** Owns one native scan. Session IDs reject delayed resolution after stop/restart. */
export function createDiscoveryController(adapter, { timeoutMs = 8000, sessionId = () => `${Date.now()}-${Math.random()}` } = {}) {
  let active = null, timer, subscriptions = [], snapshot = { status: adapter ? 'idle' : 'unavailable', devices: [], message: '' };
  const records = new Map(), listeners = new Set();
  const emit = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(snapshot); };
  const clear = () => { clearTimeout(timer); subscriptions.forEach(item => item.remove()); subscriptions = []; };
  const stop = () => { const id = active; active = null; clear(); if (id) Promise.resolve(adapter.stop(id)).catch(() => {}); };
  const publishDevices = () => {
    const unique = new Map(); for (const group of records.values()) unique.set(`${group.groupId}:${group.hostDeviceId}`, group);
    const devices = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    emit({ devices, status: devices.length ? 'ready' : 'scanning', message: '' });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async start() {
      stop(); records.clear();
      if (!adapter) { emit({ status: 'unavailable', devices: [], message: '附近发现需要安装拾传手机客户端；浏览器和 Expo Go 可使用扫码或高级连接。' }); return; }
      const id = sessionId(); active = id; emit({ status: 'scanning', devices: [], message: '' });
      const listen = (event, callback) => subscriptions.push(adapter.addListener(event, value => { if (active === id && value.sessionId === id) callback(value); }));
      listen('onService', value => { const group = normalizeService(value); if (group) { records.set(group.serviceId, group); publishDevices(); } });
      listen('onLost', value => { records.delete(value.serviceId); publishDevices(); });
      listen('onState', value => { if (['error', 'permission-denied'].includes(value.state)) { emit({ status: value.state, message: value.message || '附近发现暂不可用，请重试' }); clearTimeout(timer); } });
      timer = setTimeout(() => { if (active === id && !snapshot.devices.length && snapshot.status === 'scanning') emit({ status: 'empty', message: '还没找到附近的传输群。确认电脑已打开拾传，手机和电脑连接同一网络；访客 Wi-Fi 或热点隔离可能阻止发现。' }); }, timeoutMs);
      try { await adapter.start(id); }
      catch (error) { if (active === id && snapshot.status !== 'permission-denied') emit({ status: 'error', message: error?.message || '无法查找附近设备，请检查网络后重试' }); }
    },
    stop() { stop(); emit({ status: adapter ? 'idle' : 'unavailable', devices: [] }); },
    dispose() { stop(); listeners.clear(); },
  };
}
