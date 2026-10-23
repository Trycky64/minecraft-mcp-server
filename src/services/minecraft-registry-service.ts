import minecraftData from 'minecraft-data';

export type RegistryKind = 'item' | 'block' | 'blockState' | 'entity' | 'menu' | (string & {});
export type RegistrySourceName = 'minecraft-data' | 'protocol' | 'neoforge-bridge' | (string & {});
export type RegistryNumericIdScope = 'minecraft-data-version' | 'server-registry-generation' | 'server-block-state-generation';
export type RegistryAuthority = 'static-baseline' | 'protocol-observed' | 'authenticated-runtime';

export interface RegistryProvenance {
  source: RegistrySourceName;
  authority?: RegistryAuthority;
  minecraftVersion: string;
  /** Runtime service generation. Distinct from Mineflayer and Java source registry epochs. */
  runtimeEpoch?: string;
  /** Compatibility field for the runtime-scoped epoch on entries and resolutions. */
  registryEpoch?: string;
  minecraftEndpoint?: string;
  mineflayerSessionId?: string;
  mineflayerRegistryEpoch?: string;
  bridgeSessionId?: string;
  /** Runtime registry generation reported by the bridge; distinct from the MCP bot epoch. */
  sourceRegistryEpoch?: string;
  serverIdentity?: string;
  neoForgeVersion?: string;
  observedAt?: string;
  registryCoverage?: 'complete' | 'partial';
  providerVersion?: string;
}

/** An explicit association supplied by a registry source. numericId is never inferred. */
export interface RegistryEntry {
  kind: RegistryKind;
  minecraftVersion: string;
  namespacedId: string;
  numericId?: number;
  /** Explicit lifetime/meaning for numericId; numeric IDs must never be assumed stable across sessions. */
  numericIdScope?: RegistryNumericIdScope;
  blockStateProperties?: Record<string, string | number | boolean>;
  registryEpoch?: string;
  provenance: RegistryProvenance;
}

/** Protocol parsers must set numericId only when the wire semantics prove the association. */
export interface ProtocolRegistryEntry {
  kind: RegistryKind;
  minecraftVersion: string;
  namespacedId: string;
  numericId?: number;
  entryOrdinal?: number;
  registryEpoch?: string;
  observedAt?: string;
}

/** Future bridge contract; data remains version- and epoch-scoped. */
export interface BridgeRegistryEntry {
  kind: RegistryKind;
  minecraftVersion: string;
  namespacedId: string;
  numericId?: number;
  registryEpoch: string;
  observedAt: string;
}

export interface RegistryLookup {
  kind: RegistryKind;
  minecraftVersion: string;
  namespacedId?: string;
  numericId?: number;
  registryEpoch?: string;
}

interface ResolutionBase {
  kind: RegistryKind;
  minecraftVersion: string;
  registryEpoch?: string;
  /** Internal service generation, separate from registryEpoch and Java sourceRegistryEpoch. */
  runtimeEpoch?: string;
  lookup: RegistryLookup;
}

export type RegistryResolution =
  | (ResolutionBase & { status: 'resolved'; entry: RegistryEntry; provenance: RegistryProvenance })
  | (ResolutionBase & { status: 'unresolved'; reason: 'identifier-not-found' | 'mapping-not-observed' })
  | (ResolutionBase & { status: 'unavailable'; reason: 'unsupported-version' | 'registry-not-loaded' | 'stale-context'; availableSources: RegistrySourceName[] })
  | (ResolutionBase & { status: 'ambiguous'; candidates: RegistryEntry[] });

export interface RegistrySourceSnapshot {
  source: RegistrySourceName;
  authority?: RegistryAuthority;
  minecraftVersion: string;
  /** Active MCP registry generation used to scope runtime numeric lookups; never the Java source epoch. */
  registryEpoch?: string;
  /** Explicit alias for the service generation; retained separately from sourceRegistryEpoch. */
  runtimeEpoch?: string;
  minecraftEndpoint?: string;
  mineflayerSessionId?: string;
  mineflayerRegistryEpoch?: string;
  bridgeSessionId?: string;
  observedAt?: string;
  sourceRegistryEpoch?: string;
  serverIdentity?: string;
  neoForgeVersion?: string;
  /** Registries known to be loaded, including registries whose entry list is empty. */
  availableRegistries: RegistryKind[];
  /** Per-registry evidence coverage. Unspecified registries are conservatively partial. */
  registryCoverage?: Partial<Record<RegistryKind, 'complete' | 'partial'>>;
  entries: RegistryEntry[];
}

const PRIORITY: Record<string, number> = {
  'minecraft-data': 100,
  protocol: 200,
  'neoforge-bridge': 300,
};

const RESOURCE_LOCATION = /^[a-z0-9_.-]+:[a-z0-9/._-]+$/;

function sourcePriority(source: RegistrySourceName): number {
  return PRIORITY[source] ?? 150;
}

function uniqueEntries(entries: RegistryEntry[]): RegistryEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = JSON.stringify([entry.kind, entry.minecraftVersion, entry.registryEpoch, entry.namespacedId, entry.numericId, entry.blockStateProperties, entry.provenance.source]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateSnapshot(snapshot: RegistrySourceSnapshot): void {
  if (snapshot.observedAt !== undefined && !Number.isFinite(Date.parse(snapshot.observedAt))) throw new Error('Snapshot observation time must be a valid date');
  if (new Set(snapshot.availableRegistries).size !== snapshot.availableRegistries.length) throw new Error('Snapshot registry index contains duplicates');
  if (snapshot.authority === 'static-baseline' && snapshot.source !== 'minecraft-data') throw new Error('Static snapshot authority must come from minecraft-data');
  if (snapshot.authority === 'protocol-observed' && snapshot.source !== 'protocol') throw new Error('Protocol snapshot authority must come from protocol observation');
  if (snapshot.authority === 'authenticated-runtime' && snapshot.source !== 'neoforge-bridge') throw new Error('Authenticated snapshot authority must come from NeoForge bridge');
  if (snapshot.authority === 'authenticated-runtime' && (!snapshot.bridgeSessionId || !snapshot.sourceRegistryEpoch || !snapshot.serverIdentity || !snapshot.minecraftEndpoint || !snapshot.runtimeEpoch)) {
    throw new Error('Authenticated runtime snapshot provenance is incomplete');
  }
  for (const kind of Object.keys(snapshot.registryCoverage ?? {})) {
    if (!snapshot.availableRegistries.includes(kind)) {
      throw new Error(`Registry coverage declared for unavailable registry: ${kind}`);
    }
  }
  for (const entry of snapshot.entries) {
    if (!snapshot.availableRegistries.includes(entry.kind)) {
      throw new Error(`Registry entry supplied for unavailable registry: ${entry.kind}`);
    }
    if (entry.minecraftVersion !== snapshot.minecraftVersion || entry.provenance.minecraftVersion !== snapshot.minecraftVersion) {
      throw new Error('Registry entry and provenance must match their snapshot Minecraft version');
    }
    if (entry.provenance.source !== snapshot.source) {
      throw new Error('Registry entry provenance source must match its snapshot source');
    }
    if (snapshot.authority !== undefined && entry.provenance.authority !== snapshot.authority) {
      throw new Error('Registry entry authority must match its snapshot');
    }
    if (snapshot.sourceRegistryEpoch !== undefined && entry.provenance.sourceRegistryEpoch !== snapshot.sourceRegistryEpoch) {
      throw new Error('Registry entry source epoch must match its snapshot source epoch');
    }
    if (snapshot.serverIdentity !== undefined && entry.provenance.serverIdentity !== snapshot.serverIdentity) {
      throw new Error('Registry entry server identity must match its snapshot');
    }
    if (snapshot.minecraftEndpoint !== undefined && entry.provenance.minecraftEndpoint !== snapshot.minecraftEndpoint) {
      throw new Error('Registry entry endpoint must match its snapshot');
    }
    if (snapshot.bridgeSessionId !== undefined && entry.provenance.bridgeSessionId !== snapshot.bridgeSessionId) {
      throw new Error('Registry entry bridge session must match its snapshot');
    }
    if (snapshot.mineflayerSessionId !== undefined && entry.provenance.mineflayerSessionId !== snapshot.mineflayerSessionId) {
      throw new Error('Registry entry Mineflayer session must match its snapshot');
    }
    if (snapshot.mineflayerRegistryEpoch !== undefined && entry.provenance.mineflayerRegistryEpoch !== snapshot.mineflayerRegistryEpoch) {
      throw new Error('Registry entry Mineflayer registry epoch must match its snapshot');
    }
    if (entry.provenance.authority === 'authenticated-runtime' &&
        (!entry.provenance.bridgeSessionId || !entry.provenance.serverIdentity || !entry.provenance.minecraftEndpoint ||
         !entry.provenance.sourceRegistryEpoch || !entry.provenance.runtimeEpoch)) {
      throw new Error('Authenticated runtime provenance is incomplete');
    }
    if (entry.provenance.authority === 'static-baseline' && snapshot.source !== 'minecraft-data') {
      throw new Error('Static baseline authority must come from minecraft-data');
    }
    if (entry.provenance.authority === 'protocol-observed' && snapshot.source !== 'protocol') {
      throw new Error('Protocol observation authority must come from the protocol source');
    }
    if (entry.provenance.authority === 'authenticated-runtime' && snapshot.source !== 'neoforge-bridge') {
      throw new Error('Authenticated runtime authority must come from a NeoForge bridge');
    }
    if (snapshot.source === 'neoforge-bridge' && snapshot.bridgeSessionId !== undefined &&
        entry.provenance.bridgeSessionId !== snapshot.bridgeSessionId) {
      throw new Error('Bridge entry provenance session must match its snapshot session');
    }
    if (snapshot.runtimeEpoch !== undefined && entry.provenance.runtimeEpoch !== snapshot.runtimeEpoch) {
      throw new Error('Registry entry provenance runtime epoch must match its snapshot');
    }
    if (entry.registryEpoch !== undefined && entry.provenance.registryEpoch !== entry.registryEpoch) {
      throw new Error('Registry entry and provenance epochs must match');
    }
    if (snapshot.registryEpoch !== undefined && entry.registryEpoch !== snapshot.registryEpoch) {
      throw new Error('Registry entry epoch must match its snapshot epoch');
    }
    if (!RESOURCE_LOCATION.test(entry.namespacedId)) throw new Error(`Invalid namespaced registry ID: ${entry.namespacedId}`);
    if (entry.numericId !== undefined && (!Number.isSafeInteger(entry.numericId) || entry.numericId < 0)) {
      throw new Error('Registry numeric IDs must be non-negative safe integers');
    }
  }
}

function hasEpoch(snapshot: RegistrySourceSnapshot, epoch: string): boolean {
  if (snapshot.registryEpoch !== undefined) return snapshot.registryEpoch === epoch;
  const epochs = new Set(snapshot.entries.map((entry) => entry.registryEpoch).filter((value): value is string => value !== undefined));
  return epochs.size === 1 && epochs.has(epoch);
}

function cloneSnapshot(snapshot: RegistrySourceSnapshot): RegistrySourceSnapshot {
  return {
    ...snapshot,
    availableRegistries: [...snapshot.availableRegistries],
    registryCoverage: snapshot.registryCoverage ? { ...snapshot.registryCoverage } : undefined,
    entries: snapshot.entries.map(cloneEntry),
  };
}

function cloneEntry(entry: RegistryEntry): RegistryEntry {
  return {
    ...entry,
    provenance: { ...entry.provenance },
    ...(entry.blockStateProperties === undefined ? {} : { blockStateProperties: { ...entry.blockStateProperties } }),
  };
}

function coverage(snapshot: RegistrySourceSnapshot, kind: RegistryKind): 'complete' | 'partial' {
  return snapshot.registryCoverage?.[kind] ?? 'partial';
}

function isRuntimeSnapshot(snapshot: RegistrySourceSnapshot): boolean {
  return snapshot.source !== 'minecraft-data';
}

function canProveAbsence(snapshot: RegistrySourceSnapshot, lookup: RegistryLookup): boolean {
  if (coverage(snapshot, lookup.kind) !== 'complete') return false;
  if (isRuntimeSnapshot(snapshot)) return true;
  // minecraft-data is a complete vanilla baseline, not a complete modded server registry.
  return lookup.namespacedId?.startsWith('minecraft:') === true;
}

/** Static minecraft-data adapter for the exact requested version. */
export function createMinecraftDataSnapshot(minecraftVersion: string): RegistrySourceSnapshot | undefined {
  const data = minecraftData(minecraftVersion);
  if (!data) return undefined;
  const provenance: RegistryProvenance = {
    source: 'minecraft-data',
    authority: 'static-baseline',
    minecraftVersion,
    registryEpoch: `minecraft-data:${minecraftVersion}`,
  };
  const entries: RegistryEntry[] = [];
  for (const item of data.itemsArray) {
    entries.push({ kind: 'item', minecraftVersion, namespacedId: `minecraft:${item.name}`, numericId: item.id, numericIdScope: 'minecraft-data-version', registryEpoch: provenance.registryEpoch, provenance });
  }
  for (const block of data.blocksArray) {
    entries.push({ kind: 'block', minecraftVersion, namespacedId: `minecraft:${block.name}`, numericId: block.id, numericIdScope: 'minecraft-data-version', registryEpoch: provenance.registryEpoch, provenance });
    // minecraft-data explicitly defines these state-ID bounds for its static registry.
    for (let stateId = block.minStateId; stateId <= block.maxStateId; stateId += 1) {
      entries.push({ kind: 'blockState', minecraftVersion, namespacedId: `minecraft:${block.name}`, numericId: stateId, numericIdScope: 'minecraft-data-version', registryEpoch: provenance.registryEpoch, provenance });
    }
  }
  for (const entity of data.entitiesArray) {
    entries.push({ kind: 'entity', minecraftVersion, namespacedId: `minecraft:${entity.name}`, numericId: entity.id, numericIdScope: 'minecraft-data-version', registryEpoch: provenance.registryEpoch, provenance });
  }
  return {
    source: 'minecraft-data',
    authority: 'static-baseline',
    minecraftVersion,
    registryEpoch: provenance.registryEpoch,
    availableRegistries: ['item', 'block', 'blockState', 'entity'],
    registryCoverage: { item: 'complete', block: 'complete', blockState: 'complete', entity: 'complete' },
    entries,
  };
}

export class MinecraftRegistryService {
  private readonly snapshots: RegistrySourceSnapshot[];
  private activeRegistryEpoch: string | null = null;
  private activeRuntimeEpoch: string | null = null;
  private runtimeContextInvalidated = false;

  constructor(snapshots: RegistrySourceSnapshot[] = []) {
    snapshots.forEach(validateSnapshot);
    this.snapshots = snapshots.map(cloneSnapshot);
  }

  static withMinecraftData(versions: string[]): MinecraftRegistryService {
    return new MinecraftRegistryService(versions.flatMap((version) => {
      const snapshot = createMinecraftDataSnapshot(version);
      return snapshot ? [snapshot] : [];
    }));
  }

  /** Binds this resolver to one live runtime context. Runtime epochs are never inferred from Java source epochs. */
  bindRuntimeContext(registryEpoch: string, runtimeEpoch: string): void {
    this.activeRegistryEpoch = registryEpoch;
    this.activeRuntimeEpoch = runtimeEpoch;
    this.runtimeContextInvalidated = false;
    for (let index = this.snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = this.snapshots[index]!;
      if (snapshot.source !== 'minecraft-data' && snapshot.registryEpoch !== registryEpoch) this.snapshots.splice(index, 1);
    }
  }

  /** Revokes runtime associations while retaining version-static minecraft-data as static reference data. */
  invalidateRuntimeContext(): void {
    this.runtimeContextInvalidated = true;
    for (let index = this.snapshots.length - 1; index >= 0; index -= 1) {
      if (this.snapshots[index]!.source !== 'minecraft-data') this.snapshots.splice(index, 1);
    }
  }

  addSnapshot(snapshot: RegistrySourceSnapshot): void {
    validateSnapshot(snapshot);
    this.validateActiveSnapshot(snapshot);
    this.snapshots.push(cloneSnapshot(snapshot));
  }

  replaceSnapshot(snapshot: RegistrySourceSnapshot): void {
    validateSnapshot(snapshot);
    this.validateActiveSnapshot(snapshot);
    const identity = (candidate: RegistrySourceSnapshot) => `${candidate.source}\0${candidate.minecraftVersion}\0${candidate.registryEpoch ?? ''}`;
    const replacement = identity(snapshot);
    for (let index = this.snapshots.length - 1; index >= 0; index -= 1) {
      if (identity(this.snapshots[index]!) === replacement) this.snapshots.splice(index, 1);
    }
    this.snapshots.push(cloneSnapshot(snapshot));
  }

  removeSnapshots(source: RegistrySourceName, minecraftVersion: string, registryEpoch: string): number {
    const before = this.snapshots.length;
    for (let index = this.snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = this.snapshots[index]!;
      if (snapshot.source === source && snapshot.minecraftVersion === minecraftVersion && snapshot.registryEpoch === registryEpoch) this.snapshots.splice(index, 1);
    }
    return before - this.snapshots.length;
  }

  getSnapshots(): RegistrySourceSnapshot[] {
    return this.currentSnapshots().map(cloneSnapshot);
  }

  getEntries(options: {
    kind?: RegistryKind;
    source?: RegistrySourceName;
    minecraftVersion?: string;
    namespacedId?: string;
    registryEpoch?: string;
    offset?: number;
    limit?: number | null;
  } = {}): RegistryEntry[] {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit === null ? null : Math.min(500, Math.max(1, options.limit ?? 100));
    return this.currentSnapshots()
      .flatMap((snapshot) => snapshot.entries.filter((entry) =>
      (options.registryEpoch === undefined || entry.provenance.source === 'minecraft-data' || entry.registryEpoch === options.registryEpoch),
    ))
      .filter((entry) => (options.kind === undefined || entry.kind === options.kind) &&
        (options.source === undefined || entry.provenance.source === options.source) &&
        (options.minecraftVersion === undefined || entry.minecraftVersion === options.minecraftVersion) &&
        (options.namespacedId === undefined || entry.namespacedId === options.namespacedId))
      .slice(offset, limit === null ? undefined : offset + limit)
      .map(cloneEntry);
  }

  resolve(lookup: RegistryLookup): RegistryResolution {
    const base: ResolutionBase = { kind: lookup.kind, minecraftVersion: lookup.minecraftVersion, registryEpoch: lookup.registryEpoch,
      runtimeEpoch: this.activeRuntimeEpoch ?? undefined, lookup: { ...lookup } };
    if ((!lookup.namespacedId && lookup.numericId === undefined) || (lookup.namespacedId !== undefined && !RESOURCE_LOCATION.test(lookup.namespacedId))) {
      return { ...base, status: 'unresolved', reason: 'mapping-not-observed' };
    }

    const staticEpoch = lookup.registryEpoch === `minecraft-data:${lookup.minecraftVersion}`;
    if (!staticEpoch && lookup.registryEpoch !== undefined &&
        (this.runtimeContextInvalidated || (this.activeRegistryEpoch !== null && lookup.registryEpoch !== this.activeRegistryEpoch))) {
      return { ...base, status: 'unavailable', reason: 'stale-context', availableSources: [] };
    }

    const versionSnapshots = this.currentSnapshots().filter((snapshot) => snapshot.minecraftVersion === lookup.minecraftVersion);
    const registrySnapshots = versionSnapshots.filter((snapshot) => snapshot.availableRegistries.includes(lookup.kind));
    if (lookup.registryEpoch !== undefined) {
      const runtimeEpochLoaded = registrySnapshots.some((snapshot) => isRuntimeSnapshot(snapshot) && hasEpoch(snapshot, lookup.registryEpoch as string));
      const staticEpochRequested = registrySnapshots.some((snapshot) => !isRuntimeSnapshot(snapshot) && hasEpoch(snapshot, lookup.registryEpoch as string));
      const runtimeSnapshotsExist = registrySnapshots.some(isRuntimeSnapshot);
      const staticBaselineAvailable = registrySnapshots.some((snapshot) => !isRuntimeSnapshot(snapshot));
      if (!runtimeEpochLoaded && !staticEpochRequested && (runtimeSnapshotsExist || !staticBaselineAvailable)) {
        return {
          ...base,
          status: 'unavailable',
          reason: 'registry-not-loaded',
          availableSources: [...new Set(registrySnapshots.map((snapshot) => snapshot.source))],
        };
      }
    }
    // Static minecraft-data is a version baseline, not a runtime session. Runtime snapshots
    // remain strictly isolated to the requested epoch.
    const applicable = lookup.registryEpoch === undefined
      ? registrySnapshots
      : registrySnapshots.filter((snapshot) => !isRuntimeSnapshot(snapshot) || hasEpoch(snapshot, lookup.registryEpoch as string));
    if (applicable.length === 0) {
      const knownVersions = new Set(this.snapshots.map((snapshot) => snapshot.minecraftVersion));
      return {
        ...base,
        status: 'unavailable',
        reason: knownVersions.has(lookup.minecraftVersion) ? 'registry-not-loaded' : 'unsupported-version',
        availableSources: [...new Set(registrySnapshots.map((snapshot) => snapshot.source))],
      };
    }

    const runtimeSnapshots = applicable.filter(isRuntimeSnapshot);
    if (lookup.registryEpoch === undefined && runtimeSnapshots.length > 0) {
      return { ...base, status: 'unresolved', reason: 'mapping-not-observed' };
    }

    const runtimeNumericLookup = lookup.numericId !== undefined && lookup.registryEpoch !== undefined &&
      lookup.registryEpoch !== `minecraft-data:${lookup.minecraftVersion}`;
    const scopedEntries = uniqueEntries(applicable.flatMap((snapshot) => snapshot.entries.filter((entry) =>
      entry.kind === lookup.kind && entry.minecraftVersion === lookup.minecraftVersion &&
      (!runtimeNumericLookup || isRuntimeSnapshot(snapshot)) &&
      (lookup.registryEpoch === undefined || !isRuntimeSnapshot(snapshot) || entry.registryEpoch === lookup.registryEpoch),
    )));
    const matches = (entry: RegistryEntry): boolean =>
      (lookup.namespacedId === undefined || entry.namespacedId === lookup.namespacedId) &&
      (lookup.numericId === undefined || entry.numericId === lookup.numericId);
    const candidates = scopedEntries.filter(matches);

    const relatedEntries = scopedEntries.filter((entry) =>
      (lookup.namespacedId !== undefined && entry.namespacedId === lookup.namespacedId) ||
      (lookup.numericId !== undefined && entry.numericId === lookup.numericId),
    );

    if (candidates.length === 0) {
      const highestAvailablePriority = Math.max(...applicable.map((snapshot) => sourcePriority(snapshot.source)));
      const highestPrioritySnapshots = applicable.filter((snapshot) => sourcePriority(snapshot.source) === highestAvailablePriority);
      const highestPriorityIsComplete = highestPrioritySnapshots.every((snapshot) => canProveAbsence(snapshot, lookup));
      const absenceProven = highestPriorityIsComplete;
      return { ...base, status: 'unresolved', reason: relatedEntries.length > 0 || !absenceProven ? 'mapping-not-observed' : 'identifier-not-found' };
    }

    const highestCandidatePriority = Math.max(...candidates.map((entry) => sourcePriority(entry.provenance.source)));
    const winningCandidates = candidates.filter((entry) => sourcePriority(entry.provenance.source) === highestCandidatePriority);
    const completeAbsenceBlocks = applicable.some((snapshot) =>
      coverage(snapshot, lookup.kind) === 'complete' && sourcePriority(snapshot.source) > highestCandidatePriority &&
      !scopedEntries.some((entry) => entry.provenance.source === snapshot.source && (
        (lookup.namespacedId !== undefined && entry.namespacedId === lookup.namespacedId) ||
        (lookup.numericId !== undefined && entry.numericId === lookup.numericId)
      )),
    );
    const completeConflictingAssociationBlocks = applicable.some((snapshot) =>
      coverage(snapshot, lookup.kind) === 'complete' && sourcePriority(snapshot.source) > highestCandidatePriority &&
      scopedEntries.some((entry) => entry.provenance.source === snapshot.source && (
        (lookup.namespacedId !== undefined && entry.namespacedId === lookup.namespacedId) ||
        (lookup.numericId !== undefined && entry.numericId === lookup.numericId)
      )),
    );
    const blockedByKnownPartialAssociation = applicable.some((snapshot) =>
      coverage(snapshot, lookup.kind) === 'partial' && sourcePriority(snapshot.source) > highestCandidatePriority &&
      scopedEntries.some((entry) => entry.provenance.source === snapshot.source && (
        (lookup.namespacedId !== undefined && entry.namespacedId === lookup.namespacedId) ||
        (lookup.numericId !== undefined && entry.numericId === lookup.numericId) ||
        (lookup.namespacedId !== undefined && lookup.numericId === undefined && entry.numericId !== undefined &&
          winningCandidates.some((candidate) => candidate.numericId === entry.numericId && candidate.namespacedId !== entry.namespacedId))
      )),
    );
    if (completeAbsenceBlocks || completeConflictingAssociationBlocks || blockedByKnownPartialAssociation) {
      return { ...base, status: 'unresolved', reason: completeAbsenceBlocks ? 'identifier-not-found' : 'mapping-not-observed' };
    }
    const distinctMappings = new Set(winningCandidates.map((entry) => `${entry.namespacedId}\0${entry.numericId ?? ''}\0${entry.registryEpoch ?? ''}`));
    if (distinctMappings.size !== 1) return { ...base, status: 'ambiguous', candidates: winningCandidates };
    const entry = winningCandidates[0];
    if (!entry) return { ...base, status: 'unresolved', reason: 'identifier-not-found' };
    return { ...base, status: 'resolved', entry, provenance: entry.provenance };
  }

  private currentSnapshots(): RegistrySourceSnapshot[] {
    return this.snapshots.filter(snapshot =>
      (!this.runtimeContextInvalidated || snapshot.source === 'minecraft-data') &&
      (this.activeRegistryEpoch === null || snapshot.source === 'minecraft-data' || snapshot.registryEpoch === this.activeRegistryEpoch));
  }

  private validateActiveSnapshot(snapshot: RegistrySourceSnapshot): void {
    if (this.runtimeContextInvalidated && snapshot.source !== 'minecraft-data') throw new Error('Runtime registry context is revoked');
    if (this.activeRegistryEpoch !== null && snapshot.source !== 'minecraft-data' && snapshot.registryEpoch !== this.activeRegistryEpoch) {
      throw new Error('Snapshot registry epoch is stale for the active runtime context');
    }
    if (this.activeRuntimeEpoch !== null && snapshot.runtimeEpoch !== undefined && snapshot.runtimeEpoch !== this.activeRuntimeEpoch) {
      throw new Error('Snapshot runtime epoch is stale for the active runtime context');
    }
  }
}
