import type { StyleProp, ViewStyle } from 'react-native';

export type NativeComposerInputProps = {
  value: string;
  onChangeText: (value: string) => void;
  onPasteImage: () => void;
  editable?: boolean;
  style?: StyleProp<ViewStyle>;
};
