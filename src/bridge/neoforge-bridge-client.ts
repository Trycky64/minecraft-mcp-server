import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type {
  BridgeCapabilities, BridgeHandshakeRequest, BridgeHandshakeResponse, BridgeMachineInspection,
  BridgeMachineInspectionRequest, BridgeRecipePage, BridgeRegistryPage,
  BridgeMachineSearchPage, BridgeMachineSearchRequest,
} from './bridge-types.js';
import { BRIDGE_PROTOCOL_VERSION } from './bridge-types.js';
import type { RegistryEntry, RegistryKind, RegistrySourceSnapshot } from '../services/minecraft-registry-service.js';
import { RuntimeRegistryService } from '../services/runtime-registry-service.js';

const registryKinds: RegistryKind[] = ['item', 'block', 'blockState', 'blockEntityType', 'menu', 'entity', 'recipeSerializer', 'recipeType'];
const MAX_BRIDGE_REGISTRY_ENTRIES = 100_000;
const responseBase = z.object({ schemaVersion: z.literal(BRIDGE_PROTOCOL_VERSION), minecraftVersion: z.string(), neoForgeVersion: z.string(), serverIdentity: z.string(), minecraftEndpoint: z.string(), registryEpoch: z.string().uuid(), observedAt: z.string().datetime({ offset: true }) });
const handshakeSchema = responseBase.extend({ sessionId: z.string().uuid() });
const rowSchema = z.object({ namespacedId: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/), numericId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), numericIdScope: z.enum(['server-registry-generation', 'server-block-state-generation']).optional(), kind: z.string(), blockStateProperties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() });
const pageInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const registryPageSchema = responseBase.extend({ kind: z.string(), completeness: z.enum(['complete', 'partial']), offset: pageInteger, limit: z.number().int().positive().max(1000), total: pageInteger, entries: z.array(rowSchema) });
const recipePageSchema = responseBase.extend({ completeness: z.enum(['complete', 'partial']), offset: pageInteger, limit: z.number().int().positive().max(200), total: pageInteger, recipes: z.array(z.record(z.string(), z.unknown())) });
const energyNetworkSchema = z.object({ available: z.boolean(), cables: z.array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })), energyEndpoints: z.array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), face: z.string(), block: z.string(), stored: z.number().int().nonnegative(), capacity: z.number().int().nonnegative(), canReceive: z.boolean(), canExtract: z.boolean() })), transferMeasurement: z.enum(['observed_this_tick', 'not_measured_this_tick']), transferredThisTick: z.number().int().nonnegative(), transferLimitPerTick: z.number().int().nonnegative() });
const machineSchema = responseBase.extend({ dimension: z.string(), x: z.number().int(), y: z.number().int(), z: z.number().int(), block: z.string(), blockStateId: z.number().int().nonnegative(), blockStateProperties: z.record(z.string(), z.string()), blockEntityType: z.string().nullish().transform(value => value ?? null), blockEntityClass: z.string().nullish().transform(value => value ?? null), blockEntityPresent: z.boolean(), inventory: z.unknown().optional(), itemCapabilities: z.array(z.unknown()).optional(), energyCapabilities: z.array(z.unknown()).optional(), fluidCapabilities: z.array(z.unknown()).optional(), blockStateIdScope: z.string().optional(), energyNetwork: energyNetworkSchema.optional(), processiaMachine: z.record(z.string(), z.unknown()).optional() });
const machineSearchSchema = responseBase.extend({ dimension: z.string(), centerX: z.number().int(), centerY: z.number().int(), centerZ: z.number().int(), radius: z.number().int().min(1).max(16), coverage: z.enum(['complete', 'partial']), unloadedChunkCount: z.number().int().nonnegative(), total: pageInteger, offset: pageInteger, limit: z.number().int().positive().max(100), machines: z.array(z.record(z.string(), z.unknown())) });
const registryKindsSchema = responseBase.extend({ completeness: z.literal('complete'), registries: z.array(z.string().min(1).max(256)).max(10_000) });
const capabilitiesSchema = responseBase.extend({ status: z.literal('available'), registries: z.boolean(), blockStateProperties: z.boolean(), genericBlockEntityType: z.boolean(), itemHandler: z.boolean(), energyStorage: z.boolean(), fluidHandler: z.boolean(), loadedChunkOnly: z.boolean(), readOnly: z.boolean(), processiaAdapter: z.boolean() });

class BridgeHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`bridge-${code}`); }
  get invalidatesSession(): boolean { return this.status === 401 || this.status === 403 || this.status === 409; }
}

export interface BridgeClientConfig {
  enabled: boolean;
  mode?: 'processia' | 'generic';
  headerPrefix?: 'X-Processia' | 'X-Minecraft-MCP';
  url: string | null;
  secret: string | null;
  expectedServerIdentity: string | null;
  expectedMinecraftEndpoint: string | null;
  expectedNeoForgeVersion: string | null;
  timeoutMs: number;
  configurationError: string | null;
}

export function readBridgeClientConfig(env: Record<string, string | undefined> = process.env): BridgeClientConfig {
  const generic = env.MINECRAFT_MCP_BRIDGE_ENABLED === 'true';
  const mode = generic ? 'generic' : 'processia';
  const headerPrefix = generic ? 'X-Minecraft-MCP' : 'X-Processia';
  const enabled = generic || env.PROCESSIA_BRIDGE_ENABLED === 'true';
  if (!enabled) return { enabled: false, mode, headerPrefix, url: null, secret: null, expectedServerIdentity: null, expectedMinecraftEndpoint: null, expectedNeoForgeVersion: null, timeoutMs: 3000, configurationError: null };
  const urlValue = (generic ? env.MINECRAFT_MCP_BRIDGE_URL : env.PROCESSIA_BRIDGE_URL) ?? (generic ? 'http://127.0.0.1:25577' : 'http://127.0.0.1:25576');
  let url: URL | null = null;
  try { url = new URL(urlValue); } catch { /* Report below without echoing credentials or URL. */ }
  const loopback = url !== null && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') && !url.username && !url.password;
  let credential: { secret?: string; serverIdentity?: string; minecraftEndpoint?: string; neoForgeVersion?: string } = {};
  let credentialError: string | null = null;
  if (generic) {
    const credentialFile = env.MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE ?? '';
    if (credentialFile) {
      try {
        const stat = lstatSync(credentialFile);
        if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) throw new Error('credential-file-permissions-invalid');
        const parsed: unknown = JSON.parse(readFileSync(credentialFile, 'utf8'));
        const schema = z.object({ format: z.literal('minecraft-mcp-bridge-credential-v1'), secret: z.string().min(32).max(512), serverIdentity: z.string().min(1), minecraftEndpoint: z.string().min(1), neoForgeVersion: z.string().min(1) }).safeParse(parsed);
        if (!schema.success) throw new Error('credential-file-invalid');
        credential = schema.data;
      } catch (error) { credentialError = error instanceof Error && error.message === 'credential-file-permissions-invalid' ? error.message : 'credential-file-unavailable-or-invalid'; }
    } else if (!env.MINECRAFT_MCP_BRIDGE_SECRET) credentialError = 'bridge-credential-file-required';
  }
  const secret = generic ? (env.MINECRAFT_MCP_BRIDGE_SECRET ?? credential.secret ?? '') : (env.PROCESSIA_BRIDGE_SECRET ?? '');
  const expectedServerIdentity = (generic ? env.MINECRAFT_MCP_BRIDGE_SERVER_IDENTITY : env.PROCESSIA_BRIDGE_SERVER_IDENTITY) ?? credential.serverIdentity ?? '';
  const expectedMinecraftEndpoint = (generic ? env.MINECRAFT_MCP_SERVER_ENDPOINT : env.PROCESSIA_MINECRAFT_ENDPOINT) ?? credential.minecraftEndpoint ?? '';
  const expectedNeoForgeVersion = (generic ? env.MINECRAFT_MCP_BRIDGE_NEOFORGE_VERSION : env.PROCESSIA_BRIDGE_NEOFORGE_VERSION) ?? credential.neoForgeVersion ?? '';
  const timeoutMs = Number((generic ? env.MINECRAFT_MCP_BRIDGE_TIMEOUT_MS : env.PROCESSIA_BRIDGE_TIMEOUT_MS) ?? 3000);
  const configurationError = !loopback ? 'bridge-url-must-be-loopback-http'
    : credentialError
      ? credentialError
    : secret.length < 32 ? 'bridge-secret-must-have-at-least-32-characters'
      : !expectedServerIdentity || !expectedMinecraftEndpoint || !expectedNeoForgeVersion ? 'expected-identity-endpoint-and-neoforge-version-required'
        : !/^[A-Za-z0-9._-]{1,128}$/.test(expectedServerIdentity) ? 'bridge-server-identity-invalid'
        : !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000 ? 'bridge-timeout-out-of-range'
          : null;
  return { enabled, mode, headerPrefix, url: loopback ? url!.toString().replace(/\/$/, '') : null, secret: secret || null,
    expectedServerIdentity: expectedServerIdentity || null, expectedMinecraftEndpoint: expectedMinecraftEndpoint || null,
    expectedNeoForgeVersion: expectedNeoForgeVersion || null, timeoutMs, configurationError };
}

export class NeoForgeBridgeClient {
  private session: BridgeHandshakeResponse | null = null;
  private handshakeSequence = 0;
  constructor(readonly config: BridgeClientConfig) {}

  clearSession(): void { this.handshakeSequence += 1; this.session = null; }

  async closeSession(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try { await this.fetchJson('/v1/close', { method: 'POST' }); }
    finally { this.clearSession(); }
  }

  async handshake(minecraftVersion: string, expectedEndpoint: string): Promise<BridgeHandshakeResponse> {
    if (!this.config.enabled) throw new Error('bridge-disabled');
    if (this.config.configurationError || !this.config.url || !this.config.secret || !this.config.expectedServerIdentity || !this.config.expectedMinecraftEndpoint || !this.config.expectedNeoForgeVersion) throw new Error(this.config.configurationError ?? 'bridge-configuration-invalid');
    if (!sameEndpoint(expectedEndpoint, this.config.expectedMinecraftEndpoint)) throw new Error('minecraft-endpoint-does-not-match-bridge-configuration');
    const request: BridgeHandshakeRequest = { protocolVersion: BRIDGE_PROTOCOL_VERSION, expectedServerIdentity: this.config.expectedServerIdentity, expectedMinecraftEndpoint: this.config.expectedMinecraftEndpoint };
    const sequence = ++this.handshakeSequence;
    const raw = await this.fetchJson('/v1/handshake', { method: 'POST', body: JSON.stringify(request), authenticated: false });
    const session = handshakeSchema.parse(raw);
    if (session.minecraftVersion !== minecraftVersion) throw new Error('bridge-minecraft-version-mismatch');
    if (session.neoForgeVersion !== this.config.expectedNeoForgeVersion) throw new Error('bridge-neoforge-version-mismatch');
    if (session.serverIdentity !== this.config.expectedServerIdentity) throw new Error('bridge-server-identity-mismatch');
    if (!sameEndpoint(session.minecraftEndpoint, expectedEndpoint)) throw new Error('bridge-minecraft-endpoint-mismatch');
    if (sequence === this.handshakeSequence) this.session = session;
    return session;
  }

  getSession(): BridgeHandshakeResponse | null { return this.session ? { ...this.session } : null; }

  async registryPage(kind: RegistryKind, offset: number, limit: number): Promise<BridgeRegistryPage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('bridge-invalid-pagination-request');
    const page = registryPageSchema.parse(await this.fetchJson(`/v1/registries?kind=${encodeURIComponent(kind)}&offset=${offset}&limit=${limit}`));
    this.validateSessionMetadata(page);
    if (page.kind !== kind || page.offset !== offset || page.limit !== limit || page.entries.length > limit || page.entries.some(entry => entry.kind !== kind)) throw new Error('bridge-registry-page-shape-mismatch');
    return page;
  }

  async registryKinds(): Promise<string[]> {
    if ((this.config.mode ?? 'processia') !== 'generic') throw new Error('dynamic-registry-index-requires-generic-bridge');
    const result = registryKindsSchema.parse(await this.fetchJson('/v1/registry-kinds'));
    this.validateSessionMetadata(result);
    const kinds = [...result.registries];
    if (new Set(kinds).size !== kinds.length) throw new Error('bridge-registry-index-contains-duplicates');
    if (kinds.some((kind) => !/^(?:[a-zA-Z][A-Za-z0-9]*|registry:[a-z0-9_.-]+:[a-z0-9/._-]+)$/.test(kind))) throw new Error('bridge-registry-index-kind-invalid');
    return kinds.sort();
  }

  async capabilities(): Promise<BridgeCapabilities> {
    if ((this.config.mode ?? 'processia') !== 'generic') throw new Error('generic-capabilities-require-generic-bridge');
    const result = capabilitiesSchema.parse(await this.fetchJson('/v1/capabilities'));
    this.validateSessionMetadata(result);
    if (!result.readOnly || !result.loadedChunkOnly) throw new Error('bridge-capability-security-contract-mismatch');
    return result;
  }

  async inspectMachine(request: BridgeMachineInspectionRequest): Promise<BridgeMachineInspection> {
    const path = (this.config.mode ?? 'processia') === 'generic' ? '/v1/inspect-block' : '/v1/inspect-machine';
    const result = machineSchema.parse(await this.fetchJson(path, { method: 'POST', body: JSON.stringify(request) }));
    this.validateSessionMetadata(result);
    return result;
  }

  async inspectBlock(request: BridgeMachineInspectionRequest): Promise<BridgeMachineInspection> {
    return this.inspectMachine(request);
  }

  async listMachines(request: BridgeMachineSearchRequest): Promise<BridgeMachineSearchPage> {
    if (!Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100 ||
        !Number.isSafeInteger(request.radius) || request.radius < 1 || request.radius > 16) throw new Error('bridge-invalid-machine-search-request');
    const query = new URLSearchParams({ dimension: request.dimension, x: String(request.x), y: String(request.y), z: String(request.z),
      radius: String(request.radius), offset: String(request.offset), limit: String(request.limit) });
    const result = machineSearchSchema.parse(await this.fetchJson(`/v1/list-machines?${query}`));
    this.validateSessionMetadata(result);
    if (result.dimension !== request.dimension || result.centerX !== request.x || result.centerY !== request.y || result.centerZ !== request.z ||
        result.radius !== request.radius || result.offset !== request.offset || result.limit !== request.limit || result.machines.length > request.limit || request.offset + result.machines.length > result.total) {
      throw new Error('bridge-machine-search-page-shape-mismatch');
    }
    return result;
  }

  async inspectRecipes(offset = 0, limit = 100, kind?: string): Promise<BridgeRecipePage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('bridge-invalid-pagination-request');
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit), ...(kind ? { kind } : {}) });
    const result = recipePageSchema.parse(await this.fetchJson(`/v1/recipes?${query}`));
    this.validateSessionMetadata(result);
    if (result.offset !== offset || result.limit !== limit || result.recipes.length > limit || offset + result.recipes.length > result.total) throw new Error('bridge-recipe-page-shape-mismatch');
    return result;
  }

  private validateSessionMetadata(value: { schemaVersion: number; minecraftVersion: string; neoForgeVersion: string; serverIdentity: string; minecraftEndpoint: string; registryEpoch: string }): void {
    const session = this.session;
    if (!session) throw new Error('bridge-handshake-required');
    if (value.schemaVersion !== BRIDGE_PROTOCOL_VERSION || value.minecraftVersion !== session.minecraftVersion || value.neoForgeVersion !== session.neoForgeVersion || value.serverIdentity !== session.serverIdentity || value.minecraftEndpoint !== session.minecraftEndpoint || value.registryEpoch !== session.registryEpoch) throw new Error('bridge-session-metadata-changed');
  }

  private async fetchJson(path: string, options: { method?: string; body?: string; authenticated?: boolean } = {}): Promise<unknown> {
    if (!this.config.url || !this.config.secret) throw new Error(this.config.configurationError ?? 'bridge-not-configured');
    const authenticated = options.authenticated !== false;
    if (authenticated && !this.session) throw new Error('bridge-handshake-required');
    const requestId = randomUUID();
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${this.config.secret}` };
    const headerPrefix = this.config.headerPrefix ?? 'X-Processia';
    headers[`${headerPrefix}-Request-Id`] = requestId;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated && this.session) headers[`${headerPrefix}-Session`] = this.session.sessionId;
    let response: Response;
    try {
      response = await fetch(`${this.config.url}${path}`, { method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: options.body }), signal: AbortSignal.timeout(this.config.timeoutMs), redirect: 'error' });
    } catch (error) {
      this.clearSession();
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error('bridge-request-timeout');
      throw new Error('bridge-unreachable');
    }
    let text: string;
    try { text = await readBoundedBody(response, 2_100_000); }
    catch (error) {
      if (error instanceof Error && (error.message === 'bridge-response-too-large' || error.message === 'bridge-invalid-json')) throw error;
      this.clearSession();
      if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('bridge-request-timeout');
      throw new Error('bridge-response-read-failed');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { throw new Error('bridge-invalid-json'); }
    const responseRequestId = response.headers.get(`${this.config.headerPrefix ?? 'X-Processia'}-Request-Id`);
    if (responseRequestId !== requestId) {
      this.clearSession();
      throw new Error(`bridge-response-header-request-id-mismatch:${path}:${requestId}:${responseRequestId ?? 'missing'}`);
    }
    if (typeof parsed !== 'object' || parsed === null || !('requestId' in parsed) ||
        (parsed as { requestId?: unknown }).requestId !== requestId) {
      this.clearSession();
      throw new Error(`bridge-response-body-request-id-mismatch:${path}`);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 409) this.session = null;
      const responseError = z.object({ error: z.string().regex(/^[a-z0-9_]+$/) }).safeParse(parsed);
      throw new BridgeHttpError(response.status, responseError.success ? responseError.data.error : `http_${response.status}`);
    }
    return parsed;
  }
}

export class NeoForgeBridgeIntegration {
  readonly client: NeoForgeBridgeClient;
  private linkedEpoch: string | null = null;
  private lastError: string | null = null;
  constructor(private readonly runtime: RuntimeRegistryService, config = readBridgeClientConfig()) { this.client = new NeoForgeBridgeClient(config); }

  status(): Record<string, unknown> {
    const context = this.runtime.getContext();
    const session = context.bridgeSession;
    return { enabled: this.client.config.enabled, configured: this.client.config.enabled && this.client.config.configurationError === null,
      configurationError: this.client.config.configurationError, connected: !!session, authenticated: !!session?.authenticated,
      bridgeAvailable: context.bridgeAvailable, protocolVersion: BRIDGE_PROTOCOL_VERSION, serverIdentity: session?.serverIdentity ?? null,
      sourceRegistryEpoch: session?.sourceRegistryEpoch ?? null, botRegistryEpoch: context.registryEpoch,
      minecraftVersion: session?.minecraftVersion ?? null, neoForgeVersion: session?.neoForgeVersion ?? null,
      lastError: this.lastError, secretConfigured: this.client.config.secret !== null };
  }

  async close(): Promise<void> {
    const session = this.client.getSession();
    await this.client.closeSession().catch(() => undefined);
    this.runtime.clearBridgeSession(session?.sessionId);
    this.linkedEpoch = null;
  }

  async refreshRegistries(): Promise<Record<string, unknown>> {
    const context = this.runtime.getContext();
    if (!context.connected || !context.minecraftVersion || !context.registryEpoch || !context.serverIdentity) throw new Error('active-minecraft-session-required');
    const session = await this.ensureSession(context.minecraftVersion, context.serverIdentity, context.registryEpoch);
    this.assertCurrentContext(context, session.sessionId);
    const entries: RegistryEntry[] = [];
    const coverage: Partial<Record<RegistryKind, 'complete' | 'partial'>> = {};
    const registryCounts: Array<{ kind: RegistryKind; completeness: 'complete' | 'partial'; entries: number }> = [];
    const kinds = (this.client.config.mode ?? 'processia') === 'generic' ? await this.guarded(this.client.registryKinds(), session.sessionId) : registryKinds;
    this.assertCurrentContext(context, session.sessionId);
    for (const kind of kinds) {
      let offset = 0; let expectedTotal: number | null = null; let completeness: 'complete' | 'partial' = 'partial';
      let registryEntryCount = 0;
      do {
        const page = await this.guarded(this.client.registryPage(kind, offset, 500), session.sessionId);
        this.assertCurrentContext(context, session.sessionId);
        if (page.total > MAX_BRIDGE_REGISTRY_ENTRIES) this.failClosed(session.sessionId, 'bridge-registry-total-exceeds-safety-limit');
        if (expectedTotal === null) { expectedTotal = page.total; completeness = page.completeness; }
        if (page.total !== expectedTotal || page.completeness !== completeness || page.entries.length === 0 && offset < page.total || offset + page.entries.length > page.total) this.failClosed(session.sessionId, 'bridge-registry-pagination-inconsistent');
        if (entries.length + page.entries.length > MAX_BRIDGE_REGISTRY_ENTRIES) this.failClosed(session.sessionId, 'bridge-registry-snapshot-exceeds-safety-limit');
        for (const row of page.entries) {
          if (row.kind !== kind) throw new Error('bridge-registry-kind-mismatch');
          entries.push({ kind, minecraftVersion: context.minecraftVersion, namespacedId: row.namespacedId,
            ...(row.numericId === undefined ? {} : { numericId: row.numericId }),
            ...(row.numericId === undefined ? {} : { numericIdScope: row.numericIdScope ?? (kind === 'blockState' ? 'server-block-state-generation' : 'server-registry-generation') }),
            ...(row.blockStateProperties === undefined ? {} : { blockStateProperties: row.blockStateProperties }),
            registryEpoch: context.registryEpoch, provenance: { source: 'neoforge-bridge', minecraftVersion: context.minecraftVersion,
            registryEpoch: context.registryEpoch, sourceRegistryEpoch: session.registryEpoch, serverIdentity: session.serverIdentity,
              neoForgeVersion: session.neoForgeVersion, observedAt: page.observedAt, providerVersion: session.neoForgeVersion } });
          registryEntryCount += 1;
        }
        offset = Number(offset) + page.entries.length;
        if (!Number.isSafeInteger(offset)) this.failClosed(session.sessionId, 'bridge-registry-offset-overflow');
      } while (expectedTotal !== null && offset < expectedTotal);
      if (completeness === 'complete' && offset !== expectedTotal) this.failClosed(session.sessionId, 'bridge-complete-registry-page-set-incomplete');
      try { assertUniqueRegistryMappings(kind, entries); }
      catch (error) { this.failClosed(session.sessionId, publicErrorCode(error)); }
      coverage[kind] = completeness;
      registryCounts.push({ kind, completeness, entries: registryEntryCount });
    }
    this.assertCurrentContext(context, session.sessionId);
    const snapshot: RegistrySourceSnapshot = { source: 'neoforge-bridge', minecraftVersion: context.minecraftVersion, registryEpoch: context.registryEpoch,
      sourceRegistryEpoch: session.registryEpoch, serverIdentity: session.serverIdentity, neoForgeVersion: session.neoForgeVersion,
      availableRegistries: kinds, registryCoverage: coverage, entries };
    this.runtime.bindAuthenticatedBridge({ authenticated: true, serverIdentity: session.serverIdentity, minecraftEndpoint: session.minecraftEndpoint,
      minecraftVersion: session.minecraftVersion, neoForgeVersion: session.neoForgeVersion, sourceRegistryEpoch: session.registryEpoch,
      sessionId: session.sessionId, connectedAt: new Date().toISOString() });
    this.runtime.replaceBridgeSnapshot(snapshot, session.sessionId);
    this.linkedEpoch = context.registryEpoch;
    this.lastError = null;
    return { status: 'refreshed', serverIdentity: session.serverIdentity, sourceRegistryEpoch: session.registryEpoch, botRegistryEpoch: context.registryEpoch,
      registries: registryCounts };
  }

  async inspectMachine(request: BridgeMachineInspectionRequest): Promise<BridgeMachineInspection> {
    const session = await this.ensureCurrentSession();
    const context = this.runtime.getContext();
    const result = await this.guarded(this.client.inspectMachine(request), session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    if (result.serverIdentity !== session.serverIdentity || result.registryEpoch !== session.registryEpoch) throw new Error('bridge-machine-response-generation-mismatch');
    if (result.dimension !== request.dimension || result.x !== request.x || result.y !== request.y || result.z !== request.z) throw new Error('bridge-machine-response-location-mismatch');
    this.lastError = null;
    return result;
  }

  async inspectBlock(request: BridgeMachineInspectionRequest): Promise<BridgeMachineInspection> {
    const session = await this.ensureCurrentSession();
    const context = this.runtime.getContext();
    const result = await this.guarded(this.client.inspectBlock(request), session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    if (result.serverIdentity !== session.serverIdentity || result.registryEpoch !== session.registryEpoch) throw new Error('bridge-block-response-generation-mismatch');
    if (result.dimension !== request.dimension || result.x !== request.x || result.y !== request.y || result.z !== request.z) throw new Error('bridge-block-response-location-mismatch');
    this.lastError = null;
    return result;
  }

  async capabilities(): Promise<BridgeCapabilities> {
    const session = await this.ensureCurrentSession();
    const context = this.runtime.getContext();
    const result = await this.guarded(this.client.capabilities(), session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    return result;
  }

  async listMachines(request: BridgeMachineSearchRequest): Promise<BridgeMachineSearchPage> {
    const session = await this.ensureCurrentSession();
    const context = this.runtime.getContext();
    const result = await this.guarded(this.client.listMachines(request), session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    if (result.serverIdentity !== session.serverIdentity || result.registryEpoch !== session.registryEpoch) throw new Error('bridge-machine-search-generation-mismatch');
    return result;
  }

  async inspectRecipes(offset = 0, limit = 100, kind?: string): Promise<BridgeRecipePage> {
    const session = await this.ensureCurrentSession();
    const context = this.runtime.getContext();
    const result = await this.guarded(this.client.inspectRecipes(offset, limit, kind), session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    if (result.serverIdentity !== session.serverIdentity || result.registryEpoch !== session.registryEpoch) throw new Error('bridge-recipe-response-generation-mismatch');
    this.lastError = null;
    return result;
  }

  private async ensureCurrentSession(): Promise<BridgeHandshakeResponse> {
    const context = this.runtime.getContext();
    if (!context.connected || !context.minecraftVersion || !context.registryEpoch || !context.serverIdentity) throw new Error('active-minecraft-session-required');
    return this.ensureSession(context.minecraftVersion, context.serverIdentity, context.registryEpoch);
  }

  private async ensureSession(version: string, endpoint: string, botEpoch: string): Promise<BridgeHandshakeResponse> {
    let session = this.client.getSession();
    if (!session || this.linkedEpoch !== botEpoch) {
      if (session) {
        const oldSessionId = session.sessionId;
        await this.client.closeSession().catch(() => undefined);
        this.runtime.clearBridgeSession(oldSessionId);
      }
      try { session = await this.client.handshake(version, endpoint); }
      catch (error) { this.dropSession(); this.lastError = publicErrorCode(error); throw error; }
      const context = this.runtime.getContext();
      if (!context.connected || context.registryEpoch !== botEpoch || context.minecraftVersion !== version || context.serverIdentity !== endpoint || this.client.getSession()?.sessionId !== session.sessionId) {
        this.dropSession(session.sessionId);
        throw new Error('bridge-handshake-completed-for-stale-bot-session');
      }
      this.runtime.bindAuthenticatedBridge({ authenticated: true, serverIdentity: session.serverIdentity, minecraftEndpoint: session.minecraftEndpoint,
        minecraftVersion: session.minecraftVersion, neoForgeVersion: session.neoForgeVersion, sourceRegistryEpoch: session.registryEpoch,
        sessionId: session.sessionId, connectedAt: new Date().toISOString() });
      this.linkedEpoch = botEpoch;
    }
    return session;
  }

  private async guarded<T>(promise: Promise<T>, sessionId: string): Promise<T> {
    try { return await promise; }
    catch (error) {
      this.lastError = publicErrorCode(error);
      if (!(error instanceof BridgeHttpError) || error.invalidatesSession) this.dropSession(sessionId);
      throw error;
    }
  }

  private dropSession(sessionId?: string): void {
    const linkedSessionId = this.runtime.getContext().bridgeSession?.sessionId;
    this.runtime.clearBridgeSession(sessionId);
    if (sessionId === undefined || this.client.getSession()?.sessionId === sessionId) this.client.clearSession();
    if (sessionId === undefined || linkedSessionId === sessionId) this.linkedEpoch = null;
  }

  private assertCurrentContext(expected: ReturnType<RuntimeRegistryService['getContext']>, sessionId: string): void {
    const current = this.runtime.getContext();
    if (!current.connected || current.registryEpoch !== expected.registryEpoch || current.minecraftVersion !== expected.minecraftVersion || current.serverIdentity !== expected.serverIdentity || current.bridgeSession?.sessionId !== sessionId) {
      this.dropSession(sessionId);
      throw new Error('bridge-operation-invalidated-by-runtime-session-change');
    }
  }

  private failClosed(sessionId: string, code: string): never {
    this.lastError = code;
    this.dropSession(sessionId);
    throw new Error(code);
  }
}

function assertUniqueRegistryMappings(kind: RegistryKind, entries: RegistryEntry[]): void {
  const sourceEntries = entries.filter(entry => entry.kind === kind);
  const namespaced = new Set<string>();
  const numeric = new Set<number>();
  for (const entry of sourceEntries) {
    if (kind !== 'blockState' && namespaced.has(entry.namespacedId)) throw new Error('bridge-registry-duplicate-key');
    namespaced.add(entry.namespacedId);
    if (entry.numericId !== undefined) {
      if (numeric.has(entry.numericId)) throw new Error('bridge-registry-numeric-id-collision');
      numeric.add(entry.numericId);
    }
  }
}

function sameEndpoint(a: string, b: string): boolean {
  const parse = (value: string): string | null => {
    const match = /^(localhost|127\.0\.0\.1|\[::1\]):(\d+)$/.exec(value.trim().toLowerCase());
    return match ? `127.0.0.1:${Number(match[2])}` : null;
  };
  return parse(a) !== null && parse(a) === parse(b);
}

function publicErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'bridge-request-failed';
  return /^[a-z0-9_-]{1,96}$/.test(message) ? message : 'bridge-request-failed';
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await reader.cancel();
    throw new Error('bridge-response-too-large');
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      throw new Error('bridge-response-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('bridge-invalid-json'); }
}
