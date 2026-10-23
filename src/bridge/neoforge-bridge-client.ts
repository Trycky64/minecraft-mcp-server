import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type {
  BridgeCapabilities, BridgeHandshakeRequest, BridgeHandshakeResponse, BridgeMachineInspection,
  BridgeMachineInspectionRequest, BridgeRecipePage, BridgeRegistryPage,
  BridgeMachineSearchPage, BridgeMachineSearchRequest,
} from './bridge-types.js';
import { BRIDGE_PROTOCOL_VERSION } from './bridge-types.js';
import type { RegistryEntry, RegistryKind, RegistrySourceSnapshot } from '../services/minecraft-registry-service.js';
import { RuntimeRegistryService } from '../services/runtime-registry-service.js';
import { GenericNeoForgeBridgeAdapter, ProcessiaBridgeAdapter } from './bridge-adapters.js';
import { BridgeAdapterError, bridgeErrorInvalidatesSession, normalizeBridgeError, type BridgeAdapter, type BridgeErrorCode } from './bridge-adapter-contract.js';
import { logEvent } from '../logger.js';

const registryKinds: RegistryKind[] = ['item', 'block', 'blockState', 'blockEntityType', 'menu', 'entity', 'recipeSerializer', 'recipeType'];
const MAX_BRIDGE_REGISTRY_ENTRIES = 100_000;
const MAX_BRIDGE_CREDENTIAL_BYTES = 16 * 1024;
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
  constructor(readonly status: number, readonly protocolCode: string) { super(`bridge-${protocolCode}`); }
  get diagnosticCode(): BridgeErrorCode {
    if (this.status === 401 || this.status === 403) return 'authentication-refused';
    if (this.status === 409 || this.status === 410) return 'session-expired';
    if (this.status === 408) return 'bridge-http-timeout';
    if (this.status === 429) return 'bridge-rate-limited';
    if (this.status === 400 || this.status === 422) return 'invalid-request';
    if (this.status === 404) return 'resource-not-found';
    if (this.status === 405 || this.status === 501) return 'capability-unsupported';
    if (this.status >= 500) return 'bridge-unavailable';
    return 'bridge-request-failed';
  }
  get invalidatesSession(): boolean { return bridgeErrorInvalidatesSession(this.diagnosticCode); }
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
  expectedMinecraftVersion: string | null;
  timeoutMs: number;
  configurationError: string | null;
}

export function readBridgeClientConfig(env: Record<string, string | undefined> = process.env): BridgeClientConfig {
  const generic = env.MINECRAFT_MCP_BRIDGE_ENABLED === 'true';
  const mode = generic ? 'generic' : 'processia';
  const headerPrefix = generic ? 'X-Minecraft-MCP' : 'X-Processia';
  const enabled = generic || env.PROCESSIA_BRIDGE_ENABLED === 'true';
  if (!enabled) return { enabled: false, mode, headerPrefix, url: null, secret: null, expectedServerIdentity: null, expectedMinecraftEndpoint: null, expectedNeoForgeVersion: null, expectedMinecraftVersion: null, timeoutMs: 3000, configurationError: null };
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
        const parsed: unknown = JSON.parse(readBridgeCredentialFile(credentialFile));
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
  const expectedMinecraftVersion = generic ? (env.MINECRAFT_MCP_BRIDGE_MINECRAFT_VERSION ?? '') : '';
  const timeoutMs = Number((generic ? env.MINECRAFT_MCP_BRIDGE_TIMEOUT_MS : env.PROCESSIA_BRIDGE_TIMEOUT_MS) ?? 3000);
  const configurationError = !loopback ? 'bridge-url-must-be-loopback-http'
    : credentialError
      ? credentialError
    : secret.length < 32 ? 'bridge-secret-must-have-at-least-32-characters'
      : !expectedServerIdentity || !expectedMinecraftEndpoint || !expectedNeoForgeVersion ? 'expected-identity-endpoint-and-neoforge-version-required'
        : generic && env.MINECRAFT_MCP_CONNECTION_MODE === 'bridge-only' && !expectedMinecraftVersion ? 'bridge-minecraft-version-required'
        : !/^[A-Za-z0-9._-]{1,128}$/.test(expectedServerIdentity) ? 'bridge-server-identity-invalid'
        : !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000 ? 'bridge-timeout-out-of-range'
          : null;
  return { enabled, mode, headerPrefix, url: loopback ? url!.toString().replace(/\/$/, '') : null, secret: secret || null,
    expectedServerIdentity: expectedServerIdentity || null, expectedMinecraftEndpoint: expectedMinecraftEndpoint || null,
    expectedNeoForgeVersion: expectedNeoForgeVersion || null, expectedMinecraftVersion: expectedMinecraftVersion || null, timeoutMs, configurationError };
}

function readBridgeCredentialFile(filePath: string): string {
  const pathStat = lstatSync(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error('credential-file-permissions-invalid');

  // O_NOFOLLOW closes the symlink race on POSIX. On Windows, compare the open
  // handle's file identity to the lstat result; the Java producer separately
  // verifies the owner-only ACL before publishing this file.
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(filePath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
      throw new Error('credential-file-permissions-invalid');
    }
    if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600) {
      throw new Error('credential-file-permissions-invalid');
    }
    if (opened.size > MAX_BRIDGE_CREDENTIAL_BYTES) throw new Error('credential-file-too-large');

    const bytes = Buffer.alloc(MAX_BRIDGE_CREDENTIAL_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_BRIDGE_CREDENTIAL_BYTES) throw new Error('credential-file-too-large');
    return bytes.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
}

export class NeoForgeBridgeClient {
  private session: BridgeHandshakeResponse | null = null;
  private handshakeSequence = 0;
  constructor(readonly config: BridgeClientConfig) {}

  clearSession(): void { this.handshakeSequence += 1; this.session = null; }

  async closeSession(): Promise<void> {
    const session = this.session;
    if (!session) { this.clearSession(); return; }
    try { await this.fetchJson('/v1/close', { method: 'POST' }); }
    finally { if (this.session?.sessionId === session.sessionId) this.clearSession(); }
  }

  async handshake(minecraftVersion: string, expectedEndpoint: string): Promise<BridgeHandshakeResponse> {
    if (!this.config.enabled) throw new Error('bridge-disabled');
    if (this.config.configurationError || !this.config.url || !this.config.secret || !this.config.expectedServerIdentity || !this.config.expectedMinecraftEndpoint || !this.config.expectedNeoForgeVersion) throw new Error(this.config.configurationError ?? 'bridge-configuration-invalid');
    if (!sameEndpoint(expectedEndpoint, this.config.expectedMinecraftEndpoint)) throw new Error('minecraft-endpoint-does-not-match-bridge-configuration');
    const request: BridgeHandshakeRequest = { protocolVersion: BRIDGE_PROTOCOL_VERSION, expectedServerIdentity: this.config.expectedServerIdentity, expectedMinecraftEndpoint: this.config.expectedMinecraftEndpoint };
    const sequence = ++this.handshakeSequence;
    try {
      const raw = await this.fetchJson('/v1/handshake', { method: 'POST', body: JSON.stringify(request), authenticated: false });
      if (sequence !== this.handshakeSequence) throw new Error('bridge-session-expired');
      const session = handshakeSchema.parse(raw);
      if (session.minecraftVersion !== minecraftVersion) throw new Error('bridge-minecraft-version-mismatch');
      if (session.neoForgeVersion !== this.config.expectedNeoForgeVersion) throw new Error('bridge-neoforge-version-mismatch');
      if (session.serverIdentity !== this.config.expectedServerIdentity) throw new Error('bridge-server-identity-mismatch');
      if (!sameEndpoint(session.minecraftEndpoint, expectedEndpoint)) throw new Error('bridge-minecraft-endpoint-mismatch');
      if (sequence !== this.handshakeSequence) throw new Error('bridge-session-expired');
      this.session = session;
      return session;
    } catch (error) {
      if (sequence === this.handshakeSequence) this.clearSession();
      throw error;
    }
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
    if ((this.config.mode ?? 'processia') === 'generic') throw new Error('processia-machine-search-requires-processia-adapter');
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
    if ((this.config.mode ?? 'processia') === 'generic') throw new Error('processia-recipes-require-processia-adapter');
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
    if (value.schemaVersion !== BRIDGE_PROTOCOL_VERSION) throw categorizedBridgeError('invalid-bridge-response', 'bridge-session-metadata-changed');
    if (value.serverIdentity !== session.serverIdentity || value.minecraftEndpoint !== session.minecraftEndpoint ||
        value.minecraftVersion !== session.minecraftVersion || value.neoForgeVersion !== session.neoForgeVersion) {
      throw categorizedBridgeError('server-identity-mismatch', 'bridge-session-metadata-changed');
    }
    if (value.registryEpoch !== session.registryEpoch) throw categorizedBridgeError('stale-registry-epoch', 'bridge-session-metadata-changed');
  }

  private async fetchJson(path: string, options: { method?: string; body?: string; authenticated?: boolean } = {}): Promise<unknown> {
    if (!this.config.url || !this.config.secret) throw new Error(this.config.configurationError ?? 'bridge-not-configured');
    const authenticated = options.authenticated !== false;
    if (authenticated && !this.session) throw new Error('bridge-handshake-required');
    const sequence = this.handshakeSequence;
    const requestSessionId = authenticated ? this.session?.sessionId ?? null : null;
    const requestId = randomUUID();
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${this.config.secret}` };
    const headerPrefix = this.config.headerPrefix ?? 'X-Processia';
    headers[`${headerPrefix}-Request-Id`] = requestId;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated && this.session) headers[`${headerPrefix}-Session`] = this.session.sessionId;
    let response: Response;
    let text: string;
    let requestStage: 'fetch' | 'body' = 'fetch';
    let timedOut = false;
    const controller = new AbortController();
    let pendingResponse: Response | undefined;
    try {
      const result = await withDeadline(async () => {
        const fetched = await fetch(`${this.config.url}${path}`, { method: options.method ?? 'GET', headers,
          ...(options.body === undefined ? {} : { body: options.body }), signal: controller.signal, redirect: 'error' });
        pendingResponse = fetched;
        if (timedOut) { await fetched.body?.cancel().catch(() => undefined); throw new Error('bridge-request-timeout'); }
        requestStage = 'body';
        const body = await readBoundedBody(fetched, 2_100_000, controller.signal);
        return { response: fetched, text: body };
      }, this.config.timeoutMs, () => {
        timedOut = true;
        controller.abort();
        void pendingResponse?.body?.cancel().catch(() => undefined);
      });
      response = result.response;
      text = result.text;
    } catch (error) {
      this.clearRequestSession(sequence, requestSessionId);
      if (error instanceof Error && (error.message === 'bridge-response-too-large' || error.message === 'bridge-invalid-json')) {
        throw error;
      }
      if (timedOut || (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError'))) {
        throw new Error('bridge-request-timeout');
      }
      throw new Error(requestStage === 'fetch' ? 'bridge-unreachable' : 'bridge-response-read-failed');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch {
      this.clearRequestSession(sequence, requestSessionId);
      throw new Error('bridge-invalid-json');
    }
    const responseRequestId = response.headers.get(`${this.config.headerPrefix ?? 'X-Processia'}-Request-Id`);
    if (responseRequestId !== requestId) {
      this.clearRequestSession(sequence, requestSessionId);
      throw new Error(`bridge-response-header-request-id-mismatch:${path}:${requestId}:${responseRequestId ?? 'missing'}`);
    }
    if (typeof parsed !== 'object' || parsed === null || !('requestId' in parsed) ||
        (parsed as { requestId?: unknown }).requestId !== requestId) {
      this.clearRequestSession(sequence, requestSessionId);
      throw new Error(`bridge-response-body-request-id-mismatch:${path}`);
    }
    if (sequence !== this.handshakeSequence || (authenticated && (!requestSessionId || this.session?.sessionId !== requestSessionId))) {
      throw new Error('bridge-session-expired');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 409 || response.status >= 500) this.clearRequestSession(sequence, requestSessionId);
      const responseError = z.object({ error: z.string().regex(/^[a-z0-9_]+$/) }).safeParse(parsed);
      throw new BridgeHttpError(response.status, responseError.success ? responseError.data.error : `http_${response.status}`);
    }
    return parsed;
  }

  private clearRequestSession(sequence: number, sessionId: string | null): void {
    if (sequence === this.handshakeSequence && (sessionId === null || this.session?.sessionId === sessionId)) this.clearSession();
  }
}

async function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('bridge-request-timeout'));
    }, timeoutMs);
  });
  try { return await Promise.race([operation(), deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function categorizedBridgeError(category: BridgeErrorCode, message: string): Error {
  return new BridgeAdapterError(category, message);
}

export class NeoForgeBridgeIntegration {
  client: NeoForgeBridgeClient;
  adapter: BridgeAdapter;
  private linkedEpoch: string | null = null;
  private lastError: string | null = null;
  private readonly reloadConfigOnReconnect: boolean;
  private bridgeOnlyMinecraftVersion: string | null = null;
  private handshakeGeneration = 0;
  private registryRefreshGeneration = 0;
  constructor(private readonly runtime: RuntimeRegistryService, config?: BridgeClientConfig) {
    this.reloadConfigOnReconnect = config === undefined;
    const resolvedConfig = config ?? readBridgeClientConfig();
    this.client = new NeoForgeBridgeClient(resolvedConfig);
    this.adapter = this.createAdapter(this.client);
  }

  private createAdapter(client: NeoForgeBridgeClient): BridgeAdapter {
    return (client.config.mode ?? 'processia') === 'generic'
      ? new GenericNeoForgeBridgeAdapter(client)
      : new ProcessiaBridgeAdapter(client);
  }

  status(): Record<string, unknown> {
    const context = this.runtime.getContext();
    const session = context.bridgeSession;
    return { connectionMode: context.connectionMode, enabled: this.client.config.enabled, configured: this.client.config.enabled && this.client.config.configurationError === null,
      configurationError: this.client.config.configurationError, connected: !!session, authenticated: !!session?.authenticated,
      bridgeAvailable: context.bridgeAvailable, protocolVersion: BRIDGE_PROTOCOL_VERSION, serverIdentity: session?.serverIdentity ?? null,
      sourceRegistryEpoch: session?.sourceRegistryEpoch ?? null, botRegistryEpoch: context.connectionMode === 'bridge-only' ? null : context.registryEpoch,
      runtimeRegistryEpoch: context.runtimeEpoch,
      mineflayerSessionId: context.mineflayerSessionId, mineflayerRegistryEpoch: context.mineflayerRegistryEpoch,
      bridgeSessionId: context.bridgeSessionId,
      minecraftVersion: session?.minecraftVersion ?? null, neoForgeVersion: session?.neoForgeVersion ?? null,
      lastError: this.lastError, secretConfigured: this.client.config.secret !== null,
      adapter: this.adapter.kind, adapterState: this.adapter.state, supportedCapabilities: [...this.adapter.capabilities] };
  }

  /** Authenticate directly to the generic bridge and establish a runtime registry context without Mineflayer. */
  async connectBridgeOnly(minecraftVersion: string): Promise<Record<string, unknown>> {
    if ((this.client.config.mode ?? 'processia') !== 'generic') throw new Error('bridge-only-requires-generic-neoforge-bridge');
    if (!this.client.config.enabled || this.client.config.configurationError || !this.client.config.expectedMinecraftEndpoint || !this.client.config.expectedServerIdentity) {
      throw new Error(this.client.config.configurationError ?? 'bridge-not-configured');
    }
    if (!minecraftVersion || (this.client.config.expectedMinecraftVersion && minecraftVersion !== this.client.config.expectedMinecraftVersion)) {
      throw new Error('bridge-minecraft-version-mismatch');
    }
    const session = await this.adapter.handshake(minecraftVersion, this.client.config.expectedMinecraftEndpoint);
    const linked = { authenticated: true as const, serverIdentity: session.serverIdentity, minecraftEndpoint: session.minecraftEndpoint,
      minecraftVersion: session.minecraftVersion, neoForgeVersion: session.neoForgeVersion, sourceRegistryEpoch: session.registryEpoch,
      sessionId: session.sessionId, connectedAt: new Date().toISOString() };
    this.runtime.activateBridgeOnly(linked);
    this.bridgeOnlyMinecraftVersion = minecraftVersion;
    const context = this.runtime.getContext();
    this.linkedEpoch = context.registryEpoch;
    this.lastError = null;
    return { status: 'authenticated', connectionMode: 'bridge-only', playerAvailable: false,
      serverIdentity: session.serverIdentity, minecraftEndpoint: session.minecraftEndpoint,
      minecraftVersion: session.minecraftVersion, neoForgeVersion: session.neoForgeVersion,
      sourceRegistryEpoch: session.registryEpoch, runtimeRegistryEpoch: context.registryEpoch };
  }

  async validateBridgeOnlySession(): Promise<void> {
    const context = this.runtime.getContext();
    if (context.connectionMode !== 'bridge-only' || !context.sessionAvailable) throw new Error('bridge-only-session-unavailable');
    await this.capabilities();
  }

  async reconnectBridgeOnly(): Promise<Record<string, unknown>> {
    const version = this.bridgeOnlyMinecraftVersion ?? this.client.config.expectedMinecraftVersion;
    if (!version) throw new Error('bridge-minecraft-version-required');
    const oldSession = this.adapter.session;
    if (oldSession) await this.adapter.closeSession().catch(() => undefined);
    this.runtime.clearBridgeSession(oldSession?.sessionId);
    this.adapter.clearSession();
    if (this.reloadConfigOnReconnect) {
      const refreshedClient = new NeoForgeBridgeClient(readBridgeClientConfig());
      const refreshedAdapter = this.createAdapter(refreshedClient);
      if (refreshedAdapter.kind !== this.adapter.kind) throw new Error('bridge-adapter-kind-changed-on-reconnect');
      this.client = refreshedClient;
      this.adapter = refreshedAdapter;
    }
    this.linkedEpoch = null;
    return this.connectBridgeOnly(version);
  }

  async close(): Promise<void> {
    this.registryRefreshGeneration += 1;
    const session = this.adapter.session;
    await this.adapter.close().catch((error) => { this.lastError = publicErrorCode(error); });
    this.runtime.clearBridgeSession(session?.sessionId);
    this.linkedEpoch = null;
  }

  async refreshRegistries(): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    try {
      const result = await this.refreshRegistriesInternal();
      logEvent('info', 'bridge', 'registry-refresh', { durationMs: Date.now() - startedAt, outcome: 'success',
        connectionMode: this.runtime.getContext().connectionMode, adapter: this.adapter.kind, sessionGeneration: this.handshakeGeneration });
      return result;
    } catch (error) {
      const code = normalizeBridgeError(error).code;
      this.lastError = publicErrorCode(error);
      logEvent(code.includes('timeout') ? 'warn' : 'error', 'bridge', 'registry-refresh', { code,
        durationMs: Date.now() - startedAt, outcome: code.includes('timeout') ? 'timeout' : 'failure',
        connectionMode: this.runtime.getContext().connectionMode, adapter: this.adapter.kind, sessionGeneration: this.handshakeGeneration });
      throw error;
    }
  }

  private async refreshRegistriesInternal(): Promise<Record<string, unknown>> {
    const refreshGeneration = ++this.registryRefreshGeneration;
    let context = this.runtime.getContext();
    if (!context.sessionAvailable && context.connectionMode === 'bridge-only') {
      await this.reconnectBridgeOnly();
      context = this.runtime.getContext();
    }
    if (!context.sessionAvailable || !context.minecraftVersion || !context.registryEpoch || !context.runtimeEpoch || !context.minecraftEndpoint) throw new Error('active-minecraft-session-required');
    const session = context.connectionMode === 'bridge-only'
      ? this.requireLinkedBridgeOnlySession(context)
      : await this.ensureSession(context.minecraftVersion, context.minecraftEndpoint, context.registryEpoch);
    this.assertCurrentContext(context, session.sessionId);
    const entries: RegistryEntry[] = [];
    const coverage: Partial<Record<RegistryKind, 'complete' | 'partial'>> = {};
    const registryCounts: Array<{ kind: RegistryKind; completeness: 'complete' | 'partial'; entries: number }> = [];
    const kinds = this.adapter.supports('registry.dynamic-index') ? await this.guarded(this.adapter.getRegistryKinds(), session.sessionId) : registryKinds;
    this.assertRegistryRefreshCurrent(refreshGeneration, context, session.sessionId);
    if (new Set(kinds).size !== kinds.length) this.failClosed(session.sessionId, 'bridge-registry-index-contains-duplicates');
    if (kinds.length === 0) this.failClosed(session.sessionId, 'bridge-registry-index-empty');
    this.assertCurrentContext(context, session.sessionId);
    for (const kind of kinds) {
      let offset = 0; let expectedTotal: number | null = null; let completeness: 'complete' | 'partial' = 'partial';
      let registryEntryCount = 0;
      do {
        const page = await this.guarded(this.adapter.getRegistryPage(kind, offset, 500), session.sessionId);
        this.assertRegistryRefreshCurrent(refreshGeneration, context, session.sessionId);
        this.assertCurrentContext(context, session.sessionId);
        if (page.total > MAX_BRIDGE_REGISTRY_ENTRIES) this.failClosed(session.sessionId, 'bridge-registry-total-exceeds-safety-limit');
        if (page.kind !== kind || page.offset !== offset || page.limit !== 500 || page.entries.length > 500) this.failClosed(session.sessionId, 'bridge-registry-page-shape-mismatch');
        if (expectedTotal === null) { expectedTotal = page.total; completeness = page.completeness; }
        if (page.total !== expectedTotal || page.completeness !== completeness || page.entries.length === 0 && offset < page.total || offset + page.entries.length > page.total) this.failClosed(session.sessionId, 'bridge-registry-pagination-inconsistent');
        if (entries.length + page.entries.length > MAX_BRIDGE_REGISTRY_ENTRIES) this.failClosed(session.sessionId, 'bridge-registry-snapshot-exceeds-safety-limit');
        for (const row of page.entries) {
          if (row.kind !== kind) this.failClosed(session.sessionId, 'bridge-registry-kind-mismatch');
          entries.push({ kind, minecraftVersion: context.minecraftVersion, namespacedId: row.namespacedId,
            ...(row.numericId === undefined ? {} : { numericId: row.numericId }),
            ...(row.numericId === undefined ? {} : { numericIdScope: row.numericIdScope ?? (kind === 'blockState' ? 'server-block-state-generation' : 'server-registry-generation') }),
            ...(row.blockStateProperties === undefined ? {} : { blockStateProperties: row.blockStateProperties }),
            registryEpoch: context.registryEpoch, provenance: { source: 'neoforge-bridge', minecraftVersion: context.minecraftVersion,
            registryEpoch: context.registryEpoch, runtimeEpoch: context.runtimeEpoch, sourceRegistryEpoch: session.registryEpoch,
              authority: 'authenticated-runtime', minecraftEndpoint: session.minecraftEndpoint,
              ...(context.mineflayerSessionId ? { mineflayerSessionId: context.mineflayerSessionId } : {}),
              ...(context.mineflayerRegistryEpoch ? { mineflayerRegistryEpoch: context.mineflayerRegistryEpoch } : {}),
              bridgeSessionId: session.sessionId, serverIdentity: session.serverIdentity,
              neoForgeVersion: session.neoForgeVersion, observedAt: page.observedAt, registryCoverage: page.completeness,
              providerVersion: session.neoForgeVersion } });
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
    this.assertRegistryRefreshCurrent(refreshGeneration, context, session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    const snapshot: RegistrySourceSnapshot = { source: 'neoforge-bridge', authority: 'authenticated-runtime', minecraftVersion: context.minecraftVersion, registryEpoch: context.registryEpoch,
      runtimeEpoch: context.runtimeEpoch, minecraftEndpoint: session.minecraftEndpoint,
      ...(context.mineflayerSessionId ? { mineflayerSessionId: context.mineflayerSessionId } : {}),
      ...(context.mineflayerRegistryEpoch ? { mineflayerRegistryEpoch: context.mineflayerRegistryEpoch } : {}),
      bridgeSessionId: session.sessionId, sourceRegistryEpoch: session.registryEpoch, serverIdentity: session.serverIdentity, neoForgeVersion: session.neoForgeVersion,
      observedAt: new Date().toISOString(),
      availableRegistries: kinds, registryCoverage: coverage, entries };
    this.runtime.bindAuthenticatedBridge({ authenticated: true, serverIdentity: session.serverIdentity, minecraftEndpoint: session.minecraftEndpoint,
      minecraftVersion: session.minecraftVersion, neoForgeVersion: session.neoForgeVersion, sourceRegistryEpoch: session.registryEpoch,
      sessionId: session.sessionId, connectedAt: new Date().toISOString() });
    this.runtime.replaceBridgeSnapshot(snapshot, session.sessionId);
    this.linkedEpoch = context.registryEpoch;
    this.lastError = null;
    return { status: 'refreshed', connectionMode: context.connectionMode, serverIdentity: session.serverIdentity, sourceRegistryEpoch: session.registryEpoch,
      botRegistryEpoch: context.connectionMode === 'bridge-only' ? null : context.registryEpoch, runtimeRegistryEpoch: context.registryEpoch,
      registries: registryCounts };
  }

  async inspectMachine(request: BridgeMachineInspectionRequest): Promise<BridgeMachineInspection> {
    const session = await this.ensureCurrentSession();
    const context = this.runtime.getContext();
    const result = await this.guarded(this.adapter.inspectMachine(request), session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    if (result.serverIdentity !== session.serverIdentity) throw categorizedBridgeError('server-identity-mismatch', 'bridge-machine-response-generation-mismatch');
    if (result.registryEpoch !== session.registryEpoch) throw categorizedBridgeError('stale-registry-epoch', 'bridge-machine-response-generation-mismatch');
    if (result.dimension !== request.dimension || result.x !== request.x || result.y !== request.y || result.z !== request.z) throw categorizedBridgeError('invalid-bridge-response', 'bridge-machine-response-location-mismatch');
    this.lastError = null;
    return result;
  }

  async inspectBlock(request: BridgeMachineInspectionRequest): Promise<BridgeMachineInspection> {
    const session = await this.ensureCurrentSession();
    const context = this.runtime.getContext();
    const result = await this.guarded(this.adapter.inspectBlock(request), session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    if (result.serverIdentity !== session.serverIdentity) throw categorizedBridgeError('server-identity-mismatch', 'bridge-block-response-generation-mismatch');
    if (result.registryEpoch !== session.registryEpoch) throw categorizedBridgeError('stale-registry-epoch', 'bridge-block-response-generation-mismatch');
    if (result.dimension !== request.dimension || result.x !== request.x || result.y !== request.y || result.z !== request.z) throw categorizedBridgeError('invalid-bridge-response', 'bridge-block-response-location-mismatch');
    this.lastError = null;
    return result;
  }

  async capabilities(): Promise<BridgeCapabilities> {
    const session = await this.ensureCurrentSession();
    const context = this.runtime.getContext();
    const result = await this.guarded(this.adapter.getServerCapabilities(), session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    return result;
  }

  async listMachines(request: BridgeMachineSearchRequest): Promise<BridgeMachineSearchPage> {
    if (!this.adapter.supports('machine.search')) throw new Error('processia-machine-search-requires-processia-adapter');
    const session = await this.ensureCurrentSession();
    const context = this.runtime.getContext();
    const result = await this.guarded(this.adapter.listMachines(request), session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    if (result.serverIdentity !== session.serverIdentity) throw categorizedBridgeError('server-identity-mismatch', 'bridge-machine-search-generation-mismatch');
    if (result.registryEpoch !== session.registryEpoch) throw categorizedBridgeError('stale-registry-epoch', 'bridge-machine-search-generation-mismatch');
    return result;
  }

  async inspectRecipes(offset = 0, limit = 100, kind?: string): Promise<BridgeRecipePage> {
    if (!this.adapter.supports('recipes.inspect')) throw new Error('processia-recipes-require-processia-adapter');
    const session = await this.ensureCurrentSession();
    const context = this.runtime.getContext();
    const result = await this.guarded(this.adapter.inspectRecipes(offset, limit, kind), session.sessionId);
    this.assertCurrentContext(context, session.sessionId);
    if (result.serverIdentity !== session.serverIdentity) throw categorizedBridgeError('server-identity-mismatch', 'bridge-recipe-response-generation-mismatch');
    if (result.registryEpoch !== session.registryEpoch) throw categorizedBridgeError('stale-registry-epoch', 'bridge-recipe-response-generation-mismatch');
    this.lastError = null;
    return result;
  }

  private async ensureCurrentSession(): Promise<BridgeHandshakeResponse> {
    const context = this.runtime.getContext();
    if (!context.sessionAvailable || !context.minecraftVersion || !context.registryEpoch || !context.runtimeEpoch || !context.minecraftEndpoint) throw new Error('active-minecraft-session-required');
    if (context.connectionMode === 'bridge-only') return this.requireLinkedBridgeOnlySession(context);
    return this.ensureSession(context.minecraftVersion, context.minecraftEndpoint, context.registryEpoch);
  }

  private requireLinkedBridgeOnlySession(context: ReturnType<RuntimeRegistryService['getContext']>): BridgeHandshakeResponse {
    const session = this.adapter.session;
    if (!session || !context.bridgeSession || session.sessionId !== context.bridgeSession.sessionId || session.serverIdentity !== context.serverIdentity ||
        session.minecraftEndpoint !== context.minecraftEndpoint || session.minecraftVersion !== context.minecraftVersion ||
        session.registryEpoch !== context.bridgeSession.sourceRegistryEpoch || this.linkedEpoch !== context.registryEpoch) {
      throw new Error('bridge-only-session-unavailable-or-stale');
    }
    return session;
  }

  private async ensureSession(version: string, endpoint: string, botEpoch: string): Promise<BridgeHandshakeResponse> {
    let session = this.adapter.session;
    if (!session || this.linkedEpoch !== botEpoch) {
      if (session) {
        const oldSessionId = session.sessionId;
        await this.adapter.closeSession().catch(() => undefined);
        this.runtime.clearBridgeSession(oldSessionId);
      }
      const attempt = ++this.handshakeGeneration;
      try { session = await this.adapter.handshake(version, endpoint); }
      catch (error) {
        // A superseded handshake must not clear a newer in-flight or established session.
        if (attempt === this.handshakeGeneration && !this.adapter.session) {
          this.dropSession();
          this.lastError = publicErrorCode(error);
        }
        throw error;
      }
      const context = this.runtime.getContext();
      if (!context.connected || context.registryEpoch !== botEpoch || context.minecraftVersion !== version || context.minecraftEndpoint !== endpoint || this.adapter.session?.sessionId !== session.sessionId) {
        this.dropSession(session.sessionId);
        throw categorizedBridgeError('stale-registry-epoch', 'bridge-handshake-completed-for-stale-bot-session');
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
      const invalidatesSession = error instanceof BridgeHttpError ? error.invalidatesSession
        : error instanceof BridgeAdapterError ? error.invalidatesSession : true;
      if (invalidatesSession) this.dropSession(sessionId);
      throw error;
    }
  }

  private dropSession(sessionId?: string): void {
    const linkedSessionId = this.runtime.getContext().bridgeSession?.sessionId;
    const adapterSessionId = this.adapter.session?.sessionId;
    if (sessionId !== undefined && adapterSessionId !== sessionId && linkedSessionId !== sessionId) return;
    this.handshakeGeneration += 1;
    this.registryRefreshGeneration += 1;
    this.runtime.clearBridgeSession(sessionId);
    if (sessionId === undefined || adapterSessionId === sessionId) this.adapter.clearSession();
    if (sessionId === undefined || linkedSessionId === sessionId) this.linkedEpoch = null;
  }

  private assertCurrentContext(expected: ReturnType<RuntimeRegistryService['getContext']>, sessionId: string): void {
    const current = this.runtime.getContext();
    const activeBridge = current.bridgeSession;
    const activeAdapter = this.adapter.session;
    if (!current.sessionAvailable || current.registryEpoch !== expected.registryEpoch || current.minecraftVersion !== expected.minecraftVersion ||
        current.runtimeEpoch !== expected.runtimeEpoch || current.mineflayerSessionId !== expected.mineflayerSessionId ||
        (expected.serverIdentity !== null && current.serverIdentity !== expected.serverIdentity) || current.minecraftEndpoint !== expected.minecraftEndpoint ||
        activeBridge?.sessionId !== sessionId || activeBridge.serverIdentity !== activeAdapter?.serverIdentity ||
        activeBridge.sourceRegistryEpoch !== activeAdapter?.registryEpoch) {
      this.dropSession(sessionId);
      throw categorizedBridgeError('stale-registry-epoch', 'bridge-operation-invalidated-by-runtime-session-change');
    }
  }

  private assertRegistryRefreshCurrent(generation: number, context: ReturnType<RuntimeRegistryService['getContext']>, sessionId: string): void {
    if (generation !== this.registryRefreshGeneration) {
      throw new BridgeAdapterError('operation-superseded', 'bridge-registry-refresh-superseded');
    }
    this.assertCurrentContext(context, sessionId);
  }

  private failClosed(sessionId: string, code: string): never {
    this.lastError = code;
    this.dropSession(sessionId);
    throw new BridgeAdapterError('invalid-bridge-response', code);
  }
}

function assertUniqueRegistryMappings(kind: RegistryKind, entries: RegistryEntry[]): void {
  const sourceEntries = entries.filter(entry => entry.kind === kind);
  const namespaced = new Set<string>();
  const numeric = new Set<number>();
  const exactRows = new Set<string>();
  for (const entry of sourceEntries) {
    const properties = entry.blockStateProperties
      ? Object.fromEntries(Object.entries(entry.blockStateProperties).sort(([left], [right]) => left.localeCompare(right)))
      : undefined;
    const exactKey = JSON.stringify([entry.namespacedId, entry.numericId, properties]);
    if (exactRows.has(exactKey)) throw new Error('bridge-registry-duplicate-entry');
    exactRows.add(exactKey);
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
  if (error instanceof BridgeHttpError) return error.diagnosticCode;
  const normalized = normalizeBridgeError(error);
  return /^[a-z0-9_-]{1,96}$/.test(normalized.message) ? normalized.message : normalized.code;
}

async function readBoundedBody(response: Response, maximumBytes: number, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const cancelOnAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      await reader.cancel();
      throw new Error('bridge-response-too-large');
    }
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
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('bridge-invalid-json'); }
}
