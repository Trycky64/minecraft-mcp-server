/** Generic contracts for describing menu slot layouts. Identity resolution is deliberately separate. */
export interface MenuIdentityEvidence {
  namespacedId: string;
  numericTypeId: number;
  minecraftVersion: string;
  authority: 'version-static' | 'authenticated-runtime';
  source: string;
  serverIdentity?: string | null;
  registryEpoch?: string | null;
  runtimeEpoch?: string | null;
  mineflayerSessionId?: string | null;
  bridgeSessionId?: string | null;
}

export interface MenuSlotRange { start: number; endExclusive: number }
export interface MenuSlotRole { slots: number[]; role: string }
export interface MenuLayoutContract {
  namespacedId: string;
  minecraftVersions: readonly string[];
  source: string;
  totalSlotCount: number;
  /** Ranges are only declared when their meaning is documented by the provider. */
  menuSlots?: MenuSlotRange;
  playerInventory?: MenuSlotRange;
  playerHotbar?: MenuSlotRange;
  machineSlots?: MenuSlotRange;
  roles?: readonly MenuSlotRole[];
  controls?: readonly { kind: string; id: number; semantic: string; executableByMineflayerTools: false }[];
  capabilities?: { indexedSlotClick: boolean; shiftClick: boolean; drag: boolean };
}

export interface MenuLayoutProvider {
  readonly id: string;
  getContracts(identity: MenuIdentityEvidence): readonly MenuLayoutContract[];
  getSynchronizedPropertyName?(identity: MenuIdentityEvidence, propertyId: number): string | null;
}

export interface MenuLayoutEvidence {
  observedSlotCount: number;
  modelSlotCount?: number | null;
  modelInventoryRange?: MenuSlotRange | null;
}

export type MenuLayoutResolution =
  | { status: 'known'; source: string; providerIds: string[]; contract: MenuLayoutContract }
  | { status: 'unknown'; reason: 'no-provider' | 'identity-not-authoritative' | 'no-contract-for-version' }
  | { status: 'incompatible'; reason: 'observed-slot-count-mismatch' | 'model-range-mismatch' | 'invalid-contract' }
  | { status: 'conflict'; providerIds: string[]; reason: 'providers-disagree' };
export type MenuPropertyResolution =
  | { status: 'known'; name: string; providerIds: string[] }
  | { status: 'raw-only'; providerIds: [] }
  | { status: 'conflict'; providerIds: string[] };

const MAX_LAYOUT_PROVIDERS = 16;
const MAX_CONTRACTS_PER_PROVIDER = 128;

function isRange(range: MenuSlotRange | undefined, total: number): boolean {
  return range === undefined || (Number.isSafeInteger(range.start) && Number.isSafeInteger(range.endExclusive) &&
    range.start >= 0 && range.endExclusive >= range.start && range.endExclusive <= total);
}

function validContract(contract: MenuLayoutContract): boolean {
  if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(contract.namespacedId) ||
      typeof contract.source !== 'string' || contract.source.length === 0 || contract.source.length > 200 ||
      !Number.isSafeInteger(contract.totalSlotCount) || contract.totalSlotCount < 0 || contract.totalSlotCount > 256 ||
      contract.minecraftVersions.length === 0 || contract.minecraftVersions.some(version => !/^\d+\.\d+(?:\.\d+)?$/.test(version)) ||
      !isRange(contract.menuSlots, contract.totalSlotCount) || !isRange(contract.playerInventory, contract.totalSlotCount) ||
      !isRange(contract.playerHotbar, contract.totalSlotCount) || !isRange(contract.machineSlots, contract.totalSlotCount)) return false;
  const ranges = [contract.menuSlots, contract.playerInventory, contract.playerHotbar, contract.machineSlots].filter((range): range is MenuSlotRange => range !== undefined);
  if (ranges.some((left, index) => ranges.slice(index + 1).some(right => left.start < right.endExclusive && right.start < left.endExclusive))) return false;
  if (contract.playerInventory && contract.playerHotbar && contract.playerInventory.endExclusive !== contract.playerHotbar.start) return false;
  if (contract.roles?.some(role => !role.role || role.slots.some(slot => !Number.isSafeInteger(slot) || slot < 0 || slot >= contract.totalSlotCount))) return false;
  if (contract.controls?.some(control => !Number.isSafeInteger(control.id) || control.id < 0 || control.executableByMineflayerTools !== false)) return false;
  if (contract.capabilities && Object.values(contract.capabilities).some(value => typeof value !== 'boolean')) return false;
  return true;
}

function contractKey(contract: MenuLayoutContract): string {
  return JSON.stringify({
    namespacedId: contract.namespacedId,
    minecraftVersions: [...contract.minecraftVersions].sort(),
    source: contract.source,
    totalSlotCount: contract.totalSlotCount,
    menuSlots: contract.menuSlots ?? null,
    playerInventory: contract.playerInventory ?? null,
    playerHotbar: contract.playerHotbar ?? null,
    machineSlots: contract.machineSlots ?? null,
    roles: contract.roles ?? [],
    controls: contract.controls ?? [],
    capabilities: contract.capabilities ?? null,
  });
}

/**
 * Resolves only layout contracts. Providers cannot establish menu identity, and
 * no provider wins by priority: conflicting applicable contracts are rejected.
 */
export class MenuLayoutRegistry {
  private readonly providers: MenuLayoutProvider[] = [];

  constructor(providers: readonly MenuLayoutProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: MenuLayoutProvider): void {
    if (this.providers.length >= MAX_LAYOUT_PROVIDERS) throw new Error(`menu-layout-provider-limit-exceeded:${MAX_LAYOUT_PROVIDERS}`);
    if (!provider.id || this.providers.some(existing => existing.id === provider.id)) throw new Error(`duplicate-or-empty-menu-layout-provider:${provider.id}`);
    this.providers.push(provider);
  }

  resolve(identity: MenuIdentityEvidence | null, evidence: MenuLayoutEvidence): MenuLayoutResolution {
    if (!identity) return { status: 'unknown', reason: 'identity-not-authoritative' };
    if (!identity.namespacedId.startsWith('minecraft:') && identity.authority !== 'authenticated-runtime') {
      return { status: 'unknown', reason: 'identity-not-authoritative' };
    }
    const candidates: Array<{ provider: MenuLayoutProvider; contract: MenuLayoutContract }> = [];
    for (const provider of this.providers) {
      try {
        const contracts = provider.getContracts(identity);
        if (!Array.isArray(contracts) || contracts.length > MAX_CONTRACTS_PER_PROVIDER) return { status: 'incompatible', reason: 'invalid-contract' };
        for (const contract of contracts) {
          if (contract.namespacedId === identity.namespacedId && contract.minecraftVersions.includes(identity.minecraftVersion)) candidates.push({ provider, contract });
        }
      } catch {
        return { status: 'incompatible', reason: 'invalid-contract' };
      }
    }
    if (!candidates.length) return { status: 'unknown', reason: 'no-provider' };
    if (candidates.some(({ contract }) => !validContract(contract))) return { status: 'incompatible', reason: 'invalid-contract' };
    const keys = new Set(candidates.map(({ contract }) => contractKey(contract)));
    if (keys.size > 1) return { status: 'conflict', providerIds: candidates.map(({ provider }) => provider.id), reason: 'providers-disagree' };
    const { contract } = candidates[0]!;
    if (evidence.observedSlotCount !== contract.totalSlotCount ||
        (evidence.modelSlotCount != null && evidence.modelSlotCount !== contract.totalSlotCount)) {
      return { status: 'incompatible', reason: 'observed-slot-count-mismatch' };
    }
    const modelInventoryRange = contract.playerInventory ? {
      start: contract.playerInventory.start,
      endExclusive: contract.playerHotbar?.endExclusive ?? contract.playerInventory.endExclusive,
    } : null;
    if (modelInventoryRange && evidence.modelInventoryRange &&
        (modelInventoryRange.start !== evidence.modelInventoryRange.start || modelInventoryRange.endExclusive !== evidence.modelInventoryRange.endExclusive)) {
      return { status: 'incompatible', reason: 'model-range-mismatch' };
    }
    return {
      status: 'known', source: contract.source,
      providerIds: candidates.map(({ provider }) => provider.id),
      contract: structuredClone(contract),
    };
  }

  getSynchronizedPropertyName(identity: MenuIdentityEvidence | null, propertyId: number): string | null {
    const result = this.resolveSynchronizedProperty(identity, propertyId);
    return result.status === 'known' ? result.name : null;
  }

  resolveSynchronizedProperty(identity: MenuIdentityEvidence | null, propertyId: number): MenuPropertyResolution {
    if (!identity || (!identity.namespacedId.startsWith('minecraft:') && identity.authority !== 'authenticated-runtime')) return { status: 'raw-only', providerIds: [] };
    const results: Array<{ providerId: string; name: string }> = [];
    for (const provider of this.providers) {
      try {
        const contracts = provider.getContracts(identity);
        if (!Array.isArray(contracts) || contracts.length > MAX_CONTRACTS_PER_PROVIDER) return { status: 'conflict', providerIds: [provider.id] };
        const hasMatchingContract = contracts.some(contract => contract.namespacedId === identity.namespacedId && contract.minecraftVersions.includes(identity.minecraftVersion));
        const name = hasMatchingContract ? provider.getSynchronizedPropertyName?.(identity, propertyId) : null;
        if (name) results.push({ providerId: provider.id, name });
      } catch {
        return { status: 'conflict', providerIds: [provider.id] };
      }
    }
    if (!results.length) return { status: 'raw-only', providerIds: [] };
    if (new Set(results.map(result => result.name)).size > 1) return { status: 'conflict', providerIds: results.map(result => result.providerId) };
    return { status: 'known', name: results[0]!.name, providerIds: results.map(result => result.providerId) };
  }
}

/** Version-specific vanilla layouts are supplied by prismarine-windows. */
export function createVanillaMenuLayoutProvider(loadDefinitions: (version: string) => Record<string, {
  type: number | string; inventory: { start: number; end: number }; slots: number; craft: number;
} | null>): MenuLayoutProvider {
  return {
    id: 'minecraft-prismarine-windows',
    getContracts(identity) {
      if (!identity.namespacedId.startsWith('minecraft:')) return [];
      let definitions: Record<string, { type: number | string; inventory: { start: number; end: number }; slots: number; craft: number } | null>;
      try { definitions = loadDefinitions(identity.minecraftVersion); } catch { return []; }
      const definition = definitions[identity.namespacedId];
      if (!definition || definition.type !== identity.numericTypeId) return [];
      return [{
        namespacedId: identity.namespacedId,
        minecraftVersions: [identity.minecraftVersion],
        source: 'version-specific-prismarine-windows-definition',
        totalSlotCount: definition.slots,
        menuSlots: { start: 0, endExclusive: definition.inventory.start },
        playerInventory: { start: definition.inventory.start, endExclusive: definition.inventory.end + 1 - 9 },
        playerHotbar: { start: definition.inventory.end + 1 - 9, endExclusive: definition.inventory.end + 1 },
        capabilities: { indexedSlotClick: true, shiftClick: true, drag: false },
      }];
    },
  };
}
