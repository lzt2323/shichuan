import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../apps/mobile/src/clipboard-images.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', source)(() => ({}), module, module.exports);
const { createClipboardPaster } = module.exports;
const png = readFileSync(new URL('../apps/desktop/assets/drag-icon.png', import.meta.url));
const image = { data: `data:image/png;base64,${png.toString('base64')}`, size: { width: 32, height: 32 } };
const group = { id: 'A', baseUrl: 'http://127.0.0.1', key: 'k', deviceId: 'phone' };
function setup() {
  const state = { image, rows: [], files: new Map(), imports: [], deleted: [], reads: 0, current: true };
  const deps = {
    clipboard: { getImageAsync: async () => { state.reads++; return state.image; } },
    fs: { cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' }, async writeAsStringAsync(uri, data, options) { assert.equal(options.encoding, 'base64'); state.files.set(uri, Buffer.from(data, 'base64')); }, async deleteAsync(uri) { state.files.delete(uri); state.deleted.push(uri); } },
    randomUUID: () => 'unique-id',
    transfers: { getSnapshot: () => state.rows, async importIncoming(target, assets) { state.imports.push({ target, assets }); state.rows.push({ id: 'draft', groupId: target.id, status: 'draft', mimeType: assets[0].mimeType, size: assets[0].size }); assert.deepEqual(state.files.get(assets[0].uri), png); return ['draft']; }, async remove(id) { state.rows = state.rows.filter(item => item.id !== id); } },
  };
  return { state, deps, paste: createClipboardPaster(deps), current: () => state.current };
}
test('clipboard image becomes a PNG draft for the captured group, not a network send; temporary copy is removed', async () => {
  const { state, paste, current } = setup();
  assert.equal(state.reads, 0);
  assert.equal(await paste(group, current), true);
  assert.equal(state.reads, 1); assert.equal(state.imports[0].target.id, 'A');
  assert.equal(state.rows[0].status, 'draft'); assert.equal(state.rows[0].size, png.length);
  assert.equal(state.files.size, 0); assert.equal(state.deleted.length, 1);
});
test('empty/text clipboard, native read rejection and malformed data produce useful errors and allow retry', async () => {
  const { state, deps, paste, current } = setup();
  state.image = null; await assert.rejects(paste(group, current), /没有图片/);
  state.image = { data: 'data:image/png;base64,%%%' }; await assert.rejects(paste(group, current), /损坏/);
  deps.clipboard.getImageAsync = async () => { throw Error('Permission denied'); };
  await assert.rejects(paste(group, current), /无法读取/);
  assert.equal(state.imports.length, 0);
  deps.clipboard.getImageAsync = async () => image;
  assert.equal(await paste(group, current), true);
});
test('Android Base64.DEFAULT line-wrapped output imports the exact original PNG bytes', async () => {
  for (const newline of ['\n', '\r\n']) {
    const { state, paste, current } = setup();
    state.image = { ...image, data: 'data:image/png;base64,' + png.toString('base64').match(/.{1,76}/g).join(newline) + newline };
    assert.equal(await paste(group, current), true);
    assert.equal(state.rows[0].size, png.length);
  }
});
test('group switch during clipboard read cancels import; simultaneous presses read only once', async () => {
  const { state, deps, paste, current } = setup(); let release;
  deps.clipboard.getImageAsync = async () => { state.reads++; return new Promise(resolve => { release = resolve; }); };
  const pending = paste(group, current);
  assert.equal(await paste(group, current), false);
  state.current = false; release(image);
  assert.equal(await pending, false); assert.equal(state.reads, 1); assert.equal(state.imports.length, 0);
});
test('navigation during copy/import removes temporary data and newly created drafts', async () => {
  for (const boundary of ['write', 'import']) {
    const { state, deps, paste, current } = setup();
    const object = boundary === 'write' ? deps.fs : deps.transfers;
    const method = boundary === 'write' ? 'writeAsStringAsync' : 'importIncoming';
    const original = object[method];
    object[method] = async (...args) => { const result = await original(...args); state.current = false; return result; };
    assert.equal(await paste(group, current), false);
    assert.equal(state.rows.length, 0); assert.equal(state.files.size, 0);
  }
});
test('failed storage/import leaves no clipboard temporary file; retry succeeds', async () => {
  const { state, deps, paste, current } = setup();
  const original = deps.transfers.importIncoming;
  deps.transfers.importIncoming = async () => { state.rows.push({ id: 'failed', status: 'failed' }); return ['failed']; };
  await assert.rejects(paste(group, current), /未能加入/);
  assert.equal(state.rows.length, 0); assert.equal(state.files.size, 0);
  deps.transfers.importIncoming = original;
  assert.equal(await paste(group, current), true);
});
test('limits reject oversized image and full current-group drafts before writing; other groups do not count', async () => {
  const { state, paste, current } = setup();
  state.image = { data: 'data:image/png;base64,' + 'A'.repeat(Math.ceil(32 * 1024 ** 2 / 3) * 4 + 4) };
  await assert.rejects(paste(group, current), /32 MiB/);
  state.image = image;
  state.rows = Array.from({ length: 10 }, (_, id) => ({ id, groupId: 'A', status: 'draft', mimeType: 'image/png', size: 1 }));
  await assert.rejects(paste(group, current), /10 张/);
  state.rows = [{ groupId: 'A', status: 'draft', size: 64 * 1024 ** 2 }];
  await assert.rejects(paste(group, current), /64 MiB/);
  assert.equal(state.files.size, 0); assert.equal(state.imports.length, 0);
  state.rows[0].groupId = 'B';
  assert.equal(await paste(group, current), true);
});
