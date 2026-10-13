import { randomUUID } from 'node:crypto';
import minecraftData from 'minecraft-data';
import type mineflayer from 'mineflayer';
import {
  MinecraftRegistryService,
  type RegistrySourceSnapshot,
} from './minecraft-registry-service.js';
import { getProtocolDecodeStatus, type ProtocolDecodeStatus } from './protocol-decode-monitor.js';
import type { AuthenticatedBridgeSession } from '../bridge/bridge-types.js';

export interface RegistryConnectionAccess {
  getBot(): mineflayer.Bot | null;
  isConnected(): boolean;
  getConfig(): { host: string; port: number };
}

export interface RuntimeRegistryContext {
  connected: boolean;
  minecraftVersion: string | null;
  protocolVersion: string | null;
  protocolNumber: number | null;
  registryEpoch: string | null;
  serverIdentity: string | null;
  registryService: MinecraftRegistryService | null;
  bridgeAvailable: boolean;
  bridgeSession: AuthenticatedBridgeSession | null;
  protocolDecode: ProtocolDecodeStatus;
}

/** Owns registry data for exactly one Mineflayer bot connection/session. */
export class RuntimeRegistryService {
  private bot: mineflayer.Bot | null = null;
  private endpoint: string | null = null;
  private minecraftVersion: string | null = null;
  private epoch: string | null = null;
  private service: MinecraftRegistryService | null = null;
  private bridgeSession: AuthenticatedBridgeSession | null = null;

  constructor(private readonly connection: RegistryConnectionAccess) {}

  getContext(): RuntimeRegistryContext {
    const bot = this.connection.getBot();
    if (!bot || !this.connection.isConnected()) {
      this.invalidate();
      return {
        connected: false,
        minecraftVersion: null,
        protocolVersion: null,
        protocolNumber: null,
        registryEpoch: null,
        serverIdentity: null,
        registryService: null,
        bridgeAvailable: false,
        bridgeSession: null,
        protocolDecode: { inventory: 'unverified', issues: [] },
      };
    }

    const { host, port } = this.connection.getConfig();
    const endpoint = `${host}:${port}`;
    const version = bot.version;
    if (bot !== this.bot || endpoint !== this.endpoint || version !== this.minecraftVersion || !this.service || !this.epoch) {
      this.invalidate();
      this.bot = bot;
      this.endpoint = endpoint;
      this.minecraftVersion = version;
      // Random per-connection identity avoids reusing a process-wide counter across servers.
      this.epoch = `session:${randomUUID()}`;
      this.service = MinecraftRegistryService.withMinecraftData([version]);
    }

    const protocolData = minecraftData(version);
    return {
      connected: true,
      minecraftVersion: version,
      protocolVersion: bot.protocolVersion ?? null,
      protocolNumber: protocolData?.version.version ?? null,
      registryEpoch: this.epoch,
      serverIdentity: endpoint,
      registryService: this.service,
      bridgeAvailable: this.bridgeSession !== null,
      bridgeSession: this.bridgeSession ? { ...this.bridgeSession } : null,
      protocolDecode: getProtocolDecodeStatus(bot._client as object),
    };
  }

  /** Controlled version/epoch-scoped injection point; callers must authenticate future transports upstream. */
  replaceRuntimeSnapshot(snapshot: RegistrySourceSnapshot): void {
    const context = this.getContext();
    if (!context.connected || !context.registryService || !context.registryEpoch || !context.minecraftVersion) {
      throw new Error('Cannot inject registry data without an active bot session');
    }
    if (snapshot.source === 'minecraft-data') throw new Error('Runtime injection cannot replace the static minecraft-data source');
    if (snapshot.minecraftVersion !== context.minecraftVersion) throw new Error('Snapshot Minecraft version does not match the active bot session');
    if (snapshot.registryEpoch !== context.registryEpoch) throw new Error('Snapshot registry epoch does not match the active bot session');
    context.registryService.replaceSnapshot(snapshot);
  }

  bindAuthenticatedBridge(session: AuthenticatedBridgeSession): void {
    const context = this.getContext();
    if (!session.authenticated || !session.sessionId || !session.serverIdentity || !session.sourceRegistryEpoch) {
      throw new Error('Bridge session has not completed authenticated identity validation');
    }
    if (!context.connected || !context.registryEpoch || !context.minecraftVersion || !context.serverIdentity || !context.registryService) {
      throw new Error('Cannot bind bridge without an active Mineflayer session');
    }
    if (context.minecraftVersion !== session.minecraftVersion) throw new Error('Bridge Minecraft version does not match the active bot');
    if (!sameLocalEndpoint(context.serverIdentity, session.minecraftEndpoint)) throw new Error('Bridge Minecraft endpoint does not match the active bot server');
    if (this.bridgeSession && (this.bridgeSession.sessionId !== session.sessionId || this.bridgeSession.sourceRegistryEpoch !== session.sourceRegistryEpoch || this.bridgeSession.serverIdentity !== session.serverIdentity)) {
      context.registryService.removeSnapshots('neoforge-bridge', context.minecraftVersion, context.registryEpoch);
    }
    this.bridgeSession = { ...session };
  }

  replaceBridgeSnapshot(snapshot: RegistrySourceSnapshot, sessionId: string): void {
    const context = this.getContext();
    const session = this.bridgeSession;
    if (!session || session.sessionId !== sessionId) throw new Error('Bridge snapshot has no matching authenticated session');
    if (!context.registryService || !context.registryEpoch || !context.minecraftVersion) throw new Error('No active runtime registry session');
    if (snapshot.source !== 'neoforge-bridge' || snapshot.registryEpoch !== context.registryEpoch) throw new Error('Bridge snapshot is not mapped to the active bot registry epoch');
    if (snapshot.sourceRegistryEpoch !== session.sourceRegistryEpoch || snapshot.serverIdentity !== session.serverIdentity || snapshot.neoForgeVersion !== session.neoForgeVersion) {
      throw new Error('Bridge snapshot generation or server identity does not match the authenticated session');
    }
    for (const entry of snapshot.entries) {
      if (entry.registryEpoch !== context.registryEpoch || entry.provenance.registryEpoch !== context.registryEpoch ||
          entry.provenance.sourceRegistryEpoch !== session.sourceRegistryEpoch || entry.provenance.serverIdentity !== session.serverIdentity) {
        throw new Error('Bridge entry provenance does not match the active session linkage');
      }
    }
    context.registryService.replaceSnapshot(snapshot);
  }

  clearBridgeSession(sessionId?: string): void {
    const context = this.getContext();
    if (sessionId !== undefined && this.bridgeSession?.sessionId !== sessionId) return;
    if (context.registryService && context.minecraftVersion && context.registryEpoch) {
      context.registryService.removeSnapshots('neoforge-bridge', context.minecraftVersion, context.registryEpoch);
    }
    this.bridgeSession = null;
  }

  invalidate(): void {
    this.bot = null;
    this.endpoint = null;
    this.minecraftVersion = null;
    this.epoch = null;
    this.service = null;
    this.bridgeSession = null;
  }
}

function sameLocalEndpoint(left: string, right: string): boolean {
  const parse = (value: string): [string, string] | null => {
    const match = /^(\[[0-9a-fA-F:]+\]|[^:]+):(\d+)$/.exec(value.trim());
    if (!match) return null;
    const host = match[1]!.replace(/^\[|\]$/g, '').toLowerCase();
    const normalizedHost = host === 'localhost' || host === '::1' ? '127.0.0.1' : host;
    return [normalizedHost, String(Number(match[2]))];
  };
  const a = parse(left), b = parse(right);
  return a !== null && b !== null && a[0] === b[0] && a[1] === b[1];
}
