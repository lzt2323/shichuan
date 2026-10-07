import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { canPreview, imagePreview, MAX_PREVIEW_BYTES, dimensionsBeforeDecode } = createRequire(import.meta.url)('../apps/desktop/image-preview.cjs');
function pngHeader(width, height) {
  const bytes = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
}
const bytes = pngHeader(4000, 2000);
const message = { fileName: 'image.PNG', mime: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
test('preview excludes active content, deleted files, and oversized originals', () => {
  assert.equal(canPreview(message), true);
  for (const change of [{ mime: 'text/html' }, { fileName: 'image.svg' }, { fileName: 'image.html' }, { deleted: true }, { size: MAX_PREVIEW_BYTES + 1 }, { size: 0 }]) assert.equal(canPreview({ ...message, ...change }), false);
});
test('preview verifies original bytes before native decoding and constrains output', () => {
  let decodes = 0, dimensions;
  const native = { createFromBuffer() { decodes++; return { isEmpty: () => false, getSize: () => ({ width: 4000, height: 2000 }), resize(value) { dimensions = value; return { toDataURL: () => 'data:image/png;base64,test' }; } }; } };
  assert.throws(() => imagePreview(Buffer.from('corrupt image bytes!'), message, native), /校验失败/);
  assert.equal(decodes, 0);
  assert.equal(imagePreview(bytes, message, native).url, 'data:image/png;base64,test');
  assert.equal(dimensions.width, 480); assert.equal(dimensions.height, 240);
  imagePreview(bytes, message, native, true); assert.equal(dimensions.width, 1800);
});

test('huge compressed image dimensions are rejected before native decode', () => {
  const bytes = pngHeader(20000, 20000);
  const metadata = { ...message, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let calls = 0;
  assert.throws(() => imagePreview(bytes, metadata, { createFromBuffer() { calls++; } }), /尺寸过大/);
  assert.equal(calls, 0);
});
test('preflight reads JPEG and WebP frame sizes and rejects malformed or huge headers', () => {
  const jpeg = Buffer.from('ffd8ffe000040000ffc00008080100020001', 'hex');
  assert.deepEqual(dimensionsBeforeDecode(jpeg), { width: 512, height: 256 });
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8 ', 8); webp.writeUInt32LE(10, 16);
  Buffer.from('9d012a', 'hex').copy(webp, 23); webp.writeUInt16LE(640, 26); webp.writeUInt16LE(480, 28);
  assert.deepEqual(dimensionsBeforeDecode(webp), { width: 640, height: 480 });
  webp.writeUInt16LE(10000, 26); webp.writeUInt16LE(10000, 28);
  assert.throws(() => dimensionsBeforeDecode(webp), /尺寸过大/);
  assert.throws(() => dimensionsBeforeDecode(jpeg.subarray(0, 12)), /格式无法/);
  assert.throws(() => dimensionsBeforeDecode(Buffer.from('<svg/>')), /格式无法/);
});
test('WebP lossless and extended canvas are independently bounded', () => {
  const lossless = Buffer.alloc(26); lossless.write('RIFF'); lossless.writeUInt32LE(18, 4); lossless.write('WEBPVP8L', 8); lossless.writeUInt32LE(5, 16); lossless[20] = 0x2f;
  lossless.writeUInt32LE((479 << 14) | 639, 21);
  assert.deepEqual(dimensionsBeforeDecode(lossless), { width: 640, height: 480 });
  const extended = Buffer.alloc(44); extended.write('RIFF'); extended.writeUInt32LE(36, 4); extended.write('WEBPVP8X', 8); extended.writeUInt32LE(10, 16);
  extended.writeUIntLE(639, 24, 3); extended.writeUIntLE(479, 27, 3); lossless.subarray(12).copy(extended, 30);
  assert.deepEqual(dimensionsBeforeDecode(extended), { width: 640, height: 480 });
  extended.writeUIntLE(20000, 24, 3); extended.writeUIntLE(20000, 27, 3);
  assert.throws(() => dimensionsBeforeDecode(extended), /尺寸过大/);
});
