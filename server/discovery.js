import dgram from 'node:dgram';
import os from 'node:os';
import { isIPv4 } from 'node:net';

const PORT = 47320, MULTICAST = '239.255.47.32';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// LAN advertisements are intentionally public: no group key, code, or ticket.
// Advertised URLs are untrusted until groups.js authenticates the host with HMAC.
export async function createLanDiscovery({ getAnnouncements, onRecord, onError = () => {}, now = Date.now }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const records = new Map();
  let closed = false, ready = false;
  const refresh = () => {
    if (!ready || closed) return;
    const entries = getAnnouncements();
    for (const entry of entries) {
      const payload = Buffer.from(JSON.stringify({ protocol: 'pickdrop-groups-v1', groupId: entry.groupId, hostDeviceId: entry.hostDeviceId, port: entry.port }));
      socket.send(payload, PORT, MULTICAST, error => { if (error) onError(error); });
    }
    socket.send(Buffer.from('{"protocol":"pickdrop-discover-v1"}'), PORT, MULTICAST, () => {});
  };
  const announce = () => {
    if (!ready || closed) return;
    for (const entry of getAnnouncements()) socket.send(Buffer.from(JSON.stringify({ protocol: 'pickdrop-groups-v1', groupId: entry.groupId, hostDeviceId: entry.hostDeviceId, port: entry.port })), PORT, MULTICAST, () => {});
  };
  let lastResponse = 0;
  socket.on('message', (bytes, sender) => {
    if (bytes.length > 1024 || !isIPv4(sender.address)) return;
    try {
      const entry = JSON.parse(bytes.toString());
      if (entry.protocol === 'pickdrop-discover-v1') {
        if (now() - lastResponse > 300) { lastResponse = now(); announce(); }
        return;
      }
      if (entry.protocol !== 'pickdrop-groups-v1' || !uuid.test(entry.groupId) || !uuid.test(entry.hostDeviceId) || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) return;
      const record = { groupId: entry.groupId, hostDeviceId: entry.hostDeviceId, baseUrl: `http://${sender.address}:${entry.port}`, seenAt: now() };
      const key = `${record.groupId}:${record.baseUrl}`;
      // Bound state even on an untrusted LAN.
      if (!records.has(key) && records.size >= 1024) records.delete(records.keys().next().value);
      records.set(key, record); onRecord(record);
    } catch { /* Ignore other applications and malformed LAN packets. */ }
  });
  socket.on('error', onError);
  try {
    await new Promise((resolve, reject) => {
      const failed = error => { socket.off('listening', listening); reject(error); };
      const listening = () => { socket.off('error', failed); resolve(); };
      socket.once('error', failed); socket.once('listening', listening); socket.bind(PORT);
    });
    ready = true; socket.setMulticastTTL(1); socket.setMulticastLoopback(true);
    const interfaces = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal);
    for (const entry of interfaces) { try { socket.addMembership(MULTICAST, entry.address); } catch (error) { onError(error); } }
    if (!interfaces.length) { try { socket.addMembership(MULTICAST); } catch (error) { onError(error); } }
  } catch (error) { onError(error); }
  const interval = setInterval(refresh, 5000); interval.unref(); refresh();
  return {
    refresh,
    list() {
      for (const [key, record] of records) if (now() - record.seenAt > 20000) records.delete(key);
      return [...records.values()];
    },
    close() { if (closed) return; closed = true; clearInterval(interval); try { socket.close(); } catch { /* Bind may have failed. */ } },
  };
}
