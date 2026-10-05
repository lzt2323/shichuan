import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageDrafts, imageFiles, createImagePasteHandler, MAX_IMAGE_BYTES } from '../apps/desktop/public/clipboard-images.js';

const picture = () => new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
function event({ files = [], text = '', html = '' } = {}) {
  return { prevented: false, preventDefault() { this.prevented = true; }, clipboardData: { items: files.map(file => ({ kind: 'file', getAsFile: () => file })), files, getData: type => type === 'text/plain' ? text : html } };
}
test('image paste uses event image once, suppresses rich text and never reads native clipboard', async () => {
  const file = picture(), e = event({ files: [file], text: 'image URL' }); let staged, reads = 0;
  assert.deepEqual(imageFiles(e.clipboardData), [file]);
  const handle = createImagePasteHandler({ canPaste: () => true, context: () => 'group', readNative: () => { reads++; }, onImages: files => { staged = files; }, onError: assert.fail });
  assert.equal(await handle(e), true); assert.equal(e.prevented, true); assert.deepEqual(staged, [file]); assert.equal(reads, 0);
});
test('text, HTML, file paths and other input contexts preserve ordinary paste', async () => {
  let read = 0, images = 0;
  const handle = createImagePasteHandler({ canPaste: e => !e.dialog, context: () => 'group', readNative: () => { read++; }, onImages: () => { images++; }, onError: assert.fail });
  for (const e of [event({ text: 'hello' }), event({ html: '<p>hello</p>' }), event({ files: [new File(['file'], 'doc.txt', { type: 'text/plain' })] }), { ...event({ files: [picture()] }), dialog: true }]) {
    assert.equal(await handle(e), false); assert.equal(e.prevented, false);
  }
  assert.equal(read, 0); assert.equal(images, 0);
});
test('native paste result is staged as PNG but ignored after room or dialog change', async () => {
  let group = 'a', resolve, staged = 0, allowed = true;
  const handle = createImagePasteHandler({ canPaste: () => allowed, context: () => group, readNative: () => new Promise(r => { resolve = r; }), onImages: files => { assert.equal(files[0].type, 'image/png'); staged++; }, onError: assert.fail });
  const first = handle(event()); resolve({ bytes: new Uint8Array([1]), mimeType: 'image/png' }); assert.equal(await first, true);
  const second = handle(event()); group = 'b'; resolve({ bytes: new Uint8Array([1]), mimeType: 'image/png' }); assert.equal(await second, false);
  const third = handle(event()); allowed = false; resolve({ bytes: new Uint8Array([1]), mimeType: 'image/png' }); assert.equal(await third, false); assert.equal(staged, 1);
});
test('draft images receive unique names, remain for retry and release previews on removal', () => {
  const revoked = []; let n = 0;
  const drafts = new ImageDrafts({ createObjectURL: () => `blob:${++n}`, revokeObjectURL: url => revoked.push(url) });
  drafts.add([picture(), picture()]); assert.equal(drafts.items.length, 2); assert.notEqual(drafts.items[0].file.name, drafts.items[1].file.name);
  assert.equal(drafts.items[0].file.type, 'image/png'); assert.equal(drafts.items[0].file.size, 3);
  const failed = drafts.items[1]; drafts.remove(drafts.items[0].id); assert.deepEqual(drafts.items, [failed]); assert.deepEqual(revoked, ['blob:1']);
  drafts.clear(); assert.deepEqual(revoked, ['blob:1', 'blob:2']); assert.equal(drafts.items.length, 0);
});
test('draft bounds reject empty, oversized and excess image batches without losing existing drafts', () => {
  const drafts = new ImageDrafts({ createObjectURL: () => 'blob:demo', revokeObjectURL() {} }); drafts.add([picture()]);
  assert.throws(() => drafts.add([new File([], 'empty.png', { type: 'image/png' })]), /为空/);
  assert.throws(() => drafts.add([{ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }]), /32 MB/);
  assert.throws(() => drafts.add(Array.from({ length: 10 }, picture)), /10 张/); assert.equal(drafts.items.length, 1);
});
