export type NearbyGroup = { serviceId: string; groupId: string; hostDeviceId: string; name: string; address: string; port: number; baseUrl: string };
export type DiscoveryStatus = 'idle' | 'scanning' | 'ready' | 'empty' | 'error' | 'permission-denied' | 'unavailable';
export type DiscoverySnapshot = { status: DiscoveryStatus; devices: NearbyGroup[]; message: string };
export type DiscoveryAdapter = { start(id: string): Promise<void>; stop(id: string): Promise<void>; addListener(event: string, listener: (value: any) => void): { remove(): void } };
export function usableIPv4(value: unknown): boolean;
export function normalizeService(value: unknown): NearbyGroup | null;
export function discoveredInvite(group: NearbyGroup, code: string): string;
export function assertDiscoveredTicket(group: NearbyGroup, ticket: { groupId: string; hostDeviceId: string }): void;
export function createDiscoveryController(adapter: DiscoveryAdapter | null, options?: { timeoutMs?: number; sessionId?: () => string }): { getSnapshot(): DiscoverySnapshot; subscribe(listener: (value: DiscoverySnapshot) => void): () => void; start(): Promise<void>; stop(): void; dispose(): void };
