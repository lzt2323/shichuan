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
  onNearbyChanged: subscribe('nearby:changed'),
  removeMember: id => ipcRenderer.invoke('group:remove-member', id),
  secureMembers: () => ipcRenderer.invoke('group:secure-members'),
  leaveGroup: () => ipcRenderer.invoke('group:leave'),
  forgetGroup: () => ipcRenderer.invoke('group:forget'),
  getStorage: () => ipcRenderer.invoke('storage:get'),
  clearCache: () => ipcRenderer.invoke('storage:clear-cache'),
  listHostFiles: options => ipcRenderer.invoke('storage:host-files', options),
  deleteHostFiles: ids => ipcRenderer.invoke('storage:delete-host-files', ids),
  onCacheCleared: subscribe('storage:cache-cleared'),
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
  readClipboardImage: () => ipcRenderer.invoke('app:clipboard-image'),
  previewFile: (id, full = false) => ipcRenderer.invoke('file:preview', id, full),
  prepareFile: id => ipcRenderer.invoke('file:prepare', id),
  startDrag: id => ipcRenderer.send('file:drag', id),
  revealFile: id => ipcRenderer.invoke('file:reveal', id),
  openFile: id => ipcRenderer.invoke('file:open', id),
  saveFile: id => ipcRenderer.invoke('file:save', id),
  pin: value => ipcRenderer.invoke('window:pin', value),
  dock: () => ipcRenderer.invoke('window:dock'),
  expand: () => ipcRenderer.invoke('window:expand'),
  close: () => ipcRenderer.invoke('window:close'),
  setNativeDialogBusy: value => ipcRenderer.invoke('window:native-busy', value),
  setInteractionBusy: value => ipcRenderer.invoke('window:busy', value),
  onGroupsChanged: subscribe('groups:changed'),
  onJoinRequestsChanged: subscribe('requests:changed'),
  onWindowChanged: subscribe('window:changed'),
});

// A real, narrow BrowserWindow receives file drag events. No global drop hooks or
// transparent full-height hit area are installed at the screen edge.
let tab, latestState = { collapsed: false }, groupName = '拾传';
function renderTab() {
  if (!tab) return;
  tab.hidden = !latestState.collapsed || Boolean(latestState.transition);
  tab.title = `${groupName} · 拖动移位，悬停展开，拖入文件发送`;
  tab.dataset.accepting = String(Boolean(latestState.accepting));
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
  // Original vector courier cat, drawn only inside the small native edge window.
  tab.innerHTML = `<svg class="courier-cat" viewBox="0 0 64 64" aria-hidden="true"><g class="cat-body"><path class="cat-tail" d="M45 51c19 4 18-14 10-13" fill="none" stroke="#e6e9d9" stroke-width="7" stroke-linecap="round"/><path d="M15 48c-4-14-3-25 2-37l13 10 12-9c8 12 10 25 6 37Z" fill="#F8FAF7" stroke="#b4c6b7" stroke-width="1.5"/><path d="m18 15 8 7-9 2m25-7-7 7 10 1" fill="#ddcbbd"/><path d="M19 34c0-8 25-8 25 0v8c0 9-25 9-25 0Z" fill="#f0ede2"/><g class="cat-eyes" fill="#244a40"><ellipse cx="24" cy="33" rx="2" ry="3"/><ellipse cx="39" cy="33" rx="2" ry="3"/></g><path d="m29 39 3 2 3-2m-3 2v3" fill="none" stroke="#80655a" stroke-width="1.5" stroke-linecap="round"/><path d="m11 36 9 2m-8 5 8-1m24-4 9-2m-9 6 9 1" stroke="#b4c6b7" stroke-width="1"/><g class="cat-parcel"><rect x="19" y="46" width="26" height="15" rx="4" fill="#126A5A"/><path d="m21 48 11 7 11-7" fill="none" stroke="#83e1c1" stroke-width="1.5"/></g><g class="cat-paws" fill="#F8FAF7" stroke="#b4c6b7" stroke-width="1"><ellipse cx="18" cy="50" rx="5" ry="7"/><ellipse cx="46" cy="50" rx="5" ry="7"/></g></g></svg>`;
  tab.addEventListener('click', () => { if (!suppressTabClick) ipcRenderer.invoke('window:expand'); });
  document.body.append(tab); renderTab();
  try { const data = await ipcRenderer.invoke('app:bootstrap'); groupName = data.group.name; latestState = data.window; renderTab(); } catch { /* Renderer reports bootstrap failures. */ }
});
window.addEventListener('mouseenter', () => ipcRenderer.send('window:activity', 'pointer', true));
window.addEventListener('mouseleave', () => ipcRenderer.send('window:activity', 'pointer', false));
const isInput = node => document.hasFocus() && node instanceof Element && Boolean(node.closest('input,textarea,[contenteditable="true"],[role="dialog"]'));
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
  windowPointer = { id: event.pointerId, x: event.screenX, y: event.screenY, fromTab: handle === tab, width: innerWidth, height: innerHeight };
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
  // A native reveal changes both viewport axes. Chromium's capture-loss event
  // reports buttons=0 even while held, and can temporarily reject recapture.
  // Only that known small-tab resize keeps the session; release, cancel, Escape
  // and lost focus still terminate it through the handlers below.
  const root = document.documentElement;
  const revealingTab = windowPointer.fromTab && (innerWidth > windowPointer.width || innerHeight > windowPointer.height) && document.hasFocus();
  try {
    root.setPointerCapture(windowPointer.id);
    if (!root.hasPointerCapture(windowPointer.id) && !revealingTab) finishWindowPointer(true);
  } catch { if (!revealingTab) finishWindowPointer(true); }
}, true);
// Also accept the mouse release if a platform loses pointer capture while its
// native window is resizing. Blur, pointercancel and Escape remain hard stops.
window.addEventListener('mouseup', event => { if (event.button === 0) finishWindowPointer(); }, true);
window.addEventListener('blur', () => {
  ipcRenderer.send('window:activity', 'input', false);
  setTimeout(() => { if (!document.hasFocus()) finishWindowPointer(true); }, 60);
});
window.addEventListener('focus', () => ipcRenderer.send('window:activity', 'input', isInput(document.activeElement)));
window.addEventListener('keydown', event => { if (event.key === 'Escape') finishWindowPointer(true); });
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const reportMotion = () => ipcRenderer.send('window:activity', 'reduced-motion', motionPreference.matches);
motionPreference.addEventListener('change', reportMotion);
window.addEventListener('DOMContentLoaded', reportMotion);
