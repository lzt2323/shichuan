import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function validMetadata(size, sha256) {
  return Number.isSafeInteger(size) && size >= 0 && typeof sha256 === 'string' && /^[a-f0-9]{64}$/i.test(sha256);
}

/** A cached file is usable only if its size AND contents match the host record. */
export async function verifyLocalFile(filePath, { size, sha256 }) {
  if (!validMetadata(size, sha256)) return false;
  let file;
  try {
    file = await fs.open(filePath, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== size) return false;
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: true })) {
      bytes += chunk.length; if (bytes > size) return false; hash.update(chunk);
    }
    return bytes === size && hash.digest('hex') === sha256.toLowerCase();
  } catch { return false; }
  finally { await file?.close().catch(() => {}); }
}

/** Downloads to a NEW caller-chosen temporary file; publication is the caller's job. */
export async function downloadVerified({ url, headers, destination, size, sha256, signal, localAddress, onProgress = () => {}, timeoutMs = 120000 }) {
  if (!validMetadata(size, sha256)) throw new Error('文件记录无效或已不存在');
  const address = new URL(url);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error('文件地址不正确');
  signal?.throwIfAborted();
  // Acquire ownership before the request. EEXIST never grants permission to delete.
  const file = await fs.open(destination, 'wx', 0o600);
  let request, response, transportError, complete = false, bytes = 0;
  try {
    response = await new Promise((resolve, reject) => {
      request = (address.protocol === 'https:' ? https : http).get(address, { headers, signal, localAddress }, resolve);
      request.setTimeout(timeoutMs, () => { transportError = new Error('下载长时间无响应，请重试'); request.destroy(transportError); });
      request.on('error', error => { transportError = error; reject(error); });
    });
    if (response.statusCode !== 200) throw new Error(`下载失败 (${response.statusCode})`);
    const hash = createHash('sha256');
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      // Reject before forwarding the oversized chunk to disk.
      if (bytes > size) { callback(new Error('下载大小超出文件记录')); return; }
      hash.update(chunk);
      try { onProgress(bytes, size); callback(null, chunk); } catch (error) { callback(error); }
    } });
    await pipeline(response, meter, file.createWriteStream({ autoClose: true, flush: true }), { signal });
    if (bytes !== size || hash.digest('hex') !== sha256.toLowerCase()) throw new Error('文件内容不完整，已丢弃下载');
    signal?.throwIfAborted();
    complete = true;
    return { path: destination, size: bytes, sha256: sha256.toLowerCase() };
  } catch (error) {
    throw transportError || error;
  } finally {
    if (!complete) { response?.destroy(); request?.destroy(); }
    await file.close().catch(() => {});
    if (!complete) await fs.rm(destination, { force: true });
  }
}
