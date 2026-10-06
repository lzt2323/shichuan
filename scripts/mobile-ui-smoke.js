import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createGroupManager } from '../server/groups.js';

// This renders the production App.tsx with React Native Web. Native file and
// share APIs are covered separately; a browser run is not a device test.
const root = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-mobile-ui-'));
const manager = await createGroupManager({ dataDir: root, host: '127.0.0.1', device: { id: randomUUID(), name: '我的电脑', kind: 'desktop' }, discoveryFactory: async () => ({ list: () => [], refresh() {}, close() {} }) });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
const errors = [], peers = [];
page.on('pageerror', error => errors.push(error.message));
const poll = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for backend state');
};
async function api(group, route, options = {}) {
  const response = await fetch(group.baseUrl + route, { ...options, headers: { 'X-Room-Key': group.key, 'X-Device-Id': manager.device.id, ...options.headers } });
  assert.ok(response.ok); return response.json();
}
async function join(group, manual = false) {
  const invite = await manager.createInvite(group.id);
  await page.getByRole('button', { name: '加入传输群', exact: true }).click();
  await page.getByText('附近的传输群', { exact: true }).waitFor();
  await page.getByTestId('discovery-unavailable').waitFor();
  await page.getByText('此环境不支持附近发现', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/mobile-nearby-web.png' });
  await page.getByRole('button', { name: '高级连接', exact: true }).click();
  if (manual) {
    await page.getByRole('tab', { name: '地址 + 邀请码', exact: true }).click();
    await page.getByLabel('电脑地址', { exact: true }).fill(group.baseUrl);
    await page.getByLabel('6 位邀请码', { exact: true }).fill(invite.code);
    await page.getByRole('button', { name: '申请加入', exact: true }).click();
  } else {
    await page.getByRole('tab', { name: '粘贴完整链接' }).click();
    await page.getByLabel('完整邀请链接', { exact: true }).fill(`${group.baseUrl}/#invite=${invite.code}&group=${group.id}`);
    await page.getByRole('button', { name: '加入这个群', exact: true }).click();
  }
  const pending = await poll(async () => (await manager.listJoinRequests(group.id))[0]);
  await page.getByText('申请已发出', { exact: true }).waitFor();
  await manager.respondJoin(group.id, pending.id, true);
  await page.getByRole('button', { name: '返回群列表' }).waitFor();
  await page.getByLabel('消息内容', { exact: true }).fill('手机已连接');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await poll(async () => (await api(group, '/api/state')).messages.some(message => message.text === '手机已连接'));
}
try {
  const first = await manager.createGroup('项目传输群'), second = await manager.createGroup('家里的传输群');
  const phonePeer = { id: randomUUID(), name: '小林', kind: 'android' };
  const peerInvite = await manager.createInvite(first.id);
  const peerRequest = await fetch(first.baseUrl + '/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: peerInvite.code, device: phonePeer }) });
  const peerTicket = await peerRequest.json(); assert.ok(peerRequest.ok);
  await manager.respondJoin(first.id, peerTicket.requestId, true);
  const peerApprovalResponse = await fetch(`${first.baseUrl}/api/pair/status/${peerTicket.requestId}`, { headers: { 'X-Poll-Token': peerTicket.pollToken } });
  const peerApproval = await peerApprovalResponse.json(); assert.equal(peerApproval.status, 'approved');
  const peerKey = peerApproval.group.key;
  const peer = new WebSocket(`${first.baseUrl.replace('http:', 'ws:')}/api/events?key=${peerKey}&device=${phonePeer.id}`); peers.push(peer);
  await new Promise((resolve, reject) => { peer.once('open', resolve); peer.once('error', reject); });
  await api(first, '/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': phonePeer.id, 'X-Room-Key': peerKey }, body: JSON.stringify({ text: '最新的资料放这里，手机上也能收。' }) });
  await api(first, '/api/files?name=' + encodeURIComponent('项目说明.pdf'), { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-1.4\n% mobile UI fixture\n') });
  await api(first, '/api/files?name=' + encodeURIComponent('设计资源.zip'), { method: 'POST', body: Buffer.from('504b0506000000000000000000000000000000000000', 'hex') });
  await page.goto(process.env.PICKDROP_MOBILE_WEB_URL || 'http://localhost:8082');
  await page.getByText('文件，递给大家。', { exact: true }).waitFor();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/mobile-welcome.png' });
  await join(first);
  await page.getByText('项目说明.pdf', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/mobile-group.png' });
  await page.getByLabel('消息内容', { exact: true }).fill('这份草稿属于项目群');
  await page.getByRole('button', { name: '返回群列表' }).click();
  await join(second, true);
  assert.equal(await page.getByText('项目说明.pdf', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '返回群列表' }).click();
  await page.getByRole('button', { name: '打开项目传输群', exact: true }).click();
  assert.equal(await page.getByLabel('消息内容', { exact: true }).inputValue(), '这份草稿属于项目群');
  // Approve a new device from the mobile member sheet.
  const invitation = await manager.createInvite(first.id);
  const request = await fetch(first.baseUrl + '/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invitation.code, device: { id: randomUUID(), name: '小周的手机', kind: 'ios' } }) });
  const ticket = await request.json(); assert.equal(ticket.status, 'pending');
  await page.getByRole('button', { name: '查看群成员' }).click();
  await page.getByText('小周的手机 申请加入', { exact: true }).waitFor();
  await page.getByRole('button', { name: '允许加入', exact: true }).click();
  await poll(async () => (await api(first, '/api/state')).devices.some(device => device.name === '小周的手机'));
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  const bounds = await page.getByLabel('消息内容', { exact: true }).boundingBox();
  assert.ok(bounds && bounds.width >= 100 && bounds.y + bounds.height <= 568);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'artifacts/mobile-small.png' });
  await page.getByLabel('消息内容', { exact: true }).fill('小屏幕发送成功');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await poll(async () => (await api(first, '/api/state')).messages.some(message => message.text === '小屏幕发送成功'));
  assert.deepEqual(errors, []);
  await writeFile('artifacts/mobile-ui-smoke.json', JSON.stringify({ runtime: 'React Native Web, not a physical device', pairing: ['invitation link', 'address and code'], discoveryWebFallback: true, realServer: true, groupIsolation: true, perGroupTextDraft: true, memberApproval: true, narrowScreen: '320x568', errors }, null, 2));
  console.log('Mobile UI smoke passed: actual App.tsx, real pairing/approval, two groups, drafts, text, narrow layout.');
} finally {
  for (const peer of peers) peer.terminate();
  await browser.close(); await manager.close(); await rm(root, { recursive: true, force: true });
}
