import { requireOptionalNativeModule } from 'expo';
import { Platform, PermissionsAndroid } from 'react-native';
type Result = { saved: boolean; destination?: string };
const native = Platform.OS === 'web' ? null : requireOptionalNativeModule<{ saveMedia(uri: string, name: string, mime: string): Promise<Result>; exportFile(uri: string, name: string, mime: string): Promise<Result>; cleanupIncoming(uris: string[]): Promise<void>; sweepIncoming(clearAll: boolean): Promise<void>; incomingBytes(): Promise<number> }>('PickDropStorage');
export async function exportReceived(uri: string, name: string, mime: string, image: boolean): Promise<Result> {
  if (!native) throw new Error('请安装更新后的手机客户端以保存文件');
  if (image && Platform.OS === 'android' && Number(Platform.Version) < 29) {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
    if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('请允许保存图片，或选择保存到文件');
  }
  return image ? native.saveMedia(uri, name, mime) : native.exportFile(uri, name, mime);
}
export async function sweepIncoming(clearAll = false) { if (native) await native.sweepIncoming(clearAll); }
export async function incomingBytes() { return native ? native.incomingBytes() : 0; }
export async function cleanupIncoming(uris: string[]) { if (native) await native.cleanupIncoming(uris); }

export function incomingFileName(uri: string) {
  let name = uri.split('/').pop() || '分享文件';
  try { name = decodeURIComponent(name); } catch { /* Preserve malformed provider names for safeFileName. */ }
  // Raw Expo payloads omit originalName; only our owned staging prefix is removed.
  if (Platform.OS === 'ios' && uri.includes('/PickDropIncoming/')) name = name.replace(/^[a-f0-9-]{36}-/i, '');
  return name;
}
