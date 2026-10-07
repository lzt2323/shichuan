import { parseRoomLink, fileSize } from '/protocol.js';
import { mergeState, prependHistory } from '/history.js';
import { ImageDrafts, createImagePasteHandler } from '/clipboard-images.js';

const $ = id => document.getElementById(id);
const bridge = window.pickdrop;
let config, socket, epoch = 0, reconnectTimer, toastTimer, dropDepth = 0, preparing = 0, uploading = 0;
let requestController = new AbortController(), reconnectAttempt = 0, connectionError = '', nearbyRefresh;
let pendingTicket, pendingTimer, requestsLoading = false, groupsLoading = false, groupsDirty = false;
let state = { messages: [], devices: [] }, groups = [], requests = [], online = false, panelKind = '', inviteTimer;
const ready = new Map(), prepareQueue = [];
const imageDrafts = new ImageDrafts();
let sendingComposer = false, historyLoaded = false, readingHistory = false;
const observedFiles = new Set();
const AUTO_RECEIVE_BYTES = 8 * 1024 ** 2;
const messageNodes = new Map();
const element = (tag, className, text) => {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
};
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function showError(error) { toast(error?.message || '操作失败，请重试'); }
function action(label, callback, className = '', id = '') {
  const button = element('button', className, label); button.type = 'button'; if (id) button.id = id;
  button.addEventListener('click', event => { event.stopPropagation(); Promise.resolve().then(callback).catch(showError); }); return button;
}
function fileIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', kind === 'more' ? 'M5 12h.01M12 12h.01M19 12h.01' : 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M8 8h.01');
  svg.append(path); return svg;
}
function previewable(message) { return Boolean(bridge?.previewFile && !message.deleted && /^image\/(png|jpeg|webp)$/i.test(message.mime || '') && /\.(png|jpe?g|webp)$/i.test(message.fileName) && message.size > 0 && message.size <= AUTO_RECEIVE_BYTES); }
let previewGeneration = 0, activePreviewId = null;
async function openImage(message) {
  if (state.messages.find(item => item.id === message.id)?.deleted) return;
  const token = ++previewGeneration; activePreviewId = message.id;
  const body = openPanel(message.fileName, 'image-preview');
  body.append(description('正在校验并加载图片…'));
  try {
    const result = await bridge.previewFile(message.id, true);
    if (token !== previewGeneration || panelKind !== 'image-preview' || !$('panel').open) return;
    const image = element('img', 'image-preview-full'); image.src = result.url; image.alt = message.fileName;
    const controls = element('div', 'image-preview-controls');
    controls.append(action('另存为…', () => saveFile(message)), action('用系统应用打开', () => bridge.openFile(message.id)));
    body.replaceChildren(image, description(`${result.width} × ${result.height} · ${fileSize(message.size)}`), controls);
    ready.set(message.id, true); renderMessages();
  } catch (error) {
    if (token === previewGeneration && panelKind === 'image-preview') body.replaceChildren(description(error.message), action('重试预览', () => openImage(message)), action('另存为…', () => saveFile(message)));
  }
}
let thumbnailsActive = 0;
const thumbnailQueue = [];
function loadThumbnail(message, button) {
  if (button.dataset.previewState || !previewable(message)) return;
  button.dataset.previewState = 'loading';
  thumbnailQueue.push({ message, button, generation: epoch }); drainThumbnails();
}
function drainThumbnails() {
  while (thumbnailsActive < 2 && thumbnailQueue.length) {
    const { message, button, generation } = thumbnailQueue.shift();
    if (generation !== epoch || message.deleted) { delete button.dataset.previewState; continue; }
    thumbnailsActive++;
    bridge.previewFile(message.id).then(result => {
      if (generation !== epoch || !button.isConnected || button.disabled) { delete button.dataset.previewState; return; }
      const img = element('img'); img.src = result.url; img.alt = message.fileName; img.draggable = false;
      button.replaceChildren(img); button.dataset.previewState = 'ready';
    }).catch(() => { button.dataset.previewState = 'error'; button.replaceChildren(fileIcon('image'), element('span', '', '点按重试预览')); })
      .finally(() => { thumbnailsActive--; drainThumbnails(); });
  }
}
function busy() {
  const focused = document.hasFocus();
  const inputFocused = focused && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  bridge?.setInteractionBusy?.(Boolean(dropDepth || focused && ($('panel').open || !$('group-menu').hidden || inputFocused || document.querySelector('.file-more[open]'))));
}
function groupName() { return config?.room?.name || '我的文件'; }
function connection(value) { online = value; renderConnection(); }
function renderConnection() {
  $('connection-status').dataset.connected = String(online);
  $('connection-status').textContent = online ? `${state.devices.filter(device => device.online).length} 在线` : connectionError ? '连接失败 · 点击查看' : '连接中';
  $('connection-dot').classList.toggle('offline', !online);
  $('connection-status').title = online ? '已连接，在线状态已同步' : connectionError || '正在重新连接，在线状态待更新';
}
function avatar(name, id, className = '') {
  const displayName = (name || '?').trim();
  const letters = Array.from(displayName);
  const initial = /^[\p{Script=Han}]{2,3}$/u.test(displayName) ? letters.at(-1) : letters[0] || '?';
  const tone = Array.from(id || name || '').reduce((sum, char) => sum + char.codePointAt(0), 0) % 5;
  const node = element('span', `avatar avatar-tone-${tone} ${className}`, initial.toUpperCase());
  node.setAttribute('aria-hidden', 'true'); return node;
}
async function api(route, options = {}) {
  const response = await fetch(config.room.baseUrl + route, { ...options, signal: AbortSignal.any([requestController.signal, options.signal || AbortSignal.timeout(8000)]), headers: { 'X-Room-Key': config.room.key, 'X-Device-Id': config.device.id, ...options.headers } });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || '操作失败'), { status: response.status }); return result;
}
function time(date) { return new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function statusFor(message) { if (message.deleted) return '主机文件已清理'; return ready.get(message.id) === true ? '可拖出' : ready.get(message.id) === 'error' ? '接收失败' : ready.get(message.id) === 'loading' ? '接收中' : '点按接收'; }
function hydrate() {
  while (preparing < 2 && prepareQueue.length) {
    const { id, generation } = prepareQueue.shift(); if (generation !== epoch) continue;
    preparing++;
    Promise.resolve().then(() => bridge.prepareFile(id)).then(() => { if (generation === epoch) ready.set(id, true); }).catch(() => { if (generation === epoch) ready.set(id, 'error'); }).finally(() => { preparing--; if (generation === epoch) renderMessages(); hydrate(); });
  }
}
function applyState(next) {
  state = mergeState(state, next);
  if (bridge) for (const message of state.messages) if (message.type === 'file' && !message.deleted) {
    const isNew = historyLoaded && !observedFiles.has(message.id);
    observedFiles.add(message.id);
    if (isNew && Number.isSafeInteger(message.size) && message.size <= AUTO_RECEIVE_BYTES && !ready.has(message.id)) {
      ready.set(message.id, 'loading'); prepareQueue.push({ id: message.id, generation: epoch });
    }
  }
  while (observedFiles.size > 1000) observedFiles.delete(observedFiles.values().next().value);
  historyLoaded = true;
  hydrate(); renderDevices(); renderMessages();
}
function renderDevices() {
  renderConnection();
  const members = state.devices.slice().sort((a, b) => Number(b.online) - Number(a.online));
  $('member-avatars').replaceChildren(...members.slice(0, 3).map(device => {
    const node = avatar(device.id === config.device.id ? '我' : device.name, device.id);
    node.classList.toggle('is-offline', !device.online); return node;
  }));
  const names = members.map(device => device.id === config.device.id ? '我' : device.name);
  const memberNames = names.join('、');
  $('device-summary').textContent = !names.length ? '等待设备加入' : Array.from(memberNames).length <= 12 ? memberNames : names.slice(0, 2).join('、') + (names.length > 2 ? ` 等 ${names.length} 台设备` : '');
  $('members-button').title = names.join('、') || '本群成员与设备';
  if (panelKind !== 'members' || !$('panel').open) return;
  const list = $('devices'); if (!list) return;
  list.replaceChildren(...state.devices.map(device => {
    const row = element('div', 'device'); row.append(element('div', 'device-avatar', device.kind === 'desktop' ? '▱' : '▯'));
    const details = element('div', 'device-details'); details.append(element('strong', '', device.name + (device.id === config.device.id ? ' · 本机' : '')));
    const status = element('small'); status.append(element('i', `online-dot ${device.online ? '' : 'offline-dot'}`), document.createTextNode(device.online ? '在线' : '离线'));
    details.append(status); row.append(details);
    if (bridge?.removeMember && config.room.local && Number(config.room.authVersion) === 2 && device.id !== config.room.hostDeviceId && device.id !== config.device.id) {
      const remove = action('移除', () => confirmOperation('移除此设备', `移除「${device.name}」后，其连接和访问授权会被撤销，需要重新申请加入。`, async () => { await bridge.removeMember(device.id); openMembers(); toast('设备已移除，访问授权已撤销'); }), 'member-remove');
      remove.dataset.removeDevice = device.id; row.append(remove);
    }
    return row;
  }));
}
function createMessage(message, animate) {
  const own = message.senderId === config.device.id;
  const row = element('article', `message ${own ? 'own' : ''}`); row.dataset.messageId = message.id;
  if (animate) { row.classList.add('arriving'); row.addEventListener('animationend', () => row.classList.remove('arriving'), { once: true }); }
  if (!own) row.append(avatar(message.senderName, message.senderId, 'message-avatar'));
  const body = element('div', 'message-body');
  const meta = element('div', 'message-meta'); meta.append(element('span', '', own ? '我' : message.senderName), element('span', '', time(message.createdAt))); body.append(meta);
  if (message.type === 'text') {
    const bubble = element('div', 'bubble text-bubble', message.text);
    bubble.addEventListener('dblclick', () => (bridge ? bridge.copy(message.text) : navigator.clipboard.writeText(message.text)).then(() => toast('文字已复制')).catch(showError)); body.append(bubble);
  } else {
    const bubble = element('div', 'bubble file-bubble'); bubble.dataset.fileId = message.id;
    if (previewable(message)) {
      bubble.classList.add('image-file-bubble');
      const preview = action('', () => openImage(message), 'file-thumbnail');
      preview.setAttribute('aria-label', `预览 ${message.fileName}`);
      preview.append(fileIcon('image'), element('span', '', '点按查看图片')); bubble.append(preview);
    }
    const content = element('div', 'file-main');
    const ext = message.fileName.includes('.') ? message.fileName.split('.').pop().slice(0, 5).toUpperCase() : 'FILE';
    const details = element('div', 'file-info');
    const name = element('div', 'file-name', message.fileName); name.title = message.fileName;
    const metadata = element('div', 'file-size', fileSize(message.size));
    if (bridge) metadata.append(element('span', 'drag-label'));
    details.append(name, metadata); content.append(element('div', 'file-icon', ext), details);
    const buttons = element('div', 'file-actions');
    const more = element('details', 'file-more');
    const summary = element('summary'); summary.append(fileIcon('more')); summary.title = '更多文件操作'; summary.setAttribute('aria-label', '更多文件操作');
    const menu = element('div', 'file-action-menu');
    const menuAction = (label, callback, className = '') => action(label, () => { more.open = false; summary.focus({ preventScroll: true }); return callback(); }, className);
    if (bridge) {
      menu.append(menuAction('打开文件', () => bridge.openFile(message.id)));
      menu.append(menuAction('接收到本机', () => { ready.set(message.id, 'loading'); prepareQueue.push({ id: message.id, generation: epoch }); hydrate(); renderMessages(); }, 'receive-action'));
      menu.append(menuAction('在文件夹中显示', () => bridge.revealFile(message.id)));
      const retry = menuAction('重新接收', () => { ready.set(message.id, 'loading'); prepareQueue.push({ id: message.id, generation: epoch }); hydrate(); renderMessages(); }, 'retry-action'); menu.append(retry);
    }
    menu.append(menuAction('另存为…', () => saveFile(message), 'save-action')); more.append(summary, menu); buttons.append(more);
    more.addEventListener('toggle', () => {
      if (more.open) {
        document.querySelectorAll('.file-more[open]').forEach(other => { if (other !== more) other.open = false; });
        more.classList.remove('open-below');
        if (menu.getBoundingClientRect().top < $('timeline').getBoundingClientRect().top + 3) more.classList.add('open-below');
        menu.scrollIntoView({ block: 'nearest' });
      }
      busy();
    });
    more.addEventListener('focusout', () => setTimeout(() => { if (!more.contains(document.activeElement)) more.open = false; }, 0));
    details.tabIndex = 0; details.setAttribute('role', 'button'); details.setAttribute('aria-label', previewable(message) ? `预览 ${message.fileName}` : `打开 ${message.fileName}`);
    const activate = () => { if (!row.classList.contains('file-expired')) (previewable(message) ? openImage(message) : bridge ? bridge.openFile(message.id) : saveFile(message)).catch(showError); };
    details.addEventListener('click', activate);
    details.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
    content.append(buttons); bubble.append(content);
    bubble.addEventListener('dragstart', event => { event.preventDefault(); if (ready.get(message.id) === true) bridge.startDrag(message.id); });
    body.append(bubble);
  }
  row.append(body); return row;
}
function updateFile(message, row) {
  if (message.type !== 'file') return;
  const isReady = ready.get(message.id) === true, bubble = row.querySelector('.file-bubble');
  bubble.draggable = Boolean(bridge && isReady);
  bubble.title = bridge ? (isReady ? '直接拖到桌面、文件夹或其他应用' : '文件正在接收到本机') : message.fileName;
  row.classList.toggle('file-expired', Boolean(message.deleted));
  if (message.deleted && panelKind === 'image-preview' && activePreviewId === message.id) $('panel').close();
  if (message.deleted) { bubble.draggable = false; row.querySelectorAll('.file-actions button').forEach(button => { button.disabled = true; }); }
  const thumbnail = row.querySelector('.file-thumbnail');
  if (thumbnail) {
    thumbnail.disabled = Boolean(message.deleted);
    if (message.deleted) { thumbnail.replaceChildren(fileIcon('image'), element('span', '', '主机文件已清理')); delete thumbnail.dataset.previewState; }
    else if (isReady) loadThumbnail(message, thumbnail);
  }
  const label = row.querySelector('.drag-label');
  if (label) { label.textContent = statusFor(message); label.classList.toggle('has-error', ready.get(message.id) === 'error'); }
  const receive = row.querySelector('.receive-action'); if (receive) receive.hidden = Boolean(ready.has(message.id) && ready.get(message.id) !== 'error');
  const retry = row.querySelector('.retry-action'); if (retry) retry.hidden = ready.get(message.id) !== 'error';
}
const respondingRequests = new Set();
let requestsRevision = 0;
const requestId = request => String(request.id || request.requestId);
const requestName = request => request.device?.name || request.deviceName || request.name || '新设备';
async function respondToRequest(request, allow) {
  const id = requestId(request);
  if (respondingRequests.has(id)) return;
  respondingRequests.add(id); renderRequests();
  try {
    await bridge.respondJoin(id, allow);
    requestsRevision++;
    requests = requests.filter(item => requestId(item) !== id);
    toast(allow ? '已允许设备加入' : '已拒绝这次申请');
  } finally {
    respondingRequests.delete(id); renderRequests();
    // An older in-flight poll must not put a processed request back on screen.
    if (requestsLoading) await requestsLoading.catch(() => {});
    await refreshRequests();
  }
}
function renderRequests() {
  const banner = $('join-request-banner'), first = requests[0];
  const timeline = $('timeline'), bottomGap = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
  const wasVisible = !banner.hidden;
  banner.hidden = !first;
  if (first) {
    const name = requestName(first), pending = respondingRequests.has(requestId(first));
    $('join-request-summary').textContent = `${name} 申请加入`;
    $('join-request-summary').title = `${name} 申请加入「${groupName()}」`;
    $('view-join-requests').textContent = requests.length > 1 ? `查看全部（${requests.length}）` : '查看详情';
    for (const [id, allow] of [['deny-join-request', false], ['approve-join-request', true]]) {
      const button = $(id); button.disabled = pending;
      button.onclick = () => respondToRequest(first, allow).catch(showError);
    }
  }
  // Keep the latest message visible when the fixed strip appears/disappears;
  // readers elsewhere in history retain their scroll position.
  if (wasVisible !== !banner.hidden && bottomGap < 75 && !timeline.contains(document.activeElement) && !timeline.querySelector('.file-more[open]')) timeline.scrollTop = timeline.scrollHeight;
  const memberEntry = $('member-join-requests');
  if (memberEntry) { memberEntry.hidden = !requests.length; memberEntry.textContent = `处理加入申请（${requests.length}）`; }
  if (panelKind !== 'requests' || !$('panel').open) return;
  const body = $('panel-body');
  const cards = requests.map(request => {
    const card = element('div', 'request-card'); card.dataset.requestId = requestId(request);
    card.append(element('strong', '', `${requestName(request)} 申请加入`), description(`允许后可查看「${groupName()}」的消息和文件。`));
    const controls = element('div', 'request-actions');
    for (const [label, allow] of [['拒绝', false], ['允许加入', true]]) {
      const button = action(label, () => respondToRequest(request, allow));
      button.dataset.action = allow ? 'approve-join' : 'deny-join'; button.disabled = respondingRequests.has(requestId(request)); controls.append(button);
    }
    card.append(controls); return card;
  });
  body.replaceChildren(...(cards.length ? cards : [description('加入申请已全部处理。')]));
}
function openRequests() {
  openPanel('加入申请', 'requests'); renderRequests();
  refreshRequests().catch(showError);
}
function renderMessages() {
  const timeline = $('timeline'), nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 75;
  const hadMessages = messageNodes.size > 0, desired = [], kept = new Set();
  // Messages retain their DOM nodes as presence and file readiness change, preserving
  // selection, keyboard focus and an open file menu during background updates.
  if (!state.messages.length) {
    let empty = timeline.querySelector('.empty-state');
    if (!empty) {
      empty = element('div', 'empty-state'); empty.append(element('div', 'empty-mark', '⇄'), element('strong', '', '一起，传点东西'), element('p', '', '拖入文件开始传送'));
      if (bridge?.createInvite) empty.append(action('＋ 邀请设备加入', openInvite));
    }
    desired.push(empty);
  }
  if (readingHistory) desired.push(action('返回最新记录', loadLatest, 'history-load history-latest'));
  if (state.history?.hasMore) {
    let load = timeline.querySelector('.history-load');
    if (!load) load = action('更早记录', loadHistory, 'history-load');
    desired.push(load);
  }
  let previousDay = '';
  for (const message of state.messages) {
    const day = new Date(message.createdAt).toLocaleDateString('zh-CN');
    if (day !== previousDay) {
      let divider = Array.from(timeline.querySelectorAll('[data-day]')).find(node => node.dataset.day === day);
      if (!divider) { divider = element('div', 'date-divider'); divider.dataset.day = day; }
      divider.textContent = day === new Date().toLocaleDateString('zh-CN') ? '今天' : day; desired.push(divider); previousDay = day;
    }
    let row = messageNodes.get(message.id);
    if (!row) { row = createMessage(message, hadMessages); messageNodes.set(message.id, row); }
    updateFile(message, row); desired.push(row); kept.add(message.id);
  }
  for (const key of messageNodes.keys()) if (!kept.has(key)) messageNodes.delete(key);
  const desiredSet = new Set(desired);
  for (const child of Array.from(timeline.children)) if (!desiredSet.has(child)) child.remove();
  desired.forEach((node, index) => { if (timeline.children[index] !== node) timeline.insertBefore(node, timeline.children[index] || null); });
  if (nearBottom && !timeline.querySelector('.file-more[open]') && !timeline.contains(document.activeElement)) timeline.scrollTop = timeline.scrollHeight;
}
async function loadLatest() {
  const generation = epoch, latest = await api('/api/state');
  if (generation !== epoch) return;
  readingHistory = false; historyLoaded = false; applyState(latest);
  $('timeline').scrollTop = $('timeline').scrollHeight;
}
async function loadHistory() {
  if (!state.history?.hasMore || !state.history.before) return;
  const timeline = $('timeline'), before = state.history.before, height = timeline.scrollHeight;
  const button = timeline.querySelector('.history-load'); if (button) button.disabled = true;
  const generation = epoch;
  try {
    const page = await api(`/api/history?before=${encodeURIComponent(before)}&limit=100`);
    if (generation !== epoch) return;
    state = prependHistory(state, page); readingHistory = true;
    for (const message of page.messages || []) if (message.type === 'file') observedFiles.add(message.id);
    renderMessages(); timeline.scrollTop += timeline.scrollHeight - height;
  } finally { if (button) button.disabled = false; }
}
async function saveFile(message) {
  if (bridge) { if (await bridge.saveFile(message.id)) toast('文件已保存'); return; }
  const response = await fetch(`${config.room.baseUrl}/api/files/${message.id}`, { headers: { 'X-Room-Key': config.room.key, 'X-Device-Id': config.device.id } });
  if (!response.ok) throw new Error('文件下载失败');
  const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a'); anchor.href = url; anchor.download = message.fileName; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function retryConnection(generation, error) {
  if (generation !== epoch) return;
  connectionError = error?.message || '群主机未响应，请检查托管电脑、网络和防火墙'; connection(false);
  if ([401, 403].includes(error?.status)) { connectionError = '此设备的授权已失效，请联系托管电脑重新批准加入'; renderConnection(); return; }
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt++, 5)) + Math.floor(Math.random() * 400);
  reconnectTimer = setTimeout(() => join().catch(showError), delay);
}
function cancelConnection(message) {
  ++epoch; clearTimeout(reconnectTimer); requestController.abort(); socket?.close();
  connectionError = message; connection(false);
}
async function join() {
  const generation = ++epoch; clearTimeout(reconnectTimer); requestController.abort(); requestController = new AbortController(); socket?.close(); ready.clear(); prepareQueue.length = 0; historyLoaded = false; connection(false);
  if (config.network && (!config.network.available || config.network.switching)) { connectionError = '所选网络已断开或正在切换，请等待连接恢复'; connection(false); return; }
  $('group-name').textContent = groupName(); $('message-input').placeholder = '发文件或说点什么…'; $('drop-label').textContent = `松开，发到「${groupName()}」`; document.title = `${groupName()} · 拾传`;
  renderMessages();
  try {
    await api('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config.device) });
    if (generation !== epoch) return;
    const initial = await api('/api/state'); if (generation !== epoch) return; applyState(initial);
  } catch (error) { retryConnection(generation, error); return; }
  if (generation !== epoch) return;
  const url = new URL('/api/events', config.room.baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('key', config.room.key); url.searchParams.set('device', config.device.id); url.searchParams.set('stream', '2');
  const current = new WebSocket(url); socket = current;
  const handshake = setTimeout(() => { if (generation === epoch && current.readyState !== WebSocket.OPEN) { connectionError = '实时连接握手超时，请检查网络和托管电脑'; current.close(); } }, 8000);
  current.onopen = () => { clearTimeout(handshake); if (generation === epoch) { reconnectAttempt = 0; connectionError = ''; connection(true); } else current.close(); };
  current.onmessage = event => { if (generation !== epoch) return; try { const data = JSON.parse(event.data); if (data.type === 'state') applyState(data); } catch {} };
  current.onclose = event => { clearTimeout(handshake); if (generation === epoch) retryConnection(generation, Object.assign(new Error(connectionError || '实时连接已断开，正在重新查找群主机'), { status: event.code === 1008 ? 403 : undefined })); };
  current.onerror = () => { if (generation === epoch) connectionError ||= '无法连接群主机，请检查网络和防火墙'; current.close(); };
}
async function sendText() {
  const input = $('message-input'), text = input.value.trim(); if (!text) return true; if ($('send-text').disabled || !config) return false;
  $('send-text').disabled = true;
  try { await api('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); if (input.value.trim() === text) input.value = ''; return true; }
  catch (error) { showError(error); return false; } finally { $('send-text').disabled = false; }
}
function upload(file) {
  return new Promise(resolve => {
    if (file.size > (state.maxFileBytes || 8 * 1024 ** 3)) { toast(`${file.name} 超过当前大小上限`); resolve(false); return; }
    const row = element('div', 'upload'); row.append(element('span', 'upload-name', file.name));
    const progress = element('progress'); progress.max = 100; progress.value = 0; const percent = element('span', '', '0%'); row.append(progress, percent); $('uploads').append(row);
    const xhr = new XMLHttpRequest(); xhr.open('POST', `${config.room.baseUrl}/api/files?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('X-Room-Key', config.room.key); xhr.setRequestHeader('X-Device-Id', config.device.id); xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = event => { if (event.lengthComputable) { progress.value = Math.round(event.loaded / event.total * 100); percent.textContent = progress.value < 100 ? `${progress.value}%` : '确认中'; } };
    row.append(action('取消', () => xhr.abort()));
    xhr.onload = () => { if (!(xhr.status >= 200 && xhr.status < 300)) { try { toast(JSON.parse(xhr.responseText).error || '文件发送失败'); } catch { toast('文件发送失败'); } } row.remove(); resolve(xhr.status >= 200 && xhr.status < 300); };
    xhr.onerror = () => { toast(`${file.name} 发送失败，请检查连接`); row.remove(); resolve(false); }; xhr.onabort = () => { toast('已取消发送'); row.remove(); resolve(false); }; xhr.send(file);
  });
}
async function sendFiles(files) {
  if (!config || !files.length) return [];
  const successful = [];
  let leased = false, counted = false;
  try {
    if (bridge?.setTransferBusy) { await bridge.setTransferBusy(true); leased = true; }
    uploading++; counted = true; busy();
    for (const file of files) if (await upload(file)) successful.push(file);
  } catch (error) { showError(error); }
  finally { if (counted) uploading--; if (leased) await bridge.setTransferBusy(false).catch(() => {}); busy(); }
  return successful;
}
function renderImageDrafts() {
  $('image-drafts').hidden = !imageDrafts.items.length;
  $('image-draft-summary').textContent = `${imageDrafts.items.length} 张图片待发送 · Enter 发送`;
  $('image-draft-list').replaceChildren(...imageDrafts.items.map(item => {
    const card = element('div', 'image-draft'), image = element('img');
    image.src = item.url; image.alt = item.file.name; image.onerror = () => { image.hidden = true; };
    const label = element('span', '', item.file.name); label.title = item.file.name;
    const remove = action('×', () => { imageDrafts.remove(item.id); renderImageDrafts(); $('message-input').focus(); });
    remove.setAttribute('aria-label', `移除图片 ${item.file.name}`); remove.disabled = sendingComposer;
    card.append(image, label, remove); return card;
  }));
  const label = imageDrafts.items.length ? '发送图片和消息' : '发送消息';
  $('send-text').setAttribute('aria-label', label); $('send-text').title = label;
  busy();
}
async function sendComposer() {
  if (sendingComposer || !config) return;
  sendingComposer = true;
  const batch = [...imageDrafts.items];
  renderImageDrafts();
  try {
    if (!await sendText()) return;
    $('send-text').disabled = true; renderImageDrafts();
    const sent = await sendFiles(batch.map(item => item.file));
    for (const item of batch) if (sent.includes(item.file)) imageDrafts.remove(item.id);
    if (sent.length < batch.length) toast('未发送的图片已保留，可重试或移除');
  } finally { sendingComposer = false; $('send-text').disabled = false; renderImageDrafts(); }
}
window.addEventListener('paste', createImagePasteHandler({
  canPaste: event => Boolean(config && !$('panel').open && (event.target === $('message-input') || !event.target?.closest?.('input,textarea,[contenteditable]'))),
  context: () => `${epoch}:${config?.room?.id}`,
  readNative: bridge?.readClipboardImage ? () => bridge.readClipboardImage() : undefined,
  onImages: files => { imageDrafts.add(files); renderImageDrafts(); $('message-input').focus(); },
  onError: showError,
}));
window.addEventListener('beforeunload', () => imageDrafts.clear());
function closeMenu() { $('group-menu').hidden = true; $('group-menu-button').setAttribute('aria-expanded', 'false'); busy(); }
async function refreshGroups() {
  if (bridge?.listGroups) { const result = await bridge.listGroups(); groups = Array.isArray(result) ? result : result.groups || []; }
  $('group-list').replaceChildren(...groups.map(group => {
    const current = group.id === config.room.id;
    const button = action('', async () => { closeMenu(); if (!current) await bridge.openGroup(group.id); }, current ? 'active' : ''); button.dataset.groupId = group.id;
    button.append(element('span', '', group.name || '未命名群'), element('small', '', current ? '当前群' : '↗')); return button;
  }));
}
function openPanel(title, kind) {
  closeMenu(); clearInterval(inviteTimer); $('panel').classList.toggle('image-preview-panel', kind === 'image-preview'); panelKind = kind; $('panel-title').textContent = title; $('panel-body').replaceChildren();
  if (!$('panel').open) $('panel').showModal(); busy(); return $('panel-body');
}
function description(text) { return element('p', 'panel-description', text); }
function input(placeholder, id, value = '') { const field = element('input', 'panel-input'); field.id = id; field.placeholder = placeholder; field.value = value; return field; }
async function openInvite() {
  if (!bridge?.createInvite) { toast('请在桌面端生成邀请码'); return; }
  const body = openPanel('邀请设备加入', 'invite');
  const code = element('div', 'invite-code', '······'); code.id = 'invite-code'; const expiry = element('div', 'invite-expiry', '正在生成邀请码…'); body.append(code, expiry);
  const result = await bridge.createInvite(); if (panelKind !== 'invite' || !$('panel').open) return;
  code.textContent = result.code;
  if (result.qrDataUrl) {
    const qr = element('img', 'invite-qr'); qr.src = result.qrDataUrl; qr.alt = '用拾传手机端扫描加入本群'; qr.width = 152; qr.height = 152;
    body.prepend(qr);
    body.append(description('连接同一网络后扫码加入。'));
  }
  const expiresAt = typeof result.expiresAt === 'number' ? result.expiresAt : new Date(result.expiresAt).getTime();
  const tick = () => { const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)); expiry.textContent = seconds ? `一次有效 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后失效` : '邀请码已过期，请重新生成'; };
  tick(); inviteTimer = setInterval(tick, 1000);
  body.append(action('复制邀请码', async () => { await bridge.copy(String(result.code)); toast('邀请码已复制'); }, 'primary-button', 'copy-invite'), action('重新生成', openInvite, 'secondary-button'));
  if (result.link) body.append(action('复制手机邀请链接', async () => { await bridge.copy(result.link); toast('邀请链接已复制'); }, 'secondary-button'), description(`手动连接地址：${result.baseUrl}`));
}
function openCreate() {
  if (!bridge?.createGroup) { toast('请在桌面端新建群'); return; }
  const body = openPanel('新建一个群', 'create'); const name = input('群名称，例如：工作资料', 'new-group-name'); name.maxLength = 40;
  const submit = action('创建并打开', async () => {
    if (!name.value.trim()) { name.focus(); return; } submit.disabled = true;
    try { await bridge.createGroup(name.value.trim()); $('panel').close(); await refreshGroups(); } finally { submit.disabled = false; }
  }, 'primary-button', 'confirm-create-group');
  body.append(name, submit); name.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) submit.click(); }; name.focus();
}
function openJoin() {
  if (pendingTicket) { openPending(pendingTicket); return; }
  if (!bridge?.joinGroup) { toast('请在桌面端输入邀请码'); return; }
  const body = openPanel('输入邀请码', 'join'); const code = input('000000', 'join-code'); code.classList.add('code-input'); code.maxLength = 6; code.inputMode = 'numeric'; code.autocomplete = 'off';
  code.oninput = () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); };
  const submit = action('申请加入', async () => {
    if (!/^\d{6}$/.test(code.value)) { toast('请输入 6 位数字邀请码'); code.focus(); return; }
    submit.disabled = true;
    try {
      const ticket = address.value.trim() && bridge.joinAt ? await bridge.joinAt(address.value.trim(), code.value, nearby.selectedOptions[0]?.dataset.groupId) : await bridge.joinGroup(code.value); openPending(ticket);
    } finally { submit.disabled = false; }
  }, 'primary-button', 'confirm-join-group');
  const address = input('可选：对方电脑地址 http://192.168.…', 'join-address'); address.type = 'url';
  const nearby = element('select', 'panel-input'); nearby.id = 'nearby-groups'; nearby.setAttribute('aria-label', '同网络附近的群');
  const populate = async () => {
    const list = await bridge.listNearby?.() || []; if (panelKind !== 'join' || !nearby.isConnected) return;
    const previous = nearby.value; nearby.replaceChildren();
    const fallback = element('option', '', list.length ? '自动搜索，或选择附近的群' : '暂无附近群，可填写电脑地址'); fallback.value = ''; nearby.append(fallback);
    for (const item of list) { const option = element('option', '', `${item.name || '附近的群'} · ${item.baseUrl}`); option.value = item.baseUrl; option.dataset.groupId = item.groupId; nearby.append(option); if (item.baseUrl === previous) nearby.value = previous; }
  };
  nearbyRefresh = populate;
  nearby.onchange = () => { address.value = nearby.value; }; address.oninput = () => { nearby.value = ''; };
  body.append(code, nearby, address, submit, action('刷新附近的群', populate, 'secondary-button')); populate().catch(() => {}); code.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) submit.click(); }; code.focus();
}
function openPending(ticket) {
  pendingTicket = ticket; clearTimeout(pendingTimer);
  const body = openPanel('等待对方允许', 'pending'); body.append(element('div', 'pending-icon', '◷'), element('p', 'pending-title', '加入申请已发出'), description(`等待「${ticket.groupName || '对方群'}」批准。`));
  const status = element('p', 'panel-description'); status.id = 'join-status'; body.append(status);
  const poll = async () => {
    if (pendingTicket !== ticket) return;
    try {
      const result = await bridge.checkJoin(ticket);
      if (result.status === 'approved') { pendingTicket = null; if (panelKind === 'pending') $('panel').close(); await refreshGroups(); toast('已加入，新群窗口已打开'); return; }
      if (result.status === 'denied' || result.status === 'expired') { pendingTicket = null; const message = result.status === 'denied' ? '这次申请被拒绝了。' : '申请已过期，请获取新的邀请码。'; status.textContent = message; if (panelKind === 'pending') body.append(action('重新输入邀请码', openJoin, 'primary-button')); else toast(message); return; }
      status.textContent = '等待批准中，关闭此弹窗也会继续等待。';
    } catch (error) { status.textContent = '暂时无法连接，正在重试…'; if (ticket.expiresAt && Date.now() > ticket.expiresAt) { pendingTicket = null; status.textContent = '申请已过期，请获取新的邀请码。'; return; } }
    pendingTimer = setTimeout(poll, 1800);
  }; poll();
}

let networkPanelEpoch = 0;
const networkType = type => ({ wifi: 'Wi-Fi', ethernet: '有线网络', vpn: 'VPN', virtual: '虚拟网卡', unknown: '网络' }[type] || '网络');
function networkState(next) {
  if (!config) return; config.network = next;
  if (next && (next.switching || !next.available)) cancelConnection(next.switching ? '正在切换网络，请等待重新连接' : '所选网络已断开，请检查网络设置');
  const label = $('network-offline'), selected = next?.selected;
  label.hidden = !bridge;
  label.classList.toggle('is-offline', !next?.available);
  label.textContent = next?.switching ? '正在切换网络…' : next?.available && selected ? `${networkType(selected.type)} · ${selected.address} ▾` : '所选网络已断开 · 选择网络 ▾';
  label.title = selected ? `${networkType(selected.type)} · ${selected.name} · ${selected.cidr || selected.address}` : '选择已连接的 Wi-Fi 或有线网络';
  label.setAttribute('aria-label', `${label.textContent.replace(' ▾', '')}，打开网络设置`);
}
async function openNetwork() {
  if (!bridge?.getNetwork) return;
  const generation = ++networkPanelEpoch, body = openPanel('网络连接', 'network'); body.append(description('正在读取已连接的网卡…'));
  const next = await bridge.getNetwork();
  if (panelKind !== 'network' || generation !== networkPanelEpoch) return;
  networkState(next); body.replaceChildren();
  const selected = next.selected;
  const current = element('div', 'network-current');
  current.append(element('strong', '', selected ? `${networkType(selected.type)} · ${selected.name}` : '尚未选择网络'), element('span', '', selected ? `${selected.cidr || selected.address} · ${next.available ? '已连接' : '已断开'}` : '请连接 Wi-Fi 或有线网络'));
  body.append(current);
  const form = element('div', 'network-options');
  const row = (value, label, detail, checked) => {
    const line = element('label', 'network-option'), radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'pickdrop-network'; radio.value = value; radio.checked = checked;
    const words = element('span'); words.append(element('strong', '', label), element('small', '', detail)); line.append(radio, words); return line;
  };
  form.append(row('auto', '自动选择', 'Wi-Fi / 有线网络', next.selection.mode === 'auto'));
  const physical = next.interfaces.filter(item => !item.virtual), virtual = next.interfaces.filter(item => item.virtual);
  const choice = item => row(item.id, `${networkType(item.type)} · ${item.name}`, `${item.cidr || item.address}${!item.cidr && item.netmask ? ` · 子网掩码 ${item.netmask}` : ''}${item.description ? ` · ${item.description}` : ''}`, next.selection.mode === 'manual' && selected?.id === item.id);
  physical.forEach(item => form.append(choice(item)));
  if (virtual.length) { const details = element('details', 'network-virtual'), summary = element('summary', '', `VPN / 虚拟网络（${virtual.length}）`); details.append(summary); virtual.forEach(item => details.append(choice(item))); if (selected?.virtual && next.selection.mode === 'manual') details.open = true; form.append(details); }
  body.append(form);
  const apply = action('应用所选网络', async () => {
    const selectedRadio = form.querySelector('input:checked'); if (!selectedRadio) return;
    if (uploading || next.transferBusy) { toast('有文件正在传输，请完成或取消后再切换'); return; }
    apply.disabled = true;
    try { const result = await bridge.setNetwork(selectedRadio.value === 'auto' ? { mode: 'auto' } : { mode: 'manual', id: selectedRadio.value }); networkState(result); toast(result.available ? `已使用 ${result.selected.name} · ${result.selected.address}` : '暂无可用网络'); if (panelKind === 'network') await openNetwork(); }
    finally { apply.disabled = false; }
  }, 'primary-button', 'apply-network');
  body.append(apply, action('刷新网络列表', openNetwork, 'secondary-button'));
}

function confirmOperation(title, text, callback) {
  const body = openPanel(title, 'confirm'); body.append(description(text));
  const submit = action('确认', async () => { submit.disabled = true; try { await callback(); if (panelKind === 'confirm') $('panel').close(); } finally { submit.disabled = false; } }, 'primary-button', 'confirm-operation');
  body.append(submit, action('取消', openMembers, 'secondary-button'));
}
function openConnectionDiagnostic() {
  const body = openPanel('连接诊断', 'diagnostic');
  body.append(description(`${connectionError || '当前已连接'}。群：${groupName()}；地址：${config?.room?.baseUrl || '尚未发现'}。`), action('重新连接', async () => { reconnectAttempt = 0; connectionError = ''; $('panel').close(); await join(); }, 'primary-button', 'retry-connection'));
  if (bridge?.getNetwork) body.append(action('网络连接设置', openNetwork, 'secondary-button'));
}
function openMembers() {
  const body = openPanel(`${groupName()} · 设备`, 'members');
  if (connectionError) body.append(action('查看连接诊断', openConnectionDiagnostic, 'secondary-button', 'connection-diagnostic'));
  if (bridge?.listJoinRequests) body.append(action(`处理加入申请（${requests.length}）`, openRequests, 'primary-button', 'member-join-requests'));
  if (config.room.local && Number(config.room.authVersion) !== 2 && bridge?.secureMembers) {
    body.append(description('此旧群使用共享授权。先升级为每设备授权，才能真正撤销设备访问。升级会使现有设备离线，需要重新申请并批准加入；历史消息与文件保留。'), action('升级设备授权', () => confirmOperation('升级此群授权', '升级后全部现有成员需要重新申请并由托管电脑批准。历史消息与文件保留。确认后才能移除设备并撤销访问。', async () => { const room = await bridge.secureMembers(); if (room?.id === config.room.id) config.room = room; await groupsChanged(); await join(); openMembers(); }), 'secondary-button', 'secure-members'));
  }
  const devices = element('div'); devices.id = 'devices'; body.append(devices);
  if (!config.room.local && bridge?.leaveGroup) {
    body.append(action('退出此群', () => confirmOperation('退出此群', '退出会撤销这台设备的群访问授权，并移除本地加入关系。重新加入需要托管电脑批准。', () => bridge.leaveGroup()), 'secondary-button', 'leave-group'), action('忘记此群', () => confirmOperation('忘记此群', '删除本机连接和接收缓存，不撤销主机授权。再次加入需要邀请。', () => bridge.forgetGroup()), 'secondary-button', 'forget-group'));
  }
  if (bridge?.createInvite) body.append(action('＋ 邀请设备', openInvite, 'primary-button'));
  const settings = element('div', 'device-settings'); const label = element('label', '', '这台设备的名字'); label.htmlFor = 'device-name'; const name = input('设备名称', 'device-name', config.device.name); name.maxLength = 40;
  settings.append(label, name, action('保存设备名称', async () => {
    if (!name.value.trim()) return;
    if (bridge) { const result = await bridge.rename(name.value.trim()); config.device = result.device || { ...config.device, name: name.value.trim() }; }
    else { config.device.name = name.value.trim(); localStorage.setItem('pickdrop-device', JSON.stringify(config.device)); }
    await api('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config.device) }); toast('设备名称已保存');
  }, 'secondary-button', 'rename-device')); body.append(settings); if (bridge?.getNetwork) body.append(action('网络连接设置', openNetwork, 'secondary-button')); renderDevices(); renderRequests();
}
async function openStorage() {
  closeMenu();
  if (!bridge?.getStorage) { toast('存储管理需要桌面客户端'); return; }
  const body = openPanel('存储与清理', 'storage');
  const info = await bridge.getStorage();
  if (panelKind !== 'storage') return;
  const summary = element('div', 'storage-summary');
  for (const [label, value] of [['接收缓存', info.cache], ['本机托管', info.hosted]]) {
    const card = element('div', 'storage-stat'); card.append(element('strong', '', fileSize(value?.bytes || 0)), element('small', '', `${label} · ${value?.files || 0} 个文件`)); summary.append(card);
  }
  body.append(summary);
  body.append(action('清理接收缓存', () => confirmOperation('清理接收缓存', '已另存的文件不受影响，正在使用的缓存会保留。', async () => { await bridge.clearCache(); if (!config.room.local) { ready.clear(); prepareQueue.length = 0; } renderMessages(); toast('接收缓存已清理'); await openStorage(); }), 'primary-button'));
  if (info.cache?.maxBytes) body.append(description(`缓存上限 ${fileSize(info.cache.maxBytes)} · 最长 ${info.cache.maxAgeDays || 7} 天`));
  if (config.room.local && bridge.listHostFiles) {
    body.append(description('清理主机原件后，全群将无法再次下载。'));
    const selected = new Set(), list = element('div', 'storage-files');
    let before, loading = false;
    const more = action('更多主机文件', fetchFiles, 'secondary-button');
    async function fetchFiles() {
      if (loading) return; loading = true; more.disabled = true;
      try {
        const page = await bridge.listHostFiles(before ? {before} : {}); if (panelKind !== 'storage') return;
        const files = Array.isArray(page) ? page : page.files || [];
        for (const file of files) {
          const row = element('label', 'storage-file'), checkbox = element('input'); checkbox.type = 'checkbox';
          checkbox.onchange = () => { if (checkbox.checked) selected.add(file.id); else selected.delete(file.id); remove.disabled = !selected.size; };
          const name = element('span', '', file.fileName || file.name); name.title = file.fileName || file.name;
          row.append(checkbox, name, element('small', '', fileSize(file.size || 0))); list.append(row);
        }
        before = page.before || (files.length ? String(files.at(-1).sequence) : undefined);
        more.hidden = !(page.hasMore ?? files.length === 100);
      } finally { loading = false; more.disabled = false; }
    }
    const remove = action('清理所选主机文件', () => confirmOperation('清理主机原文件', `将清理 ${selected.size} 个文件。其他成员将不能从主机下载这些文件，请先确认需要的文件已另存。`, async () => { await bridge.deleteHostFiles([...selected]); toast('所选文件已清理'); await openStorage(); }), 'secondary-button'); remove.disabled = true;
    body.append(list, more, remove); await fetchFiles();
  }
}
async function refreshRequests() {
  if (!bridge?.listJoinRequests) return;
  if (requestsLoading) return requestsLoading;
  const revision = requestsRevision;
  requestsLoading = (async () => {
    const result = await bridge.listJoinRequests();
    const next = Array.isArray(result) ? result : result.requests || [];
    if (revision === requestsRevision && JSON.stringify(next) !== JSON.stringify(requests)) { requests = next; renderRequests(); }
  })().finally(() => { requestsLoading = false; });
  return requestsLoading;
}
async function groupsChanged() {
  if (groupsLoading) { groupsDirty = true; return; }
  groupsLoading = true;
  try {
    const next = await bridge.bootstrap(), room = next.group || next.room;
    const reconnect = room.id === config.room.id && (room.baseUrl !== config.room.baseUrl || room.key !== config.room.key || (!online && room.online !== false));
    // The native window owns this group. Never replace it with a newly joined group.
    if (room.id === config.room.id) { config.room = room; config.device = next.device; }
    await refreshGroups();
    if (reconnect) await join();
  } finally { groupsLoading = false; if (groupsDirty) { groupsDirty = false; void groupsChanged().catch(showError); } }
}
function windowState(next) {
  config.window = { ...config.window, ...next }; $('pin-button').setAttribute('aria-pressed', String(Boolean(config.window.pinned))); $('dock-button').setAttribute('aria-pressed', String(Boolean(config.window.edge || config.window.docked)));
}
async function boot() {
  if (bridge) { config = await bridge.bootstrap(); config.room = config.group || config.room; groups = config.groups || []; }
  else {
    let room; try { room = parseRoomLink(location.href); } catch { $('device-summary').textContent = '请使用桌面端提供的连接地址'; return; }
    let device; try { device = JSON.parse(localStorage.getItem('pickdrop-device') || 'null'); } catch {}
    if (!device) { device = { id: crypto.randomUUID(), name: '浏览器设备', kind: 'web' }; localStorage.setItem('pickdrop-device', JSON.stringify(device)); }
    config = { device, room: { ...room, local: false, name: '我的文件' }, window: {} };
  }
  document.body.dataset.platform = config.platform || 'web'; windowState(config.window || {}); networkState(config.network);
  bridge?.onCacheCleared?.(event => { if (!config.room.local && (!event?.groupId || event.groupId === config.room.id)) { ready.clear(); prepareQueue.length = 0; renderMessages(); } });
  bridge?.onNearbyChanged?.(() => { if (panelKind === 'join') nearbyRefresh?.().catch(showError); });
  bridge?.onNetworkChanged?.(next => { networkState(next); if (panelKind === 'network') openNetwork().catch(showError); });
  bridge?.onGroupsChanged?.(() => groupsChanged().catch(showError)); bridge?.onJoinRequestsChanged?.(() => refreshRequests().catch(showError)); bridge?.onWindowChanged?.(windowState);
  await refreshGroups(); try { await join(); await refreshRequests(); } catch (error) { showError(error); connection(false); }
  // Remote group requests arrive over HTTP; native change events only cover local hosts.
  setInterval(() => { if (document.visibilityState === 'visible' && !config.window?.collapsed) refreshRequests().catch(() => {}); }, 2500);
}
$('connection-status').onclick = event => { if (connectionError) { event.stopPropagation(); openConnectionDiagnostic(); } };
$('group-menu-button').onclick = async () => { if (!config) return; if (!$('group-menu').hidden) { closeMenu(); return; } $('group-menu').hidden = false; $('group-menu-button').setAttribute('aria-expanded', 'true'); busy(); try { await refreshGroups(); } catch (error) { showError(error); } };
$('storage-settings').onclick = () => openStorage().catch(showError);
$('network-settings').onclick = () => openNetwork().catch(showError); $('network-offline').onclick = () => openNetwork().catch(showError);
$('create-group').onclick = openCreate; $('join-group').onclick = openJoin; $('invite-members').onclick = () => openInvite().catch(showError); $('view-members').onclick = openMembers; $('members-button').onclick = () => { if (config) openMembers(); };
$('view-join-requests').onclick = openRequests;
$('close-panel').onclick = () => $('panel').close(); $('panel').addEventListener('close', () => { panelKind = ''; activePreviewId = null; previewGeneration++; $('panel-body').replaceChildren(); clearInterval(inviteTimer); busy(); });
$('panel').addEventListener('click', event => { if (event.target === $('panel')) { const rect = $('panel').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('panel').close(); } });
$('choose-file').onclick = async () => {
  try { await bridge?.setNativeDialogBusy?.(true); $('file-input').click(); }
  catch (error) { bridge?.setNativeDialogBusy?.(false); showError(error); }
};
$('file-input').addEventListener('cancel', () => bridge?.setNativeDialogBusy?.(false));
$('file-input').onchange = event => { bridge?.setNativeDialogBusy?.(false); sendFiles(Array.from(event.target.files)); event.target.value = ''; };
$('composer').onsubmit = event => { event.preventDefault(); sendComposer().catch(showError); }; $('message-input').onkeydown = event => { if (event.key === 'Enter' && event.isComposing) event.preventDefault(); };
$('pin-button').onclick = async () => { try { const next = await bridge?.pin?.(!config.window.pinned); if (next) windowState(next); } catch (error) { showError(error); } };
$('dock-button').onclick = () => { closeMenu(); document.activeElement?.blur(); bridge?.dock?.(); }; $('close-button').onclick = () => bridge?.close?.();
document.addEventListener('pointerdown', event => { document.querySelectorAll('.file-more[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }); if (!$('group-menu').contains(event.target) && !$('group-menu-button').contains(event.target)) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenu(); document.querySelectorAll('.file-more[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus({ preventScroll: true }); }); } }); document.addEventListener('focusin', busy); document.addEventListener('focusout', () => setTimeout(busy, 0));
window.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dropDepth++; busy(); bridge?.expand?.(); $('drop-overlay').hidden = false; } });
window.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', () => { dropDepth--; if (dropDepth <= 0) { dropDepth = 0; $('drop-overlay').hidden = true; busy(); } });
window.addEventListener('drop', event => { event.preventDefault(); dropDepth = 0; $('drop-overlay').hidden = true; if (event.dataTransfer?.files.length) sendFiles(Array.from(event.dataTransfer.files)); busy(); });
window.addEventListener('blur', () => { dropDepth = 0; $('drop-overlay').hidden = true; busy(); });
window.addEventListener('focus', busy);
boot().catch(showError);
