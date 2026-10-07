const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, clipboard, Menu, Tray, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const { createNetworkTransferScope } = require('./network-transfers.cjs');
const { readClipboardImage } = require('./clipboard-image.cjs');
const { canPreview, imagePreview } = require('./image-preview.cjs');
const networkTransfers = createNetworkTransferScope();
const { desktopBackend, createNativeWindowController } = require('./platform-window.cjs');
const { nativeFrame } = desktopBackend(process.platform, process.env, app.commandLine);
const { initialBounds, createWindowController } = require('./window-controller.cjs');

let manager, config, configPath, tray, uiOrigin, uiServer, networkProxy, startupPromise, quitting = false, quitFinished = false, saveQueue = Promise.resolve();
const welcomeGroup = { id: '__welcome__', name: '拾传', welcome: true, local: false };
let discoveryError = '';
const windows = new Map(), opening = new Map(), prepared = new Map(), pending = new Map();
const cachePins = new Set(), pinCounts = new Map();
function pinCache(file) {
  cachePins.add(file); pinCounts.set(file, (pinCounts.get(file) || 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true;
    const count = pinCounts.get(file) - 1;
    if (count) pinCounts.set(file, count); else { pinCounts.delete(file); cachePins.delete(file); }
  };
}
let cacheSweep = Promise.resolve(), cacheTimer;
const dragIcon = nativeImage.createFromPath(path.join(__dirname, 'assets/drag-icon.png'));
function saveConfig() {
  const snapshot = structuredClone(config);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const { writeJsonWithBackup } = await import('../../server/persistence.js');
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await writeJsonWithBackup(configPath, snapshot);
  });
  return saveQueue;
}
function recordFor(event) {
  const record = [...windows.values()].find(item => !item.win.isDestroyed() && item.win.webContents === event.sender);
  if (!record || event.senderFrame !== event.sender.mainFrame) return null;
  try { if (new URL(event.senderFrame.url).origin !== uiOrigin) return null; } catch { return null; }
  return record;
}
function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    const record = recordFor(event); if (!record) throw new Error('Invalid sender');
    return callback(record, ...args);
  });
}
function groupFor(record) {
  const group = record.groupId === welcomeGroup.id ? welcomeGroup : manager.listGroups().find(item => item.id === record.groupId);
  if (!group) throw new Error('群不存在');
  return group;
}
function publicGroup({ key, ...group }) { return group; }
function publicGroups() { return manager.listGroups().map(publicGroup); }
function bootstrap(record) {
  const group = groupFor(record);
  return { device: config.device, group, room: group, groups: publicGroups(), native: true, platform: process.platform, window: record.control.state(), network: manager.getNetwork(), discoveryError: manager.getNetwork().discoveryError || '' };
}
function cacheKey(group, id) { return `${group.id}|${group.key}|${id}`; }
async function prepareFile(record, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('文件编号不正确');
  await cacheSweep.catch(() => {});
  let group = groupFor(record); const key = cacheKey(group, id);
  const requestHeaders = { 'X-Room-Key': group.key, 'X-Device-Id': config.device.id };
  if (prepared.has(key)) {
    try { const file = prepared.get(key); await fs.utimes(file, new Date(), new Date()); return file; }
    catch (error) { if (error.code !== 'ENOENT') throw error; prepared.delete(key); }
  }
  if (pending.has(key)) return pending.get(key);
  let release, downloadSignal;
  const operation = (async () => {
    if (group.mode === 'peer') {
      const releaseLease = manager.acquireTransfer();
      try { const file = await manager.preparePeerFile(group.id, id); prepared.set(key, file); return file; }
      finally { releaseLease(); }
    }
    const hosted = manager.getHostedInbox(group.id);
    if (hosted) {
      const local = hosted.fileFor(id);
      if (!local) throw new Error('文件不存在');
      await fs.access(local.path); prepared.set(key, local.path); return local.path;
    }
    const releaseLease = manager.acquireTransfer(), cancellation = networkTransfers.begin();
    release = () => { cancellation.release(); releaseLease(); };
    const signal = cancellation.signal; downloadSignal = signal;
    group = await manager.resolveGroup(group.id);
    if (!group.online) throw new Error('群主机离线，请检查所选网络');
    let message;
    try { message = await manager.authenticated(group.id, `/api/messages/${id}`, { signal }); }
    catch (error) {
      if (error.status !== 404) throw error;
      const state = await manager.authenticated(group.id, '/api/state', { signal });
      message = state.messages.find(item => item.id === id && item.type === 'file');
    }
    if (!message || message.deleted) throw new Error('文件已被主机清理');
    const { safeFileName } = await import('../../shared/protocol.js');
    const { downloadVerified, verifyLocalFile } = await import('../../shared/download.js');
    const groupDir = createHash('sha256').update(group.id).digest('hex');
    const dir = path.join(app.getPath('userData'), 'received', groupDir, id);
    await cacheSweep.catch(() => {}); const unpin = pinCache(dir);
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const output = path.join(dir, safeFileName(message.fileName)), partial = output + '.part';
      if (await verifyLocalFile(output, message)) {
        await fs.utimes(output, new Date(), new Date()); prepared.set(key, output); return output;
      }
      await fs.rm(partial, { force: true });
      await downloadVerified({ url: `${group.baseUrl}/api/files/${id}`, headers: requestHeaders,
        destination: partial, size: message.size, sha256: message.sha256, signal,
        localAddress: manager.getNetwork().selected.address });
      await fs.rename(partial, output); prepared.set(key, output); return output;
    } finally { unpin(); }

  })().catch(error => { if (downloadSignal?.aborted) throw new Error('所选网络已断开，文件接收已停止，请重新连接后重试'); throw error; }).finally(() => release?.());
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}
function broadcast(channel, value) {
  for (const record of windows.values()) if (!record.win.isDestroyed()) record.win.webContents.send(channel, value);
}
function updateTray() {
  if (!tray || !manager) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '拾传 · 每个群一个窗口', enabled: false },
    ...manager.listGroups().map(group => ({ label: group.name, click: () => openGroup(group.id).catch(showError) })),
    { type: 'separator' },
    { label: '新建或加入群', click: () => openGroup(welcomeGroup.id).catch(showError) },
    { label: '显示所有群', click: () => { for (const group of manager.listGroups()) openGroup(group.id).catch(showError); } },
    { label: '退出拾传', click: () => app.quit() },
  ]));
}
function showError(error) { console.error(error); if (!quitting) dialog.showErrorBox('拾传', error.message || String(error)); }
async function openGroup(groupId) {
  if (quitting) return;
  if (typeof groupId !== 'string' || (groupId !== welcomeGroup.id && !manager.listGroups().some(group => group.id === groupId))) throw new Error('群不存在');
  const existing = windows.get(groupId);
  if (existing && !existing.win.isDestroyed()) { existing.control.expand(true); return publicGroup(groupFor(existing)); }
  if (opening.has(groupId)) return opening.get(groupId);
  const operation = (async () => {
    // Discovery may be temporarily unavailable; keep the saved group available offline.
    try { if (groupId !== welcomeGroup.id) await manager.resolveGroup(groupId); } catch (error) { console.warn('Group discovery:', error.message); }
    if (quitting) return;
    const group = groupId === welcomeGroup.id ? welcomeGroup : manager.listGroups().find(item => item.id === groupId);
    const saved = config.windows[groupId];
    const win = new BrowserWindow({
      ...initialBounds(saved, windows.size), minWidth: 280, minHeight: 340, maxWidth: 900, maxHeight: 1100,
      title: `${group.name} · 拾传`, icon: path.join(__dirname, 'assets', process.platform === 'darwin' ? 'mac-icon.png' : 'icon.png'), frame: nativeFrame, roundedCorners: nativeFrame,
      transparent: !nativeFrame, backgroundColor: nativeFrame ? '#F8FAF7' : '#00000000', hasShadow: nativeFrame, fullscreenable: false, resizable: nativeFrame,
      autoHideMenuBar: true, alwaysOnTop: !nativeFrame, show: false,
      webPreferences: { partition: 'persist:pickdrop-groups', preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const control = (nativeFrame ? createNativeWindowController : createWindowController)(win, saved, value => {
      config.windows[groupId] = value;
      saveConfig().catch(error => console.error('Save window preferences:', error.message));
    });
    const record = { win, groupId, control, transferReleases: [] }; windows.set(groupId, record);
    if (!nativeFrame) { if (process.platform === 'linux') win.setAlwaysOnTop(true); else win.setAlwaysOnTop(true, 'floating'); }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guardNavigation = (event, url) => { try { if (new URL(url).origin !== uiOrigin) event.preventDefault(); } catch { event.preventDefault(); } };
    win.webContents.on('will-navigate', guardNavigation); win.webContents.on('will-redirect', guardNavigation);
    win.webContents.on('did-finish-load', () => control.emit());
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    win.on('closed', () => { record.releaseDragPin?.(); record.transferReleases.forEach(release => release()); windows.delete(groupId); });
    win.webContents.on('render-process-gone', () => { record.transferReleases.splice(0).forEach(release => release()); });
    try { await win.loadURL(uiOrigin); }
    catch (error) { win.destroy(); throw error; }
    if (quitting) { if (!win.isDestroyed()) win.destroy(); return; }
    win.show(); control.restore(); control.emit(); updateTray();
    return publicGroup(groupFor(record));
  })();
  opening.set(groupId, operation);
  try { return await operation; } finally { opening.delete(groupId); }
}
function cacheRoot(groupId) {
  const root = path.join(app.getPath('userData'), 'received');
  return groupId ? path.join(root, createHash('sha256').update(groupId).digest('hex')) : root;
}
function sweepCache(groupId, clear = false) {
  const root = cacheRoot(groupId);
  cacheSweep = cacheSweep.catch(() => {}).then(async () => {
    const { cleanCache } = await import('../../server/cache.js');
    const result = await cleanCache(root, { clear, protectedPaths: cachePins, boundary: app.getPath('userData') });
    for (const [key, file] of prepared) if (file.startsWith(root + path.sep)) {
      if (!await fs.stat(file).catch(() => null)) prepared.delete(key);
    }
    if (result.removedFiles) broadcast('storage:cache-cleared', { groupId: groupId || null });
    return result;
  });
  return cacheSweep;
}
function registerIPC() {
  handle('app:bootstrap', bootstrap);
  handle('storage:get', async record => {
    const { cacheStats, CACHE_POLICY } = await import('../../server/cache.js');
    return { cache: await cacheStats(cacheRoot(record.groupId), { boundary: app.getPath('userData') }), hosted: manager.getHostedInbox(record.groupId)?.storage() || { bytes: 0, files: 0 }, policy: CACHE_POLICY };
  });
  handle('storage:clear-cache', record => sweepCache(record.groupId, true));
  handle('storage:host-files', (record, options = {}) => manager.getHostedInbox(record.groupId)?.listFiles({ before: options?.before }) || []);
  handle('storage:delete-host-files', async (record, ids) => {
    const inbox = manager.getHostedInbox(record.groupId);
    if (!inbox) throw new Error('仅群主机可清理原文件');
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new Error('请选择 1 至 100 个文件');
    if (ids.some(id => { const file = inbox.fileFor(id)?.path; return file && cachePins.has(file); })) throw new Error('文件正在使用，请稍后清理');
    const result = await inbox.deleteFiles(ids);
    for (const id of ids) prepared.delete(cacheKey(groupFor(record), id));
    return result;
  });
  handle('group:list', publicGroups);
  handle('group:create', async (_record, name) => { const group = await manager.createGroup(name); await openGroup(group.id); return publicGroup(group); });
  handle('group:open', (_record, id) => openGroup(id));
  handle('group:join', (_record, code) => manager.joinWithCode(code));
  handle('group:join-at', (_record, address, code, groupId) => manager.joinAt(address, code, groupId));
  handle('group:nearby', () => manager.listNearby());
  handle('group:discovery-status', () => ({ error: manager.getNetwork().discoveryError || '' }));
  handle('group:rename', (record, name) => manager.renameGroup(record.groupId, name));
  handle('group:upgrade', record => manager.upgradeGroup(record.groupId));
  handle('group:reconnect', (record, address) => manager.reconnectGroup(record.groupId, address));
  handle('group:remove-member', (record, id) => manager.removeMember(record.groupId, id));
  handle('group:secure-members', record => manager.secureMembers(record.groupId));
  const detachGroup = async (record, operation) => {
    if (pending.size || record.transferReleases.length) throw new Error('有文件正在传输，请完成后再移除群');
    record.detaching = true;
    try { await manager[operation](record.groupId); } catch (error) { record.detaching = false; throw error; }
    let next = manager.listGroups()[0];
    if (!next) next = welcomeGroup;
    // Group removal is already durable. Cleanup failure must not strand its window.
    await sweepCache(record.groupId, true).catch(error => console.warn('Group cache cleanup:', error.message));
    record.win.destroy();
    delete config.windows[record.groupId]; await saveConfig(); updateTray();
    await openGroup(next.id).catch(async error => { console.warn('Open remaining group:', error.message); await openGroup(welcomeGroup.id); });
    return true;
  };
  handle('group:leave', record => detachGroup(record, 'leaveGroup'));
  handle('group:forget', record => detachGroup(record, 'forgetGroup'));
  handle('group:delete', record => detachGroup(record, 'deleteGroup'));
  handle('network:get', async () => { await manager.refreshNetwork(); return manager.getNetwork(); });
  handle('network:set', async (_record, value) => {
    if (pending.size) throw new Error('有文件正在接收，请完成后再切换网络');
    return manager.setNetwork(value);
  });
  handle('transfer:busy', (record, value) => {
    if (value) record.transferReleases.push(manager.acquireTransfer());
    else record.transferReleases.pop()?.();
    return true;
  });
  handle('group:check', async (_record, ticket) => {
    const result = await manager.checkJoin(ticket);
    if (result.status === 'approved' && result.group) await openGroup(result.group.id);
    return result.group ? { ...result, group: publicGroup(result.group) } : result;
  });
  handle('group:invite', async record => {
    const invite = await manager.createInvite(record.groupId);
    if (!invite.link || !invite.baseUrl) throw new Error('当前没有可分享地址，请在网络设置选择已连接的网卡');
    const qrDataUrl = await require('qrcode').toDataURL(invite.link, { width: 224, margin: 2, errorCorrectionLevel: 'M' });
    return { ...invite, qrDataUrl };
  });
  handle('group:requests', record => manager.listJoinRequests(record.groupId));
  handle('group:respond', (record, id, allow) => { if (typeof allow !== 'boolean') throw new Error('无效的审核操作'); return manager.respondJoin(record.groupId, id, allow); });
  handle('app:rename', async (record, name) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('请输入设备名称');
    config.device.name = name.trim().slice(0, 40); await manager.updateDevice(config.device.name); await saveConfig();
    broadcast('groups:changed', publicGroups()); return bootstrap(record);
  });
  handle('app:copy', (_record, text) => { if (typeof text !== 'string' || text.length > 1e6) throw new Error('复制内容无效'); clipboard.writeText(text); return true; });
  handle('app:clipboard-image', () => readClipboardImage(clipboard, nativeImage));
  handle('window:pin', (record, value) => record.control.setPinned(value));
  handle('window:dock', record => record.control.dock());
  handle('window:expand', record => record.control.expand(true));
  handle('window:busy', (record, value) => { record.control.setBusy('ui', value); return true; });
  handle('window:native-busy', (record, value) => { record.control.setBusy('native', Boolean(value)); return true; });
  handle('window:close', record => { record.win.hide(); return true; });
  handle('file:preview', async (record, id, full) => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('文件编号不正确');
    const hosted = manager.getHostedInbox(record.groupId);
    const message = hosted ? hosted.fileFor(id)?.message : await manager.authenticated(record.groupId, `/api/messages/${id}`);
    if (!canPreview(message)) throw new Error('该图片暂不支持预览，请保存后打开');
    const file = await prepareFile(record, id), unpin = pinCache(file);
    try {
      const stat = await fs.stat(file);
      if (stat.size !== message.size) throw new Error('图片校验失败，请重新接收');
      return imagePreview(await fs.readFile(file), message, nativeImage, full === true);
    } finally { unpin(); }
  });
  handle('file:prepare', async (record, id) => { await prepareFile(record, id); return true; });
  handle('file:reveal', async (record, id) => { shell.showItemInFolder(await prepareFile(record, id)); });
  handle('file:open', async (record, id) => { const error = await shell.openPath(await prepareFile(record, id)); if (error) throw new Error(error); });
  handle('file:save', async (record, id) => {
    if (record.saving) throw new Error('请先完成当前保存');
    record.saving = true; record.control.setBusy('native', true);
    let file, unpin;
    try {
      file = await prepareFile(record, id); unpin = pinCache(file);
      const choice = await dialog.showSaveDialog(record.win, { defaultPath: path.join(app.getPath('downloads'), path.basename(file)) });
      if (choice.canceled) return false;
      if (path.resolve(choice.filePath) !== path.resolve(file)) await fs.copyFile(file, choice.filePath);
      return true;
    } finally { unpin?.(); record.saving = false; record.control.setBusy('native', false); }
  });
  ipcMain.on('window:activity', (event, type, value) => {
    const record = recordFor(event); if (!record) return;
    if (type === 'window-drag-start') record.control.startWindowDrag();
    if (type === 'window-resize-start') record.control.startWindowResize();
    if (type === 'window-drag-end') record.control.endWindowDrag(Boolean(value));
    if (type === 'reduced-motion') record.control.setReducedMotion(value);
    if (type === 'pointer') record.control.pointer(Boolean(value));
    if (type === 'input') record.control.setBusy('input', value);
    if (type === 'drag') record.control.dragActivity(value);
    if (type === 'drag-end') { record.releaseDragPin?.(); record.releaseDragPin = null; record.dragFile = null; record.control.nativeDragEnd(); }
  });
  ipcMain.on('file:drag', (event, id) => {
    const record = recordFor(event); if (!record || typeof id !== 'string') return;
    const file = prepared.get(cacheKey(groupFor(record), id));
    if (!file) return;
    record.releaseDragPin?.(); record.releaseDragPin = pinCache(file); record.dragFile = file;
    record.control.nativeDragStart();
    try { event.sender.startDrag({ file, icon: dragIcon }); }
    catch (error) { record.releaseDragPin?.(); record.releaseDragPin = null; record.dragFile = null; console.error('Native drag:', error.message); record.control.nativeDragEnd(); }
  });
}

app.setName('PickDrop');
if (process.env.PICKDROP_USER_DATA) app.setPath('userData', path.resolve(process.env.PICKDROP_USER_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
else startupPromise = app.whenReady().then(async () => {
  if (quitting) return;
  try {
    const dataDir = app.getPath('userData');
    configPath = path.join(dataDir, 'preferences.json');
    const { readJsonWithBackup } = await import('../../server/persistence.js');
    config = await readJsonWithBackup(configPath, value => value && typeof value === 'object' && (!value.device || /^[a-f0-9-]{36}$/i.test(value.device.id)) && (!value.windows || typeof value.windows === 'object')) || {};
    await sweepCache();
    cacheTimer = setInterval(() => sweepCache().catch(error => console.error('缓存清理失败:', error.message)), 15 * 60 * 1000); cacheTimer.unref();
    config.device ||= { id: randomUUID(), name: os.hostname().split('.')[0], kind: 'desktop' };
    config.windows ||= {};
    await saveConfig();
    const { createGroupManager } = await import('../../server/groups.js');
    manager = await createGroupManager({ dataDir, device: config.device, peerGroups: !(process.env.PICKDROP_USER_DATA && process.env.PICKDROP_TEST_LEGACY_GROUPS === '1') });
    config.device = manager.device; await saveConfig();
    let groups = manager.listGroups();
    if (!groups.length && !config.initialized) { await manager.createGroup('传输群 1'); groups = manager.listGroups(); }
    config.initialized = true; await saveConfig();
    const { createDesktopUiServer } = await import('../../server/index.js');
    const { createDesktopNetworkProxy } = await import('../../server/desktop-proxy.js');
    uiServer = await createDesktopUiServer(); uiOrigin = uiServer.baseUrl;
    networkProxy = await createDesktopNetworkProxy(manager);
    await session.fromPartition('persist:pickdrop-groups').setProxy({ proxyRules: networkProxy.address, proxyBypassRules: '127.0.0.1;localhost' });
    registerIPC();
    manager.events.on('groups-changed', () => {
      const available = new Set(manager.listGroups().map(group => group.id));
      for (const record of windows.values()) {
        if (record.groupId === welcomeGroup.id || record.detaching || available.has(record.groupId)) continue;
        record.win.destroy(); delete config.windows[record.groupId];
      }
      for (const record of windows.values()) if (!record.detaching && !record.win.isDestroyed()) record.win.webContents.send('groups:changed', publicGroups());
      updateTray();
      if (!quitting && !windows.size && uiOrigin) openGroup(manager.listGroups()[0]?.id || welcomeGroup.id).catch(showError);
    });
    manager.events.on('network-changed', value => { networkTransfers.networkChanged(value); if (value.switching || !value.available) networkProxy.disconnect(); broadcast('network:changed', value); });
    manager.events.on('network-error', error => console.warn('Network:', error.message));
    manager.events.on('discovery-error', error => { discoveryError = error.message || String(error); broadcast('discovery:error', discoveryError); console.warn('Discovery:', discoveryError); });
    manager.events.on('nearby-changed', () => broadcast('nearby:changed', {}));
    manager.events.on('requests-changed', () => broadcast('requests:changed', {}));
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'icon.png'));
    if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
    const sizedTrayIcon = process.platform === 'darwin' ? trayIcon : trayIcon.resize({ width: 20, height: 20 });
    tray = new Tray(sizedTrayIcon); tray.setToolTip('拾传 · 群聊文件投递');
    tray.on('click', () => { const group = manager.listGroups()[0] || welcomeGroup; openGroup(group.id).catch(showError); });
    updateTray();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '拾传', submenu: [{ role: 'about' }, { type: 'separator' }, { label: '显示所有群', click: () => { for (const group of manager.listGroups()) openGroup(group.id).catch(showError); } }, { role: 'hide' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]));
    // Each remembered group is independent; closing a window only hides it.
    for (const group of groups.length ? groups : [welcomeGroup]) await openGroup(group.id);
  } catch (error) { console.error(error); if (!quitting) { dialog.showErrorBox('拾传无法启动', error.message); app.quit(); } }
});
app.on('window-all-closed', () => {});
app.on('activate', () => { const first = manager?.listGroups()[0]; if (manager) openGroup(first?.id || welcomeGroup.id).catch(showError); });
app.on('second-instance', () => { const first = manager?.listGroups()[0]; if (manager) openGroup(first?.id || welcomeGroup.id).catch(showError); });
app.on('before-quit', event => {
  if (quitFinished) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  // Stop renderers before closing their endpoints. Otherwise their reconnects
  // (or a second-instance activation) can reopen an already stopped UI server.
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  (async () => {
    // Quit may arrive while asynchronous startup/openGroup is still in flight.
    // Their quitting guards prevent creating/showing more windows; then all
    // resources they created can be closed, and closed-window state is flushed.
    await startupPromise;
    await Promise.allSettled([...opening.values()]);
    clearInterval(cacheTimer); networkTransfers.close(); tray?.destroy();
    await Promise.allSettled([networkProxy?.close(), manager?.close({ force: true }), uiServer?.close({ force: true }), cacheSweep]);
    await saveQueue;
  })().catch(error => console.error('退出清理失败:', error)).finally(() => { quitFinished = true; app.quit(); });
});
