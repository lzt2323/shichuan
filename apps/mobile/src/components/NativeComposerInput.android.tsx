import React, { useRef, useState } from 'react';
import { requireNativeView } from 'expo';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import type { NativeComposerInputProps } from './NativeComposerInput.types';

type NativeProps = ViewProps & {
  value: string;
  editable: boolean;
  mostRecentEventCount: number;
  onTextChange: (event: NativeSyntheticEvent<{ text: string; eventCount: number }>) => void;
  onPasteImage: () => void;
  onContentHeightChange: (event: NativeSyntheticEvent<{ height: number }>) => void;
};
const NativeView = requireNativeView<NativeProps>('PickDropComposer');

export default function NativeComposerInput({ value, onChangeText, onPasteImage, editable = true, style }: NativeComposerInputProps) {
  const eventCount = useRef(0);
  const [height, setHeight] = useState(44);
  return <NativeView
    value={value}
    editable={editable}
    mostRecentEventCount={eventCount.current}
    onTextChange={event => {
      if (event.nativeEvent.eventCount < eventCount.current) return;
      eventCount.current = event.nativeEvent.eventCount;
      onChangeText(event.nativeEvent.text);
    }}
    onPasteImage={() => { if (editable) onPasteImage(); }}
    onContentHeightChange={event => setHeight(Math.max(44, Math.min(112, event.nativeEvent.height)))}
    style={[{ minWidth: 0 }, style, { height }]}
    testID="message-input"
  />;
}
