import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, FlatList, Image, KeyboardAvoidingView, Linking, Platform, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Sharing from 'expo-sharing';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { createNearbyDiscovery } from './src/discovery';
import { discoveredInvite, assertDiscoveredTicket } from './src/discovery-core';
import type { NearbyGroup } from './src/discovery-core';
import { NearbyGroups } from './src/components/NearbyGroups';
import { fileSize } from '../../shared/protocol';
import { createMobileClient, parseInviteLink } from './src/client';
import type { Device, Group, Message, GroupState, JoinTicket, Invite, JoinRequest, ConnectionStatus } from './src/client';
import { transfers } from './src/transfers';
import { pasteClipboardImage } from './src/clipboard-images';
import { ImageDrafts } from './src/components/ImageDrafts';
import type { TransferGroup, TransferItem } from './src/transfers';
import { Avatar, Button, IconButton, Notice, Busy, Sheet, MotionProvider, MotionView, palette } from './src/components/ui';

type Panel = 'join' | 'members' | 'invite' | 'settings' | 'transfers' | 'share' | null;
type RawShare = { value: string; shareType: string; mimeType?: string };
const webMemory = new Map<string, string>();
const connectionStorage = Platform.OS === 'web' ? { getItemAsync: async (key: string) => webMemory.get(key) || null, setItemAsync: async (key: string, value: string) => { webMemory.set(key, value); }, deleteItemAsync: async (key: string) => { webMemory.delete(key); } } : SecureStore;
const emptyState: GroupState = { messages: [], devices: [] };
const phase: Record<TransferItem['status'], string> = { preparing: '准备中', draft: '待发送', queued: '排队中', uploading: '正在发送', downloading: '正在接收', verifying: '正在校验', completed: '已完成', failed: '失败', cancelled: '已取消' };
const inFlight = (item: TransferItem) => ['preparing', 'queued', 'uploading', 'downloading', 'verifying'].includes(item.status);
const messageTime = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const dateLabel = (value: string) => new Date(value).toLocaleDateString('zh-CN') === new Date().toLocaleDateString('zh-CN') ? '今天' : new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });

export default function App() { return <MotionProvider><SafeAreaProvider><MobileApp /></SafeAreaProvider></MotionProvider>; }
function MobileApp() {
  const [client] = useState(() => createMobileClient({ storage: connectionStorage, randomUUID: Crypto.randomUUID, deviceName: Platform.OS === 'ios' ? '我的 iPhone' : '我的安卓手机', kind: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web' }));
  const [initAttempt, setInitAttempt] = useState(0);
  const [arrivals, setArrivals] = useState<Record<string, Set<string>>>({});
  const [ready, setReady] = useState(false), [device, setDevice] = useState<Device | null>(null), [groups, setGroups] = useState<Group[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null), [home, setHome] = useState(true), [states, setStates] = useState<Record<string, GroupState>>({});
  const [status, setStatus] = useState<ConnectionStatus>('offline'), [reconnect, setReconnect] = useState(0), [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [panel, setPanel] = useState<Panel>(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [joinMode, setJoinMode] = useState<'nearby' | 'code' | 'link'>('nearby'), [address, setAddress] = useState(''), [code, setCode] = useState(''), [link, setLink] = useState(''), [name, setName] = useState('');
  const [pending, setPending] = useState<JoinTicket | null>(null), [joinStatus, setJoinStatus] = useState(''), [requests, setRequests] = useState<JoinRequest[]>([]), [invite, setInvite] = useState<Invite | null>(null), [now, setNow] = useState(Date.now());
  const [discovery] = useState(createNearbyDiscovery), [nearby, setNearby] = useState(() => discovery.getSnapshot()), [nearbySelection, setNearbySelection] = useState<NearbyGroup | null>(null);
  const [scanning, setScanning] = useState(false), [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [queue, setQueue] = useState<TransferItem[]>(transfers.getSnapshot()), [incoming, setIncoming] = useState<RawShare[]>([]), [shareTarget, setShareTarget] = useState<string | null>(null);
  const list = useRef<FlatList<Message>>(null), nearBottom = useRef(true), scanLock = useRef(false), sending = useRef(false), joinAbort = useRef<AbortController | null>(null), incomingSignature = useRef('');
  const currentGroup = useRef(activeId), inviteEpoch = useRef(0), busyEpoch = useRef(0), knownMessages = useRef<Record<string, Set<string>>>({}), selectionEpoch = useRef(0);
  currentGroup.current = activeId;
  const pasteContext = useRef({ activeId, home, panel, appActive });
  pasteContext.current = { activeId, home, panel, appActive };
  const activeGroup = groups.find(group => group.id === activeId) || null;
  const groupState = activeId ? states[activeId] || emptyState : emptyState;
  const groupQueue = queue.filter(item => item.groupId === activeId), draftFiles = groupQueue.filter(item => item.status === 'draft');
  const activeTransfers = groupQueue.filter(inFlight), failedTransfers = groupQueue.filter(item => item.status === 'failed');
  const text = activeId ? drafts[activeId] || '' : '', online = status === 'online';
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : '操作失败，请重试'), []);
  const refreshGroups = useCallback(() => { setGroups(client.listGroups()); setDevice(client.device); }, [client]);
  const setText = (value: string) => { if (activeId) setDrafts(current => ({ ...current, [activeId]: value })); };
  const makeTransferGroup = useCallback((group: Group, deviceId: string, maxFileBytes?: number): TransferGroup => {
    const snapshot = { ...group };
    return { ...snapshot, deviceId, maxFileBytes, verify: async () => {
      const verifySnapshot = () => { const current = client.getGroup(snapshot.id); if (current.baseUrl !== snapshot.baseUrl || current.key !== snapshot.key) throw new Error('群连接已更新，请重新选择文件'); };
      verifySnapshot(); await client.verifyGroup(snapshot.id); verifySnapshot();
    } };
  }, [client]);
  const transferGroup = (group: Group) => makeTransferGroup(group, device!.id, states[group.id]?.maxFileBytes);
  const perform = async (label: string, callback: () => Promise<unknown>) => { const operation = ++busyEpoch.current; setBusy(label); setError(''); try { await callback(); } catch (cause) { if (operation === busyEpoch.current) report(cause); } finally { if (operation === busyEpoch.current) setBusy(''); } };

  useEffect(() => {
    let alive = true; setReady(false); setError('');
    client.init().then(saved => { if (alive) { setDevice(saved.device); setName(saved.device.name); setGroups(saved.groups); setActiveId(saved.activeGroupId); setReady(true); if (Platform.OS !== 'web') transfers.restoreDrafts(saved.groups.map(group => makeTransferGroup(group, saved.device.id))).catch(report); } }).catch(cause => { if (alive) { report(cause); setReady(true); } });
    return () => { alive = false; joinAbort.current?.abort(); };
  }, [client, report, makeTransferGroup, initAttempt]);
  useEffect(() => { const subscription = AppState.addEventListener('change', value => setAppActive(value === 'active')); return () => subscription.remove(); }, []);
  useEffect(() => {
    if (Platform.OS !== 'android' || home || panel) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { setHome(true); setError(''); return true; });
    return () => subscription.remove();
  }, [home, panel]);
  useEffect(() => transfers.subscribe(() => setQueue(transfers.getSnapshot())), []);
  useEffect(() => {
    if (!activeId || !device) return;
    const groupId = activeId; setStatus('connecting'); setRequests([]);
    const watcher = client.watchGroup(groupId, { onState: next => { const previous = knownMessages.current[groupId]; setArrivals(current => ({ ...current, [groupId]: new Set(previous ? next.messages.filter(message => !previous.has(message.id)).map(message => message.id) : []) })); knownMessages.current[groupId] = new Set(next.messages.map(message => message.id)); setStates(current => ({ ...current, [groupId]: next })); }, onStatus: setStatus, onError: () => {} });
    watcher.setActive(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', value => watcher.setActive(value === 'active'));
    return () => { subscription.remove(); watcher.close(); };
  }, [client, activeId, device?.name, reconnect]);
  useEffect(() => {
    if (!activeId || !online || !appActive) return;
    let alive = true, loading = false;
    const refresh = async () => { if (loading) return; loading = true; try { const next = await client.listJoinRequests(activeId); if (alive) setRequests(next); } catch {} finally { loading = false; } };
    refresh(); const timer = setInterval(refresh, 3500); return () => { alive = false; clearInterval(timer); };
  }, [client, activeId, online, appActive]);
  useEffect(() => { if (panel !== 'invite') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [panel]);
  // Expo's useIncomingShare also resolves remote URLs. Read the raw payloads so
  // receiving a link never fetches it or sends anything before confirmation.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const read = () => { try { const payloads = Sharing.getSharedPayloads(); const signature = JSON.stringify(payloads); if (payloads.length && signature !== incomingSignature.current) { incomingSignature.current = signature; setIncoming(payloads); setShareTarget(activeId || groups[0]?.id || null); setPanel('share'); } } catch {} };
    read(); const subscription = AppState.addEventListener('change', value => { if (value === 'active') read(); }); return () => subscription.remove();
  }, [activeId, groups]);
  useEffect(() => {
    const receiveLink = (url: string) => { if (/^https?:\/\//i.test(url) && /[#&](invite|key)=/.test(url)) { setLink(url); setJoinMode('link'); setPanel('join'); } };
    Linking.getInitialURL().then(url => { if (url) receiveLink(url); }).catch(() => {});
    const subscription = Linking.addEventListener('url', event => receiveLink(event.url)); return () => subscription.remove();
  }, []);

  useEffect(() => { const unsubscribe = discovery.subscribe(setNearby); return () => { unsubscribe(); discovery.dispose(); }; }, [discovery]);
  useEffect(() => {
    if (panel === 'join' && joinMode === 'nearby' && !scanning && !pending && appActive) { void discovery.start(); return () => discovery.stop(); }
    discovery.stop();
  }, [discovery, panel, joinMode, scanning, pending, appActive]);
  async function chooseNearby(group: NearbyGroup) {
    const existing = groups.find(item => item.id === group.groupId);
    if (!existing) { setNearbySelection(group); setCode(''); return; }
    await perform('正在验证并连接电脑…', async () => {
      if (existing.hostDeviceId && existing.hostDeviceId !== group.hostDeviceId) throw new Error('发现的电脑与已加入的群主机不一致，请重新扫码确认');
      const updated = await client.reconnectAt(existing.id, group.baseUrl); refreshGroups(); setReconnect(value => value + 1); await selectGroup(updated);
    });
  }

  async function selectGroup(group: Group) {
    inviteEpoch.current++; const selection = ++selectionEpoch.current; await client.setActiveGroup(group.id); if (selection !== selectionEpoch.current) return; const changed = currentGroup.current !== group.id; currentGroup.current = group.id; if (changed) { setStatus('connecting'); setRequests([]); } setActiveId(group.id); setHome(false); setPanel(null); setError(''); nearBottom.current = true;
  }
  function openJoin() { setJoinMode('nearby'); setNearbySelection(null); setCode(''); setError(''); setPanel('join'); }
  async function connect(value: string, expected?: NearbyGroup) {
    if (!device || busy || pending || joinAbort.current) return;
    const abort = new AbortController(); joinAbort.current = abort; setBusy('正在提交加入申请…'); setError(''); setJoinStatus('');
    try {
      const parsed = parseInviteLink(value);
      let joined: Group;
      if (parsed.legacy) joined = await client.joinLink(value, { signal: abort.signal });
      else {
        const ticket = await client.requestJoin(value, { signal: abort.signal });
        if (abort.signal.aborted) return;
        if (expected) assertDiscoveredTicket(expected, ticket);
        setPending(ticket); setJoinStatus(`等待「${ticket.groupName}」允许加入`); setBusy('');
        joined = await client.waitForJoin(ticket, { signal: abort.signal });
      }
      if (abort.signal.aborted) return;
      refreshGroups(); await selectGroup(joined); setPending(null); setLink(''); setCode('');
    } catch (cause) { if (!abort.signal.aborted) { setPending(null); report(cause); } }
    finally { if (joinAbort.current === abort) { joinAbort.current = null; setBusy(''); } }
  }
  function cancelJoin() { joinAbort.current?.abort(); joinAbort.current = null; setPending(null); setJoinStatus(''); setBusy(''); }
  function connectCode() {
    try { const base = new URL(address.trim().includes('://') ? address.trim() : `http://${address.trim()}`); if (!/^https?:$/.test(base.protocol) || base.username || base.password || !/^\d{6}$/.test(code)) throw new Error('请填写电脑地址和 6 位邀请码'); base.hash = `invite=${code}`; connect(base.toString()); } catch (cause) { report(cause); }
  }
  async function scan() {
    setError(''); const granted = cameraPermission?.granted || (await requestCameraPermission()).granted;
    if (!granted) { setError('相机权限未开启，可以粘贴邀请链接或填写邀请码加入。'); return; }
    scanLock.current = false; setScanning(true);
  }
  async function sendCurrent() {
    if (!activeGroup || !online || sending.current || (!text.trim() && !draftFiles.length)) return;
    const groupId = activeGroup.id, outgoing = text.trim(); sending.current = true; setBusy('发送中…'); setError('');
    try {
      if (outgoing) { await client.api(groupId, '/api/messages', { method: 'POST', body: { text: outgoing } }); setDrafts(current => ({ ...current, [groupId]: current[groupId]?.trim() === outgoing ? '' : current[groupId] })); }
      void transfers.startGroupDrafts(groupId).catch(report); if (currentGroup.current === groupId) { nearBottom.current = true; list.current?.scrollToEnd({ animated: false }); }
    } catch (cause) { report(cause); } finally { sending.current = false; setBusy(''); }
  }
  async function pickFiles() { if (Platform.OS === 'web') { setError('文件选择与传输请使用 iOS 或 Android 客户端；当前是浏览器界面预览。'); return; } if (!activeGroup || !device) return; const target = transferGroup(activeGroup); await perform('准备文件…', () => transfers.pickFiles(target)); }
  async function pasteImage() {
    if (Platform.OS !== 'android' || !activeGroup || !device || busy) return;
    const target = transferGroup(activeGroup), selection = selectionEpoch.current;
    const isCurrent = () => pasteContext.current.activeId === target.id && !pasteContext.current.home && !pasteContext.current.panel && pasteContext.current.appActive && selectionEpoch.current === selection;
    await perform('读取剪贴板图片…', async () => {
      try { await pasteClipboardImage(target, isCurrent); }
      catch (cause) { if (isCurrent()) throw cause; }
    });
  }
  async function shareFile(message: Message) { if (Platform.OS === 'web') { setError('文件接收与系统分享请使用 iOS 或 Android 客户端。'); return; } if (!activeGroup || !device) return; try { await transfers.downloadAndShare(transferGroup(activeGroup), message); } catch (cause) { report(cause); } }
  async function createInvite() { if (!activeGroup) return; const groupId = activeGroup.id, operation = ++inviteEpoch.current; setPanel('invite'); setInvite(null); await perform('正在生成邀请码…', async () => { const result = await client.createInvite(groupId); if (currentGroup.current === groupId && inviteEpoch.current === operation) { setInvite(result); setNow(Date.now()); } }); }
  async function respond(request: JoinRequest, allow: boolean) { if (!activeId) return; const id = activeId; await perform('正在处理…', async () => { await client.respondJoin(id, request.id, allow); const next = await client.listJoinRequests(id); if (currentGroup.current === id) setRequests(next); }); }
  async function prepareIncoming() {
    const group = groups.find(item => item.id === shareTarget); if (!group || !device) return;
    await perform('准备分享内容…', async () => {
      const assets = incoming.filter(item => !['text', 'url'].includes(item.shareType));
      if (assets.some(item => !/^(file|content):\/\//i.test(item.value))) throw new Error('分享的文件地址无法直接读取，请先保存到手机，再用“添加文件”选择。');
      if (assets.length) {
        const ids = await transfers.importIncoming(transferGroup(group), assets.map(item => ({ uri: item.value, mimeType: item.mimeType })));
        const failed = ids.map((id, index) => ({ id, asset: assets[index], item: transfers.getSnapshot().find(item => item.id === id) })).filter(result => result.item?.status !== 'draft');
        if (failed.length) {
          // Keep successful copies in the chosen group's drafts and only retry
          // failed inputs. Do not revoke provider access by clearing the share.
          setIncoming([...failed.map(result => result.asset), ...incoming.filter(item => ['text', 'url'].includes(item.shareType))]);
          await Promise.all(failed.map(result => transfers.remove(result.id)));
          throw new Error(`${failed.length} 个文件未能读取；其余文件已放入「${group.name}」待发送。请重试或从文件选择器添加。`);
        }
      }
      const sharedText = incoming.filter(item => ['text', 'url'].includes(item.shareType)).map(item => item.value).join('\n');
      if (sharedText) setDrafts(current => ({ ...current, [group.id]: [current[group.id], sharedText].filter(Boolean).join('\n') }));
      Sharing.clearSharedPayloads(); incomingSignature.current = ''; setIncoming([]); await selectGroup(group);
    });
  }
  const inviteSeconds = invite ? Math.max(0, Math.ceil((Number(invite.expiresAt) - now) / 1000)) : 0;
  const inviteLink = invite?.link || '';
  const currentOnline = groupState.devices.filter(item => item.online).length;
  const closePanel = () => { inviteEpoch.current++; setScanning(false); setPanel(null); setError(''); };

  function transferRow(item: TransferItem) {
    const percent = item.progress === undefined ? '' : ` · ${Math.round(item.progress * 100)}%`;
    return <View key={item.id} style={s.transferCard}><View style={s.transferHead}><Text numberOfLines={1} style={s.transferName}>{item.name}</Text><Text style={[s.transferStatus, item.status === 'failed' && s.red]}>{phase[item.status]}{percent}</Text></View><Text style={s.small}>{item.direction === 'upload' ? '发往' : '来自'} {item.groupName || '当前群'} · {fileSize(item.size || 0)}</Text>{item.progress !== undefined && inFlight(item) && <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(item.progress * 100) }} style={s.progressTrack}><View style={[s.progressFill, { width: `${Math.round(item.progress * 100)}%` }]} /></View>}{!!item.error && <Text style={s.fieldError}>{item.error}</Text>}<View style={s.actions}>{inFlight(item) && <Button compact label="取消" onPress={() => { transfers.cancel(item.id).catch(report); }} />}{['failed', 'cancelled'].includes(item.status) && <Button compact label="重试" onPress={() => { Promise.resolve(transfers.retry(item.id)).catch(report); }} />}{item.status === 'draft' && <Button compact label="发送" disabled={!online} onPress={() => { Promise.resolve(transfers.start(item.id)).catch(report); }} />}{!inFlight(item) && <Button compact label={item.status === 'draft' ? '移除' : '清除记录'} onPress={() => { Promise.resolve(transfers.remove(item.id)).catch(report); }} />}</View></View>;
  }
  if (!ready) return <SafeAreaView style={s.screen}><ActivityIndicator style={s.flex} color={palette.blue} /></SafeAreaView>;
  if (!device) return <SafeAreaView style={s.screen}><View style={s.welcome}><Text style={s.sheetHero}>暂时无法读取设备信息</Text><Text style={s.description}>{error || '请重试加载本机连接。'}</Text><Button primary label="重试加载" onPress={() => setInitAttempt(value => value + 1)} /></View></SafeAreaView>;
  return <SafeAreaView style={s.screen} edges={['top', 'bottom']}><StatusBar style="dark" /><KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    {home || !activeGroup ? <>
      <View style={s.homeHeader}><View style={s.brand}><Image source={require('./assets/brand-mark.png')} style={s.brandMark} accessible={false} /><View><Text accessibilityRole="header" style={s.brandName}>拾传</Text><Text style={s.brandCaption}>一个群，一起传文件</Text></View></View><View style={s.actions}><IconButton glyph="⚙" label="设备设置" onPress={() => setPanel('settings')} /><IconButton glyph="＋" label="加入传输群" onPress={openJoin} /></View></View>
      {Platform.OS === 'web' && <Notice text="浏览器界面预览 · 群连接可用，文件与系统分享请在手机客户端体验。连接仅保留在当前页面。" />}
      {!!pending && <Pressable accessibilityRole="button" onPress={openJoin} style={s.pendingBanner}><ActivityIndicator size="small" color={palette.blue} /><Text style={s.pendingText}>加入申请等待允许 · 点此查看</Text></Pressable>}
      <FlatList data={groups} keyExtractor={group => group.id} contentContainerStyle={s.groupList} ListHeaderComponent={groups.length ? <Text style={s.sectionLabel}>我的传输群 · {groups.length}</Text> : null} ListEmptyComponent={<View style={s.welcome}><View style={s.welcomeMark}><Text style={s.welcomeGlyph}>⇄</Text></View><Text accessibilityRole="header" style={s.welcomeTitle}>文件，递给大家。</Text><Text style={s.welcomeText}>{'加入电脑上的传输群，\n文字和文件都在同一个窗口里。'}</Text><Button primary label="＋ 加入一个群" onPress={openJoin} /><Text style={s.welcomeNote}>手机和电脑连接同一网络即可开始</Text></View>} renderItem={({ item }) => {
        const latest = states[item.id]?.messages.at(-1), count = queue.filter(task => task.groupId === item.id && (inFlight(task) || task.status === 'draft')).length;
        return <Pressable accessibilityRole="button" testID={`group-${item.id}`} accessibilityLabel={`打开${item.name}`} onPress={() => selectGroup(item).catch(report)} style={({ pressed }) => [s.groupCard, pressed && s.pressed]}><View style={s.groupIcon}><Text style={s.groupGlyph}>⇄</Text></View><View style={s.groupInfo}><View style={s.groupTitleRow}><Text numberOfLines={1} style={s.groupName}>{item.name}</Text>{latest && <Text style={s.small}>{messageTime(latest.createdAt)}</Text>}</View><Text numberOfLines={1} style={s.groupPreview}>{count ? `${count} 项文件待发或传输中` : latest ? latest.type === 'file' ? `${latest.senderName}：${latest.fileName}` : `${latest.senderName}：${latest.text}` : '进入群，开始传文件'}</Text></View><Text style={s.chevron}>›</Text></Pressable>;
      }} />
    </> : <MotionView key={activeGroup.id} style={s.flex}>
      <View style={s.chatHeader}><IconButton glyph="‹" label="返回群列表" onPress={() => { setHome(true); setError(''); }} /><Pressable accessibilityRole="button" accessibilityLabel="查看群成员" onPress={() => setPanel('members')} style={s.chatTitleButton}><Text numberOfLines={1} style={s.chatTitle}>{activeGroup.name}</Text><Text style={s.chatSubtitle}>文字和文件，发到同一个群</Text></Pressable><IconButton glyph="···" label="群成员与邀请" onPress={() => setPanel('members')} /></View>
      <Pressable accessibilityRole="button" accessibilityLabel={`群成员，${online ? `${currentOnline} 台设备在线` : '连接尚未恢复'}`} onPress={() => setPanel('members')} style={s.membersStrip}><View style={s.avatarStack}>{groupState.devices.slice(0, 3).map((member, index) => <View key={member.id} style={[s.stackedAvatar, index > 0 && { marginLeft: -7 }]}><Avatar size={27} name={member.id === device?.id ? '我' : member.name} id={member.id} muted={!member.online} /></View>)}</View><Text numberOfLines={1} style={s.memberNames}>{groupState.devices.slice(0, 3).map(member => member.id === device?.id ? '我' : member.name).join('、') || '等待连接群成员'}</Text><Text style={[s.connection, !online && s.offline]}>{online ? `● ${currentOnline} 在线` : '○ 连接中'}</Text></Pressable>
      {!online && <View style={s.offlineBanner}><Text style={s.offlineText}>{status === 'paused' ? '回到前台后继续同步' : '暂未连上电脑，正在重连；待发内容会保留。'}</Text><Button compact label="重连" onPress={() => setReconnect(value => value + 1)} /></View>}
      {!!requests.length && <Pressable accessibilityRole="button" onPress={() => setPanel('members')} style={s.requestBanner}><Text style={s.requestBannerText}>{requests.length} 台设备申请加入</Text><Text style={s.linkText}>查看 ›</Text></Pressable>}
      <FlatList ref={list} data={groupState.messages} keyExtractor={message => message.id} style={s.flex} contentContainerStyle={s.messages} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 100; }} scrollEventThrottle={100} onContentSizeChange={() => { if (nearBottom.current) list.current?.scrollToEnd({ animated: false }); }} ListEmptyComponent={<View style={s.empty}><Text style={s.emptyGlyph}>⇄</Text><Text style={s.emptyTitle}>一起，传点东西</Text><Text style={s.emptyText}>{'点下方 ＋ 选一份文件，\n也可以先和大家打个招呼。'}</Text></View>} renderItem={({ item, index }) => {
        const own = item.senderId === device?.id, previous = groupState.messages[index - 1], showDate = !previous || new Date(previous.createdAt).toLocaleDateString('zh-CN') !== new Date(item.createdAt).toLocaleDateString('zh-CN');
        return <><Text style={[s.dateDivider, !showDate && { display: 'none' }]}>{dateLabel(item.createdAt)}</Text><MotionView animate={arrivals[activeGroup.id]?.has(item.id)} style={[s.message, own && s.ownMessage]}>{!own && <Avatar size={30} name={item.senderName} id={item.senderId} />}<View style={[s.messageBody, own && s.ownBody]}><View style={s.messageMeta}><Text numberOfLines={1} style={s.senderName}>{own ? '我' : item.senderName}</Text><Text style={s.messageTime}>{messageTime(item.createdAt)}</Text></View>{item.type === 'text' ? <View style={[s.textBubble, own && s.ownBubble]}><Text selectable style={s.messageText}>{item.text}</Text></View> : <Pressable accessibilityRole="button" accessibilityLabel={`接收并分享${item.fileName}，${fileSize(item.size || 0)}`} onPress={() => shareFile(item)} style={({ pressed }) => [s.fileBubble, own && s.ownFileBubble, pressed && s.pressed]}><View style={s.fileIcon}><View style={s.fileFold} /><Text style={s.fileExt}>{item.fileName?.includes('.') ? item.fileName.split('.').pop()?.slice(0, 5).toUpperCase() : 'FILE'}</Text></View><View style={s.fileInfo}><Text numberOfLines={2} style={s.fileName}>{item.fileName}</Text><Text style={s.fileSize}>{fileSize(item.size || 0)} · 保存 / 分享</Text></View><View style={s.downloadCircle}><Text style={s.downloadGlyph}>↓</Text></View></Pressable>}</View></MotionView></>;
      }} />
      {(!!activeTransfers.length || !!failedTransfers.length) && <Pressable accessibilityRole="button" onPress={() => setPanel('transfers')} style={s.transferBanner}>{!!activeTransfers.length && <ActivityIndicator size="small" color={palette.blue} />}<Text numberOfLines={1} style={s.transferBannerText}>{activeTransfers.length ? `${phase[activeTransfers[0].status]} · ${activeTransfers[0].name}` : `${failedTransfers.length} 项文件传输失败，点此重试`}</Text><Text style={s.linkText}>查看</Text></Pressable>}
      {!!draftFiles.length && <View style={s.draftBar}><Pressable accessibilityRole="button" onPress={() => setPanel('transfers')} style={s.draftSummary}><Text style={s.draftTitle}>{draftFiles.length} 份文件待发送</Text><Text numberOfLines={1} style={s.small}>{draftFiles.map(item => item.name).join('、')}</Text></Pressable><IconButton glyph="···" label="查看待发送文件" onPress={() => setPanel('transfers')} /></View>}
      <ImageDrafts items={draftFiles} disabled={!!busy} onRemove={id => { void transfers.remove(id).catch(report); }} />
      {Platform.OS === 'android' && <View style={s.clipboardBar}><Button compact label="粘贴图片" accessibilityLabel="从剪贴板粘贴图片" onPress={pasteImage} disabled={!!busy} /><Text style={s.clipboardHint}>先预览，再发送</Text></View>}
      <View style={s.composer}><IconButton glyph="＋" label="添加文件到待发送" onPress={pickFiles} disabled={!!busy} /><TextInput style={s.messageInput} value={text} onChangeText={setText} multiline maxLength={10000} placeholder="发文件或说点什么…" placeholderTextColor="#a1aec0" testID="message-input" accessibilityLabel="消息内容" /><Pressable accessibilityRole="button" accessibilityLabel={draftFiles.length ? `发送消息和 ${draftFiles.length} 份文件到${activeGroup.name}` : '发送消息'} disabled={!online || !!busy || (!text.trim() && !draftFiles.length)} onPress={sendCurrent} style={({ pressed }) => [s.sendButton, (!online || !!busy || (!text.trim() && !draftFiles.length)) && { opacity: .4 }, pressed && { opacity: .7 }]}><Text style={s.sendGlyph}>↑</Text></Pressable></View>
    </MotionView>}
    {!panel && !!incoming.length && <Pressable accessibilityRole="button" accessibilityLabel="继续处理外部分享" onPress={() => { setShareTarget(activeId || groups[0]?.id || null); setPanel('share'); }} style={s.pendingBanner}><Text style={s.pendingText}>{incoming.length} 项外部分享待选择接收群</Text><Text style={s.linkText}>继续 ›</Text></Pressable>}
    {!panel && <><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}
  </KeyboardAvoidingView>
  <Sheet visible={panel === 'join'} title={pending ? '等待加入' : '加入传输群'} onClose={closePanel} footer={<><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}>
    {pending ? <View style={s.pendingContent}><View style={s.pendingMark}><ActivityIndicator color={palette.blue} size="large" /></View><Text style={s.sheetHero}>申请已发出</Text><Text style={s.description}>{joinStatus}。请在电脑或已加入的设备上允许这次申请，通过后会自动打开群。</Text><Text style={s.small}>关闭此窗口也会继续等待。</Text><View style={s.spacer} /><Button label="取消等待" onPress={cancelJoin} /></View> : scanning ? <><View style={s.cameraFrame}>{cameraPermission?.granted && <CameraView style={s.flex} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => { if (scanLock.current) return; scanLock.current = true; setScanning(false); setLink(data); setJoinMode('link'); connect(data); }} />}</View><Text style={s.description}>对准电脑邀请窗口里的二维码</Text><Button label="返回手动输入" onPress={() => setScanning(false)} /></> : <>
      <Text style={s.sheetHero}>找到电脑，一起传文件。</Text><Text style={s.description}>让手机和电脑连入同一网络，并在电脑上打开拾传。</Text>
      {joinMode === 'nearby' ? <><NearbyGroups snapshot={nearby} selected={nearbySelection} code={code} joinedIds={groups.map(group => group.id)} busy={!!busy} onSelect={group => { chooseNearby(group).catch(report); }} onCode={setCode} onJoin={() => { if (nearbySelection) { try { connect(discoveredInvite(nearbySelection, code), nearbySelection); } catch (cause) { report(cause); } } }} onRefresh={() => { void discovery.start(); }} onBack={() => { setNearbySelection(null); setCode(''); }} /><View style={s.spacer} /><Button label="▦ 扫描电脑二维码" onPress={scan} disabled={!!busy} /><View style={s.spacer} /><Button label="高级连接" onPress={() => setJoinMode('code')} disabled={!!busy} /></> : <><Button compact label="‹ 返回附近设备" onPress={() => setJoinMode('nearby')} /><View style={s.modePicker}>{(['code', 'link'] as const).map(mode => <Pressable key={mode} accessibilityRole="tab" accessibilityState={{ selected: joinMode === mode }} onPress={() => setJoinMode(mode)} style={[s.modeButton, joinMode === mode && s.modeActive]}><Text style={[s.modeLabel, joinMode === mode && s.modeLabelActive]}>{mode === 'code' ? '地址 + 邀请码' : '粘贴完整链接'}</Text></Pressable>)}</View>
      {joinMode === 'code' ? <><Text style={s.label}>电脑地址</Text><TextInput style={s.field} value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="http://192.168.1.5:47321" placeholderTextColor="#a0aec2" testID="join-address" accessibilityLabel="电脑地址" /><Text style={s.label}>6 位邀请码</Text><TextInput style={[s.field, s.codeField]} value={code} onChangeText={value => setCode(value.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" maxLength={6} placeholder="000000" placeholderTextColor="#bcc8d8" testID="join-code" accessibilityLabel="6 位邀请码" /><Button label="申请加入" onPress={connectCode} disabled={!!busy || !address.trim() || code.length !== 6} /></> : <><Text style={s.label}>完整邀请链接</Text><TextInput style={[s.field, s.linkField]} value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} multiline placeholder="粘贴电脑上的完整邀请链接" placeholderTextColor="#a0aec2" testID="join-link" accessibilityLabel="完整邀请链接" /><Button label="加入这个群" onPress={() => connect(link)} disabled={!!busy || !link.trim()} /></>}
      </>}
      <Text style={s.footnote}>邀请码经群内设备允许后生效；已加入的群会保留在这台手机上。</Text>
    </>}
  </Sheet>
  <Sheet visible={panel === 'members'} title="群成员与设备" onClose={closePanel} footer={<><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}>
    <Text style={s.sheetHero}>{activeGroup?.name}</Text><Text style={s.description}>{groupState.devices.length} 台已加入的设备{online ? `，${currentOnline} 台在线` : '，在线状态等待重连'}</Text>
    {requests.map(request => <View key={request.id} style={s.requestCard}><Text style={s.requestName}>{request.device.name} 申请加入</Text><Text style={s.description}>允许后，对方可接收本群的文字和文件。</Text><View style={s.actions}><Button compact label="拒绝" onPress={() => respond(request, false)} disabled={!!busy} /><Button compact primary label="允许加入" onPress={() => respond(request, true)} disabled={!!busy} /></View></View>)}
    {groupState.devices.map(member => <View key={member.id} style={s.deviceRow}><Avatar name={member.id === device?.id ? '我' : member.name} id={member.id} size={37} muted={!member.online} /><View style={s.deviceInfo}><Text numberOfLines={1} style={s.deviceName}>{member.name}{member.id === device?.id ? ' · 本机' : ''}</Text><Text style={s.small}>{online ? member.online ? '在线' : '离线' : '状态待更新'}</Text></View></View>)}<View style={s.spacer} /><Button primary label="＋ 邀请设备加入" onPress={createInvite} disabled={!online || !!busy} /><View style={s.spacer} /><Button label="传输记录与待发文件" onPress={() => setPanel('transfers')} />
  </Sheet>
  <Sheet visible={panel === 'invite'} title="邀请设备加入" onClose={closePanel} footer={<><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}><Text style={s.sheetHero}>{activeGroup?.name}</Text><Text style={s.description}>把邀请链接发给同一网络内的设备，或让对方输入下方地址和邀请码。</Text><View style={s.inviteCard}><Text style={s.label}>一次性邀请码</Text><Text selectable style={s.inviteCode}>{invite?.code || '······'}</Text><Text style={s.small}>{invite ? inviteSeconds ? `${Math.floor(inviteSeconds / 60)}:${String(inviteSeconds % 60).padStart(2, '0')} 后失效` : '已过期，请重新生成' : '正在生成'}</Text></View><Text style={s.label}>电脑地址</Text><Text selectable style={s.addressText}>{activeGroup?.baseUrl}</Text><Button primary label="分享邀请链接" disabled={!invite || !inviteSeconds} onPress={() => Share.share({ message: `加入「${activeGroup?.name}」一起传文件：\n${inviteLink}` }).catch(report)} /><View style={s.spacer} /><Button label="重新生成" onPress={createInvite} disabled={!!busy || !online} /><Text style={s.footnote}>对方申请后，请回到群成员中允许加入。</Text></Sheet>
  <Sheet visible={panel === 'settings'} title="设备设置" onClose={closePanel} footer={<><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}><Text style={s.label}>这台手机的名字</Text><TextInput style={s.field} value={name} onChangeText={setName} maxLength={40} placeholder="例如：小林的手机" placeholderTextColor="#a0aec2" accessibilityLabel="设备名称" /><Button primary label="保存名称" disabled={!!busy || !name.trim()} onPress={() => perform('正在保存…', async () => { await client.rename(name.trim()); refreshGroups(); setPanel(null); })} /><Text style={s.footnote}>此名字会显示在群成员和你发出的消息旁。切换网络后，请让手机与电脑重新连入同一网络。</Text>{activeGroup && <><View style={s.spacer} /><Button danger label={`从此手机移除「${activeGroup.name}」`} onPress={() => Alert.alert('移除此群？', '将取消本群未完成的传输，并清除本机待发草稿与连接。群内消息和文件不会删除；再次加入需要邀请。', [{ text: '取消', style: 'cancel' }, { text: '移除', style: 'destructive', onPress: () => perform('正在移除…', async () => { const groupId = activeGroup.id; await Promise.all(transfers.getSnapshot().filter(item => item.groupId === groupId).map(item => transfers.remove(item.id))); await client.removeGroup(groupId); setDrafts(current => { const next = { ...current }; delete next[groupId]; return next; }); refreshGroups(); setActiveId(null); setHome(true); setPanel(null); }) }])} /></>}</Sheet>
  <Sheet visible={panel === 'transfers'} title="文件传输" onClose={closePanel} footer={<Notice text={error} error onDismiss={() => setError('')} />}><Text style={s.description}>待发送的文件会发到「{activeGroup?.name}」。传输开始后，切换群不会改变接收方。</Text>{groupQueue.length ? groupQueue.map(transferRow) : <Text style={s.emptyText}>还没有文件传输记录</Text>}</Sheet>
  <Sheet visible={panel === 'share'} title="发送到拾传" onClose={closePanel} footer={<><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}><Text style={s.sheetHero}>选择一个传输群</Text><Text style={s.description}>{incoming.length} 项分享内容，确认后放入群的待发送区。</Text>{incoming.map((item, index) => <View key={`${index}-${item.shareType}`} style={s.incomingCard}><Text style={s.small}>{['text', 'url'].includes(item.shareType) ? '文字 / 链接' : '文件'}</Text><Text numberOfLines={3} style={s.incomingText}>{['text', 'url'].includes(item.shareType) ? item.value : (item.value.split('/').pop() || '分享的文件')}</Text></View>)}{groups.map(group => <Pressable key={group.id} accessibilityRole="radio" accessibilityState={{ checked: shareTarget === group.id }} onPress={() => setShareTarget(group.id)} style={[s.targetGroup, shareTarget === group.id && s.targetSelected]}><Text numberOfLines={1} style={s.targetName}>{group.name}</Text><Text style={s.linkText}>{shareTarget === group.id ? '●' : '○'}</Text></Pressable>)}{groups.length ? <Button primary label="放入此群待发送" onPress={prepareIncoming} disabled={!shareTarget || !!busy} /> : <Button primary label="先加入一个群" onPress={openJoin} />}<View style={s.spacer} /><Button label="取消这次分享" onPress={() => { Sharing.clearSharedPayloads(); incomingSignature.current = ''; setIncoming([]); setPanel(null); }} /></Sheet>
  </SafeAreaView>;
}

const s = StyleSheet.create({
  flex: { flex: 1 }, screen: { flex: 1, backgroundColor: '#fff' }, red: { color: palette.red }, pressed: { opacity: .72 }, actions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, spacer: { height: 16 }, small: { color: '#8c9bb1', fontSize: 11, lineHeight: 18 }, linkText: { color: '#4e87d5', fontSize: 12 },
  homeHeader: { paddingHorizontal: 21, paddingTop: 18, paddingBottom: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, brand: { flexDirection: 'row', alignItems: 'center', gap: 12 }, brandMark: { width: 45, height: 45, resizeMode: 'contain' }, brandName: { fontSize: 25, fontWeight: '700', letterSpacing: 1, color: palette.ink }, brandCaption: { fontSize: 11, color: '#91a0b6', marginTop: 4 }, groupList: { flexGrow: 1, paddingHorizontal: 20, paddingBottom: 28 }, sectionLabel: { fontSize: 11, letterSpacing: .7, color: '#9aa8bb', marginBottom: 13, marginTop: 4 }, groupCard: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 19, borderBottomWidth: 1, borderBottomColor: '#edf2f8' }, groupIcon: { width: 47, height: 47, borderRadius: 15, backgroundColor: '#edf5ff', alignItems: 'center', justifyContent: 'center' }, groupGlyph: { fontSize: 28, color: palette.blue }, groupInfo: { flex: 1, minWidth: 0 }, groupTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, groupName: { flex: 1, fontSize: 16, fontWeight: '600', color: palette.ink }, groupPreview: { color: '#94a2b6', fontSize: 12, marginTop: 7, lineHeight: 18 }, chevron: { fontSize: 25, color: '#bec9d9' },
  welcome: { flex: 1, justifyContent: 'center', paddingHorizontal: 13, paddingBottom: 50 }, welcomeMark: { width: 84, height: 84, borderRadius: 25, backgroundColor: '#edf5ff', alignItems: 'center', justifyContent: 'center', marginBottom: 28 }, welcomeGlyph: { color: '#4c94fb', fontSize: 52 }, welcomeTitle: { color: palette.ink, fontSize: 30, fontWeight: '600', marginBottom: 14 }, welcomeText: { color: '#8e9fb8', fontSize: 14, lineHeight: 25, marginBottom: 31 }, welcomeNote: { textAlign: 'center', color: '#a1afc2', fontSize: 11, marginTop: 18 },
  chatHeader: { minHeight: 69, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 5, borderBottomWidth: 1, borderBottomColor: palette.border }, chatTitleButton: { flex: 1, minWidth: 0, paddingVertical: 10 }, chatTitle: { color: palette.ink, fontSize: 18, fontWeight: '600' }, chatSubtitle: { color: '#98a7ba', fontSize: 10, marginTop: 5 }, membersStrip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 21, minHeight: 46, gap: 9, backgroundColor: '#fbfdff', borderBottomWidth: 1, borderBottomColor: palette.border }, avatarStack: { flexDirection: 'row' }, stackedAvatar: { borderWidth: 2, borderColor: '#fbfdff', borderRadius: 20 }, memberNames: { flex: 1, color: '#8293ac', fontSize: 11 }, connection: { color: '#6d9b83', fontSize: 10 }, offline: { color: '#a1adbd' }, offlineBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 18, paddingRight: 9, backgroundColor: '#f5f8fd' }, offlineText: { flex: 1, fontSize: 11, lineHeight: 18, color: '#8b9bb3' }, requestBanner: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 11, backgroundColor: '#edf5ff' }, requestBannerText: { color: '#5788c9', fontSize: 12 },
  messages: { flexGrow: 1, paddingHorizontal: 17, paddingTop: 6, paddingBottom: 12 }, dateDivider: { textAlign: 'center', color: '#a9b6c8', fontSize: 10, marginVertical: 16 }, message: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginBottom: 18 }, ownMessage: { justifyContent: 'flex-end' }, messageBody: { flexShrink: 1, maxWidth: '86%', alignItems: 'flex-start', minWidth: 0 }, ownBody: { alignItems: 'flex-end' }, messageMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, maxWidth: '100%' }, senderName: { fontSize: 10, color: '#7e8fa8', flexShrink: 1, maxWidth: 190 }, messageTime: { color: '#a4b1c4', fontSize: 10 }, textBubble: { paddingHorizontal: 13, paddingVertical: 10, backgroundColor: '#f1f4f9', borderRadius: 14, borderTopLeftRadius: 4 }, ownBubble: { backgroundColor: '#e9f3ff', borderTopLeftRadius: 14, borderTopRightRadius: 4 }, messageText: { color: '#30415c', fontSize: 14, lineHeight: 22 }, fileBubble: { flexDirection: 'row', alignItems: 'center', gap: 10, width: 280, maxWidth: '100%', padding: 12, borderWidth: 1, borderColor: '#e0e9f6', backgroundColor: '#fafdff', borderRadius: 13 }, ownFileBubble: { backgroundColor: '#f0f7ff', borderColor: '#d9eaff' }, fileIcon: { width: 33, height: 41, backgroundColor: '#3587fc', borderRadius: 5, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 7, overflow: 'hidden' }, fileFold: { position: 'absolute', right: 0, top: 0, width: 11, height: 11, backgroundColor: '#a8d0ff', borderBottomLeftRadius: 4 }, fileExt: { fontSize: 8, color: '#fff', fontWeight: '700' }, fileInfo: { flex: 1, minWidth: 0 }, fileName: { fontSize: 13, lineHeight: 19, fontWeight: '500', color: '#30415c' }, fileSize: { fontSize: 10, color: '#98a8bd', marginTop: 5 }, downloadCircle: { width: 27, height: 27, borderRadius: 14, borderWidth: 1, borderColor: '#d2dfef', alignItems: 'center', justifyContent: 'center' }, downloadGlyph: { color: '#7598c5', fontSize: 18, lineHeight: 23 }, empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 46 }, emptyGlyph: { color: '#83b0f3', fontSize: 47, marginBottom: 17 }, emptyTitle: { color: '#748aa8', fontSize: 16, fontWeight: '500', marginBottom: 10 }, emptyText: { color: '#a0aec1', fontSize: 12, lineHeight: 21, textAlign: 'center' },
  clipboardBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 3, gap: 10, backgroundColor: '#fff' }, clipboardHint: { color: '#8797ae', fontSize: 11 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 9, paddingVertical: 10, gap: 5, borderTopWidth: 1, borderTopColor: palette.border, backgroundColor: '#fff' }, messageInput: { flex: 1, minHeight: 44, maxHeight: 112, borderWidth: 1, borderColor: '#e0e9f5', borderRadius: 13, paddingHorizontal: 12, paddingVertical: 12, fontSize: 13, lineHeight: 20, color: palette.ink }, sendButton: { width: 44, height: 44, borderRadius: 13, backgroundColor: palette.blue, alignItems: 'center', justifyContent: 'center', marginLeft: 3 }, sendGlyph: { color: '#fff', fontSize: 25 }, draftBar: { flexDirection: 'row', alignItems: 'center', paddingLeft: 19, paddingRight: 10, paddingTop: 10, paddingBottom: 6, backgroundColor: '#f4f8ff', borderTopWidth: 1, borderTopColor: '#e7effb' }, draftSummary: { flex: 1, minWidth: 0 }, draftTitle: { fontSize: 12, color: '#5886c4', marginBottom: 3 }, transferBanner: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 19, paddingVertical: 10, backgroundColor: '#f5f9ff' }, transferBannerText: { flex: 1, fontSize: 11, color: '#6e8fb9' },
  sheetHero: { fontSize: 23, fontWeight: '600', color: palette.ink, lineHeight: 34, marginBottom: 12 }, description: { fontSize: 13, lineHeight: 23, color: '#8b9db6', marginBottom: 20 }, label: { fontSize: 11, color: '#8c9db5', marginBottom: 9 }, field: { borderWidth: 1, borderColor: '#dfe8f5', backgroundColor: '#fcfdff', borderRadius: 11, minHeight: 48, paddingHorizontal: 13, paddingVertical: 12, fontSize: 14, color: palette.ink, marginBottom: 18 }, codeField: { fontSize: 27, letterSpacing: 9, textAlign: 'center', paddingLeft: 22 }, linkField: { minHeight: 89, textAlignVertical: 'top', fontSize: 12, lineHeight: 21 }, modePicker: { marginTop: 27, marginBottom: 23, flexDirection: 'row', padding: 4, borderRadius: 11, backgroundColor: '#f2f6fc' }, modeButton: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 40, borderRadius: 8 }, modeActive: { backgroundColor: '#fff' }, modeLabel: { fontSize: 12, color: '#9aa9bd' }, modeLabelActive: { color: '#4b80c8', fontWeight: '600' }, footnote: { fontSize: 11, lineHeight: 20, color: '#a0aec1', marginTop: 25 }, fieldError: { fontSize: 11, lineHeight: 19, color: palette.red, marginTop: 8 }, cameraFrame: { height: 330, overflow: 'hidden', borderRadius: 18, marginBottom: 21, backgroundColor: '#192d4c' }, pendingBanner: { marginHorizontal: 20, borderRadius: 12, padding: 14, backgroundColor: '#edf5ff', flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 17 }, pendingText: { color: '#5887c5', fontSize: 12, flex: 1 }, pendingContent: { paddingTop: 45 }, pendingMark: { height: 80, justifyContent: 'center', marginBottom: 22 }, requestCard: { padding: 16, backgroundColor: '#f1f7ff', borderRadius: 13, marginBottom: 15 }, requestName: { fontSize: 14, fontWeight: '600', color: palette.ink, marginBottom: 8 }, deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: '#edf2f8', paddingVertical: 15 }, deviceInfo: { flex: 1 }, deviceName: { color: '#405776', fontSize: 13, marginBottom: 4 }, inviteCard: { alignItems: 'center', paddingVertical: 24, borderWidth: 1, borderColor: '#dfeafb', borderRadius: 16, backgroundColor: '#f5f9ff', marginBottom: 28 }, inviteCode: { fontSize: 37, letterSpacing: 8, fontWeight: '600', color: palette.blue, marginBottom: 10 }, addressText: { fontSize: 13, color: '#6485b2', marginBottom: 25 }, transferCard: { padding: 15, borderWidth: 1, borderColor: '#e0e9f5', borderRadius: 13, marginBottom: 13, backgroundColor: '#fbfdff', gap: 9 }, transferHead: { flexDirection: 'row', alignItems: 'center', gap: 8 }, transferName: { flex: 1, color: palette.ink, fontSize: 13, fontWeight: '500' }, transferStatus: { color: '#7295c2', fontSize: 10 }, progressTrack: { backgroundColor: '#e2edfc', height: 4, borderRadius: 2, overflow: 'hidden' }, progressFill: { backgroundColor: '#4e93fb', height: 4, borderRadius: 2 }, incomingCard: { backgroundColor: '#f5f8fd', padding: 13, borderRadius: 11, marginBottom: 10 }, incomingText: { fontSize: 12, color: '#60799b', lineHeight: 21, marginTop: 5 }, targetGroup: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#e3ebf6', borderRadius: 12, paddingHorizontal: 15, paddingVertical: 17, marginBottom: 12 }, targetSelected: { backgroundColor: '#f0f7ff', borderColor: '#bdd8fc' }, targetName: { flex: 1, color: '#456389', fontSize: 14 },
});
