import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Chromium does not expose localAddress on fetch/WebSocket. This private proxy
// pins its group traffic to the chosen adapter, with a strict endpoint allowlist.
export async function createDesktopNetworkProxy(manager) {
  const sockets = new Set();
  const add = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  async function validate(target) {
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid target');
    const network = manager.getNetwork();
    if (!network.available || network.switching) throw new Error('Selected network is unavailable');
    const group = manager.listGroups().find(item => item.baseUrl && new URL(item.baseUrl).origin === target.origin);
    if (!group) throw new Error('Unknown group endpoint');
    const resolved = await manager.resolveGroup(group.id);
    if (!resolved.online || resolved.baseUrl !== target.origin || manager.getNetwork().selected.address !== network.selected.address) throw new Error('Group endpoint changed');
    return network.selected.address;
  }
  const server = http.createServer(async (req, res) => {
    let release;
    const done = () => { release?.(); release = null; };
    res.once('finish', done); res.once('close', done);
    try {
      const target = new URL(req.url), localAddress = await validate(target);
      if (target.pathname === '/api/files' || target.pathname.startsWith('/api/files/')) release = manager.acquireTransfer();
      if (req.destroyed || manager.getNetwork().selected.address !== localAddress) { done(); throw new Error('Request was cancelled or network changed'); }
      const transport = target.protocol === 'https:' ? https : http;
      const headers = { ...req.headers, host: target.host }; delete headers['proxy-connection']; delete headers['proxy-authorization'];
      const outgoing = transport.request(target, { method: req.method, headers, localAddress }, upstream => { upstream.on('error', () => res.destroy()); upstream.on('aborted', () => res.destroy()); res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
      outgoing.on('socket', add); outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => outgoing.destroy()); res.on('close', () => outgoing.destroy()); req.pipe(outgoing);
    } catch { done(); if (!res.headersSent) res.writeHead(503); res.end('Selected group network is unavailable'); }
  });
  server.on('connection', add);
  // CONNECT is opaque (including persistent WSS). File transfers retain their
  // application-level leases via renderer transfer:busy / native prepareFile;
  // leasing every tunnel would permanently block switching while WSS is open.
  server.on('connect', async (req, socket, head) => {
    try {
      const candidates = manager.listGroups().filter(group => group.baseUrl && new URL(group.baseUrl).host === req.url);
      if (!candidates.length) throw new Error('Unknown group');
      const target = new URL(candidates[0].baseUrl), localAddress = await validate(target);
      if (socket.destroyed || manager.getNetwork().switching || manager.getNetwork().selected.address !== localAddress) throw new Error('Connection changed');
      const upstream = add(net.connect({ host: target.hostname, port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80), localAddress }, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
      }));
      upstream.on('error', () => socket.destroy()); upstream.on('close', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); }
  });
  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = req.url.startsWith('ws:') ? req.url.replace(/^ws:/, 'http:') : req.url;
      const target = new URL(url), localAddress = await validate(target);
      if (socket.destroyed || manager.getNetwork().switching || manager.getNetwork().selected.address !== localAddress) throw new Error('Connection changed');
      const upstream = add(net.connect({ host: target.hostname, port: Number(target.port) || 80, localAddress }, () => {
        const headers = { ...req.headers, host: target.host }; delete headers['proxy-connection']; delete headers['proxy-authorization'];
        upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
      }));
      upstream.on('error', () => socket.destroy()); upstream.on('close', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    } catch { socket.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const disconnect = () => { for (const socket of sockets) socket.destroy(); };
  return { address: `127.0.0.1:${server.address().port}`, disconnect, close: () => { disconnect(); return new Promise(resolve => server.close(resolve)); } };
}
