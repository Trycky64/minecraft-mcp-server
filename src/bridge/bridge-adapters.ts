import type {
  BridgeCapabilities, BridgeHandshakeResponse, BridgeMachineInspection, BridgeMachineInspectionRequest,
  BridgeMachineSearchPage, BridgeMachineSearchRequest, BridgeRecipePage, BridgeRegistryPage,
} from './bridge-types.js';
import type { RegistryKind } from '../services/minecraft-registry-service.js';
import type { BridgeClientConfig, NeoForgeBridgeClient } from './neoforge-bridge-client.js';
import {
  BridgeAdapterError, normalizeBridgeError,
  type BridgeAdapter, type BridgeAdapterKind, type BridgeAdapterSessionContext, type BridgeAdapterState, type BridgeCapability,
} from './bridge-adapter-contract.js';

const genericCapabilities: readonly BridgeCapability[] = Object.freeze([
  'registry.read', 'registry.dynamic-index', 'block.inspect', 'capability.item-handler',
  'capability.energy-storage', 'capability.fluid-handler',
]);
const processiaCapabilities: readonly BridgeCapability[] = Object.freeze([
  'registry.read', 'block.inspect', 'machine.inspect', 'machine.search', 'recipes.inspect',
  'capability.item-handler', 'capability.energy-storage',
]);

abstract class BaseBridgeAdapter implements BridgeAdapter {
  private closed = false;
  private closingSession = false;
  private activeHandshakes = 0;
  private operationGeneration = 0;
  private closeTask: Promise<void> | null = null;
  readonly #client: NeoForgeBridgeClient;

  protected constructor(client: NeoForgeBridgeClient, readonly kind: BridgeAdapterKind) {
    this.#client = client;
    const clientKind = client.config.mode ?? 'processia';
    const expected = kind === 'generic-neoforge' ? 'generic' : 'processia';
    if (clientKind !== expected) throw new BridgeAdapterError('bridge-configuration-invalid');
  }

  get state(): BridgeAdapterState {
    if (this.closed) return 'closed';
    if (!this.#client.config.enabled) return 'disabled';
    if (this.#client.config.configurationError) return 'unconfigured';
    if (this.closingSession) return 'closing';
    if (this.activeHandshakes > 0) return 'connecting';
    return this.#client.getSession() ? 'authenticated' : 'disconnected';
  }

  get session(): BridgeHandshakeResponse | null { return this.#client.getSession(); }
  get sessionContext(): BridgeAdapterSessionContext | null {
    const session = this.session;
    return session ? {
      sessionId: session.sessionId, serverIdentity: session.serverIdentity, minecraftEndpoint: session.minecraftEndpoint,
      minecraftVersion: session.minecraftVersion, neoForgeVersion: session.neoForgeVersion, sourceRegistryEpoch: session.registryEpoch,
    } : null;
  }
  get capabilities(): readonly BridgeCapability[] { return this.kind === 'generic-neoforge' ? genericCapabilities : processiaCapabilities; }

  supports(capability: BridgeCapability): boolean { return this.capabilities.includes(capability); }

  async handshake(minecraftVersion: string, expectedEndpoint: string): Promise<BridgeHandshakeResponse> {
    if (this.closed || this.closingSession) throw new BridgeAdapterError('bridge-unavailable');
    const generation = this.operationGeneration;
    this.activeHandshakes += 1;
    try {
      const session = await this.#client.handshake(minecraftVersion, expectedEndpoint);
      if (this.closed || this.closingSession || generation !== this.operationGeneration || this.#client.getSession()?.sessionId !== session.sessionId) {
        throw new BridgeAdapterError('session-expired');
      }
      return session;
    }
    catch (error) { throw normalizeBridgeError(error, [this.#client.config.secret]); }
    finally { this.activeHandshakes -= 1; }
  }

  async closeSession(): Promise<void> {
    if (this.closed || this.closingSession) throw new BridgeAdapterError('bridge-unavailable');
    this.closingSession = true;
    this.operationGeneration += 1;
    const task = (async () => {
      try { await this.#client.closeSession(); }
      catch (error) { throw normalizeBridgeError(error, [this.#client.config.secret]); }
      finally { this.#client.clearSession(); }
    })();
    this.closeTask = task;
    try { await task; }
    finally {
      if (this.closeTask === task) this.closeTask = null;
      if (!this.closed) this.closingSession = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closingSession = true;
    this.operationGeneration += 1;
    try {
      if (this.closeTask) await this.closeTask;
      else await this.#client.closeSession();
    } catch (error) { throw normalizeBridgeError(error, [this.#client.config.secret]); }
    finally { this.#client.clearSession(); this.closeTask = null; this.closingSession = false; }
  }

  clearSession(): void { this.operationGeneration += 1; this.#client.clearSession(); }

  async getServerCapabilities(): Promise<BridgeCapabilities> {
    if (this.kind !== 'generic-neoforge') throw new BridgeAdapterError('capability-unsupported', undefined, false);
    return this.invoke(() => this.#client.capabilities());
  }

  async getRegistryKinds(): Promise<string[]> {
    this.requireCapability('registry.dynamic-index');
    return this.invoke(() => this.#client.registryKinds());
  }

  async getRegistryPage(kind: RegistryKind, offset: number, limit: number): Promise<BridgeRegistryPage> {
    this.requireCapability('registry.read');
    return this.invoke(() => this.#client.registryPage(kind, offset, limit));
  }

  async inspectBlock(request: BridgeMachineInspectionRequest): Promise<BridgeMachineInspection> {
    this.requireCapability('block.inspect');
    return this.invoke(() => this.#client.inspectBlock(request));
  }

  async inspectMachine(request: BridgeMachineInspectionRequest): Promise<BridgeMachineInspection> {
    this.requireCapability('machine.inspect');
    return this.invoke(() => this.#client.inspectMachine(request));
  }

  async listMachines(request: BridgeMachineSearchRequest): Promise<BridgeMachineSearchPage> {
    this.requireCapability('machine.search');
    return this.invoke(() => this.#client.listMachines(request));
  }

  async inspectRecipes(offset?: number, limit?: number, kind?: string): Promise<BridgeRecipePage> {
    this.requireCapability('recipes.inspect');
    return this.invoke(() => this.#client.inspectRecipes(offset, limit, kind));
  }

  protected requireCapability(capability: BridgeCapability): void {
    if (!this.supports(capability)) throw new BridgeAdapterError('capability-unsupported', undefined, false);
  }

  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new BridgeAdapterError('bridge-unavailable');
    if (this.closingSession) throw new BridgeAdapterError('session-expired');
    const sessionId = this.#client.getSession()?.sessionId;
    if (!sessionId) throw new BridgeAdapterError('session-expired');
    const generation = this.operationGeneration;
    try {
      const result = await operation();
      if (this.closed || this.closingSession || generation !== this.operationGeneration || this.#client.getSession()?.sessionId !== sessionId) {
        throw new BridgeAdapterError('session-expired');
      }
      return result;
    } catch (error) {
      const normalized = normalizeBridgeError(error, [this.#client.config.secret]);
      if (normalized.invalidatesSession && !this.closed && !this.closingSession && generation === this.operationGeneration &&
          this.#client.getSession()?.sessionId === sessionId) this.clearSession();
      throw normalized;
    }
  }
}

/** Adapter for the standalone generic NeoForge diagnostic mod and its credential format. */
export class GenericNeoForgeBridgeAdapter extends BaseBridgeAdapter {
  constructor(client: NeoForgeBridgeClient) { super(client, 'generic-neoforge'); }
}

/** Adapter for the Processia-specific protocol; it never receives generic bridge credentials. */
export class ProcessiaBridgeAdapter extends BaseBridgeAdapter {
  constructor(client: NeoForgeBridgeClient) { super(client, 'processia'); }
}

export function createBridgeAdapter(config: BridgeClientConfig, clientFactory: (config: BridgeClientConfig) => NeoForgeBridgeClient): BridgeAdapter {
  const client = clientFactory(config);
  return (config.mode === 'generic')
    ? new GenericNeoForgeBridgeAdapter(client)
    : new ProcessiaBridgeAdapter(client);
}
