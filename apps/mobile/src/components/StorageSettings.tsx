import React, { useEffect, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, View } from 'react-native';
import { fileSize } from '../../../../shared/protocol';
import { transfers, type TransferGroup, type TransferItem } from '../transfers';
import { Button, palette } from './ui';

/** Only app-owned cache is evicted. Drafts require an explicit delete or reassignment. */
export function StorageSettings({ items, groups, onError }: { items: TransferItem[]; groups: TransferGroup[]; onError(error: unknown): void }) {
  const [usage, setUsage] = useState({ cacheBytes: 0, draftBytes: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let alive = true;
    transfers.storageStats().then(value => { if (alive) setUsage(value); }).catch(onError);
    return () => { alive = false; };
  }, [items, onError]);
  async function clean() {
    setBusy(true);
    try { await transfers.cleanCache(true); setUsage(await transfers.storageStats()); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  }
  return <View style={styles.section}>
    <Text style={styles.title}>存储空间</Text>
    <View style={styles.row}><View style={styles.details}><Text style={styles.label}>接收缓存 {fileSize(usage.cacheBytes)}</Text><Text style={styles.detail}>待发送草稿 {fileSize(usage.draftBytes)}</Text></View><Button compact label={busy ? '正在清理…' : '清理缓存'} disabled={busy || Platform.OS === 'web'} onPress={() => { void clean(); }} /></View>
    <Text style={styles.detail}>7 天 · 512 MiB 上限。清理不影响草稿和已保存文件。</Text>
    {items.filter(item => item.status === 'orphaned').map(item => <View key={item.id} style={styles.draft}>
      <Text style={styles.label}>{item.name} · {fileSize(item.size)}</Text>
      <View style={styles.actions}>{!!item.localUri && groups.map(group => <Button key={group.id} compact label={`放入 ${group.name}`} onPress={() => { void transfers.reassignDraft(item.id, group).catch(onError); }} />)}<Button compact danger label="删除草稿" onPress={() => Alert.alert('删除这份草稿？', '这会删除拾传中待发送的副本。', [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => { void transfers.remove(item.id).catch(onError); } }])} /></View>
    </View>)}
  </View>;
}
const styles = StyleSheet.create({
  section: { gap: 12, marginBottom: 28 }, title: { fontSize: 14, fontWeight: '600', color: palette.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, details: { flex: 1, gap: 4 },
  label: { color: palette.ink, fontSize: 13 }, detail: { color: palette.secondary, fontSize: 12, lineHeight: 19 },
  draft: { borderColor: palette.border, borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
