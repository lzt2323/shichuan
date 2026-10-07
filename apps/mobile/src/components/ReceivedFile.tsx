import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { fileSize } from '../../../../shared/protocol';
import type { Message } from '../client';
import { IconButton, palette } from './ui';

/** Save and share use separate responders so one tap cannot trigger both actions. */
export function ReceivedFile({ message, own, onAction }: { message: Message; own: boolean; onAction(action: 'save' | 'file' | 'share'): void }) {
  const image = message.mime?.startsWith('image/');
  return <View style={[styles.card, own && styles.own]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`保存${message.fileName}，${fileSize(message.size || 0)}`} disabled={message.deleted}
      onPress={() => onAction('save')} onLongPress={() => Alert.alert(message.fileName || '文件', '选择操作', [
        { text: '保存到文件', onPress: () => onAction('file') }, { text: '分享', onPress: () => onAction('share') }, { text: '取消', style: 'cancel' },
      ])} style={({ pressed }) => [styles.save, pressed && { opacity: .7 }]}>
      <View style={styles.fileIcon}><Text style={styles.extension}>{message.fileName?.split('.').pop()?.slice(0, 5).toUpperCase() || 'FILE'}</Text></View>
      <View style={styles.info}><Text numberOfLines={2} style={styles.name}>{message.fileName}</Text><Text style={styles.size}>{fileSize(message.size || 0)} · {message.deleted ? '原文件已清理' : image ? '保存到相册' : '保存到文件'}</Text></View>
      {!message.deleted && <Text style={styles.down}>↓</Text>}
    </Pressable>
    <IconButton glyph="↗" label={`分享${message.fileName}`} disabled={message.deleted} onPress={() => onAction('share')} />
  </View>;
}
const styles = StyleSheet.create({
  card: { width: 290, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', padding: 10, gap: 4, borderRadius: 13, borderColor: palette.border, borderWidth: 1, backgroundColor: '#F8FAF7' },
  own: { backgroundColor: '#E1F3EC' }, save: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileIcon: { width: 31, height: 39, backgroundColor: '#126A5A', borderRadius: 5, justifyContent: 'center', alignItems: 'center' },
  extension: { color: '#fff', fontSize: 8, fontWeight: '700' }, info: { flex: 1, minWidth: 0 }, name: { fontSize: 13, lineHeight: 19, color: palette.ink },
  size: { fontSize: 10, marginTop: 4, color: palette.secondary }, down: { color: '#126A5A', fontSize: 20 },
});
