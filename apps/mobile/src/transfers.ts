import * as DocumentPicker from 'expo-document-picker';
import * as FS from 'expo-file-system/legacy';
import { File, FileMode } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { randomUUID } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { safeFileName } from '../../../shared/protocol';
import { assertFileMetadata, assertLocalShareUri, byteProgress } from './transfer-utils';

export type TransferGroup = { id: string; name?: string; baseUrl: string; key: string; deviceId: string; maxFileBytes?: number; verify?: () => Promise<void> };
export type IncomingAsset = { uri: string; name?: string; mimeType?: string; size?: number };
export type TransferMessage = { id: string; fileName?: string; size?: number; mime?: string; sha256?: string };
export type TransferStatus = 'preparing' | 'draft' | 'queued' | 'uploading' | 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled';
export type TransferItem = {
  id: string; groupId: string; groupName: string; direction: 'upload' | 'download'; name: string;
  size: number; status: TransferStatus; bytesTransferred: number; totalBytes?: number; progress?: number;
  error?: string; localUri?: string; messageId?: string; mimeType?: string;
};
type Task = { item: TransferItem; group: Readonly<TransferGroup>; asset?: IncomingAsset; message?: TransferMessage; cancelled: boolean; native?: { cancelAsync(): Promise<void> }; folder?: string };
type Manifest = { version: 1; id: string; groupId: string; baseUrl: string; name: string; mimeType?: string; size: number };
const digestKey = (value: string) => bytesToHex(sha256(utf8ToBytes(value)));
const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const errorText = (error: unknown) => error instanceof Error ? error.message : '传输失败，请重试';
const isActive = (status: TransferStatus) => ['preparing', 'queued', 'uploading', 'downloading', 'verifying'].includes(status);
function directory(kind: 'drafts' | 'received') {
  const root = kind === 'drafts' ? FS.documentDirectory : FS.cacheDirectory;
  if (!root) throw new Error('当前设备无法使用本地文件目录');
  return `${root}PickDrop/${kind}/`;
}
function freezeGroup(group: TransferGroup): Readonly<TransferGroup> {
  const url = new URL(group.baseUrl);
  if (!group.id || !group.deviceId || !/^[a-f0-9]{64}$/i.test(group.key) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('群连接信息不完整，请重新连接');
  return Object.freeze({ ...group, baseUrl: url.origin });
}
function checkCancelled(task: Task) { if (task.cancelled) throw new Error('已取消'); }
async function deleteQuietly(uri: string) { try { await FS.deleteAsync(uri, { idempotent: true }); } catch { /* Best effort for cancelled partial files. */ } }
async function verifyFile(uri: string, message: TransferMessage, task: Task) {
  assertFileMetadata(message);
  const file = new File(uri);
  if (!file.exists || file.size !== message.size) throw new Error('文件大小不符，请重新接收');
  const handle = file.open(FileMode.ReadOnly);
  const hash = sha256.create();
  try {
    let read = 0;
    while (read < message.size!) {
      checkCancelled(task);
      const chunk = handle.readBytes(Math.min(1024 * 1024, message.size! - read));
      if (!chunk.length) throw new Error('文件不完整，请重新接收');
      hash.update(chunk); read += chunk.length;
      // Incremental hashing bounds memory and keeps cancellation and UI responsive.
      await yieldToUI();
    }
    checkCancelled(task);
    if (bytesToHex(hash.digest()).toLowerCase() !== message.sha256!.toLowerCase()) throw new Error('文件完整性校验失败，请重新接收');
  } finally { handle.close(); hash.destroy(); }
}

/** Credentials are kept inside locked task contexts, never in UI snapshots or draft manifests. */
export class TransferManager {
  private tasks = new Map<string, Task>();
  private listeners = new Set<() => void>();
  private snapshot: TransferItem[] = [];
  private running = new Map<string, Promise<void>>();
  private uploadTails = new Map<string, Promise<void>>();
  private picking = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit() { this.snapshot = [...this.tasks.values()].map(task => ({ ...task.item })); this.listeners.forEach(listener => listener()); }
  private update(task: Task, patch: Partial<TransferItem>) { task.item = { ...task.item, ...patch }; this.emit(); }
  private progress(task: Task, bytes: number, total: number) { if (!task.cancelled) this.update(task, byteProgress(bytes, total)); }

  async pickFiles(group: TransferGroup): Promise<string[]> {
    const locked = freezeGroup(group); // Capture BEFORE opening the picker, not after it returns.
    if (this.picking) return [];
    this.picking = true;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
      return result.canceled ? [] : await this.importIncoming(locked, result.assets);
    } finally { this.picking = false; }
  }

  /** External shares become drafts only. This method never starts a network request. */
  async importIncoming(group: TransferGroup, assets: IncomingAsset[]): Promise<string[]> {
    const locked = freezeGroup(group), ids: string[] = [];
    for (const asset of assets) {
      const id = randomUUID();
      const name = safeFileName(asset.name || asset.uri.split('/').pop() || '分享文件');
      const task: Task = { group: locked, asset: { ...asset }, cancelled: false, item: { id, groupId: locked.id, groupName: locked.name || '传输群', direction: 'upload', name, mimeType: asset.mimeType, size: asset.size || 0, status: 'preparing', bytesTransferred: 0 } };
      this.tasks.set(id, task); ids.push(id); this.emit();
      const preparing = this.prepare(task).finally(() => this.running.delete(id));
      this.running.set(id, preparing); await preparing;
    }
    return ids;
  }

  private async prepare(task: Task) {
    try {
      checkCancelled(task);
      assertLocalShareUri(task.asset!.uri);
      if ((task.asset!.size || 0) > (task.group.maxFileBytes ?? 8 * 1024 ** 3)) throw new Error('文件超过当前群的大小上限');
      const folder = directory('drafts') + task.item.id + '/'; task.folder = folder;
      await FS.makeDirectoryAsync(folder, { intermediates: true });
      await FS.makeDirectoryAsync(folder + 'payload/', { intermediates: true });
      const localUri = folder + 'payload/' + task.item.name;
      await FS.copyAsync({ from: task.asset!.uri, to: localUri });
      checkCancelled(task);
      const info = await FS.getInfoAsync(localUri);
      if (!info.exists || info.isDirectory) throw new Error('文件无法读取，请重新选择');
      if (info.size > (task.group.maxFileBytes ?? 8 * 1024 ** 3)) throw new Error('文件超过当前群的大小上限');
      const manifest: Manifest = { version: 1, id: task.item.id, groupId: task.group.id, baseUrl: task.group.baseUrl, name: task.item.name, mimeType: task.asset!.mimeType, size: info.size };
      await FS.writeAsStringAsync(folder + 'draft.json', JSON.stringify(manifest));
      checkCancelled(task);
      this.update(task, { localUri, size: info.size, status: 'draft', error: undefined });
    } catch (error) {
      if (task.folder) await deleteQuietly(task.folder);
      this.update(task, { status: task.cancelled ? 'cancelled' : 'failed', error: task.cancelled ? undefined : errorText(error) });
    }
  }

  /** Reattach persisted drafts only to the original group and origin. Never resend automatically. */
  async restoreDrafts(groups: TransferGroup[]): Promise<void> {
    const root = directory('drafts');
    await FS.makeDirectoryAsync(root, { intermediates: true });
    for (const id of await FS.readDirectoryAsync(root)) {
      if (this.tasks.has(id) || !/^[a-f0-9-]{36}$/i.test(id)) continue;
      try {
        const saved: Manifest = JSON.parse(await FS.readAsStringAsync(root + id + '/draft.json'));
        if (saved.version !== 1 || saved.id !== id || saved.name !== safeFileName(saved.name)) continue;
        const group = groups.find(group => group.id === saved.groupId && new URL(group.baseUrl).origin === saved.baseUrl);
        if (!group) continue;
        const localUri = root + id + '/payload/' + saved.name;
        const info = await FS.getInfoAsync(localUri);
        if (!info.exists || info.isDirectory || info.size !== saved.size) continue;
        this.tasks.set(id, { group: freezeGroup(group), cancelled: false, folder: root + id + '/', asset: { uri: localUri, name: saved.name, mimeType: saved.mimeType, size: saved.size }, item: { id, groupId: group.id, groupName: group.name || '传输群', direction: 'upload', name: saved.name, mimeType: saved.mimeType, size: saved.size, localUri, status: 'draft', bytesTransferred: 0 } });
      } catch { /* Ignore incomplete copies; they cannot be sent. */ }
    }
    this.emit();
  }

  start(id: string): Promise<void> {
    const current = this.running.get(id); if (current) return current;
    const task = this.tasks.get(id);
    if (!task || task.item.status === 'completed' || isActive(task.item.status)) return Promise.resolve();
    task.cancelled = false;
    this.update(task, { status: 'queued', error: undefined, progress: undefined, totalBytes: undefined, bytesTransferred: 0 });
    // Mark every selected item queued synchronously; same-group uploads use one
    // promise chain even across repeated Send taps and newly added batches.
    const previous = task.item.direction === 'upload' ? this.uploadTails.get(task.group.id) : undefined;
    const promise = (previous || Promise.resolve()).catch(() => {}).then(async () => {
      if (task.cancelled || !this.tasks.has(id)) return;
      await this.run(task);
    }).finally(() => {
      this.running.delete(id); task.native = undefined;
      if (this.uploadTails.get(task.group.id) === promise) this.uploadTails.delete(task.group.id);
    });
    this.running.set(id, promise);
    if (task.item.direction === 'upload') this.uploadTails.set(task.group.id, promise);
    return promise;
  }
  startGroupDrafts(groupId: string): Promise<void> {
    const ids = this.getSnapshot().filter(item => item.groupId === groupId && item.direction === 'upload' && item.status === 'draft').map(item => item.id);
    const pending = ids.map(id => this.start(id));
    return Promise.all(pending).then(() => {});
  }
  async retry(id: string): Promise<void> {
    await this.running.get(id);
    const task = this.tasks.get(id); if (!task || !['failed', 'cancelled'].includes(task.item.status)) return;
    if (task.item.direction === 'upload' && !task.item.localUri) { task.cancelled = false; this.update(task, { status: 'preparing', error: undefined }); const preparing = this.prepare(task).finally(() => this.running.delete(id)); this.running.set(id, preparing); await preparing; return; }
    await this.start(id);
  }
  async cancel(id: string): Promise<void> {
    const task = this.tasks.get(id); if (!task || task.item.status === 'completed') return;
    task.cancelled = true; this.update(task, { status: 'cancelled', error: undefined, progress: undefined });
    try { await task.native?.cancelAsync(); } catch { /* The request can already have settled. */ }
  }
  async remove(id: string): Promise<void> {
    const waiting = this.tasks.get(id)?.item.status === 'queued';
    await this.cancel(id);
    // A queued task has not opened its file; removal need not wait for a large
    // preceding upload. Its cancelled queue entry is skipped when reached.
    if (!waiting) await this.running.get(id);
    const task = this.tasks.get(id);
    if (task?.folder && task.item.direction === 'upload') await deleteQuietly(task.folder);
    this.tasks.delete(id); this.emit();
  }

  async downloadAndShare(group: TransferGroup, message: TransferMessage): Promise<string> {
    const locked = freezeGroup(group); assertFileMetadata(message);
    const existing = [...this.tasks.values()].find(task => task.group.id === locked.id && task.group.baseUrl === locked.baseUrl && task.item.direction === 'download' && task.item.messageId === message.id);
    if (existing && isActive(existing.item.status)) return existing.item.id;
    const id = randomUUID();
    const task: Task = { group: locked, message: { ...message }, cancelled: false, item: { id, groupId: locked.id, groupName: locked.name || '传输群', messageId: message.id, direction: 'download', name: safeFileName(message.fileName), size: message.size!, status: 'draft', bytesTransferred: 0 } };
    this.tasks.set(id, task); this.emit(); void this.start(id); return id;
  }
  private async run(task: Task) {
    try { if (task.item.direction === 'upload') await this.upload(task); else await this.download(task); }
    catch (error) { this.update(task, { status: task.cancelled ? 'cancelled' : 'failed', error: task.cancelled ? undefined : errorText(error), progress: undefined }); }
  }
  private async upload(task: Task) {
    if (!task.item.localUri) throw new Error('本地草稿已失效，请重新选择文件');
    const info = await FS.getInfoAsync(task.item.localUri);
    if (!info.exists || info.isDirectory || info.size !== task.item.size) throw new Error('本地文件已变化，请重新选择');
    if (info.size > (task.group.maxFileBytes ?? 8 * 1024 ** 3)) throw new Error('文件超过当前群的大小上限');
    checkCancelled(task);
    this.update(task, { status: 'uploading' });
    await task.group.verify?.(); checkCancelled(task);
    const native = FS.createUploadTask(`${task.group.baseUrl}/api/files?name=${encodeURIComponent(task.item.name)}`, task.item.localUri, { httpMethod: 'POST', uploadType: FS.FileSystemUploadType.BINARY_CONTENT, sessionType: FS.FileSystemSessionType.FOREGROUND, headers: { 'X-Room-Key': task.group.key, 'X-Device-Id': task.group.deviceId, 'Content-Type': task.asset?.mimeType || 'application/octet-stream' } }, data => this.progress(task, data.totalBytesSent, data.totalBytesExpectedToSend));
    task.native = native;
    const result = await native.uploadAsync(); checkCancelled(task);
    if (!result) throw new Error('上传未完成，请重试');
    let response: { error?: string; id?: string; size?: number } = {};
    try { response = JSON.parse(result.body); } catch { /* Status is checked below. */ }
    if (result.status < 200 || result.status >= 300) throw new Error(response.error || `上传失败（${result.status}）`);
    if (!response.id || response.size !== task.item.size) throw new Error('服务端未确认完整文件，请刷新消息确认后再重试');
    this.update(task, { status: 'completed', messageId: response.id, localUri: undefined });
    // Completed uploads must not retain large staged payloads or reappear as unsent drafts.
    if (task.folder) { await deleteQuietly(task.folder + 'draft.json'); await deleteQuietly(task.folder); }
  }
  private async download(task: Task) {
    const message = task.message!;
    const folder = `${directory('received')}${digestKey(task.group.id + '\n' + task.group.baseUrl)}/${digestKey(message.id)}/`;
    await FS.makeDirectoryAsync(folder, { intermediates: true });
    const target = folder + task.item.name, partial = folder + '.partial-' + task.item.id;
    checkCancelled(task);
    let cached = false;
    const info = await FS.getInfoAsync(target);
    if (info.exists) {
      this.update(task, { status: 'verifying', progress: undefined });
      try { await verifyFile(target, message, task); cached = true; }
      catch { checkCancelled(task); await deleteQuietly(target); }
    }
    if (!cached) {
      this.update(task, { status: 'downloading', progress: undefined });
      await task.group.verify?.(); checkCancelled(task);
      const native = FS.createDownloadResumable(`${task.group.baseUrl}/api/files/${encodeURIComponent(message.id)}`, partial, { headers: { 'X-Room-Key': task.group.key, 'X-Device-Id': task.group.deviceId }, sessionType: FS.FileSystemSessionType.FOREGROUND }, data => this.progress(task, data.totalBytesWritten, data.totalBytesExpectedToWrite));
      task.native = native;
      try {
        const result = await native.downloadAsync(); checkCancelled(task);
        if (!result || result.status !== 200) throw new Error(`接收失败${result ? `（${result.status}）` : ''}，请重试`);
        this.update(task, { status: 'verifying', progress: undefined });
        await verifyFile(partial, message, task); checkCancelled(task);
        await FS.moveAsync({ from: partial, to: target });
      } finally { await deleteQuietly(partial); }
    }
    checkCancelled(task);
    this.update(task, { localUri: target });
    if (!(await Sharing.isAvailableAsync())) throw new Error('文件已校验，但此设备暂不支持系统分享');
    checkCancelled(task);
    await Sharing.shareAsync(target, { mimeType: message.mime || 'application/octet-stream', dialogTitle: '保存到文件或分享' });
    checkCancelled(task); this.update(task, { status: 'completed' });
  }
}

export const transfers = new TransferManager();
