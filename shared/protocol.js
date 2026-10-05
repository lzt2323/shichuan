export function parseRoomLink(value) {
  const input = String(value).trim();
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请输入桌面端显示的完整连接地址');
  }
  const key = new URLSearchParams(url.hash.slice(1)).get('key');
  if (!key || !/^[a-f0-9]{64}$/.test(key)) throw new Error('连接地址缺少有效配对密钥，请重新扫描二维码');
  return { baseUrl: url.origin, key };
}

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? 'KB' : bytes < 1024 ** 3 ? 'MB' : 'GB';
  const scale = unit === 'KB' ? 1024 : unit === 'MB' ? 1024 ** 2 : 1024 ** 3;
  return `${(bytes / scale).toFixed(bytes / scale < 10 ? 1 : 0)} ${unit}`;
}

export function safeFileName(input) {
  const leaf = String(input || '未命名文件').split(/[\\/]/).pop();
  const name = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim().replace(/[. ]+$/g, '');
  const safe = name && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ? name : `文件_${name || '未命名'}`;
  let bytes = 0, result = '';
  for (const character of safe) {
    const code = character.codePointAt(0);
    const length = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + length > 200) break;
    bytes += length; result += character;
  }
  return result;
}
