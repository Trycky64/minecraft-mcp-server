import type { RuntimeRegistryContext } from './runtime-registry-service.js';
import type { RegistryProvenance, RegistryResolution } from './minecraft-registry-service.js';

export interface RegistryAnnotatedItem {
  slot: number;
  quantity: number;
  rawNumericId: number | null;
  namespacedId: string | null;
  mineflayerName: string;
  mineflayerNameReliable: boolean;
  mineflayerNameConfidence: 'version-static' | 'unresolved';
  resolutionStatus: RegistryResolution['status'] | 'unavailable';
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

export function resolveItemType(type: unknown, context: RuntimeRegistryContext | null): RegistryResolution | null {
  if (typeof type !== 'number' || !Number.isSafeInteger(type) || !context?.registryService || !context.minecraftVersion) return null;
  return context.registryService.resolve({
    kind: 'item',
    minecraftVersion: context.minecraftVersion,
    registryEpoch: context.registryEpoch ?? undefined,
    numericId: type,
  });
}

export function annotateItem(item: InventoryStackLike, context: RuntimeRegistryContext | null): RegistryAnnotatedItem {
  const resolution = resolveItemType(item.type, context);
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
    mineflayerNameReliable: item.name !== 'unknown',
    mineflayerNameConfidence: item.name !== 'unknown' ? 'version-static' : 'unresolved',
    resolutionStatus: resolution?.status ?? 'unavailable',
    provenance: resolution?.status === 'resolved' ? resolution.provenance : null,
    identityConfidence: resolution?.status === 'resolved'
      ? (resolution.provenance.source === 'minecraft-data' ? 'version-static-candidate' : 'session-observed')
      : staticCandidate ? 'version-static-candidate' : 'unresolved',
    staticCandidate,
    runtimeNumericIdVerified: resolution?.status === 'resolved' && resolution.provenance.source !== 'minecraft-data' && resolution.provenance.registryEpoch === context?.registryEpoch,
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
