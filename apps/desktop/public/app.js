import { parseRoomLink, fileSize } from '/protocol.js';
import { ImageDrafts, createImagePasteHandler } from '/clipboard-images.js';

const $ = id => document.getElementById(id);
const bridge = window.pickdrop;
let config, socket, epoch = 0, reconnectTimer, toastTimer, dropDepth = 0, preparing = 0, uploading = 0;
let pendingTicket, pendingTimer, requestsLoading = false, groupsLoading = false;
let state = { messages: [], devices: [] }, groups = [], requests = [], online = false, panelKind = '', inviteTimer;
const ready = new Map(), prepareQueue = [];
const imageDrafts = new ImageDrafts();
let sendingComposer = false;
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
function busy() {
  const inputFocused = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  bridge?.setInteractionBusy?.(Boolean($('panel').open || !$('group-menu').hidden || inputFocused || document.querySelector('.file-more[open]') || dropDepth || uploading || imageDrafts.items.length));
}
function groupName() { return config?.room?.name || '我的文件'; }
function connection(value) { online = value; renderConnection(); }
function renderConnection() {
  $('connection-status').dataset.connected = String(online);
  $('connection-status').textContent = online ? `${state.devices.filter(device => device.online).length} 在线` : '连接中';
  $('connection-dot').classList.toggle('offline', !online);
  $('connection-status').title = online ? '已连接，在线状态已同步' : '正在重新连接，在线状态待更新';
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
  const response = await fetch(config.room.baseUrl + route, { ...options, headers: { 'X-Room-Key': config.room.key, 'X-Device-Id': config.device.id, ...options.headers } });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作失败'); return result;
}
function time(date) { return new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function statusFor(message) { return ready.get(message.id) === true ? '可拖出' : ready.get(message.id) === 'error' ? '接收失败' : '接收中'; }
function hydrate() {
  while (preparing < 2 && prepareQueue.length) {
    const { id, generation } = prepareQueue.shift(); if (generation !== epoch) continue;
    preparing++;
    Promise.resolve().then(() => bridge.prepareFile(id)).then(() => { if (generation === epoch) ready.set(id, true); }).catch(() => { if (generation === epoch) ready.set(id, 'error'); }).finally(() => { preparing--; if (generation === epoch) renderMessages(); hydrate(); });
  }
}
function applyState(next) {
  state = { ...next, messages: next.messages || [], devices: next.devices || [] };
  if (bridge) for (const message of state.messages) if (message.type === 'file' && !ready.has(message.id)) {
    ready.set(message.id, 'loading'); prepareQueue.push({ id: message.id, generation: epoch });
  }
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
    const status = element('small'); status.append(element('i', `online-dot ${device.online ? '' : 'offline-dot'}`), document.createTextNode(device.online ? '在线' : '离线 · 加入关系已保存'));
    details.append(status); row.append(details); return row;
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
    const content = element('div', 'file-main');
    const ext = message.fileName.includes('.') ? message.fileName.split('.').pop().slice(0, 5).toUpperCase() : 'FILE';
    const details = element('div', 'file-info');
    const name = element('div', 'file-name', message.fileName); name.title = message.fileName;
    const metadata = element('div', 'file-size', fileSize(message.size));
    if (bridge) metadata.append(element('span', 'drag-label'));
    details.append(name, metadata); content.append(element('div', 'file-icon', ext), details);
    const buttons = element('div', 'file-actions');
    const primary = action(bridge ? '↗' : '↓', () => bridge ? bridge.openFile(message.id) : saveFile(message), 'file-primary');
    primary.title = bridge ? '打开文件' : '保存文件'; primary.setAttribute('aria-label', primary.title);
    buttons.append(primary);
    const more = element('details', 'file-more');
    const summary = element('summary', '', '···'); summary.title = '更多文件操作'; summary.setAttribute('aria-label', '更多文件操作');
    const menu = element('div', 'file-action-menu');
    const menuAction = (label, callback, className = '') => action(label, () => { more.open = false; summary.focus({ preventScroll: true }); return callback(); }, className);
    if (bridge) {
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
  const label = row.querySelector('.drag-label');
  if (label) { label.textContent = statusFor(message); label.classList.toggle('has-error', ready.get(message.id) === 'error'); }
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
      empty = element('div', 'empty-state'); empty.append(element('div', 'empty-mark', '⇄'), element('strong', '', '一起，传点东西'), element('p', '', '把文件拖进来，大家都能收到\n也可以随手发一句话'));
      if (bridge?.createInvite) empty.append(action('＋ 邀请设备加入', openInvite));
    }
    desired.push(empty);
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
async function saveFile(message) {
  if (bridge) { if (await bridge.saveFile(message.id)) toast('文件已保存'); return; }
  const response = await fetch(`${config.room.baseUrl}/api/files/${message.id}`, { headers: { 'X-Room-Key': config.room.key } });
  if (!response.ok) throw new Error('文件下载失败');
  const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a'); anchor.href = url; anchor.download = message.fileName; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function join() {
  const generation = ++epoch; clearTimeout(reconnectTimer); socket?.close(); ready.clear(); prepareQueue.length = 0; connection(false);
  $('group-name').textContent = groupName(); $('message-input').placeholder = '发文件或说点什么…'; $('drop-label').textContent = `松开，发到「${groupName()}」`; document.title = `${groupName()} · 拾传`;
  renderMessages();
  try {
    await api('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config.device) });
    const initial = await api('/api/state'); if (generation !== epoch) return; applyState(initial);
  } catch {
    if (generation === epoch) { connection(false); reconnectTimer = setTimeout(() => join().catch(showError), 3000); }
    return;
  }
  function connect() {
    if (generation !== epoch) return;
    const url = new URL('/api/events', config.room.baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('key', config.room.key); url.searchParams.set('device', config.device.id);
    socket = new WebSocket(url); socket.onopen = () => { if (generation === epoch) connection(true); };
    socket.onmessage = event => { if (generation !== epoch) return; try { const data = JSON.parse(event.data); if (data.type === 'state') applyState(data); } catch {} };
    socket.onclose = () => { if (generation === epoch) { connection(false); reconnectTimer = setTimeout(connect, 2500); } }; socket.onerror = () => socket.close();
  }
  connect();
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
  closeMenu(); clearInterval(inviteTimer); panelKind = kind; $('panel-title').textContent = title; $('panel-body').replaceChildren();
  if (!$('panel').open) $('panel').showModal(); busy(); return $('panel-body');
}
function description(text) { return element('p', 'panel-description', text); }
function input(placeholder, id, value = '') { const field = element('input', 'panel-input'); field.id = id; field.placeholder = placeholder; field.value = value; return field; }
async function openInvite() {
  if (!bridge?.createInvite) { toast('请在桌面端生成邀请码'); return; }
  const body = openPanel('邀请设备加入', 'invite'); body.append(description(`邀请设备加入「${groupName()}」。加入后会一直保留，下次无需再输入。`));
  const code = element('div', 'invite-code', '······'); code.id = 'invite-code'; const expiry = element('div', 'invite-expiry', '正在生成邀请码…'); body.append(code, expiry);
  const result = await bridge.createInvite(); if (panelKind !== 'invite' || !$('panel').open) return;
  code.textContent = result.code;
  if (result.qrDataUrl) {
    const qr = element('img', 'invite-qr'); qr.src = result.qrDataUrl; qr.alt = '用拾传手机端扫描加入本群'; qr.width = 152; qr.height = 152;
    body.prepend(qr);
    body.append(description('手机与电脑连接同一 Wi-Fi，在拾传手机端点击「扫码加入」。'));
  }
  const expiresAt = typeof result.expiresAt === 'number' ? result.expiresAt : new Date(result.expiresAt).getTime();
  const tick = () => { const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)); expiry.textContent = seconds ? `一次有效 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后失效` : '邀请码已过期，请重新生成'; };
  tick(); inviteTimer = setInterval(tick, 1000);
  body.append(action('复制邀请码', async () => { await bridge.copy(String(result.code)); toast('邀请码已复制'); }, 'primary-button', 'copy-invite'), description('对方输入后，本群设备需要允许这次加入。'), action('重新生成', openInvite, 'secondary-button'));
  if (result.link) body.append(action('复制手机邀请链接', async () => { await bridge.copy(result.link); toast('邀请链接已复制'); }, 'secondary-button'), description(`手动连接地址：${result.baseUrl}`));
}
function openCreate() {
  if (!bridge?.createGroup) { toast('请在桌面端新建群'); return; }
  const body = openPanel('新建一个群', 'create'); const name = input('群名称，例如：工作资料', 'new-group-name'); name.maxLength = 40;
  const submit = action('创建并打开', async () => {
    if (!name.value.trim()) { name.focus(); return; } submit.disabled = true;
    try { await bridge.createGroup(name.value.trim()); $('panel').close(); await refreshGroups(); } finally { submit.disabled = false; }
  }, 'primary-button', 'confirm-create-group');
  body.append(description('每个群都有独立窗口、成员、消息和文件。同一台设备可同时加入多个群。'), name, submit); name.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) submit.click(); }; name.focus();
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
    const list = await bridge.listNearby?.() || []; nearby.replaceChildren();
    const fallback = element('option', '', list.length ? '自动搜索，或选择附近的群' : '暂无附近群，可填写电脑地址'); fallback.value = ''; nearby.append(fallback);
    for (const item of list) { const option = element('option', '', `${item.name || '附近的群'} · ${item.baseUrl}`); option.value = item.baseUrl; option.dataset.groupId = item.groupId; nearby.append(option); }
  };
  nearby.onchange = () => { address.value = nearby.value; }; address.oninput = () => { nearby.value = ''; };
  body.append(description('输入 6 位邀请码。仅在所选网络寻找对方，也可选择附近群或填写电脑地址。'), code, nearby, address, submit, action('刷新附近的群', populate, 'secondary-button')); populate().catch(() => {}); code.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) submit.click(); }; code.focus();
}
function openPending(ticket) {
  pendingTicket = ticket; clearTimeout(pendingTimer);
  const body = openPanel('等待对方允许', 'pending'); body.append(element('div', 'pending-icon', '◷'), element('p', 'pending-title', '加入申请已发出'), description(`请让「${ticket.groupName || '对方群'}」中已加入的设备允许这次申请。通过后会自动打开新窗口。`));
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
  body.append(description('群监听、附近设备发现与传输共用此网络。网络断开后会等待原连接，不会自动换到其他网卡。'));
  const selected = next.selected;
  const current = element('div', 'network-current');
  current.append(element('strong', '', selected ? `${networkType(selected.type)} · ${selected.name}` : '尚未选择网络'), element('span', '', selected ? `${selected.cidr || selected.address} · ${next.available ? '已连接' : '已断开'}` : '请连接 Wi-Fi 或有线网络'));
  body.append(current);
  const form = element('div', 'network-options');
  const row = (value, label, detail, checked) => {
    const line = element('label', 'network-option'), radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'pickdrop-network'; radio.value = value; radio.checked = checked;
    const words = element('span'); words.append(element('strong', '', label), element('small', '', detail)); line.append(radio, words); return line;
  };
  form.append(row('auto', '自动选择', '优先已连接的 Wi-Fi / 有线网络；点应用可重新选择', next.selection.mode === 'auto'));
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
  body.append(apply, action('刷新网络列表', openNetwork, 'secondary-button'), description('切换网络会重新连接群。文件正在传输时不能切换；请先完成或取消。'));
}

function openMembers() {
  const body = openPanel(`${groupName()} · 设备`, 'members'); body.append(description('离线设备仍保留在本群，重新上线后继续同步。'));
  if (bridge?.listJoinRequests) body.append(action(`处理加入申请（${requests.length}）`, openRequests, 'primary-button', 'member-join-requests'));
  const devices = element('div'); devices.id = 'devices'; body.append(devices);
  if (bridge?.createInvite) body.append(action('＋ 邀请设备', openInvite, 'primary-button'));
  const settings = element('div', 'device-settings'); const label = element('label', '', '这台设备的名字'); label.htmlFor = 'device-name'; const name = input('设备名称', 'device-name', config.device.name); name.maxLength = 40;
  settings.append(label, name, action('保存设备名称', async () => {
    if (!name.value.trim()) return;
    if (bridge) { const result = await bridge.rename(name.value.trim()); config.device = result.device || { ...config.device, name: name.value.trim() }; }
    else { config.device.name = name.value.trim(); localStorage.setItem('pickdrop-device', JSON.stringify(config.device)); }
    await api('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config.device) }); toast('设备名称已保存');
  }, 'secondary-button', 'rename-device')); body.append(settings); if (bridge?.getNetwork) body.append(action('网络连接设置', openNetwork, 'secondary-button')); renderDevices(); renderRequests();
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
  if (groupsLoading) return;
  groupsLoading = true;
  try {
    const next = await bridge.bootstrap(), room = next.group || next.room;
    const reconnect = room.id === config.room.id && (room.baseUrl !== config.room.baseUrl || room.key !== config.room.key || (!online && room.online !== false));
    // The native window owns this group. Never replace it with a newly joined group.
    if (room.id === config.room.id) { config.room = room; config.device = next.device; }
    await refreshGroups();
    if (reconnect) await join();
  } finally { groupsLoading = false; }
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
  bridge?.onNetworkChanged?.(next => { networkState(next); if (panelKind === 'network') openNetwork().catch(showError); });
  bridge?.onGroupsChanged?.(() => groupsChanged().catch(showError)); bridge?.onJoinRequestsChanged?.(() => refreshRequests().catch(showError)); bridge?.onWindowChanged?.(windowState);
  await refreshGroups(); try { await join(); await refreshRequests(); } catch (error) { showError(error); connection(false); }
  // Remote group requests arrive over HTTP; native change events only cover local hosts.
  setInterval(() => { if (document.visibilityState === 'visible' && !config.window?.collapsed) refreshRequests().catch(() => {}); }, 2500);
}
$('group-menu-button').onclick = async () => { if (!config) return; if (!$('group-menu').hidden) { closeMenu(); return; } $('group-menu').hidden = false; $('group-menu-button').setAttribute('aria-expanded', 'true'); busy(); try { await refreshGroups(); } catch (error) { showError(error); } };
$('network-settings').onclick = () => openNetwork().catch(showError); $('network-offline').onclick = () => openNetwork().catch(showError);
$('create-group').onclick = openCreate; $('join-group').onclick = openJoin; $('invite-members').onclick = () => openInvite().catch(showError); $('view-members').onclick = openMembers; $('members-button').onclick = () => { if (config) openMembers(); };
$('view-join-requests').onclick = openRequests;
$('close-panel').onclick = () => $('panel').close(); $('panel').addEventListener('close', () => { panelKind = ''; clearInterval(inviteTimer); busy(); });
$('panel').addEventListener('click', event => { if (event.target === $('panel')) { const rect = $('panel').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('panel').close(); } });
$('choose-file').onclick = () => $('file-input').click(); $('file-input').onchange = event => { sendFiles(Array.from(event.target.files)); event.target.value = ''; };
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
boot().catch(showError);
