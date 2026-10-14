import { z } from 'zod';
import { ToolFactory } from '../tool-factory.js';
import type { RuntimeRegistryService } from '../services/runtime-registry-service.js';
import type { RegistryKind, RegistrySourceName } from '../services/minecraft-registry-service.js';
import type { NeoForgeBridgeIntegration } from '../bridge/neoforge-bridge-client.js';

function jsonResponse(factory: ToolFactory, value: unknown) {
  return factory.createResponse(JSON.stringify(value, null, 2));
}

export function registerRegistryTools(factory: ToolFactory, runtimeRegistry: RuntimeRegistryService, bridgeIntegration?: NeoForgeBridgeIntegration): void {
  // Generic capability/discovery tools are additive; the original registry-* names remain stable.
  factory.registerTool(
    'minecraft-get-server-info',
    'Report the negotiated Minecraft connection and authenticated diagnostic bridge identity when available',
    {},
    async () => {
      const context = runtimeRegistry.getContext();
      return jsonResponse(factory, {
        status: context.connected ? 'connected' : 'disconnected',
        minecraftVersion: context.minecraftVersion,
        protocolVersion: context.protocolVersion,
        protocolNumber: context.protocolNumber,
        endpoint: context.serverIdentity,
        registryEpoch: context.registryEpoch,
        bridge: context.bridgeSession ? {
          authenticated: context.bridgeSession.authenticated,
          serverIdentity: context.bridgeSession.serverIdentity,
          minecraftEndpoint: context.bridgeSession.minecraftEndpoint,
          minecraftVersion: context.bridgeSession.minecraftVersion,
          neoForgeVersion: context.bridgeSession.neoForgeVersion,
          sourceRegistryEpoch: context.bridgeSession.sourceRegistryEpoch,
        } : null,
      });
    },
    { requiresConnection: false },
  );

  factory.registerTool(
    'minecraft-get-capabilities',
    'Report observed MCP, Mineflayer, registry and bridge capabilities without implying unverified server permissions',
    {},
    async () => {
      const context = runtimeRegistry.getContext();
      const snapshots = context.registryService?.getSnapshots() ?? [];
      let bridgeCapabilities: unknown = null;
      let bridgeCapabilitiesError: string | null = null;
      if (bridgeIntegration?.client.config.enabled && bridgeIntegration.client.config.mode === 'generic') {
        try { bridgeCapabilities = await bridgeIntegration.capabilities(); }
        catch (error) { bridgeCapabilitiesError = error instanceof Error ? error.message : 'bridge-capability-query-failed'; }
      }
      const kinds = [...new Set(snapshots.flatMap((snapshot) => snapshot.availableRegistries))].sort();
      const connected = context.connected;
      const bridgeSession = context.bridgeSession;
      const capabilities = [
        { id: 'player.position.read', available: connected, source: 'mineflayer', limitation: connected ? null : 'minecraft-session-disconnected' },
        { id: 'player.inventory.read', available: connected, source: 'mineflayer', limitation: connected ? 'Only the bot inventory snapshot is exposed; container access requires an open menu.' : 'minecraft-session-disconnected' },
        { id: 'world.block.read.loaded', available: connected, source: 'mineflayer', limitation: 'Only blocks in Mineflayer loaded chunks are readable.' },
        { id: 'world.block.write.place', available: connected, source: 'mineflayer', limitation: 'Server permissions, reach, inventory, collision and confirmation remain runtime preconditions.' },
        { id: 'world.block.write.break', available: connected, source: 'mineflayer', limitation: 'Server permissions, reach and tool requirements remain runtime preconditions.' },
        { id: 'registry.static', available: snapshots.some((snapshot) => snapshot.source === 'minecraft-data'), source: 'minecraft-data', limitation: 'Static version data is not proof of runtime numeric IDs on modded servers.' },
        { id: 'registry.runtime', available: snapshots.some((snapshot) => snapshot.source !== 'minecraft-data'), source: 'protocol-or-authenticated-bridge', limitation: 'Only registries and coverage explicitly present in the current session are available.' },
        { id: 'neoforge.bridge.authenticated', available: bridgeSession?.authenticated === true, source: 'neoforge-bridge', limitation: bridgeSession ? null : 'No authenticated local NeoForge bridge session.' },
        { id: 'neoforge.capability.energy', available: bridgeSession !== null, source: 'neoforge-bridge', limitation: bridgeSession ? 'Readable only at loaded positions; mod capability semantics remain provider-defined.' : 'Bridge absent.' },
        { id: 'neoforge.capability.fluid', available: Boolean((bridgeCapabilities as { fluidHandler?: boolean } | null)?.fluidHandler), source: 'neoforge-bridge', limitation: bridgeCapabilities ? null : (bridgeCapabilitiesError ?? 'Bridge absent or fluid capability not implemented.') },
      ];
      return jsonResponse(factory, { status: connected ? 'available' : 'partially-available', minecraftVersion: context.minecraftVersion,
        registryEpoch: context.registryEpoch, registeredRegistryKinds: kinds, capabilities,
        genericBridgeCapabilities: bridgeCapabilities, genericBridgeCapabilitiesError: bridgeCapabilitiesError });
    },
    { requiresConnection: false },
  );

  factory.registerTool(
    'minecraft-list-namespaces',
    'List namespaces observed in available version/session registry snapshots; this is not a hard-coded mod list',
    {},
    async () => {
      const context = runtimeRegistry.getContext();
      if (!context.registryService || !context.minecraftVersion) return jsonResponse(factory, { status: 'unavailable', reason: 'registry-not-loaded', namespaces: [] });
      const snapshots = context.registryService.getSnapshots().filter((snapshot) => snapshot.minecraftVersion === context.minecraftVersion);
      const namespaces = new Map<string, Set<string>>();
      for (const snapshot of snapshots) for (const entry of snapshot.entries) {
        const namespace = entry.namespacedId.split(':', 1)[0]!;
        const kindsForNamespace = namespaces.get(namespace) ?? new Set<string>();
        kindsForNamespace.add(entry.kind);
        namespaces.set(namespace, kindsForNamespace);
      }
      return jsonResponse(factory, { status: 'available', minecraftVersion: context.minecraftVersion, registryEpoch: context.registryEpoch,
        namespaces: [...namespaces].sort(([a], [b]) => a.localeCompare(b)).map(([namespace, kinds]) => ({ namespace, registryKinds: [...kinds].sort() })),
        sources: snapshots.map((snapshot) => ({ source: snapshot.source, registryEpoch: snapshot.registryEpoch ?? null,
          registries: snapshot.availableRegistries.map((kind) => ({ kind, completeness: snapshot.registryCoverage?.[kind] ?? 'partial' })) })) });
    },
    { requiresConnection: false },
  );

  factory.registerTool(
    'minecraft-search-registry',
    'Search dynamically observed registry snapshots with a bounded result page',
    {
      kind: z.string().optional(), namespace: z.string().regex(/^[a-z0-9_.-]+$/).optional(),
      prefix: z.string().regex(/^[a-z0-9_.:-]*$/).optional(), source: z.string().optional(),
      offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(100).default(50),
    },
    async ({ kind, namespace, prefix, source, offset, limit }) => {
      const context = runtimeRegistry.getContext();
      if (!context.registryService || !context.minecraftVersion) return jsonResponse(factory, { status: 'unavailable', reason: 'registry-not-loaded', entries: [] });
      const snapshots = context.registryService.getSnapshots().filter((snapshot) => snapshot.minecraftVersion === context.minecraftVersion && (source === undefined || snapshot.source === source));
      const entries = snapshots.flatMap((snapshot) => snapshot.entries).filter((entry) =>
        (kind === undefined || entry.kind === kind) &&
        (namespace === undefined || entry.namespacedId.startsWith(`${namespace}:`)) &&
        (prefix === undefined || entry.namespacedId.startsWith(prefix)) &&
        (entry.provenance.source === 'minecraft-data' || entry.registryEpoch === context.registryEpoch),
      ).sort((a, b) => a.kind.localeCompare(b.kind) || a.namespacedId.localeCompare(b.namespacedId) || a.provenance.source.localeCompare(b.provenance.source));
      const unique = entries.filter((entry, index) => index === 0 || JSON.stringify([entry.kind, entry.namespacedId, entry.provenance.source]) !== JSON.stringify([entries[index - 1]!.kind, entries[index - 1]!.namespacedId, entries[index - 1]!.provenance.source]));
      return jsonResponse(factory, { status: 'available', minecraftVersion: context.minecraftVersion, registryEpoch: context.registryEpoch,
        offset, limit, returned: unique.slice(offset, offset + limit).length, totalMatching: unique.length,
        entries: unique.slice(offset, offset + limit) });
    },
    { requiresConnection: false },
  );

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
          'Modded mappings remain unresolved for registry entries that are absent from the authoritative snapshot of the current session.',
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
