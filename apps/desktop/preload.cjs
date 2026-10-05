const { contextBridge, ipcRenderer } = require('electron');
const subscribe = channel => callback => {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('pickdrop', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  listGroups: () => ipcRenderer.invoke('group:list'),
  createGroup: name => ipcRenderer.invoke('group:create', name),
  openGroup: id => ipcRenderer.invoke('group:open', id),
  joinGroup: code => ipcRenderer.invoke('group:join', code),
  joinAt: (address, code, groupId) => ipcRenderer.invoke('group:join-at', address, code, groupId),
  listNearby: () => ipcRenderer.invoke('group:nearby'),
  getNetwork: () => ipcRenderer.invoke('network:get'),
  setNetwork: value => ipcRenderer.invoke('network:set', value),
  setTransferBusy: value => ipcRenderer.invoke('transfer:busy', value),
  onNetworkChanged: subscribe('network:changed'),
  checkJoin: ticket => ipcRenderer.invoke('group:check', ticket),
  createInvite: () => ipcRenderer.invoke('group:invite'),
  listJoinRequests: () => ipcRenderer.invoke('group:requests'),
  respondJoin: (id, allow) => ipcRenderer.invoke('group:respond', id, allow),
  rename: name => ipcRenderer.invoke('app:rename', name),
  copy: text => ipcRenderer.invoke('app:copy', text),
  prepareFile: id => ipcRenderer.invoke('file:prepare', id),
  startDrag: id => ipcRenderer.send('file:drag', id),
  revealFile: id => ipcRenderer.invoke('file:reveal', id),
  openFile: id => ipcRenderer.invoke('file:open', id),
  saveFile: id => ipcRenderer.invoke('file:save', id),
  pin: value => ipcRenderer.invoke('window:pin', value),
  dock: () => ipcRenderer.invoke('window:dock'),
  expand: () => ipcRenderer.invoke('window:expand'),
  close: () => ipcRenderer.invoke('window:close'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  setInteractionBusy: value => ipcRenderer.invoke('window:busy', value),
  onGroupsChanged: subscribe('groups:changed'),
  onJoinRequestsChanged: subscribe('requests:changed'),
  onWindowChanged: subscribe('window:changed'),
  onWindowState: subscribe('window:changed'),
});

// A real, narrow BrowserWindow receives file drag events. No global drop hooks or
// transparent full-height hit area are installed at the screen edge.
let tab, latestState = { collapsed: false }, groupName = '拾传';
function renderTab() {
  if (!tab) return;
  tab.hidden = !latestState.collapsed || Boolean(latestState.transition);
  tab.title = `${groupName} · 拖动移位，悬停展开，拖入文件发送`;
  tab.textContent = '';
  tab.setAttribute('aria-label', `${groupName} · 展开群窗口`);
  if (latestState.moving) suppressTabClick = true;
  const root = document.documentElement;
  root.dataset.pickdropCollapsed = latestState.collapsed && !latestState.transition ? 'true' : 'false';
  root.dataset.windowEdge = latestState.edge || '';
  root.dataset.snapEdge = latestState.candidateEdge || '';
  root.dataset.windowMoving = latestState.moving ? 'true' : 'false';
  root.dataset.windowTransition = latestState.transition || '';
  root.style.setProperty('--content-width', `${latestState.contentWidth || 340}px`);
  root.style.setProperty('--content-height', `${latestState.contentHeight || 470}px`);
}
ipcRenderer.on('window:changed', (_event, state) => { latestState = state; renderTab(); });
window.addEventListener('DOMContentLoaded', async () => {
  tab = document.createElement('button'); tab.id = 'pickdrop-native-tab'; tab.type = 'button';
  tab.setAttribute('aria-label', '展开群窗口');
  tab.addEventListener('click', () => { if (!suppressTabClick) ipcRenderer.invoke('window:expand'); });
  document.body.append(tab); renderTab();
  try { const data = await ipcRenderer.invoke('app:bootstrap'); groupName = data.group.name; latestState = data.window; renderTab(); } catch { /* Renderer reports bootstrap failures. */ }
});
window.addEventListener('mouseenter', () => ipcRenderer.send('window:activity', 'pointer', true));
window.addEventListener('mouseleave', () => ipcRenderer.send('window:activity', 'pointer', false));
const isInput = node => node instanceof Element && Boolean(node.closest('input,textarea,[contenteditable="true"],[role="dialog"]'));
window.addEventListener('focusin', event => ipcRenderer.send('window:activity', 'input', isInput(event.target)), true);
window.addEventListener('focusout', () => setTimeout(() => ipcRenderer.send('window:activity', 'input', isInput(document.activeElement)), 0), true);
window.addEventListener('dragenter', event => {
  if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); ipcRenderer.send('window:activity', 'drag', true); }
}, true);
window.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); ipcRenderer.send('window:activity', 'drag', true); }
}, true);
window.addEventListener('drop', () => ipcRenderer.send('window:activity', 'drag', false), true);
window.addEventListener('dragend', () => { ipcRenderer.send('window:activity', 'drag', false); ipcRenderer.send('window:activity', 'drag-end'); }, true);
// A released pointer after a native drag also clears the conservative drag lock.
window.addEventListener('pointerup', () => ipcRenderer.send('window:activity', 'drag-end'), true);

// Capture on the root so changing a tab into a full window never loses capture.
// Main reads screen coordinates directly; renderer screenX can jump on mixed-DPI displays.
let windowPointer = null, suppressTabClick = false, clickReset;
window.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const handle = event.target.closest('#pickdrop-native-tab, .titlebar, .custom-window-resize-handle');
  const resizing = handle?.classList.contains('custom-window-resize-handle');
  if (!handle || (!resizing && handle !== tab && event.target.closest('button,input,a'))) return;
  event.preventDefault();
  document.activeElement?.blur();
  windowPointer = { id: event.pointerId, x: event.screenX, y: event.screenY, fromTab: handle === tab };
  suppressTabClick = false; clearTimeout(clickReset);
  document.documentElement.setPointerCapture(event.pointerId);
  ipcRenderer.send('window:activity', resizing ? 'window-resize-start' : 'window-drag-start');
}, true);
window.addEventListener('pointermove', event => {
  if (windowPointer && Math.hypot(event.screenX - windowPointer.x, event.screenY - windowPointer.y) >= 5) suppressTabClick = true;
}, true);
function finishWindowPointer(cancel = false) {
  if (!windowPointer) return;
  const { id, fromTab } = windowPointer; windowPointer = null;
  if (fromTab && !suppressTabClick && !cancel) ipcRenderer.invoke('window:expand');
  ipcRenderer.send('window:activity', 'window-drag-end', cancel);
  if (document.documentElement.hasPointerCapture(id)) document.documentElement.releasePointerCapture(id);
  clickReset = setTimeout(() => { suppressTabClick = false; }, 0);
}
window.addEventListener('pointerup', () => finishWindowPointer(), true);
window.addEventListener('pointercancel', () => finishWindowPointer(true), true);
window.addEventListener('lostpointercapture', event => {
  if (!windowPointer || event.pointerId !== windowPointer.id) return;
  // Expanding a top hemisphere changes both viewport axes. Chromium can release
  // capture during that native resize even though the physical button is down.
  // Keep the same pointer session, but only while Chromium accepts capture.
  const root = document.documentElement;
  try {
    root.setPointerCapture(windowPointer.id);
    if (!root.hasPointerCapture(windowPointer.id)) finishWindowPointer(true);
  } catch { finishWindowPointer(true); }
}, true);
// Also accept the mouse release if a platform loses pointer capture while its
// native window is resizing. Blur, pointercancel and Escape remain hard stops.
window.addEventListener('mouseup', event => { if (event.button === 0) finishWindowPointer(); }, true);
window.addEventListener('blur', () => finishWindowPointer(true));
window.addEventListener('keydown', event => { if (event.key === 'Escape') finishWindowPointer(true); });
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const reportMotion = () => ipcRenderer.send('window:activity', 'reduced-motion', motionPreference.matches);
motionPreference.addEventListener('change', reportMotion);
window.addEventListener('DOMContentLoaded', reportMotion);
