import React from 'react';
import { Box, Text } from 'ink';
import { fileSize } from '../../shared/protocol.js';
import { progressLabel } from './common.js';
import { cells, clipText, wrapText, graphemes, groupTransfers, taskStatus } from './layout.js';

const h = React.createElement;
// Explicit palette levels avoid converting near-black RGB through a terminal's
// user-customised ANSI black/bright-black palette. Basic terminals retain 40m.
export function navigationPalette(env = process.env) {
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM || '') || env.FORCE_COLOR === '3') return { base: '#080c10', text: '#e0e7ee', muted: '#9aaaba', accent: '#5ee1c4', selected: '#123e3d', warning: '#f0c67a', edge: '#34404b' };
  if (/256color/.test(env.TERM || '') || env.FORCE_COLOR === '2') return { base: 'ansi256(232)', text: 'ansi256(255)', muted: 'ansi256(248)', accent: 'ansi256(85)', selected: 'ansi256(23)', warning: 'ansi256(222)', edge: 'ansi256(240)' };
  return { base: 'black', text: 'white', muted: 'white', accent: 'cyan', selected: 'cyan', selectedText: 'black', warning: 'yellow', edge: 'gray' };
}
const row = (text = '', tone = 'text', extra = {}) => ({ text, tone, ...extra });
export const fileActions = ['下载文件', '更改保存位置', '查看完整信息', '返回消息'];
export const textActions = ['查看完整内容', '返回消息'];
const pageNames = { group: '消息', compose: '发送消息', files: '发送文件', tasks: '传输任务', settings: '保存位置', more: '更多操作' };
function drawLine(entry, width, key) {
  const value = entry || row(), colors = navigationPalette();
  const text = clipText(value.text, width);
  return h(Text, { key, color: value.focus ? colors.selectedText || colors.accent : colors[value.tone] || colors.text, backgroundColor: value.focus ? colors.selected : colors.base, bold: !!value.bold, wrap: 'truncate-end' }, text + ' '.repeat(Math.max(0, width - cells(text))));
}
function column(rows, width, height, key) {
  return h(Box, { key, width, height, flexShrink: 0, flexDirection: 'column' }, Array.from({ length: height }, (_, i) => drawLine(rows[i], width, i)));
}
function separator(height, key) { return column(Array.from({ length: height }, () => row(' │ ', 'edge')), 3, height, key); }
function timeLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
function messageTitle(message) {
  if (message.type === 'file') return `↓ ${message.fileName || '未命名文件'}`;
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  return `${/https?:\/\//i.test(text) ? '↗ ' : ''}${text || '空消息'}`;
}
function transferFor(snapshot, groupId, message) {
  return groupTransfers(snapshot, groupId).filter(task => task.messageId === message?.id && task.type === 'download').at(-1);
}
export function messageDetailText(message, snapshot = {}, groupId) {
  if (!message) return '';
  if (message.type !== 'file') return message.text || '';
  const task = transferFor(snapshot, groupId, message);
  const lines = [message.fileName || '未命名文件', `大小：${fileSize(message.size)}`, `发送者：${message.senderName || '未知设备'}`, `时间：${message.createdAt || '未知'}`];
  if (task) {
    lines.push(`下载状态：${taskStatus(task)}`);
    if (task.status === 'done' && typeof task.result === 'string' && task.result) lines.push('保存位置：', task.result);
    if (task.error) lines.push(`错误：${task.error}`);
  }
  return lines.join('\n');
}
function messageStatus(snapshot, groupId, message) {
  const task = transferFor(snapshot, groupId, message);
  if (task) return `${taskStatus(task)}${task.status === 'running' ? ' ' + progressLabel(task, 12) : ''}`;
  return message.type === 'file' ? '可下载' : /https?:\/\//i.test(message.text || '') ? '链接 · 已折叠' : '消息';
}
function selectedRows(entries, index, height, active, currentId) {
  const spacing = height >= entries.length * 2 + 2 ? 2 : 1;
  const capacity = Math.max(1, Math.floor((height - 2) / spacing));
  const start = Math.max(0, Math.min(index - Math.floor(capacity / 2), entries.length - capacity));
  const rows = [row('工作空间', active ? 'accent' : 'muted', { bold: active }), row()];
  entries.slice(start, start + capacity).forEach((entry, local) => {
    const chosen = start + local === index, focused = active && chosen;
    const current = entry.kind === 'group' && entry.groupId === currentId;
    rows.push(row(`${focused ? '›' : current ? '●' : ' '} ${entry.label}`, focused || current ? 'accent' : 'text', { focus: focused, bold: focused }));
    if (spacing === 2) rows.push(row());
  });
  return rows;
}
function messageRows({ snapshot, current, message, messageIndex, height, active }) {
  const messages = snapshot.state?.messages || [];
  const index = message ? Math.max(0, messages.findIndex(item => item.id === message.id)) : Math.max(0, messageIndex || 0);
  const count = Math.max(1, Math.floor((height - 3) / 3));
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), messages.length - count));
  const online = (snapshot.state?.devices || []).filter(device => device.online).length;
  const rows = [row(current ? `${current.name} · ${online} 台在线${current.online === false ? ' · 群离线' : ''}` : '欢迎使用拾传', active ? 'accent' : 'text', { bold: true }), row(messages.length ? `消息 ${index + 1}/${messages.length}${start ? ' · ↑ 上方还有消息' : ''}` : '暂无消息', 'muted'), row()];
  if (!current) return [...rows, row('← 工作空间 · 更多操作', 'accent'), row('创建群或加入已有传输群', 'muted')];
  if (!messages.length) return [...rows, row('← 工作空间 · 发送消息或文件', 'muted')];
  messages.slice(start, start + count).forEach((item, local) => {
    const chosen = start + local === index, focused = active && chosen;
    rows.push(row(`${focused ? '›' : chosen ? '·' : ' '} ${messageTitle(item)}`, chosen ? 'accent' : 'text', { focus: focused, bold: chosen }));
    rows.push(row(`  ${item.senderName || '未知设备'}${item.senderId === snapshot.device?.id ? ' · 我' : ''} · ${timeLabel(item.createdAt)}${item.type === 'file' ? ` · ${fileSize(item.size)}` : ''} · ${messageStatus(snapshot, current.id, item)}`, 'muted', { focus: focused }));
    rows.push(row());
  });
  if (start + count < messages.length && rows.length <= height) rows[height - 1] = row('↓ 下方还有消息', 'muted');
  return rows;
}
function actionRows({ message, snapshot, current, actionIndex, active, width, height }) {
  if (!message) return [row('消息操作', 'muted'), row(), row('先选择一条消息', 'muted')];
  const task = transferFor(snapshot, current?.id, message);
  const short = height < 19;
  const rows = [row('消息操作', active ? 'accent' : 'muted', { bold: active })];
  if (!short) rows.push(row());
  rows.push(row(messageTitle(message), 'text', { bold: true }));
  rows.push(row(`${message.senderName || '未知设备'}${message.type === 'file' ? ` · ${fileSize(message.size)}` : ''}`, 'muted'));
  if (message.type === 'file') {
    rows.push(row('保存到 · 记住上次选择', 'muted'));
    rows.push(row(clipText(snapshot.preferences?.downloadDirectory || '系统默认下载目录', width, true)));
    if (task && (!short || height >= 11)) rows.push(row(`${taskStatus(task)} · ${progressLabel(task, width)}`, task.status === 'failed' ? 'warning' : 'accent'));
  }
  if (!short) rows.push(row());
  const actions = message.type === 'file' ? [...fileActions] : textActions;
  if (message.type === 'file' && task) actions[0] = ['queued', 'running'].includes(task.status) ? '正在下载' : task.status === 'done' ? '查看保存位置' : task.status === 'failed' ? '重试下载' : '下载文件';
  actions.forEach((label, index) => rows.push(row(`${active && actionIndex === index ? '›' : ' '} ${label}`, active && actionIndex === index ? 'accent' : 'text', { focus: active && actionIndex === index, bold: active && actionIndex === index })));
  if (!short) rows.push(row(), row(active ? 'Enter 执行 · ← 返回消息' : '→ 移入操作区', 'muted'));
  if (rows.length > height) {
    const choices = rows.filter(value => actions.some(label => value.text.endsWith(` ${label}`)));
    const capacity = Math.max(1, height - 1), start = Math.max(0, Math.min(actionIndex - capacity + 1, choices.length - capacity));
    return [rows[0], ...choices.slice(start, start + capacity)];
  }
  return rows;
}
function previewRows({ kind, snapshot, current, input, cursor, active, width, height }) {
  const rows = [row(pageNames[kind] || '更多操作', active ? 'accent' : 'text', { bold: true }), row()];
  if (kind === 'compose') {
    rows.push(row(active ? '←→ 移动光标 · Enter 发送' : '→ 移入输入区', 'muted'), row());
    const parts = graphemes(input), cursorIndex = Math.max(0, Math.min(cursor ?? parts.length, parts.length));
    const before = wrapText(parts.slice(0, cursorIndex).join(''), width);
    const cursorLine = before.length - 1 + Number(cells(before.at(-1)) >= width);
    if (active) parts.splice(cursorIndex, 0, '▏');
    const lines = wrapText(parts.join('') || '输入消息…', width), capacity = Math.max(1, height - rows.length);
    const start = active ? Math.max(0, cursorLine - capacity + 1) : 0;
    rows.push(...lines.slice(start, start + capacity).map(value => row(value, active ? 'text' : 'muted')));
  } else if (kind === 'files') rows.push(row(`发送到 ${current?.name || '未选择群组'}`, 'muted'), row(), row('→ 进入本机文件选择器', 'accent'), row('↑↓ 浏览 · → 进入文件夹', 'muted'), row('Enter / 空格选择文件', 'muted'), row('↓ 移到“发送已选文件”', 'muted'), row('Enter 确认发送', 'muted'));
  else if (kind === 'settings') rows.push(row('默认保存位置', 'muted'), ...wrapText(snapshot.preferences?.downloadDirectory || '系统默认下载目录', width).map(value => row(value)), row(), row('→ 修改保存位置', 'accent'), row('下次下载默认使用上次目录', 'muted'));
  else if (kind === 'tasks') {
    const tasks = groupTransfers(snapshot, current?.id);
    if (!tasks.length) rows.push(row('当前群暂无传输任务', 'muted'));
    else for (const task of tasks.slice(-Math.max(1, Math.floor((height - 4) / 3)))) rows.push(row(`${task.type === 'download' ? '↓' : '↑'} ${task.name || '文件'}`), row(`${taskStatus(task)} · ${progressLabel(task, width)}`, task.status === 'failed' ? 'warning' : 'accent'), row());
    rows.push(row('→ 管理任务 · 取消 / 重试', 'muted'));
  } else rows.push(row('创建群、加入群、邀请设备', 'muted'), row('设备、网络与帮助', 'muted'), row(), row('→ 打开更多操作', 'accent'));
  return rows;
}
export function NavigationScreen({ width = 80, height = 24, snapshot = {}, group, mode = 'chat', workspaceEntries = [], workspaceIndex = 0, message, messageIndex = 0, actionIndex = 0, input = '', cursor, notice = '', busy = false, detailOffset = 0 }) {
  const columns = Math.max(1, Math.floor(width) - 1), rows = Math.max(1, Math.floor(height) - 1);
  const current = typeof group === 'object' ? group : (snapshot.groups || []).find(item => item.id === (group || snapshot.selectedGroupId));
  if (columns < 39 || rows < 11) return column([row('拾传 · PickDrop', 'accent'), row('请放大至 40 列 × 12 行', 'muted'), row('Ctrl+C 退出', 'muted')], columns, rows, 'tiny');
  const bodyHeight = rows - 7, workspace = mode === 'workspace';
  const selectedKind = workspaceEntries[workspaceIndex]?.kind || 'group';
  const page = workspace ? selectedKind : mode === 'compose' ? 'compose' : 'group';
  const navWidth = columns >= 99 ? 23 : workspace ? Math.min(21, Math.floor(columns * .36)) : 0;
  const actionsWidth = columns >= 139 && page === 'group' && mode !== 'message-detail' ? 33 : 0;
  const mainWidth = columns - (navWidth ? navWidth + 3 : 0) - (actionsWidth ? actionsWidth + 3 : 0);
  const common = { snapshot, current, message, messageIndex, actionIndex, height: bodyHeight };
  const panes = [];
  if (navWidth) panes.push(column(selectedRows(workspaceEntries, workspaceIndex, bodyHeight, workspace, current?.id), navWidth, bodyHeight, 'workspace'), separator(bodyHeight, 'nav-edge'));
  let content;
  if (mode === 'message-detail') {
    const text = messageDetailText(message, snapshot, current?.id);
    const all = wrapText(text, mainWidth), offset = Math.max(0, Math.min(detailOffset, all.length - Math.max(1, bodyHeight - 2)));
    content = [row('完整内容 · ↑↓ 滚动', 'accent', { bold: true }), row(), ...all.slice(offset, offset + bodyHeight - 2).map(value => row(value))];
  } else if (page !== 'group') content = previewRows({ ...common, kind: page, input, cursor, active: mode === 'compose', width: mainWidth });
  else if (mode === 'message-actions' && !actionsWidth) content = actionRows({ ...common, active: true, width: mainWidth });
  else content = messageRows({ ...common, active: mode === 'chat' });
  panes.push(column(content, mainWidth, bodyHeight, 'content'));
  if (actionsWidth) panes.push(separator(bodyHeight, 'actions-edge'), column(actionRows({ ...common, active: mode === 'message-actions', width: actionsWidth }), actionsWidth, bodyHeight, 'actions'));
  const title = mode === 'message-actions' ? '消息操作' : mode === 'message-detail' ? '完整内容' : pageNames[page];
  const network = snapshot.network?.selected;
  const net = network ? `${network.name || network.interfaceName || '网络'} · ${network.address}` : '';
  const brand = '拾传  PickDrop', right = clipText(net, Math.max(0, columns - cells(brand) - 3));
  const hints = { chat: '↑↓ 选消息   ← 工作空间   → 操作区', workspace: '↑↓ 切换内容   → 内容区   Esc 回消息', 'message-actions': '↑↓ 选操作   → 进入   Enter 执行   ← 返回', compose: '←→ 光标   行首 ← 导航   Enter 发送', 'message-detail': '↑↓ 滚动   ← / Esc 返回操作' };
  const failed = groupTransfers(snapshot, current?.id).filter(task => task.status === 'failed').length;
  const alerts = [failed ? `${failed} 项传输失败` : '', snapshot.requests?.length ? `${snapshot.requests.length} 个加入申请` : '', snapshot.joins?.filter(join => join.status === 'pending').length ? `${snapshot.joins.filter(join => join.status === 'pending').length} 个申请等待批准` : ''].filter(Boolean).join(' · ');
  const routineNotice = notice.startsWith('后台已运行') || notice.startsWith('退出界面会停止');
  const status = busy ? ['处理中…', alerts].filter(Boolean).join(' · ') : [alerts, routineNotice ? '' : notice].filter(Boolean).join(' · ') || (workspace ? `已切换至 ${workspaceEntries[workspaceIndex]?.label || '工作空间'} · → 移入内容区` : `就绪 · ${snapshot.device?.name || '本机'}`);
  return h(Box, { width: columns, height: rows, flexDirection: 'column', flexShrink: 0 },
    drawLine(row(brand + ' '.repeat(Math.max(1, columns - cells(brand) - cells(right))) + right, 'accent', { bold: true }), columns, 'brand'),
    drawLine(row(`${current?.name || '群组'} / ${title || '消息'}${workspace ? ' · 工作空间' : ''}`, 'muted'), columns, 'breadcrumb'),
    drawLine(row('─'.repeat(columns), 'edge'), columns, 'top-rule'),
    h(Box, { width: columns, height: bodyHeight, flexShrink: 0 }, ...panes),
    drawLine(row('─'.repeat(columns), 'edge'), columns, 'bottom-rule'),
    drawLine(row(status, busy || failed ? 'warning' : 'muted'), columns, 'status'),
    drawLine(row(hints[mode] || hints.chat, 'accent', { bold: true }), columns, 'keys'),
    drawLine(row(mode === 'compose' ? 'Esc 保留草稿返回 · Ctrl+U 清空 · Ctrl+C 退出' : 'Esc 返回 · Ctrl+P 更多操作 · Ctrl+C 退出', 'muted'), columns, 'secondary-keys'));
}
