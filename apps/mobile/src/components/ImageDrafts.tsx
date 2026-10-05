import React from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { TransferItem } from '../transfers';

export function ImageDrafts({ items, disabled, onRemove }: { items: TransferItem[]; disabled: boolean; onRemove: (id: string) => void }) {
  const images = items.filter(item => item.mimeType?.startsWith('image/') && item.localUri);
  if (!images.length) return null;
  return <ScrollView horizontal keyboardShouldPersistTaps="handled" style={styles.strip} contentContainerStyle={styles.content} accessibilityLabel="待发送图片预览">
    {images.map(item => <View key={item.id} style={styles.card}>
      <Image source={{ uri: item.localUri }} style={styles.image} resizeMode="contain" accessibilityLabel={item.name} />
      <Text numberOfLines={1} style={styles.name}>{item.name}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`移除图片 ${item.name}`} disabled={disabled} accessibilityState={{ disabled }} onPress={() => onRemove(item.id)} style={[styles.remove, disabled && { opacity: .4 }]}><Text style={styles.cross}>×</Text></Pressable>
    </View>)}
  </ScrollView>;
}
const styles = StyleSheet.create({
  strip: { flexGrow: 0, maxHeight: 112, backgroundColor: '#f4f8ff' }, content: { paddingHorizontal: 16, paddingVertical: 8, gap: 10 },
  card: { width: 100, height: 94, borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e0e9f5', padding: 6 },
  image: { width: 86, height: 62 }, name: { color: '#6d819d', fontSize: 10, marginTop: 5 },
  remove: { position: 'absolute', right: -4, top: -5, width: 44, height: 44, alignItems: 'flex-end', padding: 4 },
  cross: { textAlign: 'center', width: 24, height: 24, borderRadius: 12, backgroundColor: '#edf4ff', color: '#4f6683', fontSize: 20, lineHeight: 24 },
});
