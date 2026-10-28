import type { RuntimeRegistryContext } from './runtime-registry-service.js';
import type { RegistryProvenance, RegistryResolution } from './minecraft-registry-service.js';

export interface RegistryAnnotatedItem {
  slot: number;
  quantity: number;
  rawNumericId: number | null;
  namespacedId: string | null;
  mineflayerName: string;
  mineflayerNameReliable: boolean;
  mineflayerNameConfidence: 'version-static' | 'unresolved' | 'contradicted-by-runtime-registry';
  mineflayerNameStatus: MineflayerItemNameStatus;
  resolutionStatus: RegistryResolution['status'] | 'unavailable';
  /** Distinguishes absence proven by a complete registry from unobserved or unavailable mappings. */
  resolutionReason: string | null;
  provenance: RegistryProvenance | null;
  identityConfidence: 'session-observed' | 'version-static-candidate' | 'unresolved';
  staticCandidate: { namespacedId: string; numericId: number | null; provenance: RegistryProvenance } | null;
  runtimeNumericIdVerified: boolean;
  minecraftVersion: string | null;
  registryEpoch: string | null;
  components?: unknown;
}

export interface InventoryStackLike {
  slot: number;
  count: number;
  type: number;
  name: string;
  components?: unknown;
}

/** Identifies one runtime context; any change makes earlier registry-derived decisions stale. */
export function runtimeContextKey(context: RuntimeRegistryContext | null): string {
  return JSON.stringify(context ? [context.registryEpoch, context.runtimeEpoch, context.mineflayerSessionId, context.minecraftEndpoint,
    context.bridgeSessionId, context.sourceRegistryEpoch, context.serverIdentity] : null);
}

/**
 * Mineflayer derives names, hardness and shapes from static minecraft-data.
 * Returns a refusal reason when the current runtime state registry shows that
 * this static view does not describe the block the server actually has.
 */
export function runtimeBlockStateConflict(block: { name: string; stateId: number }, context: RuntimeRegistryContext | null): string | null {
  if (!context?.registryService || !context.minecraftVersion || !context.registryEpoch || !Number.isSafeInteger(block.stateId)) return null;
  const resolution = context.registryService.resolve({ kind: 'blockState', minecraftVersion: context.minecraftVersion, registryEpoch: context.registryEpoch, numericId: block.stateId });
  const staticName = block.name.includes(':') ? block.name : `minecraft:${block.name}`;
  if (resolution.status === 'resolved') {
    return resolution.provenance.source !== 'minecraft-data' && resolution.entry.namespacedId !== staticName
      ? `runtime-identity-contradicts-mineflayer: state ${block.stateId} is ${resolution.entry.namespacedId} on this server, not ${staticName}`
      : null;
  }
  if (resolution.status === 'ambiguous') return `runtime-block-state-mapping-ambiguous: state ${block.stateId}`;
  if (resolution.status === 'unresolved' && resolution.reason === 'identifier-not-found') {
    return `block-state-absent-from-complete-runtime-registry: state ${block.stateId} is not ${staticName} on this server`;
  }
  if (resolution.status === 'unavailable' && resolution.reason === 'stale-context') return 'stale-registry-context';
  return null;
}

export function resolveItemType(type: unknown, context: RuntimeRegistryContext | null): RegistryResolution | null {
  if (typeof type !== 'number' || !Number.isSafeInteger(type) || !context?.registryService || !context.minecraftVersion) return null;
  return context.registryService.resolve({
    kind: 'item',
    minecraftVersion: context.minecraftVersion,
    registryEpoch: context.registryEpoch ?? undefined,
    numericId: type,
  });
}

export type MineflayerItemNameStatus = 'matches-runtime-registry' | 'contradicts-runtime-registry' | 'ambiguous-runtime-mapping' |
  'absent-from-complete-runtime-registry' | 'stale-runtime-context' | 'mineflayer-name-unavailable' | 'not-checked-against-runtime-registry';

/**
 * Compares Mineflayer's static item name with the current runtime registry.
 * Unsafe statuses mean the static name, recipes and IDs do not describe the
 * stack the server actually holds, so no action may be selected through them.
 */
export function mineflayerItemNameStatus(item: { type: unknown; name: string }, context: RuntimeRegistryContext | null,
  resolution: RegistryResolution | null = resolveItemType(item.type, context)): MineflayerItemNameStatus {
  if (resolution?.status === 'ambiguous') return 'ambiguous-runtime-mapping';
  if (resolution?.status === 'unavailable' && resolution.reason === 'stale-context') return 'stale-runtime-context';
  if (resolution?.status === 'unresolved' && resolution.reason === 'identifier-not-found') return 'absent-from-complete-runtime-registry';
  if (item.name === 'unknown') return 'mineflayer-name-unavailable';
  if (resolution?.status !== 'resolved' || resolution.provenance.source === 'minecraft-data') return 'not-checked-against-runtime-registry';
  const staticName = item.name.includes(':') ? item.name : `minecraft:${item.name}`;
  return resolution.entry.namespacedId === staticName ? 'matches-runtime-registry' : 'contradicts-runtime-registry';
}

export function isUnsafeItemNameStatus(status: MineflayerItemNameStatus): boolean {
  return status === 'contradicts-runtime-registry' || status === 'ambiguous-runtime-mapping' ||
    status === 'absent-from-complete-runtime-registry' || status === 'stale-runtime-context';
}

/** Matches an inventory stack to a request without trusting a static name the runtime registry contradicts. */
export function itemMatchesRequest(candidate: { type: number; name: string }, request: string, context: RuntimeRegistryContext | null): boolean {
  const resolution = resolveItemType(candidate.type, context);
  const nameStatus = mineflayerItemNameStatus(candidate, context, resolution);
  if (request.includes(':')) {
    if (resolution?.status === 'resolved' && resolution.entry.namespacedId === request) return true;
    if (isUnsafeItemNameStatus(nameStatus)) return false;
    const legacyKey = candidate.name.includes(':') ? candidate.name : `minecraft:${candidate.name}`;
    return request.startsWith('minecraft:') && candidate.name !== 'unknown' && legacyKey === request;
  }
  return !isUnsafeItemNameStatus(nameStatus) && candidate.name !== 'unknown' && candidate.name.includes(request.toLowerCase());
}

export function annotateItem(item: InventoryStackLike, context: RuntimeRegistryContext | null): RegistryAnnotatedItem {
  const resolution = resolveItemType(item.type, context);
  const nameStatus = mineflayerItemNameStatus(item, context, resolution);
  const nameUnsafe = isUnsafeItemNameStatus(nameStatus);
  const staticName = item.name !== 'unknown'
    ? (item.name.includes(':') ? item.name : `minecraft:${item.name}`)
    : null;
  const staticResolution = staticName && context?.registryService && context.minecraftVersion
    ? context.registryService.resolve({ kind: 'item', minecraftVersion: context.minecraftVersion, namespacedId: staticName, registryEpoch: `minecraft-data:${context.minecraftVersion}` })
    : null;
  const staticCandidate = staticResolution?.status === 'resolved' && staticResolution.provenance.source === 'minecraft-data'
    ? { namespacedId: staticResolution.entry.namespacedId, numericId: staticResolution.entry.numericId ?? null, provenance: staticResolution.provenance }
    : null;
  const components = toBoundedJsonValue(item.components);
  return {
    slot: item.slot,
    quantity: item.count,
    rawNumericId: Number.isSafeInteger(item.type) ? item.type : null,
    namespacedId: resolution?.status === 'resolved' ? resolution.entry.namespacedId : null,
    mineflayerName: item.name,
    mineflayerNameReliable: item.name !== 'unknown' && !nameUnsafe,
    mineflayerNameConfidence: nameUnsafe ? 'contradicted-by-runtime-registry' : item.name !== 'unknown' ? 'version-static' : 'unresolved',
    mineflayerNameStatus: nameStatus,
    resolutionStatus: resolution?.status ?? 'unavailable',
    resolutionReason: resolution && 'reason' in resolution ? resolution.reason : null,
    provenance: resolution?.status === 'resolved' ? resolution.provenance : null,
    identityConfidence: resolution?.status === 'resolved'
      ? (resolution.provenance.source === 'minecraft-data' ? 'version-static-candidate' : 'session-observed')
      : staticCandidate ? 'version-static-candidate' : 'unresolved',
    staticCandidate,
    runtimeNumericIdVerified: resolution?.status === 'resolved' && resolution.provenance.authority === 'authenticated-runtime' &&
      resolution.provenance.registryEpoch === context?.registryEpoch && resolution.provenance.runtimeEpoch === context?.runtimeEpoch,
    minecraftVersion: context?.minecraftVersion ?? null,
    registryEpoch: context?.registryEpoch ?? null,
    ...(components === undefined ? {} : { components }),
  };
}

export function toBoundedJsonValue(value: unknown, maxLength = 8192): unknown | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length > maxLength) return undefined;
    return JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
}
