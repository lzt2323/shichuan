const MAX_CLIPBOARD_IMAGE_BYTES = 32 * 1024 * 1024;
const fileFormats = new Set([
  'text/uri-list', 'public.file-url', 'file-url', 'nsfilenamespboardtype', 'nsfilenames',
  'com.apple.pasteboard.promised-file-url', 'cf_hdrop', 'filename', 'filenamew',
  'filegroupdescriptor', 'filegroupdescriptorw', 'x-special/gnome-copied-files',
]);
function isFileFormat(format) {
  const value = String(format).toLowerCase();
  const raw = value.match(/^electron application\/osclipboard\s*;\s*format="([^"]+)"$/)?.[1];
  return fileFormats.has(raw || value);
}
function imagePayload(image) {
  if (!image || image.isEmpty()) return null;
  const png = image.toPNG();
  if (!png.length) return null;
  if (png.length > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('剪贴板图片超过 32 MiB，请保存后选择文件发送');
  return { bytes: Uint8Array.from(png), mimeType: 'image/png' };
}

// Called only by the trusted desktop renderer's explicit paste action. Do not
// poll the clipboard, expose raw formats, or return file-reference payloads.
async function readClipboardImage(clipboard, nativeImage) {
  // Electron <=43; 44 removed readImage/availableFormats in favour of read().
  if (typeof clipboard.readImage === 'function') {
    if (clipboard.availableFormats().some(isFileFormat)) return null;
    return imagePayload(clipboard.readImage());
  }
  const items = await clipboard.read();
  if (items.some(item => item.types.some(isFileFormat))) return null;
  for (const item of items) {
    // Chromium exposes Windows CF_DIB/CF_DIBV5 screenshots as image/png.
    // Consume that normalized representation; raw DIB bytes have no BMP file
    // header and must not be mistaken for a PNG or passed through over IPC.
    const type = item.types.includes('image/png') ? 'image/png' : item.types.find(value => /^image\/(jpeg|tiff|bmp|webp)$/i.test(value));
    if (!type) continue;
    const blob = await item.getType(type);
    if (!blob.size) continue;
    if (blob.size > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('剪贴板图片超过 32 MiB，请保存后选择文件发送');
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('剪贴板图片超过 32 MiB，请保存后选择文件发送');
    const payload = imagePayload(nativeImage.createFromBuffer(bytes));
    if (payload) return payload;
  }
  return null;
}

module.exports = { readClipboardImage, MAX_CLIPBOARD_IMAGE_BYTES };
