import minecraftData from 'minecraft-data';

export type InventoryDecodeStatus = 'unverified' | 'complete' | 'incomplete';

export interface ProtocolDecodeIssue {
  protocolState: string;
  packetId: number | null;
  packetName: string | null;
  errorName: string;
  message: string;
  observedAt: string;
}

export interface ProtocolDecodeStatus {
  inventory: InventoryDecodeStatus;
  issues: ProtocolDecodeIssue[];
}

interface PacketDecoder {
  parsePacketBuffer(buffer: Buffer): unknown;
  __processiaObserved?: boolean;
}

export interface ProtocolClientLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  state?: string;
  version?: string;
  deserializer?: PacketDecoder;
  setSerializer?(state: string): void;
  __processiaObserved?: boolean;
  __processiaOriginalSetSerializer?: (state: string) => void;
}

interface PacketMetadata { name?: string }

const monitors = new WeakMap<object, ProtocolDecodeStatus>();

function readPacketId(buffer: Buffer): number | null {
  let value = 0;
  for (let index = 0; index < Math.min(buffer.length, 5); index += 1) {
    const byte = buffer[index];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << (index * 7);
    if ((byte & 0x80) === 0) return value >>> 0;
  }
  return null;
}

function getPacketName(version: string | undefined, state: string, packetId: number | null): string | null {
  if (!version || packetId === null) return null;
  const data = minecraftData(version) as unknown as {
    protocol?: Record<string, { toClient?: { types?: { packet?: unknown } } }>;
  } | null;
  const packetType = data?.protocol?.[state]?.toClient?.types?.packet;
  if (!Array.isArray(packetType) || !Array.isArray(packetType[1])) return null;
  const nameField = packetType[1][0] as { type?: unknown } | undefined;
  if (!Array.isArray(nameField?.type) || typeof nameField.type[1] !== 'object' || nameField.type[1] === null) return null;
  const mappings = (nameField.type[1] as { mappings?: Record<string, string> }).mappings;
  return mappings?.[`0x${packetId.toString(16).padStart(2, '0')}`] ?? null;
}

function instrumentDecoder(client: ProtocolClientLike, status: ProtocolDecodeStatus): void {
  const decoder = client.deserializer;
  if (!decoder || decoder.__processiaObserved) return;
  const original = decoder.parsePacketBuffer.bind(decoder);
  decoder.parsePacketBuffer = (buffer: Buffer): unknown => {
    try {
      return original(buffer);
    } catch (error) {
      const packetId = readPacketId(buffer);
      const protocolState = client.state ?? 'unknown';
      const issue: ProtocolDecodeIssue = {
        protocolState,
        packetId,
        packetName: getPacketName(client.version, protocolState, packetId),
        errorName: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error && error.name === 'PartialReadError' ? error.message : 'Packet decode failed',
        observedAt: new Date().toISOString(),
      };
      status.issues.push(issue);
      if (status.issues.length > 20) status.issues.shift();
      if (issue.packetName === 'window_items' || issue.packetName === 'set_slot') status.inventory = 'incomplete';
      throw error;
    }
  };
  decoder.__processiaObserved = true;
}

/** Observe decoder failures without swallowing them or retaining packet contents. */
export function monitorProtocolDecode(client: ProtocolClientLike): void {
  if (client.__processiaObserved) return;
  client.__processiaObserved = true;
  const status: ProtocolDecodeStatus = { inventory: 'unverified', issues: [] };
  monitors.set(client as object, status);
  client.on('packet', (...args: unknown[]) => {
    const metadata = args[1] as PacketMetadata | undefined;
    if (metadata?.name === 'window_items') status.inventory = 'complete';
  });
  instrumentDecoder(client, status);
  if (client.setSerializer) {
    const original = client.setSerializer.bind(client);
    client.__processiaOriginalSetSerializer = original;
    client.setSerializer = (state: string): void => {
      original(state);
      instrumentDecoder(client, status);
    };
  }
}

export function getProtocolDecodeStatus(client: object | null | undefined): ProtocolDecodeStatus {
  const status = client ? monitors.get(client) : undefined;
  return status ? { inventory: status.inventory, issues: status.issues.map((issue) => ({ ...issue })) } : { inventory: 'unverified', issues: [] };
}
