import React from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { TransferItem } from '../transfers';

export function ImageDrafts({ items, disabled, onRemove }: { items: TransferItem[]; disabled: boolean; onRemove: (id: string) => void }) {
  const images = items.filter(item => item.mimeType?.startsWith('image/') && item.localUri);
  if (!images.length) return null;
  return <ScrollView horizontal keyboardShouldPersistTaps="handled" style={styles.strip} contentContainerStyle={styles.content} accessibilityLabel="输入框内的图片">
    {images.map(item => <View key={item.id} style={styles.card}>
      <Image source={{ uri: item.localUri }} style={styles.image} resizeMode="contain" accessibilityLabel={item.name} />
      <Pressable accessibilityRole="button" accessibilityLabel={`移除图片 ${item.name}`} disabled={disabled} accessibilityState={{ disabled }} onPress={() => onRemove(item.id)} style={[styles.remove, disabled && { opacity: .4 }]}><Text style={styles.cross}>×</Text></Pressable>
    </View>)}
  </ScrollView>;
}
const styles = StyleSheet.create({
  strip: { flexGrow: 0, maxHeight: 92 }, content: { paddingHorizontal: 10, paddingTop: 10, paddingBottom: 4, gap: 8 },
  card: { width: 76, height: 72, borderRadius: 8, backgroundColor: '#f4f8ff', padding: 4 },
  image: { width: 68, height: 64 },
  remove: { position: 'absolute', right: -4, top: -5, width: 44, height: 44, alignItems: 'flex-end', padding: 4 },
  cross: { textAlign: 'center', width: 24, height: 24, borderRadius: 12, backgroundColor: '#edf4ff', color: '#4f6683', fontSize: 20, lineHeight: 24 },
});
