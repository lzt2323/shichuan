import * as Clipboard from 'expo-clipboard';
import * as FS from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import { transfers } from './transfers';
import type { TransferGroup } from './transfers';

const MAX_IMAGE_BYTES = 32 * 1024 ** 2;
const MAX_DRAFT_BYTES = 64 * 1024 ** 2;
const MAX_IMAGES = 10;

// No clipboard polling: the composer invokes this only after an explicit tap.
// Capture the target before awaiting native APIs; navigating away cancels import.
export function createClipboardPaster(deps = { clipboard: Clipboard, fs: FS, transfers, randomUUID }) {
  let reading = false;
  return async (group: TransferGroup, isCurrent: () => boolean): Promise<boolean> => {
    if (reading || !isCurrent()) return false;
    reading = true;
    const target = { ...group };
    let temporary: string | undefined;
    let ids: string[] = [];
    try {
      let result;
      try { result = await deps.clipboard.getImageAsync({ format: 'png' }); }
      catch { throw new Error('无法读取剪贴板图片，请重新复制，或从相册分享至拾传'); }
      if (!isCurrent()) return false;
      if (!result) throw new Error('剪贴板中没有图片，请先复制图片或截图；文字可在输入框长按粘贴');
      const prefix = 'data:image/png;base64,';
      if (!result.data.startsWith(prefix)) throw new Error('剪贴板图片格式无法读取，请重新复制');
      // Android's Base64.DEFAULT inserts LF every 76 characters and at EOF.
      // Normalize line endings only; reject other malformed payload characters.
      const base64 = result.data.slice(prefix.length).replace(/[\r\n]/g, '');
      if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('粘贴图片不能超过 32 MiB，请改用发送文件');
      if (!base64.length || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('剪贴板图片数据为空或损坏，请重新复制');
      const bytes = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
      if (bytes > MAX_IMAGE_BYTES) throw new Error('粘贴图片不能超过 32 MiB，请改用发送文件');
      const drafts = deps.transfers.getSnapshot().filter(item => item.groupId === target.id && ['draft', 'preparing'].includes(item.status));
      if (drafts.filter(item => item.mimeType?.startsWith('image/')).length >= MAX_IMAGES) throw new Error('一次最多粘贴 10 张图片，请先发送或移除');
      if (drafts.reduce((sum, item) => sum + item.size, 0) + bytes > MAX_DRAFT_BYTES) throw new Error('待发送文件合计超过 64 MiB，请先发送或移除');
      if (!deps.fs.cacheDirectory) throw new Error('当前设备无法使用临时文件目录');
      const name = `截图-${deps.randomUUID()}.png`;
      temporary = `${deps.fs.cacheDirectory}${name}`;
      await deps.fs.writeAsStringAsync(temporary, base64, { encoding: deps.fs.EncodingType.Base64 });
      if (!isCurrent()) return false;
      ids = await deps.transfers.importIncoming(target, [{ uri: temporary, name, mimeType: 'image/png', size: bytes }]);
      if (!isCurrent()) { await Promise.all(ids.map(id => deps.transfers.remove(id))); return false; }
      const items = deps.transfers.getSnapshot();
      if (!ids.length || ids.some(id => items.find(item => item.id === id)?.status !== 'draft')) {
        await Promise.all(ids.map(id => deps.transfers.remove(id)));
        throw new Error('图片未能加入待发送区，请重试或选择图片文件');
      }
      return true;
    } finally {
      if (temporary) await deps.fs.deleteAsync(temporary, { idempotent: true }).catch(() => {});
      reading = false;
    }
  };
}

export const pasteClipboardImage = createClipboardPaster();
