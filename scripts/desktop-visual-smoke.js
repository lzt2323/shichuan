import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const dir = await mkdtemp(path.join(tmpdir(), 'pickdrop-visual-'));
const app = await electron.launch({ args: ['.'], env: { ...process.env, PICKDROP_USER_DATA: dir } });
const peers = [], errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const home = await app.firstWindow();
  await home.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true');
  const opened = app.waitForEvent('window');
  await home.evaluate(() => window.pickdrop.createGroup('项目传输群'));
  const page = await opened;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true');
  await page.evaluate(() => window.pickdrop.rename('我的电脑'));
  const { group, device } = await page.evaluate(() => window.pickdrop.bootstrap());
  const credentials = new Map([[device.id, group.key]]);
  async function api(route, sender, options = {}) {
    const response = await fetch(group.baseUrl + route, { ...options, headers: { 'X-Room-Key': credentials.get(sender), 'X-Device-Id': sender, ...options.headers } });
    assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
  }
  async function peer(name) {
    const id = randomUUID();
    const invite = await api('/api/pair/invite', device.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const requested = await fetch(group.baseUrl + '/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invite.code, device: { id, name, kind: 'desktop' } }) });
    assert.equal(requested.status, 202); const ticket = await requested.json();
    await api('/api/pair/respond', device.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: ticket.requestId, allow: true }) });
    const approved = await (await fetch(group.baseUrl + '/api/pair/status/' + ticket.requestId, { headers: { 'X-Poll-Token': ticket.pollToken } })).json();
    assert.equal(approved.status, 'approved'); assert.equal(approved.group.authVersion, 2); assert.notEqual(approved.group.key, group.key);
    credentials.set(id, approved.group.key);
    await api('/api/join', id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name, kind: 'desktop' }) });
    const ws = new WebSocket(`${group.baseUrl.replace('http:', 'ws:')}/api/events?key=${credentials.get(id)}&device=${id}`);
    peers.push(ws); await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); return id;
  }
  const lin = await peer('小林'), zhou = await peer('小周');
  const text = (sender, text) => api('/api/messages', sender, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const file = (sender, name, bytes, mime) => api('/api/files?name=' + encodeURIComponent(name), sender, { method: 'POST', headers: { 'Content-Type': mime }, body: bytes });
  await file(lin, '项目说明.pdf', Buffer.from('%PDF-1.4\n% PickDrop visual test fixture\n'), 'application/pdf');
  await text(zhou, '最新素材放这里了');
  await file(zhou, '封面.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64'), 'image/png');
  await file(device.id, '设计资源.zip', Buffer.from('504b0506000000000000000000000000000000000000', 'hex'), 'application/zip');
  await text(device.id, '收到，直接拖走就行');
  await page.locator('.file-bubble[draggable=true]').first().waitFor();
  await page.getByText('收到，直接拖走就行', { exact: true }).waitFor();
  await pause(250);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/group-transfer-desktop.png', omitBackground: true });
  assert.equal(await page.locator('.message').count(), 5);
  const layout = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    composerFits: document.querySelector('#composer').getBoundingClientRect().bottom <= innerHeight,
    inputWidth: document.querySelector('#message-input').getBoundingClientRect().width,
    visibleMessageCount: document.querySelectorAll('.message').length,
  }));
  assert.equal(layout.horizontalOverflow, false); assert.equal(layout.composerFits, true); assert.ok(layout.inputWidth > 100);
  // Presence updates must not rebuild the message DOM or close a user's file menu.
  const more = page.locator('.file-more').last(), summary = more.locator('summary');
  await summary.click();
  peers[0].terminate();
  await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent === '2 在线');
  assert.equal(await more.getAttribute('open'), '');
  await summary.focus(); await page.keyboard.press('Escape');
  assert.equal(await more.getAttribute('open'), null);
  assert.equal(await summary.evaluate(node => document.activeElement === node), true);
  // Resize through native bounds, including the smallest supported content area.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.getTitle() === '项目传输群 · 拾传'); win.setBounds({ width: 280, height: 340 });
  });
  await pause(250);
  await page.screenshot({ path: 'artifacts/group-transfer-minimum.png', omitBackground: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(await page.locator('#send-text').isVisible());
  await page.locator('#message-input').fill('小窗口也能发送');
  await page.locator('#send-text').click(); await page.getByText('小窗口也能发送', { exact: true }).waitFor();
  // The mobile invitation is a short-lived code, never a permanent group key.
  const invitation = await page.evaluate(() => window.pickdrop.createInvite());
  const invitationUrl = new URL(invitation.link);
  assert.equal(invitationUrl.origin, group.baseUrl);
  assert.notEqual(invitationUrl.hostname, '127.0.0.1');
  assert.notEqual(invitationUrl.hostname, '0.0.0.0');
  const invitationParams = new URLSearchParams(invitationUrl.hash.slice(1));
  assert.equal(invitationParams.get('group'), group.id);
  assert.match(invitationParams.get('invite'), /^\d{6}$/);
  assert.equal(invitationParams.has('key'), false);
  assert.match(invitation.qrDataUrl, /^data:image\/png;base64,/);
  await page.locator('#group-menu-button').click();
  await page.locator('#invite-members').click();
  await page.locator('.invite-qr').waitFor();
  assert.ok(await page.locator('.invite-qr').evaluate(image => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: 'artifacts/mobile-invite-desktop.png', omitBackground: true });
  await page.locator('#close-panel').click();
  // A user can inspect and explicitly select the real LAN in the smallest UI.
  await page.locator('#group-menu-button').click();
  await page.locator('#network-settings').click();
  await page.locator('#apply-network').waitFor();
  const network = await page.evaluate(() => window.pickdrop.getNetwork());
  assert.ok(network.available && network.selected?.address);
  await page.locator(`input[name="pickdrop-network"][value=${JSON.stringify(network.selected.id)}]`).check();
  await page.locator('#apply-network').click();
  await page.waitForFunction(async () => (await window.pickdrop.getNetwork()).selection.mode === 'manual');
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true');
  await page.locator('#panel-body').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/desktop-network-settings.png', omitBackground: true });
  assert.ok(await page.locator('#close-panel').isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('input[name="pickdrop-network"][value="auto"]').check();
  await page.locator('#apply-network').click();
  await page.waitForFunction(async () => (await window.pickdrop.getNetwork()).selection.mode === 'auto');
  await page.locator('#close-panel').click();
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true');
  await page.locator('#message-input').fill('切换网络后继续传输');
  await page.locator('#send-text').click();
  await page.getByText('切换网络后继续传输', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await writeFile('artifacts/desktop-visual-smoke.json', JSON.stringify({ realBackendMessages: true, distinctSenders: true, fixtureData: true, menuSurvivesPresenceUpdate: true, keyboardMenuDismissal: true, minimumSizeUsable: true, layout, errors }, null, 2));
  console.log('Desktop visual smoke passed: actual shared conversation, distinct senders, minimum layout, mobile invitation QR, screenshots.');
} finally {
  for (const peer of peers) peer.terminate();
  await app.close(); await rm(dir, { recursive: true, force: true });
}
