import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { locations, privateDirectory } from './common.js';

export function rpc(method, params = {}, { paths = locations(), timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: paths.socket, method: 'POST', path: '/rpc', headers: { 'Content-Type': 'application/json' } }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', data => { body += data; if (body.length > 16 * 1024 * 1024) request.destroy(new Error('服务响应过大')); });
      response.on('end', () => { try { const result = JSON.parse(body); if (result.error) reject(new Error(result.error)); else resolve(result.result); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    request.setTimeout(timeout, () => request.destroy(new Error('本机服务响应超时')));
    request.on('error', reject); request.end(JSON.stringify({ method, params }));
  });
}
export async function ensureDaemon(paths = locations()) {
  try { return await rpc('status', {}, { paths, timeout: 1000 }); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  await privateDirectory(paths.state); await privateDirectory(paths.runtime);
  const fd = await fs.open(paths.log, 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'daemon', '--foreground'], { detached: true, stdio: ['ignore', fd.fd, fd.fd], env: process.env });
  let spawnError; child.on('error', error => { spawnError = error; }); child.unref(); await fd.close();
  for (let n = 0; n < 80; n++) {
    if (spawnError) throw spawnError;
    await new Promise(resolve => setTimeout(resolve, 100));
    try { return await rpc('status', {}, { paths, timeout: 1000 }); } catch {}
  }
  throw new Error(`后台启动失败，请查看 ${paths.log}`);
}
