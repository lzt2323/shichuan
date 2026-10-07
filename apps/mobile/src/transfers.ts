import * as DocumentPicker from 'expo-document-picker';
import * as FS from 'expo-file-system/legacy';
import { File, FileMode } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { exportReceived, sweepIncoming, incomingBytes } from './storage-native';
import { randomUUID } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { safeFileName } from '../../../shared/protocol';
import { assertFileMetadata, assertLocalShareUri, byteProgress } from './transfer-utils';

export type TransferGroup = { id: string; name?: string; baseUrl: string; key: string; deviceId: string; hostDeviceId?: string; authVersion?: 2; maxFileBytes?: number; verify?: () => Promise<void | { baseUrl: string }> };
export type IncomingAsset = { uri: string; name?: string; mimeType?: string; size?: number };
export type TransferMessage = { id: string; fileName?: string; size?: number; mime?: string; sha256?: string };
export type TransferStatus = 'preparing' | 'draft' | 'queued' | 'uploading' | 'downloading' | 'verifying' | 'completed' | 'saving' | 'save-cancelled' | 'orphaned' | 'failed' | 'cancelled';
export type TransferItem = {
  id: string; groupId: string; groupName: string; direction: 'upload' | 'download'; name: string;
  size: number; status: TransferStatus; bytesTransferred: number; totalBytes?: number; progress?: number;
  destination?: string; action?: 'save' | 'file' | 'share'; error?: string; localUri?: string; messageId?: string; mimeType?: string;
};
type Task = { item: TransferItem; group: Readonly<TransferGroup>; asset?: IncomingAsset; message?: TransferMessage; cancelled: boolean; native?: { cancelAsync(): Promise<void> }; folder?: string };
type Manifest = { version: 1 | 2; hostDeviceId?: string; credentialHash?: string; id: string; groupId: string; baseUrl: string; name: string; mimeType?: string; size: number };
const digestKey = (value: string) => bytesToHex(sha256(utf8ToBytes(value)));
const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const errorText = (error: unknown) => error instanceof Error ? error.message : '传输失败，请重试';
const isActive = (status: TransferStatus) => ['preparing', 'queued', 'uploading', 'downloading', 'verifying', 'saving'].includes(status);
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
    if (bytesToHex(hash.digest()).toLowerCase() !== message.sha256!.toLowerCase()) throw new Error('文件内容不完整，请重新接收');
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
  private downloadLeases = new Map<string, number>();
  private downloadTails = new Map<string, Promise<void>>();
  private cacheSweep: Promise<void> = Promise.resolve();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit() {
    const finished = [...this.tasks.values()].filter(task => ['completed', 'save-cancelled'].includes(task.item.status) || (task.item.direction === 'download' && ['failed', 'cancelled'].includes(task.item.status)));
    for (const task of finished.slice(0, Math.max(0, finished.length - 100))) this.tasks.delete(task.item.id);
    this.snapshot = [...this.tasks.values()].map(task => ({ ...task.item })); this.listeners.forEach(listener => listener()); }
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
      const manifest: Manifest = { version: 2, hostDeviceId: task.group.hostDeviceId, credentialHash: digestKey('pickdrop-draft-v2:' + task.group.key), id: task.item.id, groupId: task.group.id, baseUrl: task.group.baseUrl, name: task.item.name, mimeType: task.asset!.mimeType, size: info.size };
      await FS.writeAsStringAsync(folder + 'draft.json', JSON.stringify(manifest));
      checkCancelled(task);
      this.update(task, { localUri, size: info.size, status: 'draft', error: undefined });
    } catch (error) {
      if (task.folder) await deleteQuietly(task.folder);
      this.update(task, { status: task.cancelled ? 'cancelled' : 'failed', error: task.cancelled ? undefined : errorText(error) });
    }
  }

  /** Endpoint hints may change; persisted device credentials and host identity must remain the same. */
  async restoreDrafts(groups: TransferGroup[]): Promise<void> {
    const root = directory('drafts');
    await FS.makeDirectoryAsync(root, { intermediates: true });
    for (const id of await FS.readDirectoryAsync(root)) {
      if (this.tasks.has(id) || !/^[a-f0-9-]{36}$/i.test(id)) continue;
      try {
        const saved: Manifest = JSON.parse(await FS.readAsStringAsync(root + id + '/draft.json'));
        if (![1, 2].includes(saved.version) || saved.id !== id || saved.name !== safeFileName(saved.name)) throw new Error('Invalid manifest');
        const group = groups.find(group => group.id === saved.groupId && (saved.version === 2 ? group.hostDeviceId === saved.hostDeviceId && (digestKey('pickdrop-draft-v2:' + group.key) === saved.credentialHash || (group.authVersion !== 2 && digestKey(group.key) === saved.credentialHash)) : group.authVersion !== 2 && new URL(group.baseUrl).origin === saved.baseUrl));

        const localUri = root + id + '/payload/' + saved.name;
        const info = await FS.getInfoAsync(localUri);
        if (!info.exists || info.isDirectory || info.size !== saved.size) throw new Error('Incomplete draft');
        this.tasks.set(id, { group: group ? freezeGroup(group) : { id: saved.groupId, name: '未关联群草稿', baseUrl: saved.baseUrl, key: '', deviceId: '' }, cancelled: false, folder: root + id + '/', asset: { uri: localUri, name: saved.name, mimeType: saved.mimeType, size: saved.size }, item: { id, groupId: group?.id || saved.groupId, groupName: group?.name || '未关联群草稿', direction: 'upload', name: saved.name, mimeType: saved.mimeType, size: saved.size, localUri, status: group ? 'draft' : 'orphaned', bytesTransferred: 0 } });
      } catch {
        // A crash before manifest commit must leave a visible, removable draft.
        const folder = root + id + '/'; let name = '未完成的草稿', localUri: string | undefined, size = 0;
        try {
          for (const file of await FS.readDirectoryAsync(folder + 'payload/')) {
            if (safeFileName(file) !== file) continue;
            const uri = folder + 'payload/' + file, info = await FS.getInfoAsync(uri);
            if (info.exists && !info.isDirectory) { name = file; localUri = uri; size = info.size; break; }
          }
        } catch { /* Empty preparation directory can still be explicitly removed. */ }
        this.tasks.set(id, { group: { id: 'orphaned', name: '未关联群草稿', baseUrl: 'http://localhost', key: '', deviceId: '' }, folder, cancelled: false,
          asset: localUri ? { uri: localUri, name, size } : undefined,
          item: { id, groupId: 'orphaned', groupName: '未关联群草稿', direction: 'upload', name, localUri, size, status: 'orphaned', bytesTransferred: 0 } });
      }
    }
    this.emit();
    await this.cleanCache();
  }

  async storageStats() {
    const scan = async (root: string): Promise<number> => {
      const info = await FS.getInfoAsync(root); if (!info.exists) return 0;
      if (!info.isDirectory) return info.size || 0;
      let size = 0; for (const name of await FS.readDirectoryAsync(root)) size += await scan(root.replace(/\/?$/, '/') + name); return size;
    };
    return { cacheBytes: await scan(directory('received')) + await incomingBytes(), draftBytes: await scan(directory('drafts')) };
  }
  cleanCache(clearAll = false): Promise<void> {
    // Serialize filesystem sweeps. A new download waits until every queued sweep
    // finishes before acquiring its file lease, avoiding delete/mkdir races.
    const sweep = this.cacheSweep.catch(() => {}).then(() => this.sweepCache(clearAll));
    this.cacheSweep = sweep; return sweep;
  }
  private async sweepCache(clearAll: boolean) {
    const root = directory('received'); await FS.makeDirectoryAsync(root, { intermediates: true });
    let protectedBytes = 0;
    const entries: { folder: string; size: number; touched: number }[] = [];
    for (const host of await FS.readDirectoryAsync(root)) {
      const hostRoot = root + host + '/'; const info = await FS.getInfoAsync(hostRoot); if (!info.exists || !info.isDirectory) continue;
      for (const id of await FS.readDirectoryAsync(hostRoot)) {
        const folder = hostRoot + id + '/'; const details = await FS.getInfoAsync(folder); if (!details.exists || !details.isDirectory) continue;
        const active = this.downloadLeases.has(folder) || [...this.tasks.values()].some(task => task.folder === folder && isActive(task.item.status));
        if (active) { const task = [...this.tasks.values()].find(task => task.folder === folder); protectedBytes += task?.item.size || 0; continue; }
        for (const name of await FS.readDirectoryAsync(folder)) if (name.startsWith('.partial-')) await deleteQuietly(folder + name);
        try { const meta = JSON.parse(await FS.readAsStringAsync(folder + 'cache.json')); entries.push({ folder, size: meta.size || 0, touched: meta.touched || 0 }); }
        catch { if (!this.downloadLeases.has(folder)) await deleteQuietly(folder); }
      }
    }
    await sweepIncoming(clearAll);
    entries.sort((a, b) => b.touched - a.touched); let retained = protectedBytes;
    for (const entry of entries) {
      if (this.downloadLeases.has(entry.folder)) continue;
      if (clearAll || Date.now() - entry.touched > 7 * 86400000 || retained + entry.size > 512 * 1024 ** 2) await deleteQuietly(entry.folder); else retained += entry.size;
    }
  }

  start(id: string): Promise<void> {
    const current = this.running.get(id); if (current) return current;
    const task = this.tasks.get(id);
    if (!task || task.item.status === 'orphaned' || task.item.status === 'completed' || isActive(task.item.status)) return Promise.resolve();
    task.cancelled = false;
    this.update(task, { status: 'queued', error: undefined, progress: undefined, totalBytes: undefined, bytesTransferred: 0 });
    // Mark every selected item queued synchronously; same-group uploads use one
    // promise chain even across repeated Send taps and newly added batches.
    const queueKey = task.item.direction === 'upload' ? task.group.id : task.group.id + '\n' + (task.group.hostDeviceId || task.group.baseUrl) + '\n' + task.item.messageId;
    const tails = task.item.direction === 'upload' ? this.uploadTails : this.downloadTails;
    const previous = tails.get(queueKey);
    const promise = (previous || Promise.resolve()).catch(() => {}).then(async () => {
      if (task.cancelled || !this.tasks.has(id)) return;
      await this.run(task);
    }).finally(() => {
      this.running.delete(id); task.native = undefined;
      if (tails.get(queueKey) === promise) tails.delete(queueKey);
    });
    this.running.set(id, promise);
    tails.set(queueKey, promise);
    return promise;
  }
  startGroupDrafts(groupId: string): Promise<void> {
    const ids = this.getSnapshot().filter(item => item.groupId === groupId && item.direction === 'upload' && item.status === 'draft').map(item => item.id);
    const pending = ids.map(id => this.start(id));
    return Promise.all(pending).then(() => {});
  }
  async retry(id: string): Promise<void> {
    await this.running.get(id);
    const task = this.tasks.get(id); if (!task || !['failed', 'cancelled', 'save-cancelled'].includes(task.item.status)) return;
    if (task.item.direction === 'upload' && !task.item.localUri) { task.cancelled = false; this.update(task, { status: 'preparing', error: undefined }); const preparing = this.prepare(task).finally(() => this.running.delete(id)); this.running.set(id, preparing); await preparing; return; }
    await this.start(id);
  }
  async cancel(id: string): Promise<void> {
    const task = this.tasks.get(id); if (!task || ['orphaned', 'completed', 'saving'].includes(task.item.status)) return;
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

  async receive(group: TransferGroup, message: TransferMessage, action: 'save' | 'file' | 'share' = 'save'): Promise<string> {
    const locked = freezeGroup(group); assertFileMetadata(message);
    const existing = [...this.tasks.values()].find(task => task.group.id === locked.id && task.group.hostDeviceId === locked.hostDeviceId && task.item.direction === 'download' && task.item.messageId === message.id && (isActive(task.item.status) || this.running.has(task.item.id)));
    if (existing) return existing.item.id;
    const id = randomUUID();
    const task: Task = { group: locked, message: { ...message }, cancelled: false, item: { id, groupId: locked.id, groupName: locked.name || '传输群', messageId: message.id, direction: 'download', action, mimeType: message.mime, name: safeFileName(message.fileName), size: message.size!, status: 'draft', bytesTransferred: 0 } };
    this.tasks.set(id, task); this.emit(); void this.start(id); return id;
  }
  async downloadAndShare(group: TransferGroup, message: TransferMessage) { return this.receive(group, message, 'share'); }
  async reassignDraft(id: string, group: TransferGroup) {
    const task = this.tasks.get(id); if (!task?.item.localUri || !['orphaned', 'draft', 'failed', 'cancelled'].includes(task.item.status) || task.item.direction !== 'upload') throw new Error('这个草稿暂时无法重新关联');
    const locked = freezeGroup(group); task.group = locked;
    const manifest: Manifest = { version: 2, id, groupId: locked.id, hostDeviceId: locked.hostDeviceId, credentialHash: digestKey('pickdrop-draft-v2:' + locked.key), baseUrl: locked.baseUrl, name: task.item.name, size: task.item.size, mimeType: task.item.mimeType };
    await FS.writeAsStringAsync(task.folder! + 'draft.json', JSON.stringify(manifest));
    this.update(task, { groupId: locked.id, groupName: locked.name || '传输群', status: 'draft', error: undefined });
  }
  async detachGroup(groupId: string) {
    for (const task of this.tasks.values()) if (task.item.groupId === groupId && task.item.direction === 'upload' && task.item.status !== 'completed') {
      await this.cancel(task.item.id); await this.running.get(task.item.id);
      if (task.item.localUri) this.update(task, { status: 'orphaned', groupName: '未关联群草稿' });
    }
  }
  private async run(task: Task) {
    try { if (task.item.direction === 'upload') await this.upload(task); else await this.download(task); }
    catch (error) { this.update(task, { status: task.cancelled ? 'cancelled' : 'failed', error: task.cancelled ? undefined : errorText(error), progress: undefined }); }
    finally { if (task.item.direction === 'download') await this.cleanCache().catch(() => {}); }
  }
  private async upload(task: Task) {
    if (!task.item.localUri) throw new Error('本地草稿已失效，请重新选择文件');
    const info = await FS.getInfoAsync(task.item.localUri);
    if (!info.exists || info.isDirectory || info.size !== task.item.size) throw new Error('本地文件已变化，请重新选择');
    if (info.size > (task.group.maxFileBytes ?? 8 * 1024 ** 3)) throw new Error('文件超过当前群的大小上限');
    checkCancelled(task);
    this.update(task, { status: 'uploading' });
    const verified = await task.group.verify?.(); checkCancelled(task);
    if (verified?.baseUrl) task.group = freezeGroup({ ...task.group, baseUrl: verified.baseUrl });
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
    const folder = `${directory('received')}${digestKey(task.group.id + '\n' + (task.group.hostDeviceId || task.group.baseUrl))}/${digestKey(message.id)}/`;
    while (true) {
      const sweep = this.cacheSweep; await sweep.catch(() => {});
      if (sweep === this.cacheSweep) break;
    }
    checkCancelled(task); this.downloadLeases.set(folder, (this.downloadLeases.get(folder) || 0) + 1);
    try {
      await FS.makeDirectoryAsync(folder, { intermediates: true }); task.folder = folder;
      const target = folder + task.item.name, partial = folder + '.partial-' + task.item.id;
      checkCancelled(task);
      let cached = false;
      const info = await FS.getInfoAsync(target);
      if (task.item.localUri && !info.exists) throw new Error('本地接收缓存已被清理，请回到聊天重新接收文件');
      if (info.exists) {
        this.update(task, { status: 'verifying', progress: undefined });
        try { await verifyFile(target, message, task); cached = true; }
        catch { checkCancelled(task); await deleteQuietly(target); }
      }
      if (!cached && task.item.localUri) throw new Error('本地文件已失效，请回到聊天重新接收文件');
      if (!cached) {
        this.update(task, { status: 'downloading', progress: undefined });
        const verified = await task.group.verify?.(); checkCancelled(task);
        if (verified?.baseUrl) task.group = freezeGroup({ ...task.group, baseUrl: verified.baseUrl });
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
      this.update(task, { localUri: target, status: 'saving' });
      await FS.writeAsStringAsync(folder + 'cache.json', JSON.stringify({ size: message.size, touched: Date.now() }));
      if (task.item.action === 'share') {
        if (!(await Sharing.isAvailableAsync())) throw new Error('此设备暂不支持系统分享');
        await Sharing.shareAsync(target, { mimeType: message.mime || 'application/octet-stream', dialogTitle: '分享文件' });
        this.update(task, { status: 'completed', destination: '分享面板' });
      } else {
        const mime = message.mime || 'application/octet-stream';
        const result = await exportReceived(target, task.item.name, mime, task.item.action !== 'file' && mime.startsWith('image/'));
        this.update(task, { status: result.saved ? 'completed' : 'save-cancelled', destination: result.saved ? result.destination : undefined });
      }
    } finally {
      const remaining = (this.downloadLeases.get(folder) || 1) - 1;
      if (remaining > 0) this.downloadLeases.set(folder, remaining); else this.downloadLeases.delete(folder);
    }
  }
}

export const transfers = new TransferManager();
