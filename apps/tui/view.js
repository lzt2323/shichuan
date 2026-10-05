import React from 'react';
import { Box, Text } from 'ink';
import { terminalText, progressLabel } from './common.js';
import { fileSize } from '../../shared/protocol.js';
import { cells, clipText, wrapText, getLayout, groupTransfers, taskStatus, messageLines } from './layout.js';
const h = React.createElement;
export const theme = { base: '#0B1318', panel: '#101D23', text: '#DCE8EA', muted: '#8CA2AA', accent: '#3ED6BE', selected: '#16473F', border: '#34545F', warning: '#EDBF72' };
const row = (text, tone, extra = {}) => ({ text, tone, ...extra });
function line(value, width, key, background = theme.panel) {
  const entry = typeof value === 'string' ? row(value) : value || row('');
  const content = clipText(entry.text, width), padded = content + ' '.repeat(Math.max(0, width - cells(content)));
  return h(Text, { key, color: theme[entry.tone] || theme.text, backgroundColor: entry.selected ? theme.selected : background, bold: entry.bold, wrap: 'truncate-end' }, padded);
}
function panel(title, content, width, height, focused = false) {
  const inside = width - 4, border = focused ? 'accent' : 'border';
  const rows = [line(row('┌' + '─'.repeat(width - 2) + '┐', border), width, 'top')];
  const bordered = (entry, key) => {
    const value = clipText(entry.text, inside), background = entry.selected ? theme.selected : theme.panel;
    return h(Text, { key, backgroundColor: background, wrap: 'truncate-end' },
      h(Text, { color: theme[border] }, '│ '),
      h(Text, { color: entry.color || theme[entry.tone] || theme.text, backgroundColor: entry.background, bold: entry.bold }, value + ' '.repeat(Math.max(0, inside - cells(value)))),
      h(Text, { color: theme[border] }, ' │'));
  };
  rows.push(bordered(row(title, focused ? 'accent' : 'text', { bold: true }), 'title'));
  rows.push(line(row('├' + '─'.repeat(width - 2) + '┤', border), width, 'divider'));
  for (let i = 0; i < height - 4; i++) rows.push(bordered(typeof content[i] === 'string' ? row(content[i]) : content[i] || row(''), i));
  rows.push(line(row('└' + '─'.repeat(width - 2) + '┘', border), width, 'bottom'));
  return h(Box, { width, height, flexDirection: 'column', flexShrink: 0 }, rows);
}
function gutter(height, key) { return h(Box, { key, width: 1, height, flexDirection: 'column', flexShrink: 0 }, Array.from({ length: height }, (_, i) => line('', 1, i, theme.base))); }

export function chatViewport(snapshot, current, layout) {
  const tasks = groupTransfers(snapshot, current?.id);
  const featured = tasks.find(t => ['running', 'queued', 'failed'].includes(t.status));
  const taskRows = layout.kind !== 'wide' && featured ? 2 : 0;
  return { tasks, featured, capacity: Math.max(1, layout.contentHeight - taskRows), taskRows };
}
const titles = { actions: '操作菜单', create: '创建群 · 输入群名称', join: '加入群 · 粘贴完整邀请链接', code: '加入群 · 输入 6 位邀请码', groups: '我的传输群', nearby: '附近的群 · 同一局域网', networks: '传输网络', filepath: '输入文件路径 · Enter 浏览 / Tab 补全', files: '选择文件发送', downloads: '选择下载文件', destination: '保存到 · 输入目录', requests: '加入申请 · Enter 允许 / D 拒绝', tasks: '当前群任务 · C 取消 / R 重试', devices: '当前群设备', invite: '邀请设备加入', help: '快捷键与说明' };
export const helpText = 'Ctrl+P 操作菜单   Ctrl+G 切换群   Ctrl+O 发文件\nEnter 发送 / 确认   Esc 返回   Ctrl+U 清空输入\nPageUp / PageDown 浏览历史和长内容\n文件选择：↑↓ 移动，Enter 进入目录，空格多选，Ctrl+S 发送\nCtrl+L 输入路径，Tab 补全；SSH 选择的是远端机器的文件。\n下载同名文件自动另存，完成后校验 SHA-256。\n已存入群主机表示上传成功；其他设备需主动下载。\n后台已运行时 Ctrl+C 只退出界面，默认启动退出会停止服务。\npickdrop stop 停止后台；服务重启会中断待处理传输。';
export function modeLines({ mode, target, qr, items = [], index = 0, selected = [], snapshot, width, height = Infinity }) {
  const expand = (value, tone) => wrapText(value, width).map(text => row(text, tone));
  if (mode === 'invite') {
    const output = [...expand(`邀请码 ${target?.code || ''} · 有效至 ${new Date(target?.expiresAt).toLocaleTimeString('zh-CN')}`, 'accent'), row(''), ...expand(target?.link || '', 'text'), row(''), ...expand('复制上方完整邀请链接；PageDown 查看后续内容。', 'muted')];
    const qrLines = terminalText(qr).split('\n');
    if (qr && qrLines.every(value => cells(value) <= width) && output.length + 1 + qrLines.length <= height) output.push(row(''), ...qrLines.map(text => row(text, undefined, { color: '#000000', background: '#FFFFFF', qr: true })));
    else output.push(...expand('空间不足以完整显示二维码，请扩大窗口；完整链接仍可翻页查看。', 'muted'));
    return output;
  }
  if (mode === 'help') return expand(helpText);
  if (['create', 'join', 'code', 'destination', 'filepath'].includes(mode)) return expand(({ create: '例如：我的传输群', destination: '同名文件会自动另存。成功加入下载队列后记住此目录。', filepath: '输入本机路径，按 Tab 补全，Enter 浏览。', join: '粘贴完整邀请链接；加入申请需要已有群成员确认。', code: '输入邀请码，等待群成员批准。' })[mode], 'muted');
  if (!items.length) return expand('暂无内容；Esc 返回，Ctrl+P 选择其他操作。', 'muted');
  const result = [];
  items.forEach((item, i) => {
    const label = `${i === index ? '›' : ' '} ${mode === 'files' ? selected.includes(item.path) ? '[✓] ' : '[ ] ' : ''}${item.label}`;
    const parts = i === index ? wrapText(label, width) : [clipText(label, width)];
    for (const text of parts) result.push(row(text, i === index ? 'accent' : undefined, { selected: i === index, itemIndex: i }));
  });
  return result;
}
export function PickDropScreen({ width = 80, height = 24, snapshot = {}, group, mode = 'chat', input = '', items = [], index = 0, notice = '', busy = false, selected = [], offset = 0, target, qr = '' }) {
  const layout = getLayout(width, height), { columns, rows, bodyHeight, contentHeight } = layout;
  const current = typeof group === 'object' ? group : (snapshot.groups || []).find(g => g.id === (group || snapshot.selectedGroupId));
  const devices = snapshot.state?.devices || [], net = snapshot.network?.selected;
  const netLabel = net ? `${net.name || net.interfaceName || '网络'} · ${net.address}` : '网络未连接';
  if (layout.kind === 'tiny') return h(Box, { width: columns, height: rows, flexDirection: 'column' }, [row('拾传 · PickDrop', 'accent'), ...wrapText('终端太小，请至少调整到 40 列 × 12 行。', columns).map(text => row(text)), row('Ctrl+C 退出 · Esc 返回', 'muted')].slice(0, rows).map((value, i) => line(value, columns, i, theme.base)));
  const panels = [];
  let title = mode === 'files' ? `发文件 · ${snapshot.device?.name || '当前机器'}` : titles[mode], content;
  if (mode === 'chat') {
    title = current ? `${current.name} · ${devices.filter(d => d.online).length} 在线${current.online ? '' : ' · 群主机离线'}` : '欢迎使用拾传';
    const { tasks, featured, capacity, taskRows } = chatViewport(snapshot, current, layout);
    const all = messageLines(snapshot.state?.messages || [], layout.mainWidth - 4, snapshot.device?.id);
    const clamped = Math.min(offset, Math.max(0, all.length - capacity)), end = all.length - clamped;
    content = all.length ? all.slice(Math.max(0, end - capacity), end) : wrapText(current ? '还没有消息。发一句话，或按 Ctrl+O 选择文件。' : '把手机、电脑和服务器放进同一个传输群。\nCtrl+P 创建群 / 发现附近的群 / 加入群', layout.mainWidth - 4).map(text => row(text, 'muted'));
    while (content.length < capacity) content.push(row(''));
    if (taskRows) content.push(row(`${taskStatus(featured)} · ${featured.name}`, featured.status === 'failed' ? 'warning' : 'accent'), row(`${progressLabel(featured, layout.mainWidth - 4)} · Ctrl+P 任务`, 'muted'));
    if (layout.leftWidth) {
      const entries = (snapshot.groups || []).map(g => row(`${g.id === current?.id ? '▸' : ' '} ${g.name}`, g.id === current?.id ? 'accent' : 'muted', { selected: g.id === current?.id, bold: g.id === current?.id }));
      const selectedGroup = Math.max(0, (snapshot.groups || []).findIndex(g => g.id === current?.id));
      const groupBudget = layout.kind === 'medium' ? Math.max(2, Math.floor(contentHeight / 2) - 2) : contentHeight - 2;
      const start = Math.max(0, selectedGroup - groupBudget + 1);
      const left = entries.slice(start, start + groupBudget);
      if (!entries.length) left.push(row('暂无传输群', 'muted'));
      left.push(row(''), row('Ctrl+G 切换群', 'muted'));
      if (layout.kind === 'medium') left.push(row(''), row(`设备 · ${devices.filter(d => d.online).length} 在线`, 'accent'), ...devices.map(d => row(`${d.online ? '●' : '○'} ${d.name}${d.id === snapshot.device?.id ? ' · 我' : ''}`, d.online ? 'text' : 'muted')));
      panels.push(panel('群组', left, layout.leftWidth, bodyHeight), gutter(bodyHeight, 'gap-left'));
    }
    panels.push(panel(title, content, layout.mainWidth, bodyHeight, true));
    if (layout.rightWidth) {
      const budget = Math.max(2, Math.floor(contentHeight / 2) - 1), right = devices.slice(0, budget).map(d => row(`${d.online ? '●' : '○'} ${d.name}${d.id === snapshot.device?.id ? ' · 我' : ''}`, d.online ? 'text' : 'muted'));
      if (!devices.length) right.push(row('暂无设备', 'muted'));
      if (devices.length > budget) right.push(row(`另 ${devices.length - budget} 台 · 菜单查看`, 'muted'));
      right.push(row(''), row('当前群传输', 'accent'));
      const task = featured || tasks.at(-1);
      if (task) right.push(row(task.name), row(taskStatus(task), task.status === 'failed' ? 'warning' : 'accent'), row(progressLabel(task, layout.rightWidth - 4), 'accent'), row(`${fileSize(task.bytes)}/${fileSize(task.total)}`, 'muted'), ...(task.error ? wrapText(task.error, layout.rightWidth - 4).map(text => row(text, 'warning')) : []));
      else right.push(row('暂无传输任务', 'muted'));
      right.push(row(''), row('Ctrl+P 设备 / 任务', 'muted'));
      panels.push(gutter(bodyHeight, 'gap-right'), panel(`设备 · ${devices.filter(d => d.online).length} 在线`, right, layout.rightWidth, bodyHeight));
    }
  } else {
    const all = modeLines({ mode, target, qr, items, index, selected, snapshot, width: columns - 4, height: contentHeight });
    let start = Math.min(offset, Math.max(0, all.length - contentHeight));
    if (all.some(entry => entry.itemIndex !== undefined)) {
      const selectedStart = all.findIndex(entry => entry.itemIndex === index);
      const selectedEnd = all.findLastIndex(entry => entry.itemIndex === index);
      start = offset ? Math.min(selectedStart + offset, Math.max(selectedStart, selectedEnd - contentHeight + 1)) : Math.max(0, Math.min(selectedStart, selectedEnd - contentHeight + 1));
    }
    content = all.slice(start, start + contentHeight);
    if (all.length > contentHeight) title += ` · ${start + 1}–${Math.min(start + contentHeight, all.length)}/${all.length}`;
    panels.push(panel(title, content, columns, bodyHeight, true));
  }
  const pending = (snapshot.joins || []).filter(j => j.status === 'pending').length, requests = (snapshot.requests || []).length;
  const failed = groupTransfers(snapshot, current?.id).filter(task => task.status === 'failed').length;
  const alerts = [failed ? `${failed} 失败` : '', requests ? `${requests} 设备待批准` : '', pending ? `${pending} 申请等待批准` : '', failed || requests || pending ? 'Ctrl+P 处理' : '', mode === 'chat' && offset ? '历史 · PgDn 最新' : ''].filter(Boolean);
  const routineNotice = notice.startsWith('后台已运行') || notice.startsWith('退出界面会停止');
  const statusParts = notice && !routineNotice ? [notice, ...alerts] : [...alerts, notice || snapshot.discoveryError || ''];
  const status = busy ? '处理中…' : statusParts.filter(Boolean).join('  ·  ') || `${current?.online === false ? '群主机离线' : '就绪'} · ${snapshot.device?.name || '本机'}`;
  const editable = ['chat', 'create', 'join', 'code', 'destination', 'filepath'].includes(mode);
  const filePrefix = `已选 ${selected.length} 个 · `;
  const inputLabel = mode === 'files' ? filePrefix + clipText(input, columns - cells(filePrefix), true) : editable ? `› ${input || (mode === 'chat' ? '输入消息…' : '请输入…')} ▏` : '↑↓ 选择 · Enter 确认 · PgUp/PgDn 长内容 · Esc 返回';
  const keys = mode === 'files' ? (columns < 75 ? '空格多选 Ctrl+S发送 Ctrl+L路径 Tab补全 Esc返回' : '↑↓ 选择  Enter 进入  空格多选  Ctrl+S 发送  Ctrl+L 路径  Tab 补全  Esc 返回') : columns < 75 ? 'Ctrl+P菜单 Ctrl+O文件 Ctrl+G群 Esc返回 Ctrl+C退出' : 'Ctrl+P 菜单  Ctrl+O 发文件  Ctrl+G 切群  PgUp/Dn 历史  Esc 返回  Ctrl+C 退出';
  const brand = '拾传 · PickDrop', right = clipText(netLabel, Math.max(0, columns - cells(brand) - 3));
  return h(Box, { width: columns, height: rows, flexDirection: 'column', flexShrink: 0 },
    line(row(brand + ' '.repeat(Math.max(1, columns - cells(brand) - cells(right))) + right, 'accent', { bold: true }), columns, 'brand', theme.base),
    line(row('─'.repeat(columns), 'border'), columns, 'rule', theme.base),
    h(Box, { width: columns, height: bodyHeight, flexShrink: 0 }, ...panels),
    line(row(status, 'warning'), columns, 'notice', theme.base),
    line(row(clipText(inputLabel, columns, true), editable ? 'accent' : 'muted'), columns, 'input', theme.panel),
    line(row(keys, 'muted'), columns, 'keys', theme.base));
}
