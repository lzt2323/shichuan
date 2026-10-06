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
  const state = { corrupt: false, holdUpload: false, releaseUpload: null, pick: null };
  const fs = {
    documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/', FileSystemUploadType: { BINARY_CONTENT: 0 }, FileSystemSessionType: { FOREGROUND: 1 },
    async makeDirectoryAsync() {},
    async copyAsync({ from, to }) { if (!files.has(from)) throw new Error('No source'); files.set(to, Buffer.from(files.get(from))); },
    async moveAsync({ from, to }) { if (!files.has(from)) throw new Error('No source'); files.set(to, files.get(from)); files.delete(from); },
    async getInfoAsync(uri) { return files.has(uri) ? { exists: true, isDirectory: false, size: files.get(uri).length } : { exists: false }; },
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
      return { async downloadAsync() { const data = state.corrupt ? Buffer.alloc(content.length, 88) : content; files.set(uri, data); callback({ totalBytesWritten: data.length, totalBytesExpectedToWrite: data.length }); return { status: 200, uri }; }, async cancelAsync() {} };
    },
  };
  class File {
    constructor(uri) { this.uri = uri; }
    get exists() { return files.has(this.uri); }
    get size() { return files.get(this.uri)?.length || 0; }
    open() { const data = files.get(this.uri); let offset = 0; return { readBytes(length) { const bytes = data.subarray(offset, offset + length); offset += bytes.length; return bytes; }, close() {} }; }
  }
  const mocks = { 'expo-document-picker': { getDocumentAsync: async () => state.pick ? state.pick() : { canceled: true } }, 'expo-file-system/legacy': fs, 'expo-file-system': { File, FileMode: { ReadOnly: 'r' } }, 'expo-sharing': { isAvailableAsync: async () => true, shareAsync: async uri => shared.push(uri) }, 'expo-crypto': { randomUUID }, '../../../shared/protocol': protocol, './transfer-utils': utils };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => mocks[name] || mobileRequire(name), module, module.exports);
  return { manager: new module.exports.TransferManager(), Manager: module.exports.TransferManager, state, files, shared, uploads, downloads };
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
  const wrongCredential = new env.Manager(); await wrongCredential.restoreDrafts([{ ...transfer, key: 'b'.repeat(64) }]); assert.equal(wrongCredential.getSnapshot().length, 0);
  const wrongHost = new env.Manager(); await wrongHost.restoreDrafts([{ ...transfer, hostDeviceId: randomUUID() }]); assert.equal(wrongHost.getSnapshot().length, 0);
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
