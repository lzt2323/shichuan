import React, { useEffect, useRef, useState } from 'react';
import { render, useApp, useInput, useStdout } from 'ink';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { rpc } from './rpc.js';
import { terminalText, expandPath } from './common.js';
import { getLayout, groupTransfers, messageLines, graphemes, limitText, taskStatus } from './layout.js';
import { PickDropScreen, chatViewport, modeLines } from './view.js';
import { fileSize } from '../../shared/protocol.js';
const h = React.createElement;
const actions = [ ['create', '创建一个传输群'], ['nearby', '发现附近的群'], ['join', '粘贴邀请链接'], ['invite', '邀请手机 / 电脑加入'], ['groups', '切换传输群'], ['files', '选择文件发送'], ['downloads', '下载群内文件'], ['requests', '处理加入申请'], ['tasks', '传输进度 / 取消 / 重试'], ['devices', '查看当前群设备'], ['networks', '选择传输网络'], ['help', '帮助与快捷键'], ['quit', '退出界面'] ];

export function App({ persistent = false, request = rpc, initialSnapshot, refreshInterval = 750, onDaemonStopped }) {
  const { exit } = useApp(), { stdout } = useStdout();
  const connected = useRef(false);
  const [snapshot, setSnapshot] = useState(initialSnapshot || { groups: [], state: { messages: [], devices: [] }, transfers: [], joins: [], requests: [] });
  const [group, setGroup] = useState(), [mode, setMode] = useState('chat'), [input, setInput] = useState(''), [items, setItems] = useState([]), [index, setIndex] = useState(0), [notice, setNotice] = useState(persistent ? '后台已运行；退出界面后继续传输。' : '退出界面会停止本次服务；需后台运行请使用 pickdrop --background。'), [busy, setBusy] = useState(false), [selected, setSelected] = useState([]), [offset, setOffset] = useState(0), [target, setTarget] = useState(), [qr, setQr] = useState('');
  const [{ width, height }, setSize] = useState(() => ({ width: stdout.columns || 80, height: stdout.rows || 24 }));
  useEffect(() => { const resize = () => setSize({ width: stdout.columns || 80, height: stdout.rows || 24 }); stdout.on('resize', resize); return () => stdout.off('resize', resize); }, [stdout]);
  const current = snapshot.groups.find(g => g.id === (group || snapshot.selectedGroupId));
  useEffect(() => {
    let alive = true, pending = false;
    const refresh = async () => { if (pending) return; pending = true; try { const value = await request('snapshot', { group }); if (alive) { connected.current = true; setSnapshot(value); } } catch (e) { if (alive) { setNotice(e.message); if (connected.current && ['ENOENT', 'ECONNREFUSED'].includes(e.code)) { onDaemonStopped?.(); exit(); } } } finally { pending = false; } };
    void refresh(); const timer = setInterval(refresh, refreshInterval); return () => { alive = false; clearInterval(timer); };
  }, [group, request, refreshInterval, exit, onDaemonStopped]);
  useEffect(() => {
    if (mode === 'tasks') setItems(groupTransfers(snapshot, current?.id).map(t => ({ ...t, label: `${t.name} · ${{ queued: '等待', running: '传输中', done: '完成', failed: '失败', cancelled: '已取消' }[t.status] || t.status} · ${fileSize(t.bytes)}/${fileSize(t.total)}${t.error ? ' · ' + t.error : ''}` })));
    if (mode === 'requests') setItems(snapshot.requests.map(r => ({ ...r, label: `${r.device.name} · Enter 允许 / D 拒绝` })));
    if (mode === 'devices') setItems(snapshot.state.devices.map(d => ({ ...d, label: `${d.online ? '● 在线' : '○ 离线'} · ${d.name}${d.id === snapshot.device?.id ? ' · 本机' : ''}` })));
  }, [snapshot.transfers, snapshot.requests, snapshot.state.devices, current?.id, mode]);
  useEffect(() => { setIndex(n => Math.max(0, Math.min(n, items.length - 1))); }, [items.length]);
  const run = async operation => { if (busy) return; setBusy(true); try { await operation(); } catch (e) { setNotice(e.message); } finally { setBusy(false); } };
  const showMenu = (name, entries) => { setMode(name); setOffset(0); setItems(entries); setIndex(0); setInput(''); };
  const browse = async value => { const next = await request('browse', { value, cwd: process.cwd() }); if (value.endsWith('/')) next.unshift({ name: '..', path: path.dirname(expandPath(value)), directory: true }); setItems(next.map(e => ({ ...e, label: `${e.directory ? '▸' : '·'} ${e.name}` }))); setIndex(0); setInput(value); setMode('files'); };
  const open = async name => {
    setInput(''); setNotice(''); setOffset(0);
    if (name === 'quit') { exit(); return; }
    if (name === 'create' || name === 'join' || name === 'help') { setMode(name); return; }
    if (name === 'groups') return showMenu(name, snapshot.groups.map(g => ({ id: g.id, label: `${g.online ? '●' : '○'} ${g.name}${g.local ? ' · 本机托管' : ''}` })));
    if (name === 'nearby') { const found = await request('nearby'); return showMenu(name, found.map(g => ({ ...g, label: `${g.name || '附近的传输群'} · ${g.baseUrl}` }))); }
    if (name === 'networks') { const net = await request('networks'); return showMenu(name, [{ selection: { mode: 'auto' }, label: '自动选择 · 推荐' }, ...net.interfaces.map(n => ({ selection: { mode: 'manual', interfaceName: n.name, address: n.address }, label: `${n.name} · ${n.address}${n.virtual ? ' · 虚拟网卡' : ''}` }))]); }
    if (name === 'files') { setSelected([]); return browse(process.cwd() + '/'); }
    if (!current) throw new Error('请先创建或加入一个群');
    if (name === 'invite') { const invite = await request('invite', { group: current.id }); if (!invite.link) throw new Error('没有可用的局域网地址，请选择传输网络'); setTarget(invite); setQr(await QRCode.toString(invite.link, { type: 'utf8', margin: 4 })); setMode('invite'); return; }
    if (name === 'devices') return showMenu(name, snapshot.state.devices.map(d => ({ ...d, label: `${d.online ? '● 在线' : '○ 离线'} · ${d.name}${d.id === snapshot.device?.id ? ' · 本机' : ''}` })));
    if (name === 'downloads') return showMenu(name, snapshot.state.messages.filter(m => m.type === 'file').reverse().map(m => ({ ...m, label: `${m.fileName} · ${fileSize(m.size)}` })));
    if (name === 'requests') return showMenu(name, snapshot.requests.map(r => ({ ...r, label: `${r.device.name} · Enter 允许 / D 拒绝` })));
    if (name === 'tasks') return showMenu(name, groupTransfers(snapshot, current?.id).map(t => ({ ...t, label: `${t.name} · ${taskStatus(t)} · ${fileSize(t.bytes)}/${fileSize(t.total)}${t.error ? ' · ' + t.error : ''}` })));
  };
  const submit = async () => {
    if (mode === 'chat') { if (!input.trim()) return; await request('text', { group: current?.id, text: input }); setInput(''); setOffset(0); }
    else if (mode === 'filepath') { await browse(input); }
    else if (mode === 'create') { const created = await request('create', { name: input }); setGroup(created.id); setMode('chat'); setInput(''); setNotice('群已创建，Ctrl+P → 邀请设备加入'); }
    else if (mode === 'join' || mode === 'code') { await request('join', mode === 'join' ? { link: input } : { address: target.baseUrl, code: input, expectedGroupId: target.groupId }); setMode('chat'); setInput(''); setNotice('加入申请已发出，等待群成员批准；批准后在切换群中打开。'); }
    else if (mode === 'destination') { const directory = expandPath(input); const tasks = await request('receive', { group: current.id, messageId: target.id, directory }); setSnapshot(previous => ({ ...previous, preferences: { ...previous.preferences, downloadDirectory: directory } })); setMode('chat'); setInput(''); setNotice(`已加入下载队列（${tasks.length} 个），完成后校验 SHA-256`); }
    else {
      const item = items[index]; if (!item) return;
      if (mode === 'actions') return open(item.id);
      if (mode === 'groups') { setGroup(item.id); setSnapshot(previous => ({ ...previous, selectedGroupId: item.id, state: { messages: [], devices: [] }, requests: [] })); setMode('chat'); setOffset(0); }
      if (mode === 'nearby') { setTarget(item); setMode('code'); setInput(''); }
      if (mode === 'networks') { await request('network', { selection: item.selection }); setMode('chat'); setNotice('已更新传输网络'); }
      if (mode === 'downloads') { setTarget(item); setMode('destination'); setInput(snapshot.preferences?.downloadDirectory || path.join(os.homedir(), 'Downloads', '拾传')); }
      if (mode === 'requests') { await request('respond', { group: current.id, requestId: item.id, allow: true }); await open('requests'); setNotice('已允许设备加入'); }
      if (mode === 'files') { if (item.directory) await browse(item.path + '/'); else setSelected(previous => previous.includes(item.path) ? previous.filter(p => p !== item.path) : [...previous, item.path]); }
    }
  };
  useInput((value, key) => {
    if (key.ctrl && value === 'c') { exit(); return; }
    if (busy) return;
    if (key.escape) { setMode('chat'); setInput(''); setOffset(0); return; }
    if (key.ctrl && value === 'p') { showMenu('actions', actions.map(([id, label]) => ({ id, label }))); return; }
    if (key.ctrl && value === 'o') { void run(() => open('files')); return; }
    if (key.ctrl && value === 'g') { void run(() => open('groups')); return; }
    if (key.pageUp || key.pageDown) {
      const layout = getLayout(width, height);
      const capacity = mode === 'chat' ? chatViewport(snapshot, current, layout).capacity : layout.contentHeight;
      const count = mode === 'chat' ? messageLines(snapshot.state.messages, layout.mainWidth - 4, snapshot.device?.id).length : modeLines({ mode, target, qr, items, index, selected, snapshot, width: layout.columns - 4, height: layout.contentHeight }).length;
      setOffset(n => Math.max(0, Math.min(Math.max(0, count - capacity), n + (mode === 'chat' ? key.pageUp ? 1 : -1 : key.pageDown ? 1 : -1) * Math.max(1, capacity - 1)))); return;
    }
    if (mode === 'files' && key.ctrl && value === 'l') { setMode('filepath'); return; }
    if (mode === 'files' && key.ctrl && value === 's') { void run(async () => { if (!current) throw new Error('请先加入一个群'); if (!selected.length) throw new Error('按空格选择文件，再按 Ctrl+S 发送'); await request('send', { group: current.id, files: selected }); setMode('chat'); setInput(''); setNotice(`${selected.length} 个文件已加入上传队列`); }); return; }
    if (['files', 'filepath'].includes(mode) && key.tab) { void run(async () => { const matches = await request('browse', { value: input, cwd: process.cwd() }); if (matches.length === 1) await browse(matches[0].path + (matches[0].directory ? '/' : '')); else { setItems(matches.map(e => ({ ...e, label: `${e.directory ? '▸' : '·'} ${e.name}` }))); setIndex(0); setOffset(0); setMode('files'); } }); return; }
    const menu = ['actions', 'groups', 'nearby', 'networks', 'downloads', 'requests', 'tasks', 'files', 'devices'].includes(mode);
    if (menu && (key.upArrow || key.downArrow)) { setIndex(n => Math.max(0, Math.min(items.length - 1, n + (key.upArrow ? -1 : 1)))); setOffset(0); return; }
    if (mode === 'tasks' && ['c', 'r'].includes(value.toLowerCase()) && items[index]) { void run(async () => { await request(value.toLowerCase() === 'c' ? 'cancel' : 'retry', { id: items[index].id }); await open('tasks'); }); return; }
    if (mode === 'requests' && value.toLowerCase() === 'd' && items[index]) { void run(async () => { await request('respond', { group: current.id, requestId: items[index].id, allow: false }); await open('requests'); }); return; }
    if (mode === 'files' && value === ' ' && items[index] && !items[index].directory) { void run(submit); return; }
    if (key.return) { void run(submit); return; }
    if (['chat', 'create', 'join', 'code', 'destination', 'filepath'].includes(mode)) {
      if (key.backspace || key.delete) setInput(s => graphemes(s).slice(0, -1).join(''));
      else if (key.ctrl && value === 'u') setInput('');
      else if (!key.ctrl && !key.meta && !key.tab) setInput(s => limitText(s + terminalText(value).replace(/\n/g, ' ')));
    }
  });
  return h(PickDropScreen, { width, height, snapshot, group: current, mode, input, items, index, notice, busy, selected, offset, target, qr });
}
export async function startUI({ persistent = false } = {}) {
  let daemonStopped = false;
  const instance = render(h(App, { persistent, onDaemonStopped: () => { daemonStopped = true; } }), { exitOnCtrlC: false });
  await instance.waitUntilExit();
  process.stdout.write(daemonStopped ? '后台服务已停止，已退出界面。\n' : persistent ? '已退出界面，后台继续运行。停止服务：pickdrop stop\n' : '已退出界面，正在停止本次服务。\n');
}
