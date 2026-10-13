import { z } from 'zod';
import { ToolFactory } from '../tool-factory.js';
import type { RuntimeRegistryService } from '../services/runtime-registry-service.js';
import type { RegistryKind, RegistrySourceName } from '../services/minecraft-registry-service.js';

function jsonResponse(factory: ToolFactory, value: unknown) {
  return factory.createResponse(JSON.stringify(value, null, 2));
}

export function registerRegistryTools(factory: ToolFactory, runtimeRegistry: RuntimeRegistryService): void {
  factory.registerTool(
    'registry-status',
    'Show Minecraft connection, registry source, coverage and bridge status',
    {},
    async () => {
      const context = runtimeRegistry.getContext();
      const snapshots = context.registryService?.getSnapshots() ?? [];
      return jsonResponse(factory, {
        status: context.connected ? 'connected' : 'disconnected',
        minecraftVersion: context.minecraftVersion,
        protocolVersion: context.protocolVersion,
        protocolNumber: context.protocolNumber,
        serverIdentity: context.serverIdentity,
        registryEpoch: context.registryEpoch,
        sources: snapshots.map((snapshot) => ({
          source: snapshot.source,
          minecraftVersion: snapshot.minecraftVersion,
          registryEpoch: snapshot.registryEpoch ?? null,
          sourceRegistryEpoch: snapshot.sourceRegistryEpoch ?? null,
          serverIdentity: snapshot.serverIdentity ?? null,
          neoForgeVersion: snapshot.neoForgeVersion ?? null,
          availableRegistries: snapshot.availableRegistries.map((kind) => ({
            kind,
            completeness: snapshot.registryCoverage?.[kind] ?? 'partial',
            entries: snapshot.entries.filter((entry) => entry.kind === kind).length,
          })),
        })),
        bridgeAvailable: context.bridgeAvailable,
        protocolDecode: context.protocolDecode,
        limitations: [
          'Processia mappings remain unresolved for registry entries that are absent from the authoritative snapshot of the current session.',
          'Mineflayer does not expose NeoForge FE capabilities or opaque custom payload registries.',
          'Static minecraft-data entries retain static provenance and are not proof of runtime registry identity.',
        ],
      });
    },
    { requiresConnection: false },
  );

  factory.registerTool(
    'registry-resolve',
    'Resolve an item, block, blockState, entity, menu or extensible registry identifier',
    {
      kind: z.string().min(1),
      namespacedId: z.string().optional(),
      numericId: z.number().int().nonnegative().optional(),
      registryEpoch: z.string().optional(),
    },
    async ({ kind, namespacedId, numericId, registryEpoch }) => {
      const context = runtimeRegistry.getContext();
      if (!context.registryService || !context.minecraftVersion) {
        return jsonResponse(factory, {
          status: 'unavailable',
          reason: 'registry-not-loaded',
          kind,
          minecraftVersion: null,
          registryEpoch: registryEpoch ?? null,
          availableSources: [],
        });
      }
      const staticEpoch = `minecraft-data:${context.minecraftVersion}`;
      if (registryEpoch !== undefined && registryEpoch !== context.registryEpoch && registryEpoch !== staticEpoch) {
        return jsonResponse(factory, {
          status: 'unavailable', reason: 'registry-not-loaded', kind,
          minecraftVersion: context.minecraftVersion, registryEpoch,
          availableSources: context.registryService.getSnapshots().map((snapshot) => snapshot.source),
        });
      }
      const resolution = context.registryService.resolve({
        kind: kind as RegistryKind,
        minecraftVersion: context.minecraftVersion,
        ...(namespacedId === undefined ? {} : { namespacedId }),
        ...(numericId === undefined ? {} : { numericId }),
        registryEpoch: registryEpoch ?? context.registryEpoch ?? undefined,
      });
      return jsonResponse(factory, resolution.status === 'resolved'
        ? {
          ...resolution,
          identityConfidence: resolution.provenance.source === 'minecraft-data' ? 'version-static' : 'session-observed',
          runtimeNumericIdVerified: resolution.provenance.source !== 'minecraft-data' && resolution.provenance.registryEpoch === context.registryEpoch,
        }
        : resolution);
    },
    { requiresConnection: false },
  );

  factory.registerTool(
    'registry-inspect',
    'Inspect a bounded page of registry entries and their provenance',
    {
      kind: z.string().optional(),
      source: z.string().optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().max(200).default(50),
    },
    async ({ kind, source, offset, limit }) => {
      const context = runtimeRegistry.getContext();
      if (!context.registryService) {
        return jsonResponse(factory, { status: 'unavailable', reason: 'registry-not-loaded', entries: [] });
      }
      const snapshots = context.registryService.getSnapshots();
      const entries = context.registryService.getEntries({
        ...(kind === undefined ? {} : { kind: kind as RegistryKind }),
        ...(source === undefined ? {} : { source: source as RegistrySourceName }),
        offset,
        limit,
      });
      const coverage = snapshots
        .filter((snapshot) => source === undefined || snapshot.source === source)
        .flatMap((snapshot) => snapshot.availableRegistries
          .filter((registryKind) => kind === undefined || registryKind === kind)
          .map((registryKind) => ({
            source: snapshot.source,
            minecraftVersion: snapshot.minecraftVersion,
            registryEpoch: snapshot.registryEpoch ?? null,
            kind: registryKind,
            completeness: snapshot.registryCoverage?.[registryKind] ?? 'partial',
          })));
      return jsonResponse(factory, {
        status: 'available',
        minecraftVersion: context.minecraftVersion,
        registryEpoch: context.registryEpoch,
        registryCoverage: coverage,
        offset,
        limit,
        returned: entries.length,
        totalMatching: snapshots.flatMap((snapshot) => snapshot.entries).filter((entry) =>
          (kind === undefined || entry.kind === kind) && (source === undefined || entry.provenance.source === source),
        ).length,
        coverage,
        entries,
      });
    },
    { requiresConnection: false },
  );
}
