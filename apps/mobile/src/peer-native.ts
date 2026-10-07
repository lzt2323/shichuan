import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';

type Request = { id: string; method: string; path: string; headers: Record<string, string>; body: string };
type Response = { status?: number; body?: unknown; file?: string };
type Native = {
  start(): Promise<{ baseUrl: string; address: string; port: number }>;
  stop(): Promise<void>;
  advertise(groups: Array<{ groupId: string; hostDeviceId: string; name: string }>): Promise<void>;
  respond(id: string, status: number, body: string, file: string | null): Promise<void>;
  addListener(event: string, callback: (request: any) => void): { remove(): void };
  readRecord(key: string): Promise<string | null>;
  writeRecord(key: string, value: string): Promise<void>;
  deleteRecord(key: string): Promise<void>;
  importFile(uri: string): Promise<{ uri: string; sha256: string; size: number }>;
  hasFile(hash: string): Promise<{ uri: string; size: number } | null>;
  removeFile(hash: string): Promise<boolean>;
  fileStats(): Promise<{ count: number; bytes: number }>;
  clearFiles(): Promise<{ removed: number }>;
};
const native = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('PickDropPeer') : null;
export async function peerFileStats() { return native ? native.fileStats() : { count: 0, bytes: 0 }; }
export async function clearPeerFiles() { return native ? native.clearFiles() : { removed: 0 }; }

/** Expo Go, web and iOS deliberately expose no pretend HTTP server. */
export function createNativePeerOptions() {
  if (!native) return undefined;
  const module = native;
  let listener: { remove(): void } | undefined, diagnostic: { remove(): void } | undefined;
  return {
    randomBytes: (length: number) => Crypto.getRandomBytes(length),
    records: {
      getItemAsync: (key: string) => module.readRecord(key),
      setItemAsync: (key: string, value: string) => module.writeRecord(key, value),
      deleteItemAsync: (key: string) => module.deleteRecord(key),
    },
    transport: {
      async start(handler: (request: Request) => Promise<Response>, report: (message: string) => void) {
        if (!diagnostic) diagnostic = module.addListener('diagnostic', value => report(value.message));
        if (!listener) listener = module.addListener('request', request => {
          Promise.resolve(handler(request)).then(response => module.respond(request.id, response.status || 200, JSON.stringify(response.body ?? {}), response.file || null))
            .catch(error => module.respond(request.id, Number(error?.status) || 400, JSON.stringify({ error: error?.message || '请求失败' }), null)).catch(() => {});
        });
        return module.start();
      },
      async stop() { listener?.remove(); listener = undefined; diagnostic?.remove(); diagnostic = undefined; await module.stop(); },
      advertise: (groups: Array<{ groupId: string; hostDeviceId: string; name: string }>) => module.advertise(groups),
      importFile: (uri: string) => module.importFile(uri),
      hasFile: (hash: string) => module.hasFile(hash),
      removeFile: (hash: string) => module.removeFile(hash),
    },
  };
}
