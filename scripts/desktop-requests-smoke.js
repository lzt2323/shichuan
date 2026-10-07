import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-requests-'));
const packaged = process.env.PICKDROP_TEST_EXECUTABLE;
const app = await electron.launch({ executablePath: packaged || require('electron'), args: packaged ? [] : ['.'], env: { ...process.env, PICKDROP_TEST_LEGACY_GROUPS: '1', PICKDROP_USER_DATA: temporary } });
try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true');
  const { group, device } = await page.evaluate(() => window.pickdrop.bootstrap());
  async function api(route, body) {
    const response = await fetch(group.baseUrl + route, { method: body ? 'POST' : 'GET', headers: { 'X-Room-Key': group.key, 'X-Device-Id': device.id, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
  }
  async function request(name, id = randomUUID(), reset = false) {
    const invite = await api('/api/pair/invite', {});
    return api('/api/pair/request', { code: invite.code, reset, device: { id, name, kind: 'desktop' } });
  }
  async function status(ticket) {
    const response = await fetch(`${group.baseUrl}/api/pair/status/${ticket.requestId}`, { headers: { 'X-Poll-Token': ticket.pollToken } });
    assert.ok(response.ok); return (await response.json()).status;
  }
  for (let n = 1; n <= 45; n++) await api('/api/messages', { text: `历史消息 ${n}` });
  await page.getByText('历史消息 45', { exact: true }).waitFor();
  await page.locator('#message-input').fill('正在编辑的消息不会丢失');
  await page.locator('#timeline').evaluate(node => { node.scrollTop = node.scrollHeight; window.lastMessageNode = node.lastElementChild; });
  const firstId = randomUUID(), first = await request('Linux 工作站', firstId);
  await page.locator('#join-request-banner').waitFor();
  assert.equal(await page.locator('#timeline [data-request-id]').count(), 0);
  assert.equal(await page.locator('#message-input').inputValue(), '正在编辑的消息不会丢失');
  assert.equal(await page.evaluate(() => window.lastMessageNode === document.querySelector('#timeline').lastElementChild), true);
  const second = await request('第二台电脑'), third = await request('第三台电脑');
  await page.getByRole('button', { name: '查看全部（3）', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 280, height: 340 }));
  await page.waitForFunction(() => innerWidth === 280);
  const position = await page.evaluate(() => {
    const banner = document.querySelector('#join-request-banner').getBoundingClientRect();
    const timeline = document.querySelector('#timeline');
    return { top: banner.top, bottom: banner.bottom, timelineTop: timeline.getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth, scrolled: timeline.scrollTop > 0 };
  });
  assert.ok(position.top >= 0 && position.bottom <= position.timelineTop);
  assert.equal(position.overflow, false); assert.equal(position.scrolled, true);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/desktop-join-request-banner.png' });
  await page.locator('#approve-join-request').click();
  await page.getByRole('button', { name: '查看全部（2）', exact: true }).waitFor();
  assert.equal(await status(first), 'approved');
  await page.locator('#view-join-requests').click();
  await page.locator(`[data-request-id="${second.requestId}"] [data-action="deny-join"]`).click();
  await page.locator(`[data-request-id="${second.requestId}"]`).waitFor({ state: 'detached' });
  assert.equal(await status(second), 'denied');
  // Approval through the host API is reflected without closing/reopening the panel.
  await api('/api/pair/respond', { requestId: third.requestId, allow: true });
  await page.getByText('加入申请已全部处理。', { exact: true }).waitFor();
  assert.equal(await page.locator('#join-request-banner').isVisible(), false);
  await page.locator('#close-panel').click();
  assert.equal(await page.locator('#message-input').inputValue(), '正在编辑的消息不会丢失');
  const recovery = await request('Linux 工作站', firstId, true);
  await page.locator('#join-request-reset-note').waitFor();
  assert.match(await page.locator('#join-request-reset-note').innerText(), /原连接将失效/);
  assert.equal(await page.locator('#approve-join-request').innerText(), '恢复授权');
  await page.locator('#approve-join-request').click();
  await page.locator('#confirm-operation').waitFor();
  assert.equal(await status(recovery), 'pending', 'identity reset requires explicit confirmation');
  await page.locator('#confirm-operation').click();
  await page.waitForFunction(() => document.querySelector('#join-request-banner').hidden);
  assert.equal(await status(recovery), 'approved');
  assert.deepEqual(errors, []);
  console.log('Request UI smoke passed: long history, fixed actions, 280px window, multi-request approval/denial, remote decisions, preserved draft and message DOM.');
} finally { await app.close(); await rm(temporary, { recursive: true, force: true }); }
