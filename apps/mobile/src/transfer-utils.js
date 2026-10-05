/** Only native byte counters may produce a progress fraction. Unknown totals stay indeterminate. */
export function byteProgress(bytes, total) {
  const bytesTransferred = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(total) || total <= 0 || bytesTransferred > total) return { bytesTransferred, totalBytes: undefined, progress: undefined };
  return { bytesTransferred, totalBytes: total, progress: bytesTransferred / total };
}

export function assertFileMetadata(message) {
  if (!message || typeof message.id !== 'string' || !message.id || !Number.isSafeInteger(message.size) || message.size < 0 || !/^[a-f0-9]{64}$/i.test(message.sha256 || '')) {
    throw new Error('文件校验信息不完整，请刷新群消息后重试');
  }
}

export function assertLocalShareUri(uri) {
  if (typeof uri !== 'string' || !/^(file|content):\/\//i.test(uri)) throw new Error('无法读取这个分享文件，请从文件选择器重新添加');
}
