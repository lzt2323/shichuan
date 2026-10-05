const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, clipboard, Menu, Tray, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http'), https = require('node:https');
const fs = require('node:fs/promises');
const { createWriteStream, createReadStream } = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createNetworkTransferScope } = require('./network-transfers.cjs');
const { readClipboardImage } = require('./clipboard-image.cjs');
const networkTransfers = createNetworkTransferScope();
const { initialBounds, createWindowController } = require('./window-controller.cjs');

let manager, config, configPath, tray, uiOrigin, uiServer, networkProxy, quitting = false, saveQueue = Promise.resolve();
const windows = new Map(), opening = new Map(), prepared = new Map(), pending = new Map();
const dragIcon = nativeImage.createFromPath(path.join(__dirname, 'assets/drag-icon.png'));
function saveConfig() {
  const serialized = JSON.stringify(config, null, 2);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(configPath + '.tmp', serialized, { mode: 0o600 });
    await fs.rename(configPath + '.tmp', configPath);
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
  const group = manager.listGroups().find(item => item.id === record.groupId);
  if (!group) throw new Error('群不存在');
  return group;
}
function publicGroup({ key, ...group }) { return group; }
function publicGroups() { return manager.listGroups().map(publicGroup); }
function bootstrap(record) {
  const group = groupFor(record);
  return { device: config.device, group, room: group, groups: publicGroups(), native: true, platform: process.platform, window: record.control.state(), network: manager.getNetwork() };
}
function cacheKey(group, id) { return `${group.id}|${group.key}|${id}`; }
async function prepareFile(record, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('文件编号不正确');
  let group = groupFor(record); const key = cacheKey(group, id);
  const requestHeaders = { 'X-Room-Key': group.key, 'X-Device-Id': config.device.id };
  if (prepared.has(key)) {
    try { await fs.access(prepared.get(key)); return prepared.get(key); }
    catch (error) { if (error.code !== 'ENOENT') throw error; prepared.delete(key); }
  }
  if (pending.has(key)) return pending.get(key);
  let release, downloadSignal;
  const operation = (async () => {
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
    const state = await manager.authenticated(group.id, '/api/state', { signal }), message = state.messages.find(item => item.id === id && item.type === 'file');
    if (!message) throw new Error('找不到这个文件');
    if (!/^[a-f0-9]{64}$/i.test(message.sha256)) throw new Error('文件校验信息不正确');
    const { safeFileName } = await import('../../shared/protocol.js');
    const groupDir = createHash('sha256').update(group.id).digest('hex');
    const dir = path.join(app.getPath('userData'), 'received', groupDir, id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const output = path.join(dir, safeFileName(message.fileName)), partial = output + '.part';
    try {
      const bytes = await fs.stat(output);
      if (bytes.size === message.size) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(output)) hash.update(chunk);
        if (hash.digest('hex') === message.sha256) { prepared.set(key, output); return output; }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const download = await new Promise((resolve, reject) => {
      const target = new URL(`${group.baseUrl}/api/files/${id}`), transport = target.protocol === 'https:' ? https : http;
      const request = transport.get(target, { headers: requestHeaders, localAddress: manager.getNetwork().selected.address, signal, timeout: 60 * 60 * 1000 }, resolve);
      request.on('timeout', () => request.destroy(new Error('文件接收超时'))); request.on('error', reject);
    });
    if (download.statusCode !== 200) { download.destroy(); throw new Error('文件接收失败'); }
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({ transform(chunk, enc, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(download, meter, createWriteStream(partial, { mode: 0o600 }), { signal });
      if (hash.digest('hex') !== message.sha256 || bytes !== message.size) throw new Error('文件完整性校验失败，请重新接收');
      await fs.rename(partial, output); prepared.set(key, output); return output;
    } catch (error) { await fs.rm(partial, { force: true }); throw error; }
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
    { label: '显示所有群', click: () => { for (const group of manager.listGroups()) openGroup(group.id).catch(showError); } },
    { label: '退出拾传', click: () => app.quit() },
  ]));
}
function showError(error) { console.error(error); dialog.showErrorBox('拾传', error.message || String(error)); }
async function openGroup(groupId) {
  if (typeof groupId !== 'string' || !manager.listGroups().some(group => group.id === groupId)) throw new Error('群不存在');
  const existing = windows.get(groupId);
  if (existing && !existing.win.isDestroyed()) { existing.control.expand(true); return publicGroup(groupFor(existing)); }
  if (opening.has(groupId)) return opening.get(groupId);
  const operation = (async () => {
    // Discovery may be temporarily unavailable; keep the saved group available offline.
    try { await manager.resolveGroup(groupId); } catch (error) { console.warn('Group discovery:', error.message); }
    const group = manager.listGroups().find(item => item.id === groupId);
    const saved = config.windows[groupId];
    const win = new BrowserWindow({
      ...initialBounds(saved, windows.size), minWidth: 280, minHeight: 340, maxWidth: 900, maxHeight: 1100,
      title: `${group.name} · 拾传`, icon: path.join(__dirname, 'assets/icon.png'), frame: false, roundedCorners: false,
      transparent: true, backgroundColor: '#00000000', hasShadow: false, fullscreenable: false, resizable: false,
      autoHideMenuBar: true, alwaysOnTop: true, show: false,
      webPreferences: { partition: 'persist:pickdrop-groups', preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const control = createWindowController(win, saved, value => {
      config.windows[groupId] = value;
      saveConfig().catch(error => console.error('Save window preferences:', error.message));
    });
    const record = { win, groupId, control, transferReleases: [] }; windows.set(groupId, record);
    win.setAlwaysOnTop(true, 'floating');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guardNavigation = (event, url) => { try { if (new URL(url).origin !== uiOrigin) event.preventDefault(); } catch { event.preventDefault(); } };
    win.webContents.on('will-navigate', guardNavigation); win.webContents.on('will-redirect', guardNavigation);
    win.webContents.on('did-finish-load', () => control.emit());
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    win.on('closed', () => { record.transferReleases.forEach(release => release()); windows.delete(groupId); });
    win.webContents.on('render-process-gone', () => { record.transferReleases.splice(0).forEach(release => release()); });
    try { await win.loadURL(uiOrigin); }
    catch (error) { win.destroy(); throw error; }
    win.show(); control.restore(); control.emit(); updateTray();
    return publicGroup(groupFor(record));
  })();
  opening.set(groupId, operation);
  try { return await operation; } finally { opening.delete(groupId); }
}
function registerIPC() {
  handle('app:bootstrap', bootstrap);
  handle('group:list', publicGroups);
  handle('group:create', async (_record, name) => { const group = await manager.createGroup(name); await openGroup(group.id); return publicGroup(group); });
  handle('group:open', (_record, id) => openGroup(id));
  handle('group:join', (_record, code) => manager.joinWithCode(code));
  handle('group:join-at', (_record, address, code, groupId) => manager.joinAt(address, code, groupId));
  handle('group:nearby', () => manager.listNearby());
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
  handle('window:close', record => { record.win.hide(); return true; });
  handle('window:minimize', record => { record.win.hide(); return true; });
  handle('file:prepare', async (record, id) => { await prepareFile(record, id); return true; });
  handle('file:reveal', async (record, id) => { shell.showItemInFolder(await prepareFile(record, id)); });
  handle('file:open', async (record, id) => { const error = await shell.openPath(await prepareFile(record, id)); if (error) throw new Error(error); });
  handle('file:save', async (record, id) => {
    record.control.setBusy('native', true);
    try {
      const file = await prepareFile(record, id);
      const choice = await dialog.showSaveDialog(record.win, { defaultPath: path.join(app.getPath('downloads'), path.basename(file)) });
      if (choice.canceled) return false;
      if (path.resolve(choice.filePath) !== path.resolve(file)) await fs.copyFile(file, choice.filePath);
      return true;
    } finally { record.control.setBusy('native', false); }
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
    if (type === 'drag-end') record.control.nativeDragEnd();
  });
  ipcMain.on('file:drag', (event, id) => {
    const record = recordFor(event); if (!record || typeof id !== 'string') return;
    const file = prepared.get(cacheKey(groupFor(record), id));
    if (!file) return;
    record.control.nativeDragStart();
    try { event.sender.startDrag({ file, icon: dragIcon }); }
    catch (error) { console.error('Native drag:', error.message); record.control.nativeDragEnd(); }
  });
}

app.setName('PickDrop');
if (process.env.PICKDROP_USER_DATA) app.setPath('userData', path.resolve(process.env.PICKDROP_USER_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  try {
    const dataDir = app.getPath('userData');
    configPath = path.join(dataDir, 'preferences.json');
    try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; config = {}; }
    config.device ||= { id: randomUUID(), name: os.hostname().split('.')[0], kind: 'desktop' };
    config.windows ||= {};
    await saveConfig();
    const { createGroupManager } = await import('../../server/groups.js');
    manager = await createGroupManager({ dataDir, device: config.device });
    config.device = manager.device; await saveConfig();
    let groups = manager.listGroups();
    if (!groups.some(group => group.local)) { await manager.createGroup('我的设备'); groups = manager.listGroups(); }
    const { createDesktopUiServer } = await import('../../server/index.js');
    const { createDesktopNetworkProxy } = await import('../../server/desktop-proxy.js');
    uiServer = await createDesktopUiServer(); uiOrigin = uiServer.baseUrl;
    networkProxy = await createDesktopNetworkProxy(manager);
    await session.fromPartition('persist:pickdrop-groups').setProxy({ proxyRules: networkProxy.address, proxyBypassRules: '127.0.0.1;localhost' });
    registerIPC();
    manager.events.on('groups-changed', () => { broadcast('groups:changed', publicGroups()); updateTray(); });
    manager.events.on('network-changed', value => { networkTransfers.networkChanged(value); if (value.switching || !value.available) networkProxy.disconnect(); broadcast('network:changed', value); });
    manager.events.on('network-error', error => console.warn('Network:', error.message));
    manager.events.on('discovery-error', error => console.warn('Discovery:', error.message));
    manager.events.on('requests-changed', () => broadcast('requests:changed', {}));
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'icon.png'));
    if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
    const sizedTrayIcon = process.platform === 'darwin' ? trayIcon : trayIcon.resize({ width: 20, height: 20 });
    tray = new Tray(sizedTrayIcon); tray.setToolTip('拾传 · 群聊文件投递');
    tray.on('click', () => { const group = manager.listGroups()[0]; if (group) openGroup(group.id).catch(showError); });
    updateTray();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '拾传', submenu: [{ role: 'about' }, { type: 'separator' }, { label: '显示所有群', click: () => { for (const group of manager.listGroups()) openGroup(group.id).catch(showError); } }, { role: 'hide' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]));
    // Each remembered group is independent; closing a window only hides it.
    for (const group of groups) await openGroup(group.id);
  } catch (error) { console.error(error); dialog.showErrorBox('拾传无法启动', error.message); app.quit(); }
});
app.on('window-all-closed', () => {});
app.on('activate', () => { const first = manager?.listGroups()[0]; if (first) openGroup(first.id).catch(showError); });
app.on('second-instance', () => { const first = manager?.listGroups()[0]; if (first) openGroup(first.id).catch(showError); });
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true; networkTransfers.close();
  Promise.allSettled([networkProxy?.close(), manager?.close(), uiServer?.close(), saveQueue]).finally(() => { tray?.destroy(); app.quit(); });
});
