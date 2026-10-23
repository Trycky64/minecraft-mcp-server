import type { RuntimeRegistryContext } from './runtime-registry-service.js';
import type { MenuIdentityEvidence } from './menu-layout-registry.js';

export interface MenuIdentityResolution {
  identity: Record<string, unknown>;
  evidence: MenuIdentityEvidence | null;
}

export interface VersionedMenuTypeDefinition {
  type: number | string;
  inventory: { start: number; end: number };
  slots: number;
  craft: number;
}

/** Modded numeric IDs are named only by an authenticated current bridge snapshot. */
export function resolveAuthenticatedRuntimeRegistryId(
  kind: 'item' | 'menu',
  numericId: number,
  minecraftVersion: string,
  context: RuntimeRegistryContext | null,
): { namespacedId: string; provenance: Record<string, unknown> } | null {
  if (!context?.registryService || !context.registryEpoch || !context.bridgeAvailable || context.bridgeSession?.authenticated !== true) return null;
  const resolution = context.registryService.resolve({ kind, minecraftVersion, numericId, registryEpoch: context.registryEpoch });
  if (resolution.status !== 'resolved') return null;
  const { entry, provenance } = resolution;
  const entryProvenance = entry.provenance;
  const valid = entry.kind === kind && entry.minecraftVersion === minecraftVersion && entry.numericId === numericId &&
    entry.numericIdScope === 'server-registry-generation' && entry.registryEpoch === context.registryEpoch &&
    provenance.registryEpoch === context.registryEpoch && entryProvenance.minecraftVersion === minecraftVersion &&
    entryProvenance.minecraftEndpoint === context.minecraftEndpoint && entryProvenance.source === 'neoforge-bridge' &&
    entryProvenance.authority === 'authenticated-runtime' && entryProvenance.registryEpoch === provenance.registryEpoch &&
    entryProvenance.runtimeEpoch === provenance.runtimeEpoch && entryProvenance.bridgeSessionId === provenance.bridgeSessionId &&
    entryProvenance.serverIdentity === provenance.serverIdentity && entryProvenance.sourceRegistryEpoch === provenance.sourceRegistryEpoch &&
    provenance.minecraftVersion === minecraftVersion && provenance.source === 'neoforge-bridge' && provenance.authority === 'authenticated-runtime' &&
    context.bridgeSession.sessionId === context.bridgeSessionId && context.bridgeSession.serverIdentity === context.serverIdentity &&
    context.bridgeSession.minecraftEndpoint === context.minecraftEndpoint && context.bridgeSession.minecraftVersion === minecraftVersion &&
    context.bridgeSession.sourceRegistryEpoch === context.sourceRegistryEpoch && provenance.bridgeSessionId === context.bridgeSessionId &&
    provenance.serverIdentity === context.serverIdentity && provenance.sourceRegistryEpoch === context.sourceRegistryEpoch &&
    provenance.runtimeEpoch === context.runtimeEpoch && provenance.minecraftEndpoint === context.minecraftEndpoint;
  if (!valid) return null;
  return {
    namespacedId: entry.namespacedId,
    provenance: {
      source: provenance.source, authority: provenance.authority, minecraftVersion: provenance.minecraftVersion,
      registryEpoch: provenance.registryEpoch, runtimeEpoch: provenance.runtimeEpoch,
      sourceRegistryEpoch: provenance.sourceRegistryEpoch, bridgeSessionId: provenance.bridgeSessionId,
      serverIdentity: provenance.serverIdentity, minecraftEndpoint: provenance.minecraftEndpoint,
    },
  };
}

/** Resolves names only from the current authenticated registry or exact-version vanilla type table. */
export function resolveMenuIdentity(
  rawMenuTypeId: number | null,
  minecraftVersion: string | null,
  mineflayerTypeHint: string | number,
  registryContext: RuntimeRegistryContext | null,
  getDefinitions: (version: string) => Record<string, VersionedMenuTypeDefinition | null>,
): MenuIdentityResolution {
  let base: Record<string, unknown> = {
    status: 'unresolved', reason: 'menu-type-not-observed-or-not-mapped',
    rawNumericTypeId: rawMenuTypeId, mineflayerTypeHint,
  };
  if (rawMenuTypeId === null || minecraftVersion === null) return { identity: base, evidence: null };

  let canUseVersionTable = true;
  const service = registryContext?.registryService;
  if (service && registryContext?.registryEpoch) {
    const resolution = service.resolve({ kind: 'menu', minecraftVersion, numericId: rawMenuTypeId, registryEpoch: registryContext.registryEpoch });
    if (resolution.status === 'resolved') {
      const { entry, provenance } = resolution;
      const entryProvenance = entry.provenance;
      const linkedToCurrentBridge = entry.kind === 'menu' && entry.minecraftVersion === minecraftVersion &&
        entry.numericId === rawMenuTypeId && entry.numericIdScope === 'server-registry-generation' &&
        entry.registryEpoch === registryContext.registryEpoch && provenance.registryEpoch === registryContext.registryEpoch &&
        entryProvenance.minecraftVersion === minecraftVersion && entryProvenance.minecraftEndpoint === registryContext.minecraftEndpoint &&
        entryProvenance.source === provenance.source && entryProvenance.authority === provenance.authority &&
        entryProvenance.registryEpoch === provenance.registryEpoch && entryProvenance.runtimeEpoch === provenance.runtimeEpoch &&
        entryProvenance.bridgeSessionId === provenance.bridgeSessionId && entryProvenance.serverIdentity === provenance.serverIdentity &&
        entryProvenance.sourceRegistryEpoch === provenance.sourceRegistryEpoch &&
        provenance.minecraftVersion === minecraftVersion && provenance.source === 'neoforge-bridge' && provenance.authority === 'authenticated-runtime' &&
        registryContext.bridgeAvailable && registryContext.bridgeSession?.authenticated === true &&
        registryContext.bridgeSession.sessionId === registryContext.bridgeSessionId &&
        registryContext.bridgeSession.serverIdentity === registryContext.serverIdentity &&
        registryContext.bridgeSession.minecraftEndpoint === registryContext.minecraftEndpoint &&
        registryContext.bridgeSession.minecraftVersion === minecraftVersion &&
        registryContext.bridgeSession.sourceRegistryEpoch === registryContext.sourceRegistryEpoch &&
        provenance.bridgeSessionId === registryContext.bridgeSessionId && provenance.serverIdentity === registryContext.serverIdentity &&
        provenance.sourceRegistryEpoch === registryContext.sourceRegistryEpoch && provenance.runtimeEpoch === registryContext.runtimeEpoch &&
        provenance.minecraftEndpoint === registryContext.minecraftEndpoint;
      if (linkedToCurrentBridge) {
        const identity: Record<string, unknown> = {
          status: 'resolved', namespacedId: entry.namespacedId, rawNumericTypeId: rawMenuTypeId,
          provenance: {
            source: provenance.source, authority: provenance.authority, minecraftVersion: provenance.minecraftVersion,
            registryEpoch: provenance.registryEpoch, runtimeEpoch: provenance.runtimeEpoch,
            sourceRegistryEpoch: provenance.sourceRegistryEpoch, bridgeSessionId: provenance.bridgeSessionId,
            serverIdentity: provenance.serverIdentity, minecraftEndpoint: provenance.minecraftEndpoint,
          },
        };
        return {
          identity,
          evidence: {
            namespacedId: entry.namespacedId, numericTypeId: rawMenuTypeId, minecraftVersion,
            authority: 'authenticated-runtime', source: provenance.source,
            serverIdentity: provenance.serverIdentity, registryEpoch: provenance.registryEpoch,
            runtimeEpoch: provenance.runtimeEpoch, mineflayerSessionId: registryContext.mineflayerSessionId,
            bridgeSessionId: provenance.bridgeSessionId,
          },
        };
      }
      canUseVersionTable = false;
      base = { ...base, reason: 'menu-mapping-provenance-not-linked-to-current-authenticated-bridge' };
    } else if (resolution.status === 'unavailable') {
      if (resolution.reason === 'stale-context') canUseVersionTable = false;
      base = { ...base, reason: resolution.reason };
    } else if (resolution.status === 'ambiguous') {
      canUseVersionTable = false;
      base = { ...base, reason: 'ambiguous-runtime-menu-mapping' };
    } else if (resolution.reason === 'identifier-not-found') {
      // A complete runtime menu registry proves this server does not use the ID;
      // the static vanilla table would contradict the server.
      canUseVersionTable = false;
      base = { ...base, reason: 'menu-type-id-absent-from-complete-runtime-registry' };
    }
  }

  if (!canUseVersionTable) return { identity: base, evidence: null };
  try {
    const matches = Object.entries(getDefinitions(minecraftVersion))
      .filter(([id, definition]) => id.startsWith('minecraft:') && definition?.type === rawMenuTypeId);
    if (matches.length === 1) {
      const [namespacedId] = matches[0]!;
      return {
        identity: {
          status: 'resolved', namespacedId, rawNumericTypeId: rawMenuTypeId,
          provenance: { source: 'version-specific-prismarine-windows-menu-type', authority: 'version-static', minecraftVersion },
          note: 'Static version-specific identity; not a runtime registry observation.',
        },
        evidence: {
          namespacedId, numericTypeId: rawMenuTypeId, minecraftVersion,
          authority: 'version-static', source: 'version-specific-prismarine-windows-menu-type',
        },
      };
    }
    if (matches.length > 1) base = { ...base, reason: 'version-table-menu-type-id-is-ambiguous' };
  } catch {
    base = { ...base, reason: 'version-specific-menu-type-table-unavailable' };
  }
  return { identity: base, evidence: null };
}
