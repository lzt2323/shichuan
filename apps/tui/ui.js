import React, { useEffect, useRef, useState } from 'react';
import { render, useApp, useInput, useStdout } from 'ink';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { rpc } from './rpc.js';
import { terminalText, expandPath } from './common.js';
import { getLayout, groupTransfers, messageLines, wrapText, graphemes, limitText, taskStatus } from './layout.js';
import { PickDropScreen, chatViewport, modeLines, groupRoleLabel, groupManagementEntries, requestLabel } from './view.js';
import { NavigationScreen, messageDetailText } from './navigation-view.js';
import { fileSize } from '../../shared/protocol.js';
const h = React.createElement;
const actions = [ ['create', '创建一个传输群'], ['nearby', '发现附近的群'], ['join', '粘贴邀请链接'], ['invite', '邀请手机 / 电脑加入'], ['groups', '切换传输群'], ['files', '选择文件发送'], ['downloads', '下载群内文件'], ['requests', '处理加入申请'], ['tasks', '传输进度 / 取消 / 重试'], ['devices', '查看当前群设备'], ['networks', '选择传输网络'], ['history', '加载更早的消息'], ['management', '群管理 · 名称 / 退出 / 解散'], ['help', '帮助与快捷键'], ['quit', '退出界面'] ];

export function App({ persistent = false, request = rpc, initialSnapshot, refreshInterval = 750, onDaemonStopped }) {
  const { exit } = useApp(), { stdout } = useStdout();
  const connected = useRef(false), groupRef = useRef(), busyRef = useRef(false), drafts = useRef({}), revision = useRef(0);
  const [snapshot, setSnapshot] = useState(initialSnapshot || { groups: [], state: { messages: [], devices: [] }, transfers: [], joins: [], requests: [] });
  const [group, setGroup] = useState(), [mode, setMode] = useState('chat'), [input, setInput] = useState(''), [items, setItems] = useState([]), [index, setIndex] = useState(0), [notice, setNotice] = useState(persistent ? '后台已运行；退出界面后继续传输。' : '退出界面会停止本次服务；需后台运行请使用 pickdrop --background。'), [busy, setBusy] = useState(false), [selected, setSelected] = useState([]), [offset, setOffset] = useState(0), [target, setTarget] = useState(), [qr, setQr] = useState('');
  const [workspaceIndex, setWorkspaceIndex] = useState(0), [messageIds, setMessageIds] = useState({}), [actionIndex, setActionIndex] = useState(0), [cursor, setCursor] = useState(0), [returnMode, setReturnMode] = useState('chat');
  const [{ width, height }, setSize] = useState(() => ({ width: stdout.columns || 80, height: stdout.rows || 24 }));
  useEffect(() => { const resize = () => setSize({ width: stdout.columns || 80, height: stdout.rows || 24 }); stdout.on('resize', resize); return () => stdout.off('resize', resize); }, [stdout]);
  const current = snapshot.groups.find(g => g.id === (group || snapshot.selectedGroupId));
  const workspaceEntries = [...snapshot.groups.map(g => ({ id: g.id, groupId: g.id, label: g.name, kind: 'group' })), ...[['compose', '发送消息'], ['files', '发送文件'], ['tasks', '传输任务'], ['settings', '保存位置'], ['more', '更多功能']].map(([kind, label]) => ({ id: kind, label, kind }))];
  const messages = snapshot.state.messages || [];
  const message = messages.find(m => m.id === messageIds[current?.id]) || messages.at(-1);
  const messageIndex = messages.indexOf(message);
  useEffect(() => { if (current && message && !messages.some(m => m.id === messageIds[current.id])) setMessageIds(previous => ({ ...previous, [current.id]: message.id })); }, [current?.id, message?.id, messages, messageIds]);
  useEffect(() => { if (mode === 'compose') drafts.current[current?.id || ''] = input; }, [input, mode, current?.id]);
  useEffect(() => { setWorkspaceIndex(i => Math.min(i, workspaceEntries.length - 1)); }, [workspaceEntries.length]);
  const changeGroup = id => { if (id === current?.id) return; groupRef.current = id; setGroup(id); setSnapshot(previous => ({ ...previous, selectedGroupId: id, state: { messages: [], devices: [] }, requests: [] })); setOffset(0); setTarget(undefined); };
  const enterWorkspace = () => { setMode('workspace'); setWorkspaceIndex(Math.max(0, snapshot.groups.findIndex(g => g.id === current?.id))); setOffset(0); };
  useEffect(() => {
    let alive = true, pending = false;
    const refresh = async () => { if (pending) return; pending = true; const startedAt = revision.current; try { const value = await request('snapshot', { group }); if (alive && groupRef.current === group && revision.current === startedAt) { connected.current = true; setSnapshot(value); } } catch (e) { if (alive) { setNotice(e.message); if (connected.current && ['ENOENT', 'ECONNREFUSED'].includes(e.code)) { onDaemonStopped?.(); exit(); } } } finally { pending = false; } };
    void refresh(); const timer = setInterval(refresh, refreshInterval); return () => { alive = false; clearInterval(timer); };
  }, [group, request, refreshInterval, exit, onDaemonStopped]);
  useEffect(() => {
    if (mode === 'tasks') setItems(groupTransfers(snapshot, current?.id).map(t => ({ ...t, label: `${t.name} · ${{ queued: '等待', waiting: '等待在线副本', running: '传输中', done: '完成', failed: '失败', cancelled: '已取消' }[t.status] || t.status} · ${fileSize(t.bytes)}/${fileSize(t.total)}${t.error ? ' · ' + t.error : ''}` })));
    if (mode === 'requests') setItems(snapshot.requests.map(r => ({ ...r, label: requestLabel(r) })));
    if (mode === 'devices') setItems(snapshot.state.devices.map(d => ({ ...d, label: `${d.online ? '● 在线' : '○ 离线'} · ${d.name}${d.id === snapshot.device?.id ? ' · 本机' : ''}` })));
  }, [snapshot.transfers, snapshot.requests, snapshot.state.devices, current?.id, mode]);
  useEffect(() => { setIndex(n => Math.max(0, Math.min(n, items.length - 1))); }, [items.length]);
  const run = async operation => { if (busyRef.current) return; busyRef.current = true; setBusy(true); try { await operation(); } catch (e) { setNotice(e.message); } finally { busyRef.current = false; setBusy(false); } };
  const showMenu = (name, entries) => { setMode(name); setOffset(0); setItems(entries); setIndex(0); setInput(''); };
  const browse = async value => { const next = await request('browse', { value, cwd: process.cwd() }); if (value.endsWith('/')) next.unshift({ name: '..', path: path.dirname(expandPath(value)), directory: true }); setItems([...next.map(e => ({ ...e, label: `${e.directory ? '▸' : '·'} ${e.name}` })), { id: 'send-selected', label: '发送已选文件' }, { id: 'edit-path', label: '输入其他路径' }]); setIndex(0); setInput(value); setMode('files'); };
  const open = async name => {
    setInput(''); setCursor(0); setNotice(''); setOffset(0);
    if (name === 'compose') { if (!current) throw new Error('请先创建或加入一个群'); const draft = drafts.current[current.id] || ''; setInput(draft); setCursor(graphemes(draft).length); setMode('compose'); return; }
    if (name === 'settings') { const directory = snapshot.preferences?.downloadDirectory || path.join(os.homedir(), 'Downloads', '拾传'); setInput(directory); setCursor(graphemes(directory).length); setMode('settings'); return; }
    if (name === 'quit') { exit(); return; }
    if (name === 'create') { let number = 1; while (snapshot.groups.some(item => item.name === `传输群 ${number}`)) number++; const name = `传输群 ${number}`; setInput(name); setCursor(graphemes(name).length); setMode('create'); return; }
    if (name === 'join' || name === 'help') { setMode(name); return; }
    if (name === 'groups') return showMenu(name, snapshot.groups.map(g => ({ id: g.id, label: `${g.online ? '●' : '○'} ${g.name} · ${groupRoleLabel(g)} · ${g.id.slice(0, 6)}` })));
    if (name === 'nearby') { const found = await request('nearby'); if (snapshot.network?.discoveryError) setNotice(`自动发现受限：${snapshot.network.discoveryError}；可粘贴完整邀请链接连接。`); return showMenu(name, found.map(g => ({ ...g, label: `${g.name || '附近的传输群'} · ${g.baseUrl}` }))); }
    if (name === 'networks') { const net = await request('networks'); return showMenu(name, [{ selection: { mode: 'auto' }, label: '自动选择 · 推荐' }, ...net.interfaces.map(n => ({ selection: { mode: 'manual', interfaceName: n.name, address: n.address }, label: `${n.name} · ${n.address}${n.virtual ? ' · 虚拟网卡' : ''}` }))]); }
    if (name === 'files') { setSelected([]); return browse(process.cwd() + '/'); }
    if (!current) throw new Error('请先创建或加入一个群');
    if (name === 'management') return showMenu(name, groupManagementEntries(current));
    if (name === 'history') { const state = await request('history', { group: current.id }); revision.current++; setSnapshot(previous => ({ ...previous, state })); setMode('chat'); setNotice(state.history?.hasMore ? '已加载更早的消息；在最早消息处按 ↑ 可继续加载。' : '已加载全部可用消息'); return; }
    if (name === 'invite') { const invite = await request('invite', { group: current.id }); if (!invite.link) throw new Error('没有可用的局域网地址，请选择传输网络'); setTarget(invite); setQr(await QRCode.toString(invite.link, { type: 'utf8', margin: 4 })); setMode('invite'); return; }
    if (name === 'devices') return showMenu(name, snapshot.state.devices.map(d => ({ ...d, label: `${d.online ? '● 在线' : '○ 离线'} · ${d.name}${d.id === snapshot.device?.id ? ' · 本机' : ''}` })));
    if (name === 'downloads') return showMenu(name, snapshot.state.messages.filter(m => m.type === 'file').reverse().map(m => ({ ...m, label: `${m.fileName} · ${fileSize(m.size)}` })));
    if (name === 'requests') return showMenu(name, snapshot.requests.map(r => ({ ...r, label: requestLabel(r) })));
    if (name === 'tasks') return showMenu(name, groupTransfers(snapshot, current?.id).map(t => ({ ...t, label: `${t.name} · ${taskStatus(t)} · ${fileSize(t.bytes)}/${fileSize(t.total)}${t.error ? ' · ' + t.error : ''}` })));
  };
  const confirmAction = (operation, description, requestId) => { setTarget({ operation, description, requestId, groupId: current.id }); showMenu('confirm', [{id:'cancel',label:'取消'}, {id:'confirm',label:'确认执行'}]); };
  const respond = async (item, allow) => {
    if (allow && item.reset) {
      if (!(current.mode === 'peer' ? current.canManage : current.local || current.hostDeviceId === snapshot.device?.id)) throw new Error('仅群创建者可以恢复设备授权');
      return confirmAction('respond', `恢复或重置「${item.device.name}」的设备授权，原连接将失效。请核实设备身份。`, item.id);
    }
    await request('respond', {group:current.id,requestId:item.id,allow}); await open('requests');
  };
  const submit = async () => {
    if (mode === 'compose') { if (!input.trim()) return; await request('text', { group: current?.id, text: input }); drafts.current[current.id] = ''; setInput(''); setMode('chat'); setNotice('消息已发送'); setOffset(0); }
    else if (mode === 'rename') { await request('rename', {group:current.id,name:input}); revision.current++; setSnapshot(await request('snapshot',{group:current.id})); setMode('chat'); setNotice('群名称已更新'); }
    else if (mode === 'filepath') { await browse(input); }
    else if (mode === 'create') { const created = await request('create', { name: input }); groupRef.current = created.id; setGroup(created.id); setSnapshot(previous => ({ ...previous, selectedGroupId: created.id, groups: [...previous.groups.filter(g => g.id !== created.id), created], state: { messages: [], devices: [] }, requests: [] })); setMode('chat'); setInput(''); setNotice('群已创建，Ctrl+P → 邀请设备加入'); }
    else if (mode === 'join' || mode === 'code') { await request('join', mode === 'join' ? { link: input } : { address: target.baseUrl, code: input, expectedGroupId: target.groupId }); setMode('chat'); setInput(''); setNotice('加入申请已发出，等待群成员批准；批准后在切换群中打开。'); }
    else if (mode === 'settings') { const preferences = await request('preferences', { downloadDirectory: expandPath(input) }); revision.current++; setSnapshot(previous => ({ ...previous, preferences })); setMode('workspace'); setNotice('保存位置已记住，下次下载默认使用此目录'); }
    else if (mode === 'destination') { const directory = expandPath(input); const tasks = await request('receive', { group: current.id, messageId: target.id, directory }); revision.current++; setSnapshot(previous => ({ ...previous, preferences: { ...previous.preferences, downloadDirectory: directory }, transfers: [...previous.transfers, ...tasks.map(task => ({ type: 'download', groupId: current.id, messageId: target.id, name: target.fileName, status: 'queued', bytes: 0, total: target.size, ...task }))] })); setMode('chat'); setInput(''); setNotice(`已加入下载队列（${tasks.length} 个）`); }
    else {
      const item = items[index]; if (!item) return;
      if (mode === 'task-actions') { await request(item.id, { id: target.id }); return open('tasks'); }
      if (mode === 'request-actions') return respond(target, item.id === 'allow');
      if (mode === 'management') {
        if (item.id === 'rename') { setInput(current.name); setCursor(graphemes(current.name).length); setMode('rename'); return; }
        const descriptions = {delete:'解散整个群。所有成员收到同步后将无法继续使用，已保存文件保留。',leave:'退出此群并移除本机关联，重新加入需要邀请。已保存文件保留。',forget:'仅移除本机关联，不保证撤销其他设备保存的授权。已保存文件保留。',upgrade:'升级为多设备群，旧客户端需升级后重新邀请加入。现有文件按在线副本接收。'};
        return confirmAction(item.id, descriptions[item.id]);
      }
      if (mode === 'confirm') {
        if (item.id === 'cancel') { setMode('chat'); return; }
        if (target.operation === 'respond') { await request('respond',{group:target.groupId,requestId:target.requestId,allow:true}); return open('requests'); }
        await request(target.operation,{group:target.groupId});
        revision.current++; const remaining = await request('snapshot',{}); groupRef.current = undefined; setGroup(undefined); setSnapshot(remaining); setMode('chat'); setNotice('群操作已完成'); return;
      }
      if (mode === 'actions') return open(item.id);
      if (mode === 'groups') { changeGroup(item.id); setMode('chat'); setOffset(0); }
      if (mode === 'nearby') { setTarget(item); setMode('code'); setInput(''); }
      if (mode === 'networks') { await request('network', { selection: item.selection }); setMode('chat'); setNotice('已更新传输网络'); }
      if (mode === 'downloads') { setReturnMode('downloads'); setTarget(item); setMode('destination'); const directory = snapshot.preferences?.downloadDirectory || path.join(os.homedir(), 'Downloads', '拾传'); setInput(directory); setCursor(graphemes(directory).length); }
      if (mode === 'requests') return respond(item, true);
      if (mode === 'files') { if (item.id === 'send-selected') return sendSelected(); if (item.id === 'edit-path') { setMode('filepath'); setCursor(graphemes(input).length); return; } if (item.directory) await browse(item.path + '/'); else setSelected(previous => previous.includes(item.path) ? previous.filter(p => p !== item.path) : [...previous, item.path]); }
    }
  };
  const sendSelected = async () => {
    if (!current) throw new Error('请先加入一个群');
    if (!selected.length) throw new Error('先按 Enter 或空格选择文件，再选择“发送已选文件”');
    await request('send', { group: current.id, files: selected }); setMode('chat'); setInput(''); setNotice(`${selected.length} 个文件已加入上传队列`);
  };
  const messageAction = async (navigateOnly = false) => {
    if (!message || !current) return;
    if (message.type !== 'file') { setMode(actionIndex === 0 ? 'message-detail' : 'chat'); setOffset(0); return; }
    if (actionIndex === 3) { setMode('chat'); return; }
    if (actionIndex === 2) { setMode('message-detail'); setOffset(0); return; }
    if (actionIndex === 1) { setTarget(message); setReturnMode('message-actions'); const dir = snapshot.preferences?.downloadDirectory || path.join(os.homedir(), 'Downloads', '拾传'); setInput(dir); setCursor(graphemes(dir).length); setMode('destination'); return; }
    if (navigateOnly) return;
    const task = [...groupTransfers(snapshot, current.id)].reverse().find(t => t.type === 'download' && t.messageId === message.id);
    if (task && ['queued', 'running', 'waiting'].includes(task.status)) { setNotice(task.status === 'waiting' ? '此文件正在等待在线副本，可在传输任务中立即重试或取消' : '此文件已在下载队列中'); return; }
    if (task?.status === 'done') { setNotice(`已保存：${task.result || snapshot.preferences?.downloadDirectory || ''}`); setMode('message-detail'); setOffset(0); return; }
    if (task && ['failed', 'cancelled'].includes(task.status)) { await request('retry', { id: task.id }); setNotice('已重新加入下载队列'); }
    else { const tasks = await request('receive', { group: current.id, messageId: message.id, directory: snapshot.preferences?.downloadDirectory || path.join(os.homedir(), 'Downloads', '拾传') }); revision.current++; setSnapshot(previous => ({ ...previous, transfers: [...previous.transfers, ...tasks.map(task => ({ type: 'download', groupId: current.id, messageId: message.id, name: message.fileName, status: 'queued', bytes: 0, total: message.size, ...task }))] })); setNotice('已加入下载队列'); }
    setMode('chat');
  };
  useInput((value, key) => {
    if (key.ctrl && value === 'c') { exit(); return; }
    if (busyRef.current) return;
    if (key.escape) { if (mode === 'compose') { setMode('workspace'); setWorkspaceIndex(snapshot.groups.length); } else if (mode === 'message-detail') setMode('message-actions'); else if (mode === 'message-actions') setMode('chat'); else if (mode === 'destination') setMode(returnMode); else if (mode === 'task-actions') void run(() => open('tasks')); else if (mode === 'request-actions') void run(() => open('requests')); else setMode('chat'); setOffset(0); return; }
    if (key.ctrl && value === 'p') { showMenu('actions', actions.map(([id, label]) => ({ id, label }))); return; }
    if (key.ctrl && value === 'o') { void run(() => open('files')); return; }
    if (key.ctrl && value === 'g') { void run(() => open('groups')); return; }
    if (mode === 'workspace') {
      if (key.upArrow || key.downArrow) { const next = Math.max(0, Math.min(workspaceEntries.length - 1, workspaceIndex + (key.downArrow ? 1 : -1))); setWorkspaceIndex(next); const entry = workspaceEntries[next]; if (entry.kind === 'group') changeGroup(entry.groupId); return; }
      if (key.rightArrow || key.return) { const entry = workspaceEntries[workspaceIndex]; if (entry.kind === 'group') { changeGroup(entry.groupId); setMode('chat'); } else if (entry.kind === 'more') showMenu('actions', actions.map(([id, label]) => ({ id, label }))); else void run(() => open(entry.kind)); return; }
      return;
    }
    if (mode === 'chat') {
      if (key.leftArrow) { enterWorkspace(); return; }
      if (key.rightArrow || key.return) { if (message) { setActionIndex(0); setMode('message-actions'); } return; }
      if ((key.upArrow || key.pageUp) && messageIndex === 0 && snapshot.state.history?.hasMore) { void run(() => open('history')); return; }
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) { const jump = key.pageUp || key.pageDown ? Math.max(1, Math.floor((height - 10) / 3)) : 1; const next = Math.max(0, Math.min(messages.length - 1, messageIndex + (key.upArrow || key.pageUp ? -jump : jump))); if (messages[next]) setMessageIds(previous => ({ ...previous, [current.id]: messages[next].id })); return; }
      return;
    }
    if (mode === 'message-actions') {
      if (key.leftArrow) { setMode('chat'); return; }
      if (key.upArrow || key.downArrow) { setActionIndex(i => Math.max(0, Math.min(message?.type === 'file' ? 3 : 1, i + (key.downArrow ? 1 : -1)))); return; }
      if (key.rightArrow || key.return) void run(() => messageAction(!!key.rightArrow));
      return;
    }
    if (mode === 'message-detail') {
      if (key.leftArrow) { setMode('message-actions'); return; }
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) { const lines = wrapText(messageDetailText(message, snapshot, current?.id), Math.max(1, width - 1 - (width >= 100 ? 26 : 0))); setOffset(n => Math.max(0, Math.min(lines.length - 1, n + (key.upArrow || key.pageUp ? -1 : 1) * (key.pageUp || key.pageDown ? Math.max(1, height - 10) : 1)))); } return;
    }
    const editable = ['rename', 'compose', 'create', 'join', 'code', 'destination', 'settings', 'filepath'].includes(mode);
    if (editable && (key.leftArrow || key.rightArrow)) { if (key.leftArrow && cursor === 0) { if (mode === 'destination') setMode(returnMode); else if (mode === 'compose') { setMode('workspace'); setWorkspaceIndex(snapshot.groups.length); } else enterWorkspace(); } else setCursor(n => Math.max(0, Math.min(graphemes(input).length, n + (key.leftArrow ? -1 : 1)))); return; }
    if (!editable && key.leftArrow) { if (mode === 'task-actions') void run(() => open('tasks')); else if (mode === 'request-actions') void run(() => open('requests')); else { setMode('workspace'); setOffset(0); } return; }
    if (key.pageUp || key.pageDown) {
      const layout = getLayout(width, height);
      const capacity = mode === 'chat' ? chatViewport(snapshot, current, layout).capacity : layout.contentHeight;
      const count = mode === 'chat' ? messageLines(snapshot.state.messages, layout.mainWidth - 4, snapshot.device?.id).length : modeLines({ mode, target, qr, items, index, selected, snapshot, width: layout.columns - 4, height: layout.contentHeight }).length;
      setOffset(n => Math.max(0, Math.min(Math.max(0, count - capacity), n + (mode === 'chat' ? key.pageUp ? 1 : -1 : key.pageDown ? 1 : -1) * Math.max(1, capacity - 1)))); return;
    }
    if (mode === 'files' && key.ctrl && value === 'l') { setMode('filepath'); setCursor(graphemes(input).length); return; }
    if (mode === 'files' && key.ctrl && value === 's') { void run(sendSelected); return; }
    if (['files', 'filepath'].includes(mode) && key.tab) { void run(async () => { const matches = await request('browse', { value: input, cwd: process.cwd() }); if (matches.length === 1) await browse(matches[0].path + (matches[0].directory ? '/' : '')); else { setItems([...matches.map(e => ({ ...e, label: `${e.directory ? '▸' : '·'} ${e.name}` })), { id: 'send-selected', label: '发送已选文件' }, { id: 'edit-path', label: '输入其他路径' }]); setIndex(0); setOffset(0); setMode('files'); } }); return; }
    const menu = ['management', 'confirm', 'task-actions', 'request-actions', 'actions', 'groups', 'nearby', 'networks', 'downloads', 'requests', 'tasks', 'files', 'devices'].includes(mode);
    if (menu && (key.upArrow || key.downArrow)) { setIndex(n => Math.max(0, Math.min(items.length - 1, n + (key.upArrow ? -1 : 1)))); setOffset(0); return; }
    if (mode === 'tasks' && ['c', 'r'].includes(value.toLowerCase()) && items[index]) { void run(async () => { await request(value.toLowerCase() === 'c' ? 'cancel' : 'retry', { id: items[index].id }); await open('tasks'); }); return; }
    if (mode === 'requests' && value.toLowerCase() === 'd' && items[index]) { void run(async () => { await request('respond', { group: current.id, requestId: items[index].id, allow: false }); await open('requests'); }); return; }
    if (mode === 'files' && value === ' ' && items[index] && !items[index].directory) { void run(submit); return; }
    if (key.rightArrow && menu) {
      if (mode === 'tasks' && items[index]) { setTarget(items[index]); showMenu('task-actions', items[index].status === 'waiting' ? [{id:'retry',label:'立即重试'}, {id:'cancel',label:'取消等待'}] : ['failed', 'cancelled'].includes(items[index].status) ? [{ id: 'retry', label: '重试传输' }] : ['queued', 'running', 'waiting'].includes(items[index].status) ? [{ id: 'cancel', label: '取消传输' }] : []); }
      else if (mode === 'requests' && items[index]) { setTarget(items[index]); showMenu('request-actions', [{ id: 'allow', label: items[index].reset ? '恢复授权 · 原连接将失效' : '允许加入' }, { id: 'deny', label: '拒绝加入' }]); }
      else if (['groups', 'nearby', 'downloads'].includes(mode) || mode === 'actions' && items[index]?.id !== 'quit' || mode === 'files' && items[index]?.directory) void run(submit);
      return;
    }
    if (key.return) { void run(submit); return; }
    if (editable) {
      const parts = graphemes(input);
      if (key.backspace || key.delete) { if (cursor > 0) { parts.splice(cursor - 1, 1); setInput(parts.join('')); setCursor(cursor - 1); } }
      else if (key.ctrl && value === 'u') { setInput(''); setCursor(0); }
      else if (!key.ctrl && !key.meta && !key.tab) { const text = terminalText(value).replace(/\n/g, ' '); parts.splice(cursor, 0, text); const next = limitText(parts.join('')); setInput(next); setCursor(Math.min(graphemes(next).length, cursor + graphemes(text).length)); }
    }
  });
  if (['chat', 'workspace', 'compose', 'message-actions', 'message-detail'].includes(mode)) return h(NavigationScreen, { width, height, snapshot, group: current, mode, workspaceEntries, workspaceIndex, message, messageIndex, actionIndex, input, cursor, notice, busy, detailOffset: offset });
  return h(PickDropScreen, { width, height, snapshot, group: current, mode, input, items, index, notice, busy, selected, offset, target, qr, cursor });
}
export async function startUI({ persistent = false } = {}) {
  let daemonStopped = false;
  const instance = render(h(App, { persistent, onDaemonStopped: () => { daemonStopped = true; } }), { exitOnCtrlC: false });
  await instance.waitUntilExit();
  process.stdout.write(daemonStopped ? '后台服务已停止，已退出界面。\n' : persistent ? '已退出界面，后台继续运行。停止服务：pickdrop stop\n' : '已退出界面，正在停止本次服务。\n');
}
