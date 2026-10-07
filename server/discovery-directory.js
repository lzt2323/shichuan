import http from 'node:http';
import { isIPv4 } from 'node:net';

export const DIRECTORY_PORT = 47321;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const privateAddress = address => isIPv4(address) && (/^(10\.|192\.168\.|127\.)/.test(address) || (address.startsWith('172.') && Number(address.split('.')[1]) >= 16 && Number(address.split('.')[1]) <= 31));

// No credentials, history, invite codes or file paths leave this directory.
export function normalizeDirectory(body, address, now = Date.now()) {
  if (body?.protocol !== 'pickdrop-directory-v1' || !Array.isArray(body.groups)) return [];
  return body.groups.slice(0, 100).flatMap(entry => {
    if (!UUID.test(entry?.groupId || '') || !UUID.test(entry?.hostDeviceId || '') || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) return [];
    return [{ groupId: entry.groupId, hostDeviceId: entry.hostDeviceId, name: String(entry.name || '传输群').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40), port: entry.port, baseUrl: `http://${address}:${entry.port}`, ...(entry.peerProtocol === 'pickdrop-peer-v1' ? { peerProtocol: entry.peerProtocol } : {}), seenAt: now, transport: 'directory' }];
  });
}

export async function createDiscoveryDirectory({ address, getAnnouncements, port = DIRECTORY_PORT, onError = () => {} }) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/api/discovery/groups') { res.writeHead(404); res.end(); return; }
    const groups = getAnnouncements().slice(0, 100).map(({ groupId, hostDeviceId, name, port, peerProtocol }) => ({ groupId, hostDeviceId, name, port, ...(peerProtocol === 'pickdrop-peer-v1' ? { peerProtocol } : {}) }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ protocol: 'pickdrop-directory-v1', groups }));
  });
  server.requestTimeout = 3000; server.headersTimeout = 3000; server.maxConnections = 32;
  let bound = false;
  for (const candidate of port === 0 ? [0] : [port, port + 1, port + 2, port + 3]) {
    try {
      await new Promise((resolve, reject) => {
        const error = value => { server.removeListener('listening', listening); reject(value); };
        const listening = () => { server.removeListener('error', error); resolve(); };
        server.once('error', error); server.once('listening', listening); server.listen(candidate, address);
      });
      bound = true; break;
    } catch (error) { if (error.code !== 'EADDRINUSE') { onError(error); break; } }
  }
  if (!bound) onError(new Error('附近发现目录端口被占用，仍可通过 mDNS、UDP 或扫码连接'));
  return {
    port: server.address()?.port || null,
    async close() { if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); },
  };
}

export function directoryHosts(network, maximum = 256) {
  const address = network?.address, mask = network?.netmask;
  if (!privateAddress(address) || address.startsWith('127.') || !isIPv4(mask)) return [];
  const number = value => value.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  const ip = number(address), bits = number(mask), inverse = (~bits) >>> 0;
  if (((inverse + 1) & inverse) !== 0) return [];
  const subnetStart = (ip & bits) >>> 0, subnetEnd = (subnetStart + inverse) >>> 0;
  // Large subnets are capped to the local /24 segment; never scan a whole /16.
  const start = Math.max(subnetStart + 1, (ip & 0xffffff00) >>> 0), end = Math.min(subnetEnd - 1, (((ip & 0xffffff00) >>> 0) + 255));
  const result = [];
  for (let n = start; n <= end && result.length < maximum; n++) if (n !== ip) result.push([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  return result;
}

export async function probeDirectory(address, { port = DIRECTORY_PORT, localAddress, signal, timeoutMs = 250 } = {}) {
  if (!privateAddress(address) || !Number.isInteger(port) || port < 1 || port > 65535) return [];
  return new Promise(resolve => {
    const request = http.get({ host: address, port, path: '/api/discovery/groups', localAddress, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), timeout: timeoutMs }, response => {
      if (response.statusCode !== 200) { response.destroy(); resolve([]); return; }
      let bytes = 0, body = '';
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) { request.destroy(); resolve([]); } else body += chunk; });
      response.on('error', () => resolve([]));
      response.on('end', () => { try { resolve(normalizeDirectory(JSON.parse(body), address)); } catch { resolve([]); } });
    });
    request.on('timeout', () => request.destroy()); request.on('error', () => resolve([]));
  });
}

export async function scanDirectories(network, { signal, onRecord = () => {}, probe = probeDirectory } = {}) {
  const hosts = directoryHosts(network); let index = 0;
  await Promise.all(Array.from({ length: Math.min(16, hosts.length) }, async () => {
    while (index < hosts.length && !signal?.aborted) {
      const address = hosts[index++];
      for (const port of [DIRECTORY_PORT, DIRECTORY_PORT + 1, DIRECTORY_PORT + 2, DIRECTORY_PORT + 3]) {
        if (signal?.aborted) break;
        for (const record of await probe(address, { port, localAddress: network.address, signal })) if (!signal?.aborted) onRecord(record);
      }
    }
  }));
}

// A user-specified address is a targeted hint, independent of the bounded /24
// fallback. The returned endpoints are NOT trusted until the group handshake.
export function parseConnectionAddress(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 2048) throw Object.assign(new Error('请输入对方 IP、IP:端口或完整邀请链接'), { status: 400 });
  let url;
  try { url = new URL(input.includes('://') ? input : `http://${input}`); }
  catch { throw Object.assign(new Error('连接地址不正确，请输入 IP:端口或完整邀请链接'), { status: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.search || !['', '/'].includes(url.pathname)) {
    throw Object.assign(new Error('连接地址不正确，请输入 IP:端口或完整邀请链接'), { status: 400 });
  }
  const invite = new URLSearchParams(url.hash.slice(1));
  const code = invite.get('invite'), groupId = invite.get('group');
  if ((code !== null && !/^\d{6}$/.test(code)) || (groupId !== null && !UUID.test(groupId))) throw Object.assign(new Error('邀请链接不完整，请重新复制'), { status: 400 });
  // URL.port drops explicit :80/:443, so preserve the user's intent separately.
  const authority = (input.includes('://') ? input.split('://')[1] : input).split(/[/?#]/)[0];
  return { origin: url.origin, address: url.hostname, explicitPort: /:\d+$/.test(authority), ...(code ? { code } : {}), ...(groupId ? { groupId } : {}) };
}

export async function manualGroupCandidates(value, { localAddress, signal, expectedGroupId, probe = probeDirectory } = {}) {
  const parsed = parseConnectionAddress(value);
  const wanted = expectedGroupId || parsed.groupId;
  if (wanted && !UUID.test(wanted)) throw Object.assign(new Error('群编号不正确'), { status: 400 });
  signal?.throwIfAborted();
  const records = (await Promise.all([0, 1, 2, 3].map(offset => probe(parsed.address, { port: DIRECTORY_PORT + offset, localAddress, signal, timeoutMs: 700 })))).flat();
  signal?.throwIfAborted();
  const hints = records.filter(record => !wanted || record.groupId === wanted).map(record => record.baseUrl);
  return [...new Set(parsed.explicitPort ? [parsed.origin, ...hints] : [...hints, parsed.origin])].slice(0, 101);
}
