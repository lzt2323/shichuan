// Capture real Ink output with isolated demo data, then display its ANSI cells
// in Chromium for review. This is not a native Linux terminal screenshot.
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

process.env.FORCE_COLOR = '3';
const requireTui = createRequire(new URL('../apps/tui/package.json', import.meta.url));
const { default: React } = await import(requireTui.resolve('react'));
const { render } = await import(requireTui.resolve('ink'));
const { default: stringWidth } = await import(requireTui.resolve('string-width'));
const { App } = await import('../apps/tui/ui.js');
const output = path.resolve('artifacts/tui');
await mkdir(output, { recursive: true });
const state = {
  device: { id: 'linux', name: 'Linux Server' }, selectedGroupId: 'main',
  groups: [{ id: 'main', name: '我的传输群', local: true, online: true }, { id: 'dev', name: '开发测试群', online: false }],
  network: { selected: { name: 'ens42f0', address: '192.168.1.30' } },
  preferences: { downloadDirectory: '/home/demo/Downloads/拾传' },
  joins: [], requests: [],
  state: {
    devices: [{ id: 'linux', name: 'Linux Server', online: true }, { id: 'mac', name: 'MacBook Air', online: true }, { id: 'android', name: 'Android', online: false }],
    messages: [
      { id: '1', senderId: 'mac', senderName: 'MacBook Air', type: 'text', text: '协议文档更新了，放在这里。', createdAt: '2026-10-05T11:05:00Z' },
      { id: '2', senderId: 'mac', senderName: 'MacBook Air', type: 'file', fileName: '协议内容 v5.docx', size: 159744, createdAt: '2026-10-05T11:05:10Z' },
      { id: '3', senderId: 'android', senderName: 'Android', type: 'file', fileName: 'base.apk', size: 113246208, createdAt: '2026-10-05T11:06:00Z' },
      { id: '4', senderId: 'linux', senderName: 'Linux Server', type: 'text', text: '收到，正在上传构建包。', createdAt: '2026-10-05T11:07:00Z' },
      { id: '5', senderId: 'mac', senderName: 'MacBook Air', type: 'text', text: '构建完成后我来下载。', createdAt: '2026-10-05T11:08:00Z' },
    ],
  },
  transfers: [{ id: 'upload', groupId: 'main', type: 'upload', name: 'build.tar.gz', status: 'running', bytes: 72477573, total: 113246208 }],
};
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
const frames = [];
const stdout = new Writable({ write(chunk, _, callback) { frames.push(chunk.toString()); callback(); } });
Object.assign(stdout, { columns: 160, rows: 40, isTTY: true });
const stdin = new PassThrough();
Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
const app = render(React.createElement(App, { persistent: true, initialSnapshot: state, request: async () => state, refreshInterval: 60000 }), {
  stdout, stdin, stderr: stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
});
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const basic = ['#000000', '#cc5555', '#55aa55', '#cdcd55', '#5555cc', '#cc55cc', '#55cccc', '#cccccc', '#666666', '#ff7777', '#77ff77', '#ffff77', '#7777ff', '#ff77ff', '#77ffff', '#ffffff'];
function indexed(n) {
  if (n < 16) return basic[n];
  if (n > 231) { const c = 8 + (n - 232) * 10; return `rgb(${c},${c},${c})`; }
  const c = n - 16, level = v => v ? 55 + v * 40 : 0;
  return `rgb(${level(Math.floor(c / 36))},${level(Math.floor(c / 6) % 6)},${level(c % 6)})`;
}
function terminalHtml(ansi) {
  let fg = '#DCE8EA', bg = '#0B1318', bold = false, dim = false, html = '';
  const segments = new Intl.Segmenter('zh', { granularity: 'grapheme' });
  for (const token of ansi.split(/(\x1b\[[0-9;]*m)/)) {
    if (token.startsWith('\x1b[')) {
      const codes = token.slice(2, -1).split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) { fg = '#DCE8EA'; bg = '#0B1318'; bold = false; dim = false; }
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (c === 22) { bold = false; dim = false; }
        else if (c === 39) fg = '#DCE8EA';
        else if (c === 49) bg = '#0B1318';
        else if (c >= 30 && c <= 37) fg = basic[c - 30];
        else if (c >= 40 && c <= 47) bg = basic[c - 40];
        else if (c >= 90 && c <= 97) fg = basic[c - 90 + 8];
        else if (c >= 100 && c <= 107) bg = basic[c - 100 + 8];
        else if (c === 38 || c === 48) {
          let color;
          if (codes[i + 1] === 2) { color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
          else if (codes[i + 1] === 5) { color = indexed(codes[i + 2]); i += 2; }
          if (color) { if (c === 38) fg = color; else bg = color; }
        }
      }
      continue;
    }
    for (const { segment } of segments.segment(stripVTControlCharacters(token))) {
      if (segment === '\n') { html += '\n'; continue; }
      const cells = stringWidth(segment);
      html += `<span style="display:inline-block;width:${cells * 9}px;color:${fg};background:${bg};font-weight:${bold ? 700 : 400};opacity:${dim ? 0.65 : 1}">${escapeHtml(segment)}</span>`;
    }
  }
  return html;
}
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [columns, rows, name] of [[160, 40, 'wide'], [120, 30, 'medium'], [80, 24, 'narrow'], [60, 18, 'compact']]) {
    stdout.columns = columns; stdout.rows = rows; stdout.emit('resize'); await pause();
    const ansi = frames.at(-1), plain = stripVTControlCharacters(ansi);
    const lines = plain.replace(/\n$/, '').split('\n');
    assert.ok(lines.length <= rows, `${name} overflows terminal height`);
    assert.ok(lines.every(line => stringWidth(line) <= columns), `${name} overflows terminal width`);
    assert.match(plain, /输入消息/); assert.match(plain, /Ctrl\+P/);
    const html = `<!doctype html><meta charset="utf-8"><title>PickDrop ${columns}×${rows}</title><style>*{box-sizing:border-box}body{margin:0;padding:20px;background:#0B1318;color:#8CA2AA}header{font:13px monospace;margin-bottom:12px}pre{margin:0;font-family:Menlo,Consolas,"Hiragino Sans GB",monospace;font-size:14px;line-height:21px;white-space:pre}span{height:21px;vertical-align:top}</style><header>PickDrop · ${columns} × ${rows} · Ink 渲染输出 / 演示数据</header><pre>${terminalHtml(ansi)}</pre>`;
    await writeFile(path.join(output, `${name}.ansi`), ansi);
    await writeFile(path.join(output, `${name}.txt`), plain);
    await writeFile(path.join(output, `${name}.html`), html);
    const page = await browser.newPage({ viewport: { width: columns * 9 + 40, height: rows * 21 + 80 }, deviceScaleFactor: 1.5 });
    await page.setContent(html); await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true }); await page.close();
    results.push({ columns, rows, outputRows: lines.length, image: `${name}.png` });
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ actualInkOutput: true, fixtureData: true, nativeLinuxTerminal: false, results }, null, 2));
  console.log('TUI visual smoke passed: 160×40, 120×30, 80×24, 60×18. See artifacts/tui/.');
} finally {
  await browser.close(); app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy();
}
