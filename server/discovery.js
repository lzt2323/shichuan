import dgram from 'node:dgram';
import { isIPv4 } from 'node:net';
import { Bonjour } from 'bonjour-service';
import { isPublicIPv4 } from './network.js';

const PORT = 47320, MULTICAST = '239.255.47.32';
export const SERVICE_TYPE = '_pickdrop._tcp.local';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function discoveryTxt(entry) {
  return { protocol: 'pickdrop', version: '1', groupId: entry.groupId, hostDeviceId: entry.hostDeviceId, name: String(entry.name || '传输群').slice(0, 40) };
}
export function parseDiscoveredService(service, now = Date.now()) {
  const txt = service.txt || {};
  if (txt.protocol !== 'pickdrop' || String(txt.version) !== '1' || !uuid.test(txt.groupId) || !uuid.test(txt.hostDeviceId) || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return [];
  return [...new Set(service.addresses || [])].filter(isPublicIPv4).map(address => ({ groupId: txt.groupId, hostDeviceId: txt.hostDeviceId, name: String(txt.name || '传输群').slice(0, 40), baseUrl: `http://${address}:${service.port}`, seenAt: now, transport: 'mdns' }));
}
// Bonjour's default records() enumerates EVERY adapter, independent of its
// multicast socket setting. Override that public method before asynchronous
// probing announces anything, so VPN/unselected addresses never enter DNS-SD.
export function restrictServiceAddress(service, address) {
  const original = service.records.bind(service);
  service.records = () => [...original().filter(record => !['A', 'AAAA'].includes(record.type)).map(record => ({ ...record, ttl: 30 })), { name: service.host, type: 'A', ttl: 30, data: address }];
  return service;
}

export async function createLanDiscovery({ getAnnouncements, onRecord, onChanged = () => {}, onError = () => {}, now = Date.now, interfaceAddress, BonjourImpl = Bonjour, udp = true }) {
  const records = new Map(), published = new Map(), dnsRecords = new Map();
  let closed = false, ready = false, bonjour, browser, socket;
  const remember = record => {
    const key = `${record.groupId}:${record.baseUrl}`, previous = records.get(key);
    if (!records.has(key) && records.size >= 1024) records.delete(records.keys().next().value);
    records.set(key, record);
    if (!previous || previous.name !== record.name || now() - previous.seenAt > 3000) onRecord(record);
  };
  function readDns(packet, sender) {
    if (closed || (sender && !isIPv4(sender.address))) return;
    const incoming = [...(packet.answers || []), ...(packet.additionals || [])];
    for (const rr of incoming.slice(0, 256)) {
      if (!['PTR', 'SRV', 'TXT', 'A'].includes(rr.type) || typeof rr.name !== 'string') continue;
      const key = `${rr.name.toLowerCase()}:${rr.type}:${JSON.stringify(rr.data)}`;
      if (!rr.ttl) { dnsRecords.delete(key); continue; }
      if (dnsRecords.size >= 2048 && !dnsRecords.has(key)) dnsRecords.delete(dnsRecords.keys().next().value);
      dnsRecords.set(key, { ...rr, name: rr.name.toLowerCase(), seenAt: now(), expires: now() + Math.min(rr.ttl, 120) * 1000 });
    }
    for (const [key, rr] of dnsRecords) if (rr.expires <= now()) dnsRecords.delete(key);
    const all = [...dnsRecords.values()];
    for (const ptr of all.filter(rr => rr.type === 'PTR' && rr.name === SERVICE_TYPE)) {
      const instance = String(ptr.data).toLowerCase();
      const srv = all.filter(rr => rr.type === 'SRV' && rr.name === instance).sort((a, b) => b.seenAt - a.seenAt)[0];
      const raw = all.filter(rr => rr.type === 'TXT' && rr.name === instance).sort((a, b) => b.seenAt - a.seenAt)[0];
      if (!srv || !raw) continue;
      const txt = Object.create(null);
      for (const value of raw.data || []) { const text = Buffer.from(value).toString(), split = text.indexOf('='); if (split > 0) txt[text.slice(0, split)] = text.slice(split + 1); }
      const addresses = all.filter(rr => rr.type === 'A' && rr.name === String(srv.data.target).toLowerCase()).map(rr => rr.data);
      for (const record of parseDiscoveredService({ txt, port: srv.data.port, addresses }, Math.min(ptr.seenAt, srv.seenAt, raw.seenAt))) remember(record);
    }
    // Goodbye packets remove stale entries immediately, while TTL handles crashes.
    const aliveGroups = new Set(all.filter(rr => rr.type === 'TXT').flatMap(rr => parseDiscoveredService({ txt: Object.fromEntries((rr.data || []).map(value => Buffer.from(value).toString()).filter(value => value.includes('=')).map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)])), port: 1, addresses: ['192.0.2.1'] }).map(record => record.groupId)));
    if (incoming.some(rr => rr.ttl === 0)) {
      let removed = false;
      for (const [key, record] of records) if (record.transport === 'mdns' && !aliveGroups.has(record.groupId)) { records.delete(key); removed = true; }
      if (removed) onChanged();
    }
  }
  const publish = () => {
    if (!bonjour || closed) return;
    const entries = getAnnouncements().filter(entry => uuid.test(entry.groupId) && uuid.test(entry.hostDeviceId) && entry.port);
    const wanted = new Set(entries.map(entry => entry.groupId));
    for (const [id, value] of published) if (!wanted.has(id)) { value.service.stop(); published.delete(id); }
    for (const entry of entries) {
      const signature = JSON.stringify([entry.port, entry.name, interfaceAddress]);
      if (published.get(entry.groupId)?.signature === signature) continue;
      published.get(entry.groupId)?.service.stop();
      const service = bonjour.publish({ name: `pickdrop-${entry.groupId}`, type: 'pickdrop', protocol: 'tcp', port: entry.port, host: `pickdrop-${entry.groupId}.local`, txt: discoveryTxt(entry), disableIPv6: true });
      restrictServiceAddress(service, interfaceAddress);
      published.set(entry.groupId, { signature, service });
    }
  };
  const announce = () => {
    if (!socket || !ready || closed) return;
    for (const entry of getAnnouncements()) socket.send(Buffer.from(JSON.stringify({ protocol: 'pickdrop-groups-v1', groupId: entry.groupId, hostDeviceId: entry.hostDeviceId, name: entry.name, port: entry.port, directoryPort: entry.directoryPort })), PORT, MULTICAST, error => { if (error) onError(error); });
  };
  const refresh = () => {
    if (closed) return;
    prune();
    publish(); browser?.update(); announce();
    if (ready) socket.send(Buffer.from('{"protocol":"pickdrop-discover-v1"}'), PORT, MULTICAST, () => {});
  };
  if (isPublicIPv4(interfaceAddress)) {
    try {
      // Bind the multicast socket wildcard for reception, but join and transmit
      // ONLY on the chosen adapter. Group HTTP listeners bind its unicast IP.
      bonjour = new BonjourImpl({ interface: interfaceAddress, bind: '0.0.0.0', type: 'udp4', reuseAddr: true }, onError);
      bonjour.server.mdns.on('error', onError); bonjour.server.mdns.on('warning', onError);
      bonjour.server.mdns.on('response', (packet, sender) => { try { readDns(packet, sender); } catch { /* Ignore malformed DNS-SD data. */ } });
      browser = bonjour.find({ type: 'pickdrop', protocol: 'tcp' });
      publish();
    } catch (error) { onError(error); }
    if (udp) {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let lastResponse = 0;
      socket.on('message', (bytes, sender) => {
        if (bytes.length > 1024 || !isPublicIPv4(sender.address)) return;
        try {
          const entry = JSON.parse(bytes.toString());
          if (entry.protocol === 'pickdrop-discover-v1') { if (now() - lastResponse > 300) { lastResponse = now(); announce(); } return; }
          if (entry.protocol !== 'pickdrop-groups-v1' || !uuid.test(entry.groupId) || !uuid.test(entry.hostDeviceId) || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) return;
          remember({ groupId: entry.groupId, hostDeviceId: entry.hostDeviceId, name: String(entry.name || '传输群').slice(0, 40), baseUrl: `http://${sender.address}:${entry.port}`, ...(Number.isInteger(entry.directoryPort) && entry.directoryPort > 0 && entry.directoryPort <= 65535 ? { directoryPort: entry.directoryPort } : {}), seenAt: now(), transport: 'udp' });
        } catch { /* Ignore other applications and malformed advertisements. */ }
      });
      socket.on('error', onError);
      try {
        await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(PORT, '0.0.0.0', resolve); });
        socket.setMulticastTTL(1); socket.setMulticastLoopback(true); socket.addMembership(MULTICAST, interfaceAddress); socket.setMulticastInterface(interfaceAddress); ready = true;
      } catch (error) { onError(error); }
    }
  }
  const interval = setInterval(refresh, 5000); interval.unref(); refresh();
  function prune() {
    let removed = false;
    for (const [key, record] of records) if (now() - record.seenAt > (record.transport === 'mdns' ? 35000 : 20000)) { records.delete(key); removed = true; }
    if (removed) onChanged();
  }
  return {
    refresh,
    list() { prune(); return [...records.values()]; },
    async close() {
      if (closed) return; closed = true; clearInterval(interval); browser?.stop();
      if (bonjour) { await new Promise(resolve => { const timer = setTimeout(resolve, 300); bonjour.unpublishAll(() => { clearTimeout(timer); resolve(); }); }); await new Promise(resolve => bonjour.destroy(resolve)); }
      try { socket?.close(); } catch { /* Bind may have failed. */ }
    },
  };
}
