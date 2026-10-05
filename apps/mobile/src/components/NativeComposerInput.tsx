import React from 'react';
import { TextInput } from 'react-native';
import type { NativeComposerInputProps } from './NativeComposerInput.types';

// Other platforms keep the existing system text editor. Image clipboard entry
// is intentionally Android-only until a platform-native integration is added.
export default function NativeComposerInput({ value, onChangeText, editable = true, style }: NativeComposerInputProps) {
  return <TextInput value={value} onChangeText={onChangeText} editable={editable} multiline maxLength={10000}
    placeholder="发文件或说点什么…" placeholderTextColor="#a1aec0" testID="message-input" accessibilityLabel="消息内容"
    style={[{ minHeight: 44, maxHeight: 112, minWidth: 0, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#30415c', textAlignVertical: 'top' }, style]} />;
}
