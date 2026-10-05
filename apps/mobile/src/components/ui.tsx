import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AccessibilityInfo, Animated, ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View, KeyboardAvoidingView, ScrollView } from 'react-native';

const ReducedMotion = createContext(true);
export function MotionProvider({ children }: { children: React.ReactNode }) {
  const [reduced, setReduced] = useState(true);
  useEffect(() => { AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => {}); const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced); return () => subscription.remove(); }, []);
  return <ReducedMotion.Provider value={reduced}>{children}</ReducedMotion.Provider>;
}
export function MotionView({ children, animate = true, style }: { children: React.ReactNode; animate?: boolean; style?: React.ComponentProps<typeof View>['style'] }) {
  const reduced = useContext(ReducedMotion), value = useRef(new Animated.Value(animate && !reduced ? 0 : 1)).current;
  useEffect(() => { if (reduced) { value.stopAnimation(); value.setValue(1); return; } const motion = Animated.timing(value, { toValue: 1, duration: 180, useNativeDriver: Platform.OS !== 'web' }); motion.start(); return () => motion.stop(); }, [reduced, value]);
  return <Animated.View style={[style, { opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [5, 0] }) }] }]}>{children}</Animated.View>;
}
export const palette = { blue: '#2478ff', ink: '#243650', secondary: '#7d8ea7', border: '#e5edf7', background: '#f7faff', red: '#b94f5a' };
const tones = ['#3689fc', '#74a780', '#e99c4b', '#9788c8', '#859ab7'];
export function Avatar({ name, id, size = 32, muted = false }: { name: string; id: string; size?: number; muted?: boolean }) {
  const label = name.trim() || '?', chars = Array.from(label);
  const initial = /^[\p{Script=Han}]{2,3}$/u.test(label) ? chars.at(-1) : chars[0];
  const tone = Array.from(id).reduce((sum, char) => sum + char.codePointAt(0)!, 0) % tones.length;
  return <View accessible={false} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tones[tone], alignItems: 'center', justifyContent: 'center', opacity: muted ? 0.5 : 1 }}><Text style={{ color: '#fff', fontSize: size * .38, fontWeight: '600' }}>{initial?.toUpperCase()}</Text></View>;
}
export function Button({ label, onPress, disabled = false, primary = false, danger = false, accessibilityLabel, compact = false }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean; danger?: boolean; accessibilityLabel?: string; compact?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel || label} accessibilityState={{ disabled }} onPress={onPress} disabled={disabled} style={({ pressed }) => [u.button, compact && u.compact, primary && u.primary, pressed && { opacity: .72 }, disabled && { opacity: .45 }]}><Text style={[u.buttonLabel, primary && { color: '#fff' }, danger && { color: palette.red }]}>{label}</Text></Pressable>;
}
export function IconButton({ glyph, label, onPress, disabled = false }: { glyph: string; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} onPress={onPress} disabled={disabled} style={({ pressed }) => [u.iconButton, pressed && { backgroundColor: '#eef5ff' }, disabled && { opacity: .4 }]}><Text style={u.icon}>{glyph}</Text></Pressable>;
}
export function Notice({ text, onDismiss, error = false }: { text: string; onDismiss?: () => void; error?: boolean }) {
  if (!text) return null;
  return <View accessibilityLiveRegion="polite" style={[u.notice, error && { backgroundColor: '#fff1f2' }]}><Text style={[u.noticeText, error && { color: palette.red }]}>{text}</Text>{onDismiss && <IconButton glyph="×" label="关闭提示" onPress={onDismiss} />}</View>;
}
export function Busy({ label }: { label: string }) {
  if (!label) return null;
  return <View accessibilityLiveRegion="polite" style={u.busy}><ActivityIndicator size="small" color={palette.blue} /><Text style={u.busyText}>{label}</Text></View>;
}
export function Sheet({ visible, title, onClose, children, footer }: { visible: boolean; title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  const reduced = useContext(ReducedMotion);
  return <Modal visible={visible} animationType={reduced ? 'none' : 'slide'} presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaProvider><SafeAreaView style={u.sheet}><KeyboardAvoidingView style={u.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><View style={u.sheetHeader}><Text accessibilityRole="header" style={u.sheetTitle}>{title}</Text><Button compact label="完成" onPress={onClose} /></View><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={u.sheetContent}>{children}</ScrollView>{footer}</KeyboardAvoidingView></SafeAreaView></SafeAreaProvider></Modal>;
}
const u = StyleSheet.create({
  flex: { flex: 1 }, button: { minHeight: 44, paddingHorizontal: 17, paddingVertical: 12, borderRadius: 12, backgroundColor: '#edf4ff', alignItems: 'center', justifyContent: 'center' }, compact: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 9 }, primary: { backgroundColor: palette.blue }, buttonLabel: { color: '#4f84cd', fontSize: 14, fontWeight: '600' }, iconButton: { width: 44, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, icon: { color: '#6484af', fontSize: 26, lineHeight: 30 }, notice: { marginHorizontal: 16, marginBottom: 8, paddingLeft: 13, paddingVertical: 3, paddingRight: 5, backgroundColor: '#edf5ff', borderRadius: 11, flexDirection: 'row', alignItems: 'center' }, noticeText: { flex: 1, fontSize: 12, color: '#6186b6', lineHeight: 19, paddingVertical: 7 }, busy: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 20, paddingVertical: 9 }, busyText: { flex: 1, fontSize: 12, color: '#6d8db7', lineHeight: 18 }, sheet: { flex: 1, backgroundColor: '#fff' }, sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 21, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: palette.border }, sheetTitle: { fontSize: 18, fontWeight: '600', color: palette.ink }, sheetContent: { padding: 24, paddingBottom: 38 },
});
