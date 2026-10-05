import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readClipboardImage, MAX_CLIPBOARD_IMAGE_BYTES } = require('../apps/desktop/clipboard-image.cjs');
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const image = bytes => ({ isEmpty: () => false, toPNG: () => bytes });
const item = (types, payload = new Blob([png])) => ({ types, getType: async () => payload });

test('Electron 44 clipboard API returns only PNG bytes and prefers PNG over other representations', async () => {
  const retrieved = [];
  const payload = await readClipboardImage({ read: async () => [{ types: ['text/plain', 'image/jpeg', 'image/png'], async getType(type) { retrieved.push(type); return new Blob([png]); } }] }, {
    createFromBuffer(bytes) { assert.deepEqual(bytes, png); return image(png); },
  });
  assert.deepEqual(retrieved, ['image/png']);
  assert.deepEqual(payload, { bytes: Uint8Array.from(png), mimeType: 'image/png' });
  assert.equal(Buffer.isBuffer(payload.bytes), false);
  assert.notEqual(payload.bytes.buffer, png.buffer, 'the IPC payload owns its byte range');
});

test('copied file formats suppress thumbnails without fetching native file paths or image payloads', async () => {
  for (const format of ['text/uri-list', 'public.file-url', 'NSFilenamesPboardType', 'electron application/osclipboard;format="public.file-url"', 'electron application/osclipboard;format="NSFilenamesPboardType"', 'CF_HDROP', 'FileGroupDescriptorW']) {
    const entry = { types: [format, 'image/png'], getType() { assert.fail('file-reference payloads must not be fetched'); } };
    assert.equal(await readClipboardImage({ read: async () => [entry] }, {}), null, format);
    assert.equal(await readClipboardImage({ availableFormats: () => [format, 'image/png'], readImage() { assert.fail('Finder thumbnails must not be read'); } }, {}), null, format);
  }
});

test('Windows screenshot formats use the normalized PNG and never decode raw DIB data', async () => {
  const retrieved = [];
  const types = ['electron application/osclipboard;format="CF_DIBV5"', 'electron application/osclipboard;format="PNG"', 'image/png', 'text/html'];
  const payload = await readClipboardImage({ read: async () => [{ types, async getType(type) { retrieved.push(type); assert.equal(type, 'image/png'); return new Blob([png]); } }] }, { createFromBuffer: bytes => { assert.deepEqual(bytes, png); return image(png); } });
  assert.deepEqual(retrieved, ['image/png']);
  assert.deepEqual(payload, { bytes: Uint8Array.from(png), mimeType: 'image/png' });
  const rawOnly = { types: ['electron application/osclipboard;format="CF_DIB"'], getType() { assert.fail('raw DIB is not an encoded image file'); } };
  assert.equal(await readClipboardImage({ read: async () => [rawOnly] }, {}), null);
  for (const bitmapFormat of ['CF_DIB', 'CF_DIBV5']) {
    assert.deepEqual(await readClipboardImage({ availableFormats: () => [bitmapFormat], readImage: () => image(png) }, {}), { bytes: Uint8Array.from(png), mimeType: 'image/png' });
  }
});

test('Windows Explorer file references override image previews across all clipboard items', async () => {
  const fileTypes = ['CF_HDROP', 'FileName', 'FileNameW', 'FileGroupDescriptor', 'FileGroupDescriptorW'];
  for (const fileType of fileTypes) {
    for (const format of [fileType, `electron application/osclipboard;format="${fileType}"`]) {
      const entries = [
        { types: ['image/png'], getType() { assert.fail('Explorer image preview must not be returned as a screenshot'); } },
        { types: [format], getType() { assert.fail('Windows file paths must never be retrieved'); } },
      ];
      assert.equal(await readClipboardImage({ read: async () => entries }, {}), null, format);
      assert.equal(await readClipboardImage({ availableFormats: () => ['image/png', format], readImage() { assert.fail('copied files take precedence on older Electron too'); } }, {}), null, format);
    }
  }
});

test('text, empty clipboard and undecodable images return null; clipboard errors propagate', async () => {
  assert.equal(await readClipboardImage({ read: async () => [] }, {}), null);
  assert.equal(await readClipboardImage({ read: async () => [item(['text/plain'])] }, {}), null);
  assert.equal(await readClipboardImage({ read: async () => [item(['image/png'], new Blob())] }, {}), null);
  assert.equal(await readClipboardImage({ read: async () => [item(['image/png'])] }, { createFromBuffer: () => ({ isEmpty: () => true }) }), null);
  await assert.rejects(readClipboardImage({ read: async () => { throw new Error('permission denied'); } }, {}), /permission denied/);
});

test('native fallback enforces 32 MiB before decoding and after PNG conversion', async () => {
  const oversized = { size: MAX_CLIPBOARD_IMAGE_BYTES + 1, arrayBuffer() { assert.fail('oversized blob must not be allocated'); } };
  await assert.rejects(readClipboardImage({ read: async () => [item(['image/png'], oversized)] }, {}), /32 MiB/);
  const nativeImage = { createFromBuffer: () => image(Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 1)) };
  await assert.rejects(readClipboardImage({ read: async () => [item(['image/jpeg'])] }, nativeImage), /32 MiB/);
  await assert.rejects(readClipboardImage({ availableFormats: () => ['image/png'], readImage: () => image(Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 1)) }, {}), /32 MiB/);
});

test('legacy native image clipboard remains supported and never returns empty PNG data', async () => {
  assert.deepEqual(await readClipboardImage({ availableFormats: () => ['public.tiff'], readImage: () => image(png) }, {}), { bytes: Uint8Array.from(png), mimeType: 'image/png' });
  assert.equal(await readClipboardImage({ availableFormats: () => [], readImage: () => ({ isEmpty: () => true }) }, {}), null);
  assert.equal(await readClipboardImage({ availableFormats: () => ['image/png'], readImage: () => image(Buffer.alloc(0)) }, {}), null);
});

test('clipboard IPC applies the existing known-window, main-frame and UI-origin trust boundary', async () => {
  let reads = 0;
  const handlers = new Map();
  const mainFrame = { url: 'http://127.0.0.1:12345/' };
  const sender = { mainFrame };
  const trusted = { win: { isDestroyed: () => false, webContents: sender } };
  const electron = {
    app: { setName() {}, setPath() {}, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on() {} },
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback), on() {} },
    nativeImage: { createFromPath() {}, createFromBuffer: () => image(png) },
    clipboard: { read: async () => { reads++; return [item(['image/png'])]; } },
  };
  const mainRequire = createRequire(new URL('../apps/desktop/main.cjs', import.meta.url));
  const context = vm.createContext({ require: name => name === 'electron' ? electron : mainRequire(name), __dirname: path.resolve('apps/desktop'), process: { env: {} }, console, URL, __trusted: trusted });
  const source = await readFile(new URL('../apps/desktop/main.cjs', import.meta.url), 'utf8');
  vm.runInContext(source + '\nuiOrigin = "http://127.0.0.1:12345"; windows.set("test", __trusted); registerIPC();', context);
  const handler = handlers.get('app:clipboard-image');
  assert.equal(typeof handler, 'function');
  assert.equal(reads, 0, 'registering the IPC endpoint must not read the clipboard');
  for (const event of [{ sender: { mainFrame }, senderFrame: mainFrame }, { sender, senderFrame: { url: mainFrame.url } }]) await assert.rejects(handler(event), /Invalid sender/);
  mainFrame.url = 'https://untrusted.example/';
  await assert.rejects(handler({ sender, senderFrame: mainFrame }), /Invalid sender/);
  assert.equal(reads, 0);
  mainFrame.url = 'http://127.0.0.1:12345/';
  assert.equal((await handler({ sender, senderFrame: mainFrame })).mimeType, 'image/png');
  assert.equal(reads, 1);
});
