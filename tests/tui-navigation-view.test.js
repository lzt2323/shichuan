import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { NavigationScreen, navigationPalette, messageDetailText } from '../apps/tui/navigation-view.js';
import { cells } from '../apps/tui/layout.js';
const requireTui = createRequire(new URL('../apps/tui/package.json', import.meta.url));
const { default: React } = await import(requireTui.resolve('react'));
const { render } = await import(requireTui.resolve('ink'));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
const messages = Array.from({ length: 18 }, (_, i) => ({ id: `m${i}`, type: 'file', fileName: `设计稿-${i}-👨‍👩‍👧‍👦-${'中文长文件名'.repeat(20)}.pdf`, senderName: '我的手机', senderId: 'other', size: 2048, createdAt: '2026-10-05T12:00:00Z' }));
const snapshot = { selectedGroupId: 'one', groups: [{ id: 'one', name: '设计资料', online: true }], device: { id: 'self', name: '我的服务器' }, state: { messages, devices: [] }, preferences: { downloadDirectory: '/home/中文/Downloads' }, transfers: [] };
const workspaceEntries = [{ id: 'one', kind: 'group', groupId: 'one', label: '设计资料' }, ...['compose', 'files', 'tasks', 'settings', 'more'].map(kind => ({ id: kind, kind, label: { compose: '发送消息', files: '发送文件', tasks: '传输任务', settings: '保存位置', more: '更多操作' }[kind] }))];
async function capture(props) {
  const frames = [], stdout = new Writable({ write(chunk, _, done) { frames.push(chunk.toString()); done(); } });
  Object.assign(stdout, { columns: props.width, rows: props.height, isTTY: true });
  const stdin = new PassThrough(); Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let app;
  try {
    await act(async () => { app = render(React.createElement(NavigationScreen, { snapshot, workspaceEntries, message: messages[12], messageIndex: 12, ...props }), { stdout, stdin, stderr: stdout, debug: true, patchConsole: false }); await new Promise(resolve => setImmediate(resolve)); });
    return frames.map(value => stripVTControlCharacters(value)).filter(value => value.trim()).at(-1)?.trimEnd() || '';
  } finally { await act(async () => app?.unmount()); app?.cleanup(); stdout.destroy(); stdin.destroy(); }
}
test('navigation screens fit real Ink output and keep selected file/actions visible at four terminal sizes', async () => {
  for (const [width, height] of [[160, 40], [120, 30], [80, 24], [60, 18]]) {
    for (const mode of ['chat', 'workspace', 'message-actions', 'message-detail', 'compose']) {
      const frame = await capture({ width, height, mode, input: '你好🙂', cursor: 2 });
      assert.ok(frame.split('\n').length <= height, `${mode} ${width} height overflow`);
      assert.ok(frame.split('\n').every(line => cells(line) <= width), `${mode} ${width} width overflow`);
      if (['chat', 'workspace', 'message-actions'].includes(mode)) assert.match(frame, /设计稿-12/);
      if (mode === 'message-actions') { assert.match(frame, /下载文件/); assert.match(frame, /返回消息/); }
      if (mode === 'compose') assert.match(frame, /你好▏🙂/);
    }
  }
});
test('workspace preview replaces message content and transfers stay scoped to current group', async () => {
  for (const width of [160, 80, 60]) {
    const frame = await capture({ width, height: 24, mode: 'workspace', workspaceIndex: 4 });
    assert.match(frame, /默认保存位置/); assert.match(frame, /Downloads/); assert.doesNotMatch(frame, /设计稿-12/);
  }
  const frame = await capture({ width: 120, height: 30, mode: 'workspace', workspaceIndex: 3, snapshot: { ...snapshot, transfers: [{ groupId: 'elsewhere', name: 'private-other-group', status: 'running' }] } });
  assert.doesNotMatch(frame, /private-other-group/); assert.match(frame, /当前群暂无传输任务/);
});
test('download actions reflect current message task and long links stay collapsed until detail', async () => {
  for (const [status, label] of [['running', '正在下载'], ['done', '查看保存位置'], ['failed', '重试下载']]) {
    const frame = await capture({ width: 60, height: 18, mode: 'message-actions', snapshot: { ...snapshot, transfers: [{ groupId: 'one', type: 'download', messageId: 'm12', status, bytes: 10, total: 100 }] } });
    assert.match(frame, new RegExp(label)); assert.match(frame, /返回消息/);
  }
  const message = { id: 'link', type: 'text', text: `https://example.com/${'path/'.repeat(100)}ENDMARKER`, senderName: '设备', createdAt: '2026-10-05T12:00:00Z' };
  const frame = await capture({ width: 80, height: 24, mode: 'chat', message, snapshot: { ...snapshot, state: { messages: [message] } } });
  assert.match(frame, /链接 · 已折叠/); assert.doesNotMatch(frame, /ENDMARKER/);
});
test('long compose drafts keep the editing cursor visible when moving back to the beginning', async () => {
  const frame = await capture({ width: 60, height: 18, mode: 'compose', input: '开头' + '中间文字'.repeat(300), cursor: 0 });
  assert.match(frame, /▏开头/);
});
test('startup notice does not hide actionable alerts and short action panes retain focused choice', async () => {
  const frame = await capture({ width: 60, height: 18, mode: 'chat', notice: '退出界面会停止本次服务；需后台运行请使用 pickdrop --background。', snapshot: { ...snapshot, requests: [{ id: 'request' }], joins: [{ status: 'pending' }], transfers: [{ groupId: 'one', status: 'failed' }] } });
  assert.match(frame, /1 项传输失败/); assert.match(frame, /1 个加入申请/); assert.match(frame, /1 个申请等待批准/);
  assert.doesNotMatch(frame, /需后台运行/);
  const short = await capture({ width: 40, height: 12, mode: 'message-actions', actionIndex: 3 });
  assert.match(short, /› 返回消息/);
  assert.ok(short.split('\n').length <= 12);
});
test('complete file details include the scoped completed path and can page to its final segment', async () => {
  const message = { ...messages[12], fileName: '报告.pdf' };
  const saved = '/home/downloads/' + '长目录/'.repeat(180) + 'FINAL-SAVED-FILE.pdf';
  const state = { ...snapshot, transfers: [
    { groupId: 'elsewhere', messageId: message.id, type: 'download', status: 'done', result: 'OTHER-GROUP-PRIVATE-PATH' },
    { groupId: 'one', messageId: message.id, type: 'download', status: 'done', result: saved },
  ] };
  const text = messageDetailText(message, state, 'one');
  assert.ok(text.includes(saved)); assert.match(text, /发送者：我的手机/); assert.doesNotMatch(text, /OTHER-GROUP/);
  assert.equal(messageDetailText({ type: 'text', text: '首行\n末行' }, state, 'one'), '首行\n末行');
  for (const width of [160, 80, 60]) {
    const first = await capture({ width, height: 18, mode: 'message-detail', message, snapshot: state });
    assert.doesNotMatch(first, /FINAL-SAVED-FILE/);
    const last = await capture({ width, height: 18, mode: 'message-detail', message, snapshot: state, detailOffset: 99999 });
    assert.match(last.replace(/\s+/g, ''), /FINAL-SAVED-FILE\.pdf/);
  }
});
test('palette keeps truecolor, indexed black and basic terminal fallback distinct', () => {
  assert.equal(navigationPalette({ COLORTERM: 'truecolor' }).base, '#080c10');
  assert.equal(navigationPalette({ TERM: 'xterm-256color' }).base, 'ansi256(232)');
  assert.equal(navigationPalette({ FORCE_COLOR: '2' }).base, 'ansi256(232)');
  assert.equal(navigationPalette({ TERM: 'vt100' }).base, 'black');
});
