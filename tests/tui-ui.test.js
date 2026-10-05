import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { App } from '../apps/tui/ui.js';
import { modeLines } from '../apps/tui/view.js';
import { limitText, messageLines } from '../apps/tui/layout.js';
import QRCode from 'qrcode';

// Resolve the real runtime from the TUI workspace, without another test renderer.
const requireTui = createRequire(new URL('../apps/tui/package.json', import.meta.url));
const { default: React } = await import(requireTui.resolve('react'));
const { render } = await import(requireTui.resolve('ink'));
const { default: stringWidth } = await import(requireTui.resolve('string-width'));
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const keys = { menu: '\x10', files: '\x0f', groups: '\x07', down: '\x1b[B', enter: '\r', escape: '\x1b' };

function snapshot(group = 'a') {
  return {
    selectedGroupId: group,
    device: { id: 'self', name: 'linux-test' },
    groups: [
      { id: 'a', name: '设计资料', local: true, online: true },
      { id: 'b', name: '发布构建', local: false, online: true },
    ],
    network: { selected: { name: 'eth0', address: '192.168.1.28' } },
    state: {
      devices: [{ id: 'self', name: 'linux-test', online: true }, { id: 'phone', name: '我的手机', online: true }],
      messages: Array.from({ length: 12 }, (_, i) => ({
        id: `message-${group}-${i}`, type: i % 2 ? 'file' : 'text', senderId: 'phone', senderName: '我的手机',
        createdAt: '2026-10-05T11:00:00Z', size: 1234567,
        fileName: `中文设计资料-👨‍👩‍👧‍👦-${'文件名很长'.repeat(20)}-${i}.zip`,
        text: `正文-${group}-${i} ${'中文消息🙂 abc '.repeat(24)}\n换行后的内容`,
      })),
    },
    transfers: [
      { id: 'a-running', groupId: 'a', name: '本群上传.zip', status: 'running', bytes: 68, total: 100, direction: 'upload' },
      { id: 'a-failed', groupId: 'a', name: '校验失败.zip', status: 'failed', bytes: 50, total: 100, error: 'SHA-256 不匹配' },
      { id: 'b-running', groupId: 'b', name: 'OTHER_GROUP_SECRET.zip', status: 'running', bytes: 3, total: 100 },
    ],
    requests: group === 'a' ? [{ id: 'approval-1', device: { name: '新手机' } }] : [],
    joins: [{ id: 'join-1', status: 'pending' }],
  };
}

async function mount(t, columns = 80, rows = 24, options = {}) {
  const frames = [], calls = [];
  const stdout = new Writable({ write(chunk, _, callback) {
    const frame = stripVTControlCharacters(chunk.toString());
    if (frame.trim()) frames.push(frame);
    callback();
  } });
  Object.assign(stdout, { columns, rows, isTTY: true });
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const initialSnapshot = options.snapshot || snapshot();
  const request = async (method, params = {}) => {
    calls.push({ method, params });
    if (options.request) {
      const value = await options.request(method, params);
      if (value !== undefined) return value;
    }
    if (method === 'snapshot') return options.snapshot || snapshot(params.group || 'a');
    if (method === 'browse') return [
      { name: '报告.pdf', path: '/test/报告.pdf', directory: false },
      { name: '图像.png', path: '/test/图像.png', directory: false },
    ];
    if (method === 'invite') return {
      code: '123456', expiresAt: '2026-10-05T12:00:00Z',
      link: 'http://192.168.1.28:50000/#invite=123456&group=11111111-2222-3333-4444-555555555555',
    };
    if (method === 'nearby') return [{ name: '附近测试群', baseUrl: 'http://192.168.1.9:50000', groupId: 'nearby-a' }];
    return [];
  };
  const app = render(React.createElement(App, { persistent: true, request, initialSnapshot, refreshInterval: 60000, ...options.appProps }), {
    stdout, stdin, stderr: stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  let exited = false;
  void app.waitUntilExit().then(() => { exited = true; });
  t.after(() => { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); });
  await pause();
  return {
    calls, frames, exited: () => exited,
    frame: () => frames.at(-1) || '',
    async key(value) { stdin.write(value); await pause(); },
    async resize(width, height) { stdout.columns = width; stdout.rows = height; stdout.emit('resize'); await pause(); },
  };
}

function fits(frame, columns, rows) {
  const lines = frame.replace(/\n$/, '').split('\n');
  assert.ok(lines.length <= rows, `${columns}x${rows}: ${lines.length} rendered rows\n${frame}`);
  for (const line of lines) assert.ok(stringWidth(line) <= columns, `${columns} columns exceeded by ${stringWidth(line)}: ${line}`);
  assert.doesNotMatch(frame, /�/, 'Unicode must not be split into replacement characters');
}

async function action(ui, index) {
  await ui.key(keys.menu);
  for (let i = 0; i < index; i++) await ui.key(keys.down);
  await ui.key(keys.enter);
}

for (const [columns, rows] of [[160, 40], [120, 30], [80, 24], [60, 18], [140, 26], [139, 26], [100, 26], [99, 26], [160, 25]]) {
  test(`real Ink frame fits ${columns}x${rows} with CJK/emoji and status alerts`, async t => {
    const ui = await mount(t, columns, rows);
    fits(ui.frame(), columns, rows);
    const panels = columns >= 100 && rows >= 26 ? columns >= 140 ? 3 : 2 : 1;
    assert.equal((ui.frame().split('\n')[2].match(/┌/g) || []).length, panels, 'responsive panel count');
    assert.match(ui.frame(), /输入消息/);
    assert.match(ui.frame(), /Ctrl\+P/);
    assert.match(ui.frame(), /Ctrl\+O/);
    assert.match(ui.frame(), /Ctrl\+G/);
    assert.match(ui.frame(), /审批|批准|申请/);
    assert.match(ui.frame(), /失败/);
    assert.doesNotMatch(ui.frame(), /OTHER_GROUP_SECRET/);
  });
}

test('resize updates an already mounted app without a snapshot tick and preserves draft', async t => {
  const ui = await mount(t, 160, 40);
  await ui.key('草稿🙂');
  for (const [width, height] of [[120, 30], [80, 24], [60, 18], [160, 40]]) {
    await ui.resize(width, height);
    fits(ui.frame(), width, height);
    assert.equal((ui.frame().split('\n')[2].match(/┌/g) || []).length, width >= 140 ? 3 : width >= 100 ? 2 : 1);
    assert.match(ui.frame(), /草稿🙂/);
    assert.match(ui.frame(), /Ctrl\+P/);
  }
  await ui.key(keys.enter);
  assert.deepEqual(ui.calls.find(c => c.method === 'text')?.params, { group: 'a', text: '草稿🙂' });
});

test('file picker supports multi-select and Ctrl+S on a narrow screen', async t => {
  const ui = await mount(t, 60, 18);
  await ui.key(keys.files);
  fits(ui.frame(), 60, 18);
  assert.match(ui.frame(), /linux-test/);
  assert.match(ui.frame(), /Ctrl\+S/);
  // The picker adds a parent directory when browsing a directory.
  await ui.key(keys.down);
  await ui.key(' ');
  await ui.key(keys.down);
  await ui.key(' ');
  await ui.key('\x13');
  assert.deepEqual(ui.calls.find(c => c.method === 'send')?.params, { group: 'a', files: ['/test/报告.pdf', '/test/图像.png'] });
  assert.match(ui.frame(), /输入消息/);
});

test('switching groups isolates task menus and task commands', async t => {
  const ui = await mount(t, 80, 24);
  await action(ui, 8);
  assert.match(ui.frame(), /本群上传|校验失败/);
  assert.doesNotMatch(ui.frame(), /OTHER_GROUP_SECRET/);
  await ui.key('c');
  assert.deepEqual(ui.calls.find(c => c.method === 'cancel')?.params, { id: 'a-running' });
  await ui.key(keys.down);
  await ui.key('r');
  assert.deepEqual(ui.calls.find(c => c.method === 'retry')?.params, { id: 'a-failed' });
  await ui.key(keys.groups);
  await ui.key(keys.down);
  await ui.key(keys.enter);
  await action(ui, 8);
  assert.match(ui.frame(), /OTHER_GROUP_SECRET/);
  assert.doesNotMatch(ui.frame(), /本群上传|校验失败/);
});

test('approval and both join paths keep existing RPC semantics', async t => {
  const ui = await mount(t, 80, 24);
  await action(ui, 7);
  assert.match(ui.frame(), /新手机/);
  await ui.key(keys.enter);
  assert.deepEqual(ui.calls.find(c => c.method === 'respond')?.params, { group: 'a', requestId: 'approval-1', allow: true });
  await ui.key('d');
  assert.deepEqual(ui.calls.filter(c => c.method === 'respond').at(-1)?.params, { group: 'a', requestId: 'approval-1', allow: false });
  await action(ui, 2);
  const link = 'http://192.168.1.9:50000/#invite=123456&group=nearby-a';
  await ui.key(link);
  await ui.key(keys.enter);
  assert.deepEqual(ui.calls.find(c => c.method === 'join')?.params, { link });
  await action(ui, 1);
  await ui.key(keys.enter);
  await ui.key('654321');
  await ui.key(keys.enter);
  assert.deepEqual(ui.calls.filter(c => c.method === 'join').at(-1)?.params, { address: 'http://192.168.1.9:50000', code: '654321', expectedGroupId: 'nearby-a' });
});

test('narrow invitation view keeps every link character available', async t => {
  const ui = await mount(t, 60, 18);
  await action(ui, 3);
  fits(ui.frame(), 60, 18);
  const text = ui.frame().replace(/[\s│┃║]/gu, '');
  assert.ok(text.includes('http://192.168.1.28:50000/#invite=123456&group=11111111-2222-3333-4444-555555555555'), ui.frame());
});

test('download destination is prefilled from the last successful saved directory', async t => {
  const saved = snapshot();
  saved.preferences = { downloadDirectory: '/mnt/shared/上次下载目录' };
  const ui = await mount(t, 80, 24, { snapshot: saved });
  await action(ui, 6);
  await ui.key(keys.enter);
  assert.match(ui.frame(), /\/mnt\/shared\/上次下载目录/);
  await ui.key(keys.enter);
  assert.equal(ui.calls.find(c => c.method === 'receive')?.params.directory, '/mnt/shared/上次下载目录');
});

test('empty initial state retains onboarding and the create action', async t => {
  const empty = { groups: [], state: { messages: [], devices: [] }, transfers: [], requests: [], joins: [] };
  const ui = await mount(t, 60, 18, {
    snapshot: empty,
    request: async method => method === 'create' ? { id: 'new-group' } : undefined,
  });
  fits(ui.frame(), 60, 18);
  assert.match(ui.frame(), /创建|加入/);
  assert.match(ui.frame(), /Ctrl\+P/);
  await action(ui, 0);
  await ui.key('新建中文群');
  await ui.key(keys.enter);
  assert.deepEqual(ui.calls.find(c => c.method === 'create')?.params, { name: '新建中文群' });
});

test('long invitation content can be paged on a short terminal and Esc returns to chat', async t => {
  const ui = await mount(t, 60, 18, {
    request: async method => method === 'invite' ? {
      code: '123456', expiresAt: '2026-10-05T12:00:00Z',
      link: `http://192.168.1.28:50000/#invite=123456&group=${'a'.repeat(900)}LINK-END`,
    } : undefined,
  });
  await action(ui, 3);
  assert.doesNotMatch(ui.frame(), /LINK-END/);
  let visible = ui.frame();
  for (let i = 0; i < 4; i++) {
    await ui.key('\x1b[6~');
    fits(ui.frame(), 60, 18);
    visible += ui.frame();
  }
  assert.match(visible, /LINK-END/);
  await ui.key(keys.escape);
  assert.match(ui.frame(), /输入消息/);
});

test('slow group refresh never shows or approves the previous group state under the new group', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release(snapshot('b')));
  const saved = snapshot();
  saved.state.messages = [{ id: 'old', type: 'text', senderName: 'old-device', createdAt: '2026-10-05T11:00:00Z', text: 'OLD_GROUP_MESSAGE' }];
  const ui = await mount(t, 80, 24, {
    snapshot: saved,
    request: async (method, params) => method === 'snapshot' && params.group === 'b' ? pending : undefined,
  });
  assert.match(ui.frame(), /OLD_GROUP_MESSAGE/);
  await ui.key(keys.groups);
  await ui.key(keys.down);
  await ui.key(keys.enter);
  assert.match(ui.frame(), /发布构建/);
  assert.doesNotMatch(ui.frame(), /OLD_GROUP_MESSAGE|old-device|设备待批准/);
  await action(ui, 7);
  assert.doesNotMatch(ui.frame(), /新手机/);
  await ui.key(keys.enter);
  assert.equal(ui.calls.filter(call => call.method === 'respond').length, 0);
  release(snapshot('b'));
  await pause();
});

test('invitation QR retains every quiet row, uses black on white, and hides as a whole on short screens', async t => {
  const target = { code: '123456', expiresAt: '2026-10-05T12:00:00Z', link: 'http://192.168.1.28:50000/#invite=123456&group=11111111-2222-3333-4444-555555555555' };
  const qr = await QRCode.toString(target.link, { type: 'utf8', margin: 4 });
  const sourceRows = qr.split('\n');
  const large = modeLines({ mode: 'invite', target, qr, width: 155, height: 50 });
  const qrRows = large.filter(row => row.qr);
  assert.deepEqual(qrRows.map(row => row.text), sourceRows, 'the QR must retain all leading/trailing quiet rows');
  assert.ok(sourceRows.slice(0, 2).every(row => !row.trim()));
  assert.ok(sourceRows.slice(-2).every(row => !row.trim()));
  assert.ok(qrRows.every(row => row.color === '#000000' && row.background === '#FFFFFF'));
  for (const [width, height] of [[55, 8], [155, large.length - 1], [10, 50]]) {
    const small = modeLines({ mode: 'invite', target, qr, width, height });
    assert.equal(small.filter(row => row.qr).length, 0, 'never show a cropped subset of the QR');
    assert.match(small.map(row => row.text).join(''), /完整链接/);
  }
  const ui = await mount(t, 160, 60);
  await action(ui, 3);
  fits(ui.frame(), 160, 60);
  const visibleQrRows = ui.frame().split('\n').filter(row => /[▄▀█]/u.test(row));
  assert.equal(visibleQrRows.length, sourceRows.filter(row => /[▄▀█]/u.test(row)).length);
  await ui.resize(60, 18);
  assert.doesNotMatch(ui.frame(), /[▄▀█]/u);
});

test('the 10000 UTF-16 input cap never cuts an emoji or combining grapheme', async t => {
  for (const cluster of ['🙂', 'e\u0301', '👨‍👩‍👧‍👦']) {
    const prefix = 'a'.repeat(10000 - cluster.length);
    assert.equal(limitText(prefix + cluster), prefix + cluster);
    assert.equal(limitText(prefix + 'a' + cluster), prefix + 'a');
  }
  const ui = await mount(t, 60, 18);
  await ui.key('a'.repeat(9999) + '🙂');
  await ui.key(keys.enter);
  assert.equal(ui.calls.find(call => call.method === 'text')?.params.text, 'a'.repeat(9999));
});

test('confirmed daemon disappearance exits and notifies once; transient RPC errors keep the UI open', async t => {
  let failure, stopped = 0;
  const ui = await mount(t, 80, 24, {
    appProps: { refreshInterval: 15, onDaemonStopped: () => { stopped++; } },
    request: async method => {
      if (method === 'snapshot' && failure) throw Object.assign(new Error('test connection error'), { code: failure });
      return undefined;
    },
  });
  failure = 'ETIMEDOUT';
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stopped, 0);
  assert.equal(ui.exited(), false);
  failure = 'ECONNREFUSED';
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stopped, 1);
  assert.equal(ui.exited(), true);
});

test('message display cache remains correct across cloned snapshots and edits with the same ID', () => {
  const message = { id: 'cache-regression', type: 'text', senderId: 'self', senderName: '原作者', createdAt: '2026-10-05T11:00:00Z', text: '初始内容' };
  const first = messageLines([message], 60, 'self');
  assert.deepEqual(messageLines([{ ...message }], 60, 'self'), first);
  message.text = '修改后的内容🙂';
  message.senderName = '新作者';
  const changed = messageLines([message], 60, 'self').map(row => row.text).join('\n');
  assert.match(changed, /新作者.*我/);
  assert.match(changed, /修改后的内容🙂/);
  assert.doesNotMatch(changed, /初始内容|原作者/);
  const narrow = messageLines([{ ...message }], 8, 'other');
  assert.ok(narrow.every(row => stringWidth(row.text) <= 8));
  assert.doesNotMatch(narrow.map(row => row.text).join('\n'), / · 我/);
});
