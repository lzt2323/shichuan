import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const executablePath = process.env.PICKDROP_TEST_EXECUTABLE || require('electron');
const packaged = Boolean(process.env.PICKDROP_TEST_EXECUTABLE);
const temp = await mkdtemp(path.join(tmpdir(), 'pickdrop-groups-smoke-'));
const output = path.join(root, 'artifacts'); await mkdir(output, { recursive: true });
let hostApp, peerApp;
const errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bootstrap = page => page.evaluate(() => window.pickdrop.bootstrap());
async function start(dataDir) {
  const app = await electron.launch({ executablePath, args: packaged ? [] : [root], cwd: root, env: { ...process.env, PICKDROP_USER_DATA: dataDir }, timeout: 30000 });
  const capture = page => page.on('pageerror', error => errors.push(error.message));
  app.windows().forEach(capture); app.on('window', capture);
  return app;
}
async function connected(page) {
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true', { timeout: 15000 });
}
async function snapshot(page) {
  const { room, device } = await bootstrap(page);
  const headers = { 'X-Room-Key': room.key, 'X-Device-Id': device.id };
  const response = await fetch(room.baseUrl + '/api/state', { headers }); assert.ok(response.ok);
  return { state: await response.json(), room, device, headers };
}
async function pageFor(app, id) {
  for (let n = 0; n < 100; n++) {
    for (const page of app.windows()) {
      try { if ((await bootstrap(page)).group.id === id) return page; } catch {}
    }
    await pause(100);
  }
  throw new Error('No independent window opened for the group');
}
async function settled(page, collapsed) {
  for (let i = 0; i < 100; i++) {
    const state = (await bootstrap(page)).window;
    if (!state.transition && (collapsed === undefined || state.collapsed === collapsed)) return;
    await pause(25);
  }
  throw new Error('Window motion did not settle');
}
async function bounds(app, groupName) {
  return app.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows().find(win => win.getTitle() === `${name} · 拾传`).getBounds(), groupName);
}

try {
  hostApp = await start(path.join(temp, 'host'));
  const personal = await hostApp.firstWindow(); await connected(personal);
  const original = await bootstrap(personal);
  assert.equal((await bounds(hostApp, original.group.name)).width, 340);
  await personal.locator('#group-menu-button').click();
  await personal.locator('#create-group').click();
  await personal.locator('#new-group-name').fill('工作资料');
  const workOpened = hostApp.waitForEvent('window');
  await personal.locator('#confirm-create-group').click();
  const work = await workOpened; await connected(work);
  const workConfig = await bootstrap(work);
  assert.notEqual(workConfig.group.id, original.group.id);
  assert.equal((await bootstrap(personal)).group.id, original.group.id);
  assert.ok((await bootstrap(personal)).groups.every(group => !Object.hasOwn(group, 'key')));

  await work.locator('#message-input').fill('只发送到工作资料群');
  await work.locator('#send-text').click();
  await work.getByText('只发送到工作资料群', { exact: true }).waitFor();
  assert.ok(!(await snapshot(personal)).state.messages.some(message => message.text === '只发送到工作资料群'));
  const bytes = randomBytes(256 * 1024 + 3);
  await work.locator('#file-input').setInputFiles({ name: '群文件隔离.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await work.locator('.file-bubble[draggable=true]').waitFor();
  const workState = await snapshot(work), sent = workState.state.messages.find(message => message.fileName === '群文件隔离.bin');
  assert.ok(sent); assert.equal((await snapshot(personal)).state.messages.filter(message => message.type === 'file').length, 0);
  const received = await fetch(workState.room.baseUrl + '/api/files/' + sent.id, { headers: workState.headers });
  assert.deepEqual(Buffer.from(await received.arrayBuffer()), bytes);

  // Exercise the browser drop handler with a File, through the real upload API.
  await personal.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([0, 255, 42, 128])], '拖入个人群.bin'));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await personal.locator('.file-bubble[draggable=true]').waitFor();
  assert.ok(!(await snapshot(work)).state.messages.some(message => message.fileName === '拖入个人群.bin'));

  // Two genuinely separate desktop processes discover and pair via the LAN.
  peerApp = await start(path.join(temp, 'peer'));
  const peerHome = await peerApp.firstWindow(); await connected(peerHome);
  await peerHome.evaluate(() => window.pickdrop.rename('另一台电脑'));
  // Keep the join panel open before a new host advertisement exists. No manual refresh.
  await peerHome.locator('#group-menu-button').click(); await peerHome.locator('#join-group').click();
  const lateGroup = await personal.evaluate(() => window.pickdrop.createGroup('发现刷新回归'));
  await peerHome.locator(`#nearby-groups option[data-group-id="${lateGroup.id}"]`).waitFor({ state: 'attached', timeout: 15000 });
  await peerHome.locator('#close-panel').click();
  await work.locator('#group-menu-button').click(); await work.locator('#invite-members').click();
  await work.waitForFunction(() => /^\d{6}$/.test(document.querySelector('#invite-code')?.textContent || ''));
  const code = await work.locator('#invite-code').innerText();
  await work.locator('#close-panel').click();
  await peerHome.locator('#group-menu-button').click(); await peerHome.locator('#join-group').click();
  await peerHome.locator('#join-code').fill(code); await peerHome.locator('#confirm-join-group').click();
  await work.locator('[data-action=approve-join]').waitFor({ timeout: 15000 });
  await work.locator('[data-action=approve-join]').click();
  const peerWork = await pageFor(peerApp, workConfig.group.id); await connected(peerWork);
  await peerWork.getByText('群文件隔离.bin', {exact:true}).waitFor();
  assert.equal(await peerWork.locator('.file-bubble[draggable=true]').count(), 0, 'Joining a group must not fetch old attachments');
  await peerWork.locator('.file-more summary').first().click();
  await peerWork.getByRole('button', {name:'接收到本机',exact:true}).click();
  await peerWork.locator('.file-bubble[draggable=true]').waitFor({ timeout: 15000 });
  assert.equal((await bootstrap(peerHome)).group.id, (await bootstrap(peerHome)).groups.find(group => group.local).id);
  assert.ok(!(await snapshot(peerHome)).state.messages.some(message => message.text === '只发送到工作资料群'));
  const cacheRoot = path.join(await peerApp.evaluate(({ app }) => app.getPath('userData')), 'received');
  const cacheFiles = (await readdir(cacheRoot, { recursive: true }))
    .filter(entry => entry.includes(sent.id) && entry.endsWith('群文件隔离.bin')).map(entry => path.join(cacheRoot, entry));
  assert.equal(cacheFiles.length, 1); assert.deepEqual(await readFile(cacheFiles[0]), bytes);

  // Dispatch the production drag event and inspect its IPC result without an OS drag session.
  await peerApp.evaluate(({ BrowserWindow }, groupName) => {
    const win = BrowserWindow.getAllWindows().find(win => win.getTitle() === `${groupName} · 拾传`);
    globalThis.__pickdropDrag = null;
    win.webContents.startDrag = item => { globalThis.__pickdropDrag = { file: item.file, iconEmpty: item.icon.isEmpty() }; };
  }, workConfig.group.name);
  await peerWork.locator('.file-bubble[draggable=true]').dispatchEvent('dragstart'); await pause(100);
  const drag = await peerApp.evaluate(() => globalThis.__pickdropDrag);
  assert.equal(drag.file, cacheFiles[0]); assert.equal(drag.iconEmpty, false);
  await peerWork.evaluate(() => window.dispatchEvent(new Event('dragend')));

  // This suite checks window state, not the user's physical mouse position.
  await hostApp.evaluate(({ screen }) => { globalThis.__realCursor = screen.getCursorScreenPoint; screen.getCursorScreenPoint = () => ({ x: -100000, y: -100000 }); });
  await work.evaluate(() => { document.activeElement?.blur(); return window.pickdrop.pin(false); });
  await work.locator('#dock-button').click();
  await settled(work);
  await settled(work, true);
  assert.equal((await bounds(hostApp, '工作资料')).width, 40);
  await work.screenshot({ path: path.join(output, 'group-edge-halfball.png') });
  await work.locator('#pickdrop-native-tab').click(); await settled(work, false);
  assert.equal((await bounds(hostApp, '工作资料')).width, 340);
  await work.locator('#pin-button').click();
  assert.equal((await bootstrap(work)).window.pinned, true);
  await work.locator('#dock-button').click();
  await settled(work);
  assert.equal((await bounds(hostApp, '工作资料')).width, 340);
  await work.locator('#pin-button').click(); await work.locator('#dock-button').click();
  await personal.locator('#dock-button').click(); await settled(personal); await settled(work);
  const one = await bounds(hostApp, '工作资料'), two = await bounds(hostApp, original.group.name);
  assert.ok(one.x !== two.x || one.y + one.height <= two.y || two.y + two.height <= one.y, 'Group edge tabs overlap');

  await hostApp.evaluate(({ screen }) => { screen.getCursorScreenPoint = globalThis.__realCursor; });

  // Persist on shutdown; host restarts with new TCP ports, peer must recover by identity.
  const previousBaseUrl = (await bootstrap(peerWork)).room.baseUrl;
  await hostApp.close(); hostApp = null;
  hostApp = await start(path.join(temp, 'host'));
  const hostRestored = await pageFor(hostApp, workConfig.group.id);
  const restored = await bootstrap(hostRestored);
  assert.equal(restored.group.name, '工作资料');
  assert.equal((await bootstrap(await pageFor(hostApp, original.group.id))).group.id, original.group.id);
  await hostRestored.evaluate(() => window.pickdrop.expand()); await connected(hostRestored);
  await peerWork.waitForFunction(old => window.pickdrop.bootstrap().then(data => data.room.baseUrl !== old && data.room.online), previousBaseUrl, { timeout: 20000 });
  await connected(peerWork);
  await hostRestored.locator('#message-input').fill('托管电脑重启后的消息');
  await hostRestored.locator('#send-text').click();
  await peerWork.getByText('托管电脑重启后的消息', { exact: true }).waitFor({ timeout: 15000 });
  await peerWork.screenshot({ path: path.join(output, 'mini-group-window.png') });
  // Removal must revoke the saved token, not merely hide an avatar.
  const oldPeer = await bootstrap(peerWork);
  await hostRestored.locator('#members-button').click();
  await hostRestored.locator(`[data-remove-device="${oldPeer.device.id}"]`).click();
  await hostRestored.locator('#confirm-operation').click();
  await hostRestored.waitForFunction(id => !document.querySelector(`[data-remove-device="${id}"]`), oldPeer.device.id);
  const revoked = await fetch(oldPeer.room.baseUrl + '/api/state', { headers: { 'X-Room-Key': oldPeer.room.key, 'X-Device-Id': oldPeer.device.id } });
  assert.ok([401, 403].includes(revoked.status), 'Removed device token still accesses group');
  await peerWork.waitForFunction(() => document.querySelector('#connection-status')?.title.includes('授权已失效'), null, { timeout: 15000 });
  // An offline/revoked member can forget locally and the native window is destroyed.
  await peerWork.locator('#members-button').click(); await peerWork.locator('#forget-group').click();
  const closedPeer = peerWork.waitForEvent('close'); await peerWork.locator('#confirm-operation').click(); await closedPeer;
  assert.ok(!(await bootstrap(peerHome)).groups.some(group => group.id === oldPeer.room.id));
  // Rejoin the same identity with a new grant, then explicitly leave online.
  const reInvite = await hostRestored.evaluate(() => window.pickdrop.createInvite());
  const reTicket = await peerHome.evaluate(value => window.pickdrop.joinAt(value.baseUrl, value.code, value.groupId), { ...reInvite, groupId: oldPeer.room.id });
  const reRequests = await hostRestored.evaluate(() => window.pickdrop.listJoinRequests());
  const requestList = Array.isArray(reRequests) ? reRequests : reRequests.requests;
  const reRequest = requestList.find(item => item.device.id === oldPeer.device.id);
  assert.ok(reRequest); await hostRestored.evaluate(id => window.pickdrop.respondJoin(id, true), reRequest.id);
  await peerHome.evaluate(ticket => window.pickdrop.checkJoin(ticket), reTicket);
  const rePeer = await pageFor(peerApp, oldPeer.room.id); await connected(rePeer);
  const reGrant = await bootstrap(rePeer); assert.notEqual(reGrant.room.key, oldPeer.room.key);
  await rePeer.locator('#members-button').click(); await rePeer.locator('#leave-group').click();
  const left = rePeer.waitForEvent('close'); await rePeer.locator('#confirm-operation').click(); await left;
  const leftAccess = await fetch(reGrant.room.baseUrl + '/api/state', { headers: { 'X-Room-Key': reGrant.room.key, 'X-Device-Id': reGrant.device.id } });
  assert.ok([401, 403].includes(leftAccess.status));
  assert.ok(!(await bootstrap(peerHome)).groups.some(group => group.id === reGrant.room.id));
  await assert.rejects(hostRestored.evaluate(() => window.pickdrop.leaveGroup()), /托管电脑/);
  await assert.rejects(hostRestored.evaluate(() => window.pickdrop.forgetGroup()), /托管电脑/);
  assert.deepEqual(errors, []);
  const report = { nativeMultiWindow: true, liveNearbyRefresh: true, memberTokenRevoked: true, revokedMemberForget: true, onlineLeaveRevokesToken: true, hostLeaveProtected: true, groupIsolation: true, binaryTransfer: true, dropToGroup: true, shortCodeApproval: true, persistentGroups: true, hostRestartDiscovery: true, remoteCacheHashVerified: true, nativeDragIPC: true, edgeTabBounds: true, nonOverlappingTabs: true, pinKeepsExpanded: true, physicalOSDropTested: false, consoleErrors: errors };
  await writeFile(path.join(output, 'desktop-groups-smoke.json'), JSON.stringify(report, null, 2));
  console.log('Desktop groups smoke passed: independent apps/groups, live nearby discovery, pairing, file drag/cache, restart recovery, member revocation, forget/leave and host protection.');
} catch (error) { console.error('Desktop groups smoke failed:', error); throw error;
} finally {
  if (peerApp) await peerApp.close().catch(() => {});
  if (hostApp) await hostApp.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
