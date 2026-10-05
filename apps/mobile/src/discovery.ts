import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { createDiscoveryController } from './discovery-core';
import type { DiscoveryAdapter } from './discovery-core';

export function createNearbyDiscovery() {
  const native = Platform.OS === 'web' ? null : requireOptionalNativeModule<DiscoveryAdapter>('PickDropDiscovery');
  return createDiscoveryController(native);
}
