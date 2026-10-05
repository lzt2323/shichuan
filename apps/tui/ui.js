import React, { useEffect, useState } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { rpc } from './rpc.js';
import { terminalText, expandPath, progressLabel } from './common.js';
import { fileSize } from '../../shared/protocol.js';
const h = React.createElement;
const text = (value, props = {}) => h(Text, props, terminalText(value));
const actions = [ ['create', '创建一个传输群'], ['nearby', '发现附近的群'], ['join', '粘贴邀请链接'], ['invite', '邀请手机 / 电脑加入'], ['groups', '切换传输群'], ['files', '选择文件发送'], ['downloads', '下载群内文件'], ['requests', '处理加入申请'], ['tasks', '传输进度 / 取消 / 重试'], ['networks', '选择传输网络'], ['help', '帮助与快捷键'], ['quit', '退出界面'] ];

function App({ persistent }) {
  const { exit } = useApp(), { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState({ groups: [], state: { messages: [], devices: [] }, transfers: [], joins: [], requests: [] });
  const [group, setGroup] = useState(), [mode, setMode] = useState('chat'), [input, setInput] = useState(''), [items, setItems] = useState([]), [index, setIndex] = useState(0), [notice, setNotice] = useState(persistent ? '后台已运行；退出界面后继续传输。' : '退出界面会停止本次服务；需后台运行请使用 pickdrop --background。'), [busy, setBusy] = useState(false), [selected, setSelected] = useState([]), [offset, setOffset] = useState(0), [target, setTarget] = useState(), [qr, setQr] = useState('');
  const width = stdout.columns || 80, height = stdout.rows || 24;
  const current = snapshot.groups.find(g => g.id === (group || snapshot.selectedGroupId));
  useEffect(() => {
    let alive = true, pending = false;
    const refresh = async () => { if (pending) return; pending = true; try { const value = await rpc('snapshot', { group }); if (alive) setSnapshot(value); } catch (e) { if (alive) setNotice(e.message); } finally { pending = false; } };
    void refresh(); const timer = setInterval(refresh, 750); return () => { alive = false; clearInterval(timer); };
  }, [group]);
  useEffect(() => {
    if (mode === 'tasks') setItems(snapshot.transfers.map(t => ({ ...t, label: `${t.name} · ${{ queued: '等待', running: '传输中', done: '完成', failed: '失败', cancelled: '已取消' }[t.status] || t.status} · ${fileSize(t.bytes)}/${fileSize(t.total)}${t.error ? ' · ' + t.error : ''}` })));
    if (mode === 'requests') setItems(snapshot.requests.map(r => ({ ...r, label: `${r.device.name} · Enter 允许 / D 拒绝` })));
  }, [snapshot.transfers, snapshot.requests, mode]);
  useEffect(() => { setIndex(n => Math.max(0, Math.min(n, items.length - 1))); }, [items.length]);
  const run = async operation => { if (busy) return; setBusy(true); try { await operation(); } catch (e) { setNotice(e.message); } finally { setBusy(false); } };
  const showMenu = (name, entries) => { setMode(name); setItems(entries); setIndex(0); setInput(''); };
  const browse = async value => { const next = await rpc('browse', { value, cwd: process.cwd() }); if (value.endsWith('/')) next.unshift({ name: '..', path: path.dirname(expandPath(value)), directory: true }); setItems(next.map(e => ({ ...e, label: `${e.directory ? '▸' : '·'} ${e.name}` }))); setIndex(0); setInput(value); setMode('files'); };
  const open = async name => {
    setInput(''); setNotice('');
    if (name === 'quit') { exit(); return; }
    if (name === 'create' || name === 'join' || name === 'help') { setMode(name); return; }
    if (name === 'groups') return showMenu(name, snapshot.groups.map(g => ({ id: g.id, label: `${g.online ? '●' : '○'} ${g.name}${g.local ? ' · 本机托管' : ''}` })));
    if (name === 'nearby') { const found = await rpc('nearby'); return showMenu(name, found.map(g => ({ ...g, label: `${g.name || '附近的传输群'} · ${g.baseUrl}` }))); }
    if (name === 'networks') { const net = await rpc('networks'); return showMenu(name, [{ selection: { mode: 'auto' }, label: '自动选择 · 推荐' }, ...net.interfaces.map(n => ({ selection: { mode: 'manual', interfaceName: n.name, address: n.address }, label: `${n.name} · ${n.address}${n.virtual ? ' · 虚拟网卡' : ''}` }))]); }
    if (name === 'files') { setSelected([]); return browse(process.cwd() + '/'); }
    if (!current) throw new Error('请先创建或加入一个群');
    if (name === 'invite') { const invite = await rpc('invite', { group: current.id }); if (!invite.link) throw new Error('没有可用的局域网地址，请选择传输网络'); setTarget(invite); setQr(await QRCode.toString(invite.link, { type: 'utf8', small: true })); setMode('invite'); return; }
    if (name === 'downloads') return showMenu(name, snapshot.state.messages.filter(m => m.type === 'file').reverse().map(m => ({ ...m, label: `${m.fileName} · ${fileSize(m.size)}` })));
    if (name === 'requests') return showMenu(name, snapshot.requests.map(r => ({ ...r, label: `${r.device.name} · Enter 允许 / D 拒绝` })));
    if (name === 'tasks') return showMenu(name, snapshot.transfers.map(t => ({ ...t, label: `${t.name} · ${t.status} · ${fileSize(t.bytes)}/${fileSize(t.total)}${t.error ? ' · ' + t.error : ''}` })));
  };
  const submit = async () => {
    if (mode === 'chat') { if (!input.trim()) return; await rpc('text', { group: current?.id, text: input }); setInput(''); setOffset(0); }
    else if (mode === 'filepath') { await browse(input); }
    else if (mode === 'create') { const created = await rpc('create', { name: input }); setGroup(created.id); setMode('chat'); setInput(''); setNotice('群已创建，Ctrl+P → 邀请设备加入'); }
    else if (mode === 'join' || mode === 'code') { await rpc('join', mode === 'join' ? { link: input } : { address: target.baseUrl, code: input, expectedGroupId: target.groupId }); setMode('chat'); setInput(''); setNotice('加入申请已发出，等待群成员批准；批准后在切换群中打开。'); }
    else if (mode === 'destination') { const tasks = await rpc('receive', { group: current.id, messageId: target.id, directory: expandPath(input) }); setMode('chat'); setInput(''); setNotice(`已加入下载队列（${tasks.length} 个），完成后校验 SHA-256`); }
    else {
      const item = items[index]; if (!item) return;
      if (mode === 'actions') return open(item.id);
      if (mode === 'groups') { setGroup(item.id); setMode('chat'); setOffset(0); }
      if (mode === 'nearby') { setTarget(item); setMode('code'); setInput(''); }
      if (mode === 'networks') { await rpc('network', { selection: item.selection }); setMode('chat'); setNotice('已更新传输网络'); }
      if (mode === 'downloads') { setTarget(item); setMode('destination'); setInput(path.join(os.homedir(), 'Downloads', '拾传')); }
      if (mode === 'requests') { await rpc('respond', { group: current.id, requestId: item.id, allow: true }); await open('requests'); setNotice('已允许设备加入'); }
      if (mode === 'files') { if (item.directory) await browse(item.path + '/'); else setSelected(previous => previous.includes(item.path) ? previous.filter(p => p !== item.path) : [...previous, item.path]); }
    }
  };
  useInput((value, key) => {
    if (key.ctrl && value === 'c') { exit(); return; }
    if (busy) return;
    if (key.escape) { setMode('chat'); setInput(''); return; }
    if (key.ctrl && value === 'p') { showMenu('actions', actions.map(([id, label]) => ({ id, label }))); return; }
    if (key.ctrl && value === 'o') { void run(() => open('files')); return; }
    if (key.ctrl && value === 'g') { void run(() => open('groups')); return; }
    if (mode === 'chat' && (key.pageUp || key.pageDown)) { setOffset(n => Math.max(0, Math.min(snapshot.state.messages.length - 1, n + (key.pageUp ? 4 : -4)))); return; }
    if (mode === 'files' && key.ctrl && value === 'l') { setMode('filepath'); return; }
    if (mode === 'files' && key.ctrl && value === 's') { void run(async () => { if (!current) throw new Error('请先加入一个群'); if (!selected.length) throw new Error('按空格选择文件，再按 Ctrl+S 发送'); await rpc('send', { group: current.id, files: selected }); setMode('chat'); setInput(''); setNotice(`${selected.length} 个文件已加入上传队列`); }); return; }
    if (['files', 'filepath'].includes(mode) && key.tab) { void run(async () => { const matches = await rpc('browse', { value: input, cwd: process.cwd() }); if (matches.length === 1) await browse(matches[0].path + (matches[0].directory ? '/' : '')); else { setItems(matches.map(e => ({ ...e, label: `${e.directory ? '▸' : '·'} ${e.name}` }))); setIndex(0); } }); return; }
    const menu = ['actions', 'groups', 'nearby', 'networks', 'downloads', 'requests', 'tasks', 'files'].includes(mode);
    if (menu && (key.upArrow || key.downArrow)) { setIndex(n => Math.max(0, Math.min(items.length - 1, n + (key.upArrow ? -1 : 1)))); return; }
    if (mode === 'tasks' && ['c', 'r'].includes(value.toLowerCase()) && items[index]) { void run(async () => { await rpc(value.toLowerCase() === 'c' ? 'cancel' : 'retry', { id: items[index].id }); await open('tasks'); }); return; }
    if (mode === 'requests' && value.toLowerCase() === 'd' && items[index]) { void run(async () => { await rpc('respond', { group: current.id, requestId: items[index].id, allow: false }); await open('requests'); }); return; }
    if (mode === 'files' && value === ' ' && items[index] && !items[index].directory) { void run(submit); return; }
    if (key.return) { void run(submit); return; }
    if (['chat', 'create', 'join', 'code', 'destination', 'filepath'].includes(mode)) {
      if (key.backspace || key.delete) setInput(s => [...s].slice(0, -1).join(''));
      else if (key.ctrl && value === 'u') setInput('');
      else if (!key.ctrl && !key.meta && !key.tab) setInput(s => (s + terminalText(value).replace(/\n/g, ' ')).slice(0, 10000));
    }
  });
  const net = snapshot.network?.selected, netLabel = net ? `${net.name || net.interfaceName || '网络'} · ${net.address}` : '网络未连接';
  const count = Math.max(1, Math.floor((height - 11) / 3)), messages = snapshot.state.messages || [], end = Math.max(0, messages.length - offset);
  const title = ({ chat: current?.name || '欢迎使用拾传', actions: '操作菜单', create: '创建群 · 输入群名称', join: '加入群 · 粘贴完整邀请链接', code: '加入群 · 输入该设备的 6 位邀请码', groups: '我的传输群', nearby: '附近的群 · 同一局域网', networks: '传输网络', filepath: '输入文件路径 · Enter 浏览 / Tab 补全', files: `发送文件 · 当前机器 ${snapshot.device?.name || os.hostname()}`, downloads: '选择下载文件', destination: '保存到 · 请输入目录', requests: '加入申请', tasks: '传输任务 · C 取消 / R 重试', invite: '邀请设备加入 · 一次性邀请码', help: '快捷键与说明' })[mode];
  let body;
  if (mode === 'chat') body = messages.length ? messages.slice(Math.max(0, end - count), end).map(m => h(Box, { key: m.id, flexDirection: 'column', marginBottom: 1 }, text(`${m.senderName}${m.senderId === snapshot.device?.id ? ' · 我' : ''}   ${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, { dimColor: true }), text(m.type === 'file' ? `▣ ${m.fileName}  ${fileSize(m.size)} · 已存入群主机` : m.text.replace(/\n/g, ' ').slice(0, width * 2), { wrap: 'truncate-end' }))) : [text(current ? '还没有消息。发一句话，或按 Ctrl+O 选择文件。' : '把手机、电脑和服务器放进同一个传输群。', { dimColor: true }), text('Ctrl+P → 创建群 / 发现附近的群 / 粘贴邀请链接', { color: 'cyan' })];
  else if (mode === 'invite') body = [text(`邀请码 ${target?.code} · 有效至 ${new Date(target?.expiresAt).toLocaleTimeString()}`, { color: 'cyan', bold: true }), text(target?.link, { wrap: 'wrap' }), ...(width >= 60 && height >= 36 ? [text(qr)] : [text('终端空间不足显示二维码；复制完整链接发给手机即可。', { dimColor: true })])];
  else if (mode === 'help') body = [text('Ctrl+P 操作菜单   Ctrl+G 切换群   Ctrl+O 发文件\nEnter 发送 / 确认   Esc 返回   Ctrl+U 清空输入\nPageUp / PageDown 浏览历史\n文件选择：↑↓ 移动，Enter 进入目录，空格多选，Ctrl+S 发送\nCtrl+L 输入路径，Tab 补全；SSH 选择的是远端机器的文件。\n下载同名文件自动另存，完成后校验 SHA-256。\n已运行后台时 Ctrl+C 只退出界面。默认启动退出会停止服务。\npickdrop stop 停止后台；服务重启会中断待处理传输。')];
  else if (['create', 'join', 'code', 'destination', 'filepath'].includes(mode)) body = [text(mode === 'create' ? '例如：我的传输群' : mode === 'destination' ? '同名文件会自动另存，不覆盖现有文件。' : '加入申请需要已有群成员确认。', { dimColor: true })];
  else {
    const size = Math.max(3, height - 12), start = Math.max(0, index - size + 1);
    body = items.length ? items.slice(start, start + size).map((item, i) => text(`${index === start + i ? '›' : ' '} ${mode === 'files' && selected.includes(item.path) ? '[✓] ' : ''}${item.label}`, { key: item.id || item.path || String(start + i), color: index === start + i ? 'cyan' : undefined, wrap: 'truncate-end' })) : [text('暂无内容；Esc 返回，Ctrl+P 选择其他操作。', { dimColor: true })];
  }
  const active = snapshot.transfers.filter(t => ['running', 'queued'].includes(t.status));
  const pending = snapshot.joins.filter(j => j.status === 'pending');
  return h(Box, { flexDirection: 'column', width: Math.max(1, width - 1) },
    h(Box, { justifyContent: 'space-between' }, text('拾传 · PickDrop', { bold: true, color: 'cyan' }), text(netLabel, { dimColor: true, wrap: 'truncate-end' })),
    text('─'.repeat(Math.max(1, width - 2)), { dimColor: true }),
    text(`${title}${mode === 'chat' && current ? `  · ${snapshot.state.devices.filter(d => d.online).length} 台在线${current.online ? '' : ' · 群主机离线'}` : ''}`, { bold: true }),
    h(Box, { flexDirection: 'column', marginTop: 1, minHeight: Math.min(8, height - 10) }, ...body),
    active.length ? text(`${progressLabel(active[0], width)}${width >= 36 ? ' · ' + active[0].name : ''}${width >= 70 ? ' · ' + fileSize(active[0].bytes) + '/' + fileSize(active[0].total) : ''}`, { color: 'cyan', wrap: 'truncate-end' }) : null,
    snapshot.requests.length ? text(`${snapshot.requests.length} 个设备等待批准 · Ctrl+P → 处理加入申请`, { color: 'yellow' }) : null,
    pending.length ? text(`${pending.length} 个加入申请等待批准`, { color: 'yellow' }) : null,
    text(busy ? '处理中…' : notice || snapshot.discoveryError || '', { color: 'yellow', wrap: 'truncate-end' }),
    ['chat', 'create', 'join', 'code', 'destination', 'files', 'filepath'].includes(mode) ? text(`${mode === 'files' ? `路径（已选 ${selected.length} 个）` : '›'} ${input || (mode === 'chat' ? '输入消息…' : '')}`, { color: input ? undefined : 'gray', wrap: 'truncate-start' }) : null,
    text(mode === 'files' ? '↑↓ 选择  Enter 进入  空格多选  Ctrl+L 路径  Ctrl+S 发送  Esc 返回' : 'Ctrl+P 菜单  Ctrl+O 发文件  Ctrl+G 切换群  Esc 返回  Ctrl+C 退出界面', { dimColor: true, wrap: 'truncate-end' }));
}
export async function startUI({ persistent = false } = {}) {
  const instance = render(h(App, { persistent }), { exitOnCtrlC: false });
  await instance.waitUntilExit();
  process.stdout.write(persistent ? '已退出界面，后台继续运行。停止服务：pickdrop stop\n' : '已退出界面，正在停止本次服务。\n');
}
