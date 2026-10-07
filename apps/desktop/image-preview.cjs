const { createHash } = require('node:crypto');
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
function canPreview(message) {
  return message && !message.deleted && /^image\/(png|jpeg|webp)$/i.test(message.mime || '') && /\.(png|jpe?g|webp)$/i.test(message.fileName || '') &&
    Number.isSafeInteger(message.size) && message.size > 0 && message.size <= MAX_PREVIEW_BYTES;
}
// Read container/frame headers before asking a native decoder to allocate pixels.
// Reject malformed/unknown structures; decoding is never a dimension probe.
function dimensionsBeforeDecode(bytes) {
  const invalid = () => { throw new Error('图片格式无法预览，请保存后打开'); };
  const check = (width, height) => {
    if (!width || !height) invalid();
    if (width * height > 40_000_000) throw new Error('图片尺寸过大，请保存后打开');
    return { width, height };
  };
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid();
    return check(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) invalid();
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) invalid();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      if (frames.has(marker)) {
        if (length < 8) invalid();
        return check(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      }
      offset += length;
    }
    invalid();
  }
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const end = bytes.readUInt32LE(4) + 8;
    if (end > bytes.length) invalid();
    let result, frameFound = false;
    function chunks(start, limit, nested = false) {
      let offset = start;
      while (offset + 8 <= limit) {
        const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), data = offset + 8;
        if (data + size > limit) invalid();
        if (kind === 'VP8X') {
          if (nested || size < 10) invalid();
          result = check(bytes.readUIntLE(data + 4, 3) + 1, bytes.readUIntLE(data + 7, 3) + 1);
        } else if (kind === 'VP8L') {
          if (size < 5 || bytes[data] !== 0x2f) invalid();
          const bits = bytes.readUInt32LE(data + 1);
          result = check((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); frameFound = true;
        } else if (kind === 'VP8 ') {
          if (size < 10 || bytes.toString('hex', data + 3, data + 6) !== '9d012a') invalid();
          result = check(bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff); frameFound = true;
        } else if (kind === 'ANMF') {
          if (nested || size < 16) invalid();
          check(bytes.readUIntLE(data + 6, 3) + 1, bytes.readUIntLE(data + 9, 3) + 1);
          chunks(data + 16, data + size, true);
        }
        offset = data + size + (size & 1);
      }
      if (offset !== limit) invalid();
    }
    chunks(12, end);
    if (!frameFound) invalid();
    return result;
  }
  invalid();
}
function imagePreview(bytes, message, nativeImage, full = false) {
  if (!canPreview(message)) throw new Error('该图片暂不支持预览，请保存后打开');
  if (bytes.length !== message.size || createHash('sha256').update(bytes).digest('hex') !== message.sha256) throw new Error('图片校验失败，请重新接收');
  dimensionsBeforeDecode(bytes);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('图片无法解码，请保存后打开');
  const { width, height } = image.getSize();
  if (width * height > 40_000_000) throw new Error('图片尺寸过大，请保存后打开');
  const edge = full ? 1800 : 480, scale = Math.min(1, edge / Math.max(width, height));
  const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' }) : image;
  return { url: resized.toDataURL(), width, height };
}
module.exports = { canPreview, imagePreview, MAX_PREVIEW_BYTES, dimensionsBeforeDecode };
