export const MAX_IMAGE_BYTES = 32 * 1024 ** 2;
export const MAX_DRAFT_BYTES = 64 * 1024 ** 2;
export const MAX_DRAFT_IMAGES = 10;

export function imageFiles(data) {
  const items = Array.from(data?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  return [...new Set(items.length ? items : Array.from(data?.files || []))].filter(file => file.type.startsWith('image/'));
}

// Only the actual paste gesture may request native clipboard data. Ordinary text
// and copied file paths must retain the platform's normal paste behaviour.
export function createImagePasteHandler({ canPaste, context, readNative, onImages, onError }) {
  return async event => {
    if (!canPaste(event)) return false;
    const files = imageFiles(event.clipboardData);
    if (files.length) {
      event.preventDefault();
      try { onImages(files); } catch (error) { onError(error); }
      return true;
    }
    if (!readNative || event.clipboardData?.getData('text/plain') || event.clipboardData?.getData('text/html') || event.clipboardData?.files?.length) return false;
    const atPaste = context();
    try {
      const result = await readNative();
      if (!result || context() !== atPaste || !canPaste(event)) return false;
      onImages([new File([result.bytes], 'image.png', { type: result.mimeType })]);
      return true;
    } catch (error) { onError(error); return false; }
  };
}

export class ImageDrafts {
  constructor(urls = URL) { this.items = []; this.urls = urls; }
  add(files) {
    const images = files.filter(file => file.type.startsWith('image/'));
    if (images.some(file => !file.size)) throw new Error('剪贴板图片为空，请重新复制');
    if (images.some(file => file.size > MAX_IMAGE_BYTES)) throw new Error('粘贴图片不能超过 32 MB，请改用发送文件');
    if (this.items.length + images.length > MAX_DRAFT_IMAGES) throw new Error('一次最多粘贴 10 张图片');
    if ([...this.items.map(item => item.file), ...images].reduce((sum, file) => sum + file.size, 0) > MAX_DRAFT_BYTES) throw new Error('待发送图片总大小不能超过 64 MB');
    for (const source of images) {
      const extension = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/tiff': 'tiff', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' })[source.type] || 'png';
      const id = crypto.randomUUID();
      const name = !source.name || /^(image|blob|clipboard)(\.[a-z]+)?$/i.test(source.name) ? `截图-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}.${extension}` : source.name;
      const file = new File([source], name, { type: source.type, lastModified: source.lastModified });
      this.items.push({ id, file, url: this.urls.createObjectURL(file) });
    }
  }
  remove(id) { const item = this.items.find(item => item.id === id); if (item) this.urls.revokeObjectURL(item.url); this.items = this.items.filter(item => item.id !== id); }
  clear() { this.items.forEach(item => this.urls.revokeObjectURL(item.url)); this.items = []; }
}
