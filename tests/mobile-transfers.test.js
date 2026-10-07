import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInboxServer } from '../server/index.js';
import { createMobileClient, createVerifiedTransferGroup } from '../apps/mobile/src/client.js';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import * as protocol from '../shared/protocol.js';
import * as utils from '../apps/mobile/src/transfer-utils.js';

const mobileRequire = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
const ts = mobileRequire('typescript');
const source = ts.transpileModule(readFileSync(new URL('../apps/mobile/src/transfers.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const group = () => ({ id: 'group-A', name: 'A', baseUrl: 'http://192.168.1.5:8080', key: 'a'.repeat(64), deviceId: 'phone' });
const content = Buffer.from('A real file with bytes');
const message = { id: '../remote/id', fileName: 'sample.txt', size: content.length, sha256: createHash('sha256').update(content).digest('hex') };

function setup() {
  const files = new Map([['content://source', content]]);
  const shared = [], uploads = [], downloads = [];
  const state = { saveCancelled: false, saveError: false, exported: [], corrupt: false, holdUpload: false, releaseUpload: null, pick: null };
  const fs = {
    documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/', FileSystemUploadType: { BINARY_CONTENT: 0 }, FileSystemSessionType: { FOREGROUND: 1 },
    async makeDirectoryAsync() {},
    async copyAsync({ from, to }) { if (!files.has(from)) throw new Error('No source'); files.set(to, Buffer.from(files.get(from))); },
    async moveAsync({ from, to }) { if (!files.has(from)) throw new Error('No source'); files.set(to, files.get(from)); files.delete(from); },
    async getInfoAsync(uri) { if ([...files.keys()].some(key => key.startsWith(uri.replace(/\/?$/, '/') ))) return { exists: true, isDirectory: true }; return files.has(uri) ? { exists: true, isDirectory: false, size: files.get(uri).length } : { exists: false }; },
    async writeAsStringAsync(uri, value) { files.set(uri, Buffer.from(value)); },
    async readAsStringAsync(uri) { if (!files.has(uri)) throw new Error('Missing'); return files.get(uri).toString(); },
    async readDirectoryAsync(root) { return [...new Set([...files.keys()].filter(uri => uri.startsWith(root)).map(uri => uri.slice(root.length).split('/')[0]))]; },
    async deleteAsync(uri) { for (const key of files.keys()) if (key === uri || key.startsWith(uri.endsWith('/') ? uri : uri + '/')) files.delete(key); },
    createUploadTask(url, uri, options, callback) {
      uploads.push({ url, uri, options }); let cancel = false;
      return { async uploadAsync() { callback({ totalBytesSent: 4, totalBytesExpectedToSend: content.length }); if (state.holdUpload) await new Promise(resolve => { state.releaseUpload = resolve; }); if (cancel) return null; if (state.uploadHandler) return state.uploadHandler(url, uri, options, files); return { status: 201, body: JSON.stringify({ id: 'sent', size: files.get(uri).length }) }; }, async cancelAsync() { cancel = true; state.releaseUpload?.(); } };
    },
    createDownloadResumable(url, uri, options, callback) {
      downloads.push({ url, uri, options });
      return { async downloadAsync() { if (state.downloadHandler) await state.downloadHandler(); const data = state.corrupt ? Buffer.alloc(content.length, 88) : content; files.set(uri, data); callback({ totalBytesWritten: data.length, totalBytesExpectedToWrite: data.length }); return { status: 200, uri }; }, async cancelAsync() {} };
    },
  };
  class File {
    constructor(uri) { this.uri = uri; }
    get exists() { return files.has(this.uri); }
    get size() { return files.get(this.uri)?.length || 0; }
    open() { const data = files.get(this.uri); let offset = 0; return { readBytes(length) { const bytes = data.subarray(offset, offset + length); offset += bytes.length; return bytes; }, close() {} }; }
  }
  const mocks = { './storage-native': { incomingBytes: async () => 0, sweepIncoming: async () => {}, exportReceived: async (uri, name, mime, image) => { state.exported.push({ uri, image }); if (state.saveHandler) return state.saveHandler(uri); if (state.saveError) throw new Error('No permission'); return { saved: !state.saveCancelled, destination: image ? '相册' : '文件' }; } }, 'expo-document-picker': { getDocumentAsync: async () => state.pick ? state.pick() : { canceled: true } }, 'expo-file-system/legacy': fs, 'expo-file-system': { File, FileMode: { ReadOnly: 'r' } }, 'expo-sharing': { isAvailableAsync: async () => true, shareAsync: async uri => shared.push(uri) }, 'expo-crypto': { randomUUID }, '../../../shared/protocol': protocol, './transfer-utils': utils };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => mocks[name] || mobileRequire(name), module, module.exports);
  return { manager: new module.exports.TransferManager(), Manager: module.exports.TransferManager, state, files, fs, shared, uploads, downloads };
}
async function settle(manager, id) {
  for (let tick = 0; tick < 100; tick++) {
    const item = manager.getSnapshot().find(item => item.id === id);
    if (['completed', 'failed', 'cancelled'].includes(item?.status)) return item;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Transfer did not settle');
}

test('byte progress is indeterminate without valid native totals', () => {
  assert.equal(utils.byteProgress(3, -1).progress, undefined);
  assert.equal(utils.byteProgress(NaN, 10).progress, undefined);
  assert.equal(utils.byteProgress(0, 0).progress, undefined);
  assert.equal(utils.byteProgress(12, 10).progress, undefined);
  assert.equal(utils.byteProgress(3, 10).progress, 0.3);
  assert.throws(() => utils.assertLocalShareUri('https://example.com/secret'));
  assert.throws(() => utils.assertFileMetadata({ ...message, sha256: 'wrong' }));
});

test('system share is a durable draft, filename cannot overwrite manifest, and group is locked', async () => {
  const env = setup(), original = group();
  const [id] = await env.manager.importIncoming(original, [{ uri: 'content://source', name: 'draft.json' }]);
  original.id = 'group-B'; original.key = 'b'.repeat(64); original.baseUrl = 'http://elsewhere';
  const draft = env.manager.getSnapshot()[0];
  assert.equal(draft.status, 'draft'); assert.equal(env.uploads.length, 0);
  assert.deepEqual(env.files.get(draft.localUri), content);
  env.files.delete('content://source');
  const restored = new env.Manager(); await restored.restoreDrafts([group()]);
  assert.equal(restored.getSnapshot()[0].status, 'draft');
  await env.manager.start(id);
  assert.equal(env.uploads[0].options.headers['X-Room-Key'], 'a'.repeat(64));
  assert.equal(env.uploads[0].url.startsWith(group().baseUrl), true);
  assert.equal(env.manager.getSnapshot()[0].status, 'completed');
  assert.equal(env.files.has(draft.localUri), false);
  const noRestore = new env.Manager(); await noRestore.restoreDrafts([group()]);
  assert.equal(noRestore.getSnapshot().length, 0);
});

test('image preview metadata and bytes survive draft restore and upload uses image MIME', async () => {
  const env = setup();
  const [id] = await env.manager.importIncoming(group(), [{ uri: 'content://source', name: '截图.png', mimeType: 'image/png' }]);
  const image = env.manager.getSnapshot().find(item => item.id === id);
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(env.files.get(image.localUri), content);
  const restored = new env.Manager(); await restored.restoreDrafts([group()]);
  assert.equal(restored.getSnapshot()[0].mimeType, 'image/png');
  await restored.startGroupDrafts('group-A');
  assert.equal((await settle(restored, id)).status, 'completed');
  assert.equal(env.uploads[0].options.headers['Content-Type'], 'image/png');
});

test('picker captures destination before asynchronous selection', async () => {
  const env = setup(), original = group(); let resolve;
  env.state.pick = () => new Promise(r => { resolve = r; });
  const pending = env.manager.pickFiles(original);
  original.id = 'group-B'; original.key = 'b'.repeat(64);
  resolve({ canceled: false, assets: [{ uri: 'content://source', name: 'file.txt' }] });
  const [id] = await pending; await env.manager.start(id);
  assert.equal(env.manager.getSnapshot()[0].groupId, 'group-A');
  assert.equal(env.uploads[0].options.headers['X-Room-Key'], 'a'.repeat(64));
});

test('upload cancellation preserves retryable local draft and uses real byte progress', async () => {
  const env = setup(); env.state.holdUpload = true;
  const [id] = await env.manager.importIncoming(group(), [{ uri: 'content://source', name: 'file.txt' }]);
  const pending = env.manager.start(id);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(env.manager.getSnapshot()[0].progress, 4 / content.length);
  await env.manager.cancel(id); await pending;
  assert.equal(env.manager.getSnapshot()[0].status, 'cancelled');
  env.state.holdUpload = false; await env.manager.retry(id);
  assert.equal(env.manager.getSnapshot()[0].status, 'completed');
});

test('same-size corrupt download is never shared, retry verifies SHA256 and uses isolated cache', async () => {
  const env = setup(); env.state.corrupt = true;
  const id = await env.manager.downloadAndShare(group(), message);
  assert.equal((await settle(env.manager, id)).status, 'failed');
  assert.equal(env.shared.length, 0);
  assert.equal([...env.files.keys()].some(key => key.includes('.partial-')), false);
  env.state.corrupt = false; await env.manager.retry(id);
  assert.equal(env.manager.getSnapshot()[0].status, 'completed'); assert.equal(env.shared.length, 1);
  const other = { ...group(), id: 'group-B', key: 'b'.repeat(64) };
  const next = await env.manager.downloadAndShare(other, message); await settle(env.manager, next);
  assert.notEqual(env.shared[0], env.shared[1]);
  assert.equal(env.downloads[0].uri.includes('../remote/id'), false);
});

test('identity rejection prevents native requests carrying group credentials', async () => {
  const env = setup();
  const verifiedGroup = { ...group(), verify: async () => { throw new Error('Identity mismatch'); } };
  const [id] = await env.manager.importIncoming(verifiedGroup, [{ uri: 'content://source', name: 'file.txt' }]);
  await env.manager.start(id);
  assert.equal(env.uploads.length, 0);
  assert.equal(env.manager.getSnapshot()[0].status, 'failed');
  const download = await env.manager.downloadAndShare(verifiedGroup, message);
  assert.equal((await settle(env.manager, download)).status, 'failed');
  assert.equal(env.downloads.length, 0);
});


test('batch marks all files queued immediately, deduplicates Send and cancels waiting files', async () => {
  const env = setup(); env.state.holdUpload = true;
  const ids = await env.manager.importIncoming(group(), [
    { uri: 'content://source', name: 'first.txt' },
    { uri: 'content://source', name: 'second.txt' },
  ]);
  const batch = env.manager.startGroupDrafts(group().id);
  assert.deepEqual(env.manager.getSnapshot().map(item => item.status), ['queued', 'queued']);
  const repeated = env.manager.startGroupDrafts(group().id);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(env.uploads.length, 1);
  assert.equal(env.manager.getSnapshot()[1].status, 'queued');
  await env.manager.remove(ids[1]);
  assert.equal(env.manager.getSnapshot().some(item => item.id === ids[1]), false);
  env.state.holdUpload = false; env.state.releaseUpload();
  await Promise.all([batch, repeated]);
  assert.equal(env.uploads.length, 1);
  assert.equal(env.manager.getSnapshot()[0].status, 'completed');
});

test('new batch waits behind an existing upload in the same group', async () => {
  const env = setup(); env.state.holdUpload = true;
  await env.manager.importIncoming(group(), [{ uri: 'content://source', name: 'first.txt' }]);
  const firstBatch = env.manager.startGroupDrafts(group().id);
  await new Promise(resolve => setTimeout(resolve, 0));
  await env.manager.importIncoming(group(), [{ uri: 'content://source', name: 'later.txt' }]);
  const laterBatch = env.manager.startGroupDrafts(group().id);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(env.uploads.length, 1);
  env.state.holdUpload = false; env.state.releaseUpload();
  await Promise.all([firstBatch, laterBatch]);
  assert.equal(env.uploads.length, 2);
  assert.equal(env.manager.getSnapshot().every(item => item.status === 'completed'), true);
});


test('identity-locked file drafts restore and upload to a verified restarted real host', async t => {
  const env = setup(), dataDir = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'pickdrop-draft-reconnect-'));
  const metadata = { id: randomUUID(), name: '文件恢复群', hostDeviceId: randomUUID(), authVersion: 2 };
  let inbox = await createInboxServer({ dataDir, host: '127.0.0.1', group: metadata });
  await inbox.ensureHostDevice({ id: metadata.hostDeviceId, name: '主机', kind: 'desktop' });
  const saved = new Map();
  const client = createMobileClient({ randomUUID, storage: { getItemAsync: async key => saved.get(key) || null, setItemAsync: async (key, value) => saved.set(key, value) } });
  t.after(async () => { client.close(); await inbox.close(); await nodeFs.rm(dataDir, { recursive: true, force: true }); });
  await client.init();
  const ticket = await client.requestJoin(`${inbox.baseUrl}/#invite=${inbox.pairing.invite().code}&group=${metadata.id}`);
  await inbox.pairing.respond(ticket.requestId, true);
  const original = (await client.checkJoin(ticket)).group;
  const transfer = createVerifiedTransferGroup(client, original, client.device.id);
  const [id] = await env.manager.importIncoming(transfer, [{ uri: 'content://source', name: 'saved.txt' }]);
  const manifestUri = [...env.files.keys()].find(uri => uri.endsWith('/draft.json'));
  const manifest = JSON.parse(env.files.get(manifestUri));
  assert.notEqual(manifest.credentialHash, createHash('sha256').update(original.key).digest('hex'), 'draft fingerprint must not reveal the host proof secret');
  const oldUrl = original.baseUrl;
  await inbox.close(); inbox = await createInboxServer({ dataDir, host: '127.0.0.1', group: metadata });
  await client.reconnectAt(original.id, inbox.baseUrl);
  assert.notEqual(inbox.baseUrl, oldUrl);
  const restored = new env.Manager();
  await restored.restoreDrafts([createVerifiedTransferGroup(client, client.getGroup(original.id), client.device.id)]);
  assert.equal(restored.getSnapshot()[0].id, id); assert.deepEqual(env.files.get(restored.getSnapshot()[0].localUri), content);
  const wrongCredential = new env.Manager(); await wrongCredential.restoreDrafts([{ ...transfer, key: 'b'.repeat(64) }]); assert.equal(wrongCredential.getSnapshot()[0].status, 'orphaned');
  const wrongHost = new env.Manager(); await wrongHost.restoreDrafts([{ ...transfer, hostDeviceId: randomUUID() }]); assert.equal(wrongHost.getSnapshot()[0].status, 'orphaned');
  env.state.uploadHandler = async (url, uri, options, files) => {
    assert.ok(url.startsWith(inbox.baseUrl));
    const response = await fetch(url, { method: 'POST', headers: options.headers, body: files.get(uri) });
    return { status: response.status, body: await response.text() };
  };
  // The original queued task also resolves its endpoint immediately before native upload.
  await env.manager.start(id);
  assert.equal(env.manager.getSnapshot()[0].status, 'completed');
  assert.equal(inbox.state().messages[0].fileName, 'saved.txt');
});


test('receive image saves directly; cancel export never says saved and retry uses verified cache', async () => {
  const env = setup();
  const image = { ...message, mime: 'image/png', fileName: 'picture.png' };
  const id = await env.manager.receive(group(), image);
  assert.equal((await settle(env.manager, id)).destination, '相册');
  assert.equal(env.state.exported[0].image, true); assert.equal(env.shared.length, 0);
  const file = { ...message, id: 'file-2' }; env.state.saveCancelled = true;
  const cancelled = await env.manager.receive(group(), file);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(env.manager.getSnapshot().find(item => item.id === cancelled).status, 'save-cancelled');
  env.state.saveCancelled = false; await env.manager.retry(cancelled);
  assert.equal(env.downloads.length, 2); assert.equal(env.shared.length, 0);
  assert.equal(env.manager.getSnapshot().find(item => item.id === cancelled).destination, '文件');
});

test('save failure can retry without redownload; explicit share remains separate', async () => {
  const env = setup(); env.state.saveError = true;
  const id = await env.manager.receive(group(), { ...message, mime: 'image/png' });
  assert.equal((await settle(env.manager, id)).status, 'failed');
  env.state.saveError = false; await env.manager.retry(id);
  assert.equal(env.downloads.length, 1); assert.equal(env.shared.length, 0);
  const share = await env.manager.receive(group(), message, 'share'); await settle(env.manager, share);
  assert.equal(env.shared.length, 1);
});

test('unrelated credential restores visible orphan and requires explicit reassignment', async () => {
  const env = setup(); const [id] = await env.manager.importIncoming(group(), [{ uri: 'content://source', name: 'draft.txt' }]);
  const restored = new env.Manager(); await restored.restoreDrafts([]);
  assert.equal(restored.getSnapshot()[0].status, 'orphaned');
  await restored.start(id); assert.equal(env.uploads.length, 0);
  await restored.reassignDraft(id, { ...group(), id: 'new-group', key: 'b'.repeat(64) });
  assert.equal(restored.getSnapshot()[0].status, 'draft');
  await restored.start(id); assert.equal(env.uploads[0].options.headers['X-Room-Key'], 'b'.repeat(64));
});

test('cache is keyed by host identity across endpoint changes and explicit cleanup removes bytes', async () => {
  const env = setup(); const original = { ...group(), hostDeviceId: 'stable-host' };
  const first = await env.manager.receive(original, message); await settle(env.manager, first);
  const second = await env.manager.receive({ ...original, baseUrl: 'http://192.168.1.7:9999' }, message); await settle(env.manager, second);
  assert.equal(env.downloads.length, 1);
  await env.manager.cleanCache(true);
  assert.equal([...env.files.keys()].some(uri => uri.includes('/received/')), false);
});

test('startup recovers incomplete draft as a removable orphan, never automatically sends it', async () => {
  const env = setup(), id = randomUUID();
  env.files.set(`file:///documents/PickDrop/drafts/${id}/payload/recovered.txt`, content);
  const restored = new env.Manager(); await restored.restoreDrafts([]);
  assert.equal(restored.getSnapshot()[0].name, 'recovered.txt');
  assert.equal(restored.getSnapshot()[0].status, 'orphaned');
  await restored.start(id); assert.equal(env.uploads.length, 0);
  await restored.remove(id);
  assert.equal([...env.files.keys()].some(uri => uri.includes(id)), false);
});

test('cache sweeper expires old entries and recovers partial files without deleting drafts', async () => {
  const env = setup();
  const id = await env.manager.receive(group(), message); await settle(env.manager, id);
  const meta = [...env.files.keys()].find(uri => uri.endsWith('/cache.json'));
  const folder = meta.slice(0, -'cache.json'.length);
  env.files.set(meta, Buffer.from(JSON.stringify({ size: content.length, touched: Date.now() - 8 * 86400000 })));
  env.files.set(folder + '.partial-interrupted', content);
  await env.manager.importIncoming(group(), [{ uri: 'content://source', name: 'draft.txt' }]);
  await env.manager.cleanCache();
  assert.equal([...env.files.keys()].some(uri => uri.includes('/received/')), false);
  assert.equal([...env.files.keys()].some(uri => uri.endsWith('/payload/draft.txt')), true);
});


test('native export holds a file lease: JS cancel is ignored and cleanup waits for system cancellation', async () => {
  const env = setup(); let finish;
  env.state.saveHandler = () => new Promise(resolve => { finish = resolve; });
  const id = await env.manager.receive(group(), message);
  for (let tick = 0; tick < 100 && !finish; tick++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(typeof finish, 'function');
  const source = env.manager.getSnapshot().find(item => item.id === id).localUri;
  await env.manager.cancel(id);
  assert.equal(env.manager.getSnapshot().find(item => item.id === id).status, 'saving');
  await env.manager.cleanCache(true);
  assert.equal(env.files.has(source), true, 'the native exporter still owns this source');
  finish({ saved: false });
  for (let tick = 0; tick < 100 && env.manager.getSnapshot().find(item => item.id === id).status === 'saving'; tick++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(env.manager.getSnapshot().find(item => item.id === id).status, 'save-cancelled');
  await env.manager.cleanCache(true);
  assert.equal(env.files.has(source), false, 'system cancellation releases the source lease');
});


test('a download waits for an in-progress cache sweep before opening its source directory', async () => {
  const env = setup(); const readDirectory = env.fs.readDirectoryAsync;
  let release, entered; const scanning = new Promise(resolve => { entered = resolve; }); let held = false;
  env.fs.readDirectoryAsync = async root => {
    if (root === 'file:///cache/PickDrop/received/' && !held) {
      held = true; entered(); await new Promise(resolve => { release = resolve; });
    }
    return readDirectory(root);
  };
  const sweep = env.manager.cleanCache(true); await scanning;
  const id = await env.manager.receive(group(), message);
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(env.downloads.length, 0, 'native download must not race deletion');
  release(); await sweep;
  assert.equal((await settle(env.manager, id)).status, 'completed');
  assert.equal(env.downloads.length, 1);
});


test('receive deduplicates a cancelled request until native download actually settles', async () => {
  const env = setup(); let release;
  env.state.downloadHandler = () => new Promise(resolve => { release = resolve; });
  const first = await env.manager.receive(group(), message);
  for (let tick = 0; tick < 100 && !release; tick++) await new Promise(resolve => setTimeout(resolve, 1));
  env.files.set(env.downloads[0].uri, content);
  await env.manager.cancel(first);
  const duplicate = await env.manager.receive(group(), message);
  assert.equal(duplicate, first); assert.equal(env.downloads.length, 1);
  await env.manager.cleanCache(true);
  assert.equal(env.files.has(env.downloads[0].uri), true, 'cancelled status does not release native file ownership');
  release(); await env.manager.start(first); env.state.downloadHandler = undefined;
  const next = await env.manager.receive(group(), message);
  assert.notEqual(next, first); assert.equal((await settle(env.manager, next)).status, 'completed');
  assert.equal(env.downloads.length, 2);
});

test('retry of an old save failure queues behind a new receive of the same file', async () => {
  const env = setup(); env.state.saveError = true;
  const old = await env.manager.receive(group(), message); await settle(env.manager, old);
  env.state.saveError = false; let release;
  env.state.saveHandler = () => new Promise(resolve => { release = resolve; });
  const next = await env.manager.receive(group(), message);
  for (let tick = 0; tick < 100 && !release; tick++) await new Promise(resolve => setTimeout(resolve, 1));
  const retry = env.manager.retry(old);
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(env.state.exported.length, 2, 'only the new receive owns the native export');
  const source = env.manager.getSnapshot().find(item => item.id === next).localUri;
  await env.manager.cleanCache(true); assert.equal(env.files.has(source), true);
  env.state.saveHandler = undefined; release({ saved: true, destination: '文件' });
  await retry;
  assert.equal(env.manager.getSnapshot().find(item => item.id === old).status, 'completed');
  assert.equal(env.manager.getSnapshot().find(item => item.id === next).status, 'completed');
  assert.equal(env.downloads.length, 1);
});

// Received filenames and cache bookkeeping must occupy separate namespaces.
test('cache.json and .partial-* user payloads survive export, cache sweeping, and retry', async () => {
  const env = setup();
  for (const name of ['cache.json', '.partial-user-photo.png', 'payload']) {
    const file = { ...message, id: name, fileName: name };
    const id = await env.manager.receive(group(), file);
    const item = await settle(env.manager, id);
    assert.equal(item.status, 'completed');
    assert.ok(item.localUri.endsWith('/payload/' + name));
    assert.deepEqual(env.files.get(item.localUri), content);
    await env.manager.cleanCache();
    assert.deepEqual(env.files.get(item.localUri), content);
    const again = await env.manager.receive(group(), file, 'share');
    assert.equal((await settle(env.manager, again)).status, 'completed');
    assert.deepEqual(env.files.get(env.shared.at(-1)), content);
  }
  assert.equal(env.downloads.length, 3, 'repeat exports reuse verified payloads');
});

test('legacy cache.json collision is ignored and freshly verified bytes are exported', async () => {
  const env = setup();
  const file = { ...message, fileName: 'cache.json' };
  const host = createHash('sha256').update(group().id + '\n' + group().baseUrl).digest('hex');
  const id = createHash('sha256').update(file.id).digest('hex');
  const folder = `file:///cache/PickDrop/received/${host}/${id}/`;
  env.files.set(folder + 'cache.json', Buffer.from(JSON.stringify({ size: content.length, touched: Date.now() })));
  const saved = await env.manager.receive(group(), file);
  assert.equal((await settle(env.manager, saved)).status, 'completed');
  assert.equal(env.downloads.length, 1);
  assert.deepEqual(env.files.get(env.state.exported[0].uri), content);
});

test('different files queue native save and share panels and waiting saves are cancellable', async () => {
  const env = setup(); let finish;
  env.state.saveHandler = () => new Promise(resolve => { finish = resolve; });
  const first = await env.manager.receive(group(), { ...message, id: 'first' });
  for (let tick = 0; tick < 100 && !finish; tick++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(typeof finish, 'function');
  const second = await env.manager.receive(group(), { ...message, id: 'second' });
  const third = await env.manager.receive(group(), { ...message, id: 'third' }, 'share');
  for (let tick = 0; tick < 100 && !env.manager.getSnapshot().find(item => item.id === third).localUri; tick++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(env.state.exported.length, 1);
  assert.equal(env.shared.length, 0);
  await env.manager.cancel(second);
  await env.manager.cleanCache(true);
  const firstUri = env.manager.getSnapshot().find(item => item.id === first).localUri;
  assert.deepEqual(env.files.get(firstUri), content);
  finish({ saved: true, destination: '文件' });
  assert.equal((await settle(env.manager, third)).status, 'completed');
  assert.equal(env.state.exported.length, 1, 'cancelled waiting panel must never open');
  assert.equal(env.shared.length, 1);
  assert.equal(env.manager.getSnapshot().find(item => item.id === second).status, 'cancelled');
});

test('image preview verifies local bytes without exporting, holds display lease, and reuses save cache', async () => {
  const env = setup();
  const image = { ...message, fileName: 'photo.png', mime: 'image/png' };
  const preview = await env.manager.previewImage(group(), image);
  assert.ok(preview.uri.startsWith('file:///cache/'));
  assert.equal(preview.uri.includes(group().key), false);
  assert.deepEqual(env.files.get(preview.uri), content);
  assert.equal(env.shared.length, 0); assert.equal(env.state.exported.length, 0);
  assert.deepEqual(env.manager.getSnapshot(), [], 'background previews do not appear as saved transfers');
  await env.manager.cleanCache(true);
  assert.deepEqual(env.files.get(preview.uri), content, 'displayed preview owns a cache lease');
  const saved = await env.manager.receive(group(), image);
  assert.equal((await settle(env.manager, saved)).status, 'completed');
  assert.equal(env.downloads.length, 1);
  preview.release(); preview.release();
  await env.manager.cleanCache(true);
  assert.equal(env.files.has(preview.uri), false);
});

test('preview rejects corrupt bytes, unsupported formats and oversized originals without export', async () => {
  const env = setup(), image = { ...message, mime: 'image/png' };
  await assert.rejects(env.manager.previewImage(group(), { ...image, size: 8 * 1024 * 1024 + 1 }), /不支持预览/);
  await assert.rejects(env.manager.previewImage(group(), { ...image, mime: 'image/svg+xml' }), /不支持预览/);
  assert.equal(env.downloads.length, 0);
  env.state.corrupt = true;
  await assert.rejects(env.manager.previewImage(group(), image), /文件内容不完整/);
  assert.equal(env.state.exported.length, 0); assert.equal(env.shared.length, 0);
  assert.equal([...env.files.keys()].some(key => key.includes('.partial-')), false);
  env.state.corrupt = false;
  const preview = await env.manager.previewImage(group(), image);
  assert.deepEqual(env.files.get(preview.uri), content); preview.release();
});

test('preview abort cancels active and queued work and releases completed display leases', async () => {
  const env = setup(), image = { ...message, mime: 'image/png' };
  let unblock;
  env.state.downloadHandler = () => new Promise(resolve => { unblock = resolve; });
  const firstController = new AbortController(), secondController = new AbortController();
  const first = env.manager.previewImage(group(), image, firstController.signal);
  const firstRejected = assert.rejects(first, /已取消/);
  for (let tick = 0; tick < 100 && !unblock; tick++) await new Promise(resolve => setTimeout(resolve, 1));
  const second = env.manager.previewImage(group(), { ...image, id: 'next-image' }, secondController.signal);
  const secondRejected = assert.rejects(second, /已取消/);
  secondController.abort(); firstController.abort(); unblock();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(env.downloads.length, 1, 'queued cancelled previews never start a request');
  assert.equal([...env.files.keys()].some(key => key.includes('.partial-')), false);
  env.state.downloadHandler = undefined;
  const controller = new AbortController();
  const preview = await env.manager.previewImage(group(), image, controller.signal);
  controller.abort(); await env.manager.cleanCache(true);
  assert.equal(env.files.has(preview.uri), false);
});

test('legacy flat cache is verified and moved without duplicated bytes or redownload', async () => {
  const env = setup();
  const host = createHash('sha256').update(group().id + '\n' + group().baseUrl).digest('hex');
  const id = createHash('sha256').update(message.id).digest('hex');
  const folder = `file:///cache/PickDrop/received/${host}/${id}/`;
  env.files.set(folder + message.fileName, content);
  env.files.set(folder + 'cache.json', Buffer.from(JSON.stringify({ size: content.length, touched: Date.now() })));
  const saved = await env.manager.receive(group(), message);
  assert.equal((await settle(env.manager, saved)).status, 'completed');
  assert.equal(env.downloads.length, 0);
  assert.equal(env.files.has(folder + message.fileName), false);
  assert.deepEqual(env.files.get(env.state.exported[0].uri), content);
});

test('explicit save waits for the same-file preview verification and reuses its bytes', async () => {
  const env = setup(), image = { ...message, mime: 'image/png' }; let unblock;
  env.state.downloadHandler = () => new Promise(resolve => { unblock = resolve; });
  const previewing = env.manager.previewImage(group(), image);
  for (let tick = 0; tick < 100 && !unblock; tick++) await new Promise(resolve => setTimeout(resolve, 1));
  const id = await env.manager.receive(group(), image);
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(env.downloads.length, 1); assert.equal(env.state.exported.length, 0);
  unblock(); const preview = await previewing;
  assert.equal((await settle(env.manager, id)).status, 'completed');
  assert.equal(env.downloads.length, 1); assert.equal(env.state.exported.length, 1);
  preview.release();
});
