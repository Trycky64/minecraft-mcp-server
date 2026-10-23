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
  getConnectionMode?(): 'bot' | 'bridge-only' | 'auto';
}

export interface RuntimeRegistryContext {
  /** A Mineflayer player is connected. Kept separate from bridge-only server availability. */
  connected: boolean;
  sessionAvailable: boolean;
  playerAvailable: boolean;
  connectionMode: 'bot' | 'bridge-only' | 'auto';
  minecraftVersion: string | null;
  minecraftEndpoint: string | null;
  protocolVersion: string | null;
  protocolNumber: number | null;
  registryEpoch: string | null;
  /** Internal service generation, never interchangeable with a Mineflayer or Java epoch. */
  runtimeEpoch: string | null;
  mineflayerSessionId: string | null;
  mineflayerRegistryEpoch: string | null;
  bridgeSessionId: string | null;
  sourceRegistryEpoch: string | null;
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
  private runtimeEpoch: string | null = null;
  private mineflayerSessionId: string | null = null;
  private service: MinecraftRegistryService | null = null;
  private bridgeSession: AuthenticatedBridgeSession | null = null;
  private bridgeOnlySession: AuthenticatedBridgeSession | null = null;

  constructor(private readonly connection: RegistryConnectionAccess) {}

  getContext(): RuntimeRegistryContext {
    const bot = this.connection.getBot();
    if (!bot || !this.connection.isConnected()) {
      if (!bot && this.bridgeOnlySession && this.service && this.epoch) {
        const protocolData = minecraftData(this.minecraftVersion!);
        return {
          connected: false,
          sessionAvailable: true,
          playerAvailable: false,
          connectionMode: 'bridge-only',
          minecraftVersion: this.minecraftVersion,
          minecraftEndpoint: this.endpoint,
          protocolVersion: null,
          protocolNumber: protocolData?.version.version ?? null,
          registryEpoch: this.epoch,
          runtimeEpoch: this.runtimeEpoch,
          mineflayerSessionId: null,
          mineflayerRegistryEpoch: null,
          bridgeSessionId: this.bridgeOnlySession.sessionId,
          sourceRegistryEpoch: this.bridgeOnlySession.sourceRegistryEpoch,
          serverIdentity: this.bridgeOnlySession.serverIdentity,
          registryService: this.service,
          bridgeAvailable: this.bridgeSession !== null,
          bridgeSession: this.bridgeSession ? { ...this.bridgeSession } : null,
          protocolDecode: { inventory: 'unverified', issues: [] },
        };
      }
      this.invalidate();
      return {
        connected: false,
        sessionAvailable: false,
        playerAvailable: false,
        connectionMode: this.connection.getConnectionMode?.() ?? 'bot',
        minecraftVersion: null,
        minecraftEndpoint: null,
        protocolVersion: null,
        protocolNumber: null,
        registryEpoch: null,
        runtimeEpoch: null,
        mineflayerSessionId: null,
        mineflayerRegistryEpoch: null,
        bridgeSessionId: null,
        sourceRegistryEpoch: null,
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
    if (bot !== this.bot || endpoint !== this.endpoint || version !== this.minecraftVersion || !this.service || !this.epoch || !this.runtimeEpoch || !this.mineflayerSessionId) {
      this.invalidate();
      this.bot = bot;
      this.endpoint = endpoint;
      this.minecraftVersion = version;
      // Random per-connection identity avoids reusing a process-wide counter across servers.
      this.epoch = `mineflayer-registry:${randomUUID()}`;
      this.runtimeEpoch = `runtime:${randomUUID()}`;
      this.mineflayerSessionId = `mineflayer-session:${randomUUID()}`;
      this.service = MinecraftRegistryService.withMinecraftData([version]);
      this.service.bindRuntimeContext(this.epoch, this.runtimeEpoch);
    }

    const protocolData = minecraftData(version);
    return {
      connected: true,
      sessionAvailable: true,
      playerAvailable: true,
      connectionMode: this.connection.getConnectionMode?.() ?? 'bot',
      minecraftVersion: version,
      minecraftEndpoint: endpoint,
      protocolVersion: bot.protocolVersion ?? null,
      protocolNumber: protocolData?.version.version ?? null,
      registryEpoch: this.epoch,
      runtimeEpoch: this.runtimeEpoch,
      mineflayerSessionId: this.mineflayerSessionId,
      mineflayerRegistryEpoch: this.epoch,
      bridgeSessionId: this.bridgeSession?.sessionId ?? null,
      sourceRegistryEpoch: this.bridgeSession?.sourceRegistryEpoch ?? null,
      // The TCP endpoint is not proof of a server identity. Only an authenticated bridge can provide one.
      serverIdentity: this.bridgeSession?.serverIdentity ?? null,
      registryService: this.service,
      bridgeAvailable: this.bridgeSession !== null,
      bridgeSession: this.bridgeSession ? { ...this.bridgeSession } : null,
      protocolDecode: getProtocolDecodeStatus(bot._client as object),
    };
  }

  /** Activate a registry/runtime context from a completed, authenticated bridge handshake without creating a bot. */
  activateBridgeOnly(session: AuthenticatedBridgeSession): void {
    if (!session.authenticated || !session.sessionId || !session.serverIdentity || !session.sourceRegistryEpoch || !session.minecraftVersion || !session.minecraftEndpoint) {
      throw new Error('bridge-session-not-authenticated-or-incomplete');
    }
    if (!isLoopbackEndpoint(session.minecraftEndpoint)) throw new Error('bridge-only-endpoint-must-be-loopback');
    if (this.connection.getBot()) throw new Error('cannot-activate-bridge-only-while-bot-exists');
    this.invalidate();
    this.bridgeOnlySession = { ...session };
    this.bridgeSession = { ...session };
    this.endpoint = session.minecraftEndpoint;
    this.minecraftVersion = session.minecraftVersion;
    this.epoch = `bridge-registry:${randomUUID()}`;
    this.runtimeEpoch = `runtime:${randomUUID()}`;
    this.service = MinecraftRegistryService.withMinecraftData([session.minecraftVersion]);
    this.service.bindRuntimeContext(this.epoch, this.runtimeEpoch);
  }

  /** Controlled version/epoch-scoped injection point; callers must authenticate future transports upstream. */
  replaceRuntimeSnapshot(snapshot: RegistrySourceSnapshot): void {
    const context = this.getContext();
    if (!context.connected || !context.registryService || !context.registryEpoch || !context.minecraftVersion) {
      throw new Error('Cannot inject registry data without an active bot session');
    }
    if (snapshot.source === 'minecraft-data') throw new Error('Runtime injection cannot replace the static minecraft-data source');
    if (snapshot.source === 'neoforge-bridge') throw new Error('NeoForge bridge snapshots require authenticated session linkage');
    if (snapshot.minecraftVersion !== context.minecraftVersion) throw new Error('Snapshot Minecraft version does not match the active bot session');
    if (snapshot.registryEpoch !== context.registryEpoch) throw new Error('Snapshot registry epoch does not match the active bot session');
    if (snapshot.runtimeEpoch !== undefined && snapshot.runtimeEpoch !== context.runtimeEpoch) throw new Error('Snapshot runtime epoch does not match the active session');
    if (snapshot.source === 'protocol') {
      if (snapshot.authority !== 'protocol-observed' || snapshot.runtimeEpoch !== context.runtimeEpoch ||
          snapshot.minecraftEndpoint !== context.minecraftEndpoint || snapshot.mineflayerSessionId !== context.mineflayerSessionId ||
          snapshot.mineflayerRegistryEpoch !== context.mineflayerRegistryEpoch) {
        throw new Error('Protocol snapshot provenance is not linked to the active Mineflayer session');
      }
      for (const entry of snapshot.entries) {
        if (entry.provenance.authority !== 'protocol-observed' || entry.provenance.runtimeEpoch !== context.runtimeEpoch ||
            entry.provenance.minecraftEndpoint !== context.minecraftEndpoint || entry.provenance.mineflayerSessionId !== context.mineflayerSessionId ||
            entry.provenance.mineflayerRegistryEpoch !== context.mineflayerRegistryEpoch) {
          throw new Error('Protocol entry provenance is not linked to the active Mineflayer session');
        }
      }
    }
    context.registryService.replaceSnapshot(snapshot);
  }

  bindAuthenticatedBridge(session: AuthenticatedBridgeSession): void {
    const context = this.getContext();
    if (!session.authenticated || !session.sessionId || !session.serverIdentity || !session.sourceRegistryEpoch) {
      throw new Error('Bridge session has not completed authenticated identity validation');
    }
    if (!context.sessionAvailable || !context.registryEpoch || !context.runtimeEpoch || !context.minecraftVersion || !context.minecraftEndpoint || !context.registryService) {
      throw new Error('Cannot bind bridge without an active Mineflayer session');
    }
    if (context.connectionMode === 'bridge-only') {
      if (context.serverIdentity !== session.serverIdentity || context.minecraftEndpoint !== session.minecraftEndpoint || context.minecraftVersion !== session.minecraftVersion) {
        throw new Error('Bridge identity does not match the active bridge-only session');
      }
      this.bridgeSession = { ...session };
      this.bridgeOnlySession = { ...session };
      return;
    }
    if (context.minecraftVersion !== session.minecraftVersion) throw new Error('Bridge Minecraft version does not match the active bot');
    if (!sameLocalEndpoint(context.minecraftEndpoint, session.minecraftEndpoint)) throw new Error('Bridge Minecraft endpoint does not match the active bot server');
    if (this.bridgeSession?.sessionId === session.sessionId && (this.bridgeSession.sourceRegistryEpoch !== session.sourceRegistryEpoch ||
        this.bridgeSession.serverIdentity !== session.serverIdentity || this.bridgeSession.minecraftEndpoint !== session.minecraftEndpoint ||
        this.bridgeSession.minecraftVersion !== session.minecraftVersion || this.bridgeSession.neoForgeVersion !== session.neoForgeVersion)) {
      throw new Error('Bridge session ID was reused for a different authenticated context');
    }
    if (this.bridgeSession && (this.bridgeSession.sessionId !== session.sessionId || this.bridgeSession.sourceRegistryEpoch !== session.sourceRegistryEpoch || this.bridgeSession.serverIdentity !== session.serverIdentity)) {
      context.registryService.removeSnapshots('neoforge-bridge', context.minecraftVersion, context.registryEpoch);
    }
    this.bridgeSession = { ...session };
  }

  replaceBridgeSnapshot(snapshot: RegistrySourceSnapshot, sessionId: string): void {
    const context = this.getContext();
    const session = this.bridgeSession;
    if (!session || session.sessionId !== sessionId) throw new Error('Bridge snapshot has no matching authenticated session');
    if (!context.registryService || !context.registryEpoch || !context.runtimeEpoch || !context.minecraftVersion || !context.minecraftEndpoint) throw new Error('No active runtime registry session');
    if (snapshot.source !== 'neoforge-bridge' || snapshot.authority !== 'authenticated-runtime' || !snapshot.observedAt || snapshot.registryEpoch !== context.registryEpoch) {
      throw new Error('Bridge snapshot is not an authenticated snapshot mapped to the active runtime registry epoch');
    }
    if (snapshot.runtimeEpoch !== context.runtimeEpoch || snapshot.bridgeSessionId !== session.sessionId || snapshot.minecraftEndpoint !== session.minecraftEndpoint ||
        (snapshot.mineflayerSessionId ?? null) !== context.mineflayerSessionId || (snapshot.mineflayerRegistryEpoch ?? null) !== context.mineflayerRegistryEpoch ||
        snapshot.sourceRegistryEpoch !== session.sourceRegistryEpoch || snapshot.serverIdentity !== session.serverIdentity || snapshot.neoForgeVersion !== session.neoForgeVersion) {
      throw new Error('Bridge snapshot generation or server identity does not match the authenticated session');
    }
    for (const entry of snapshot.entries) {
      if (entry.registryEpoch !== context.registryEpoch || entry.provenance.registryEpoch !== context.registryEpoch ||
          entry.provenance.runtimeEpoch !== context.runtimeEpoch || entry.provenance.bridgeSessionId !== session.sessionId ||
          entry.provenance.minecraftEndpoint !== session.minecraftEndpoint || (entry.provenance.mineflayerSessionId ?? null) !== context.mineflayerSessionId ||
          (entry.provenance.mineflayerRegistryEpoch ?? null) !== context.mineflayerRegistryEpoch || entry.provenance.sourceRegistryEpoch !== session.sourceRegistryEpoch ||
          entry.provenance.serverIdentity !== session.serverIdentity || entry.provenance.authority !== 'authenticated-runtime' ||
          entry.provenance.registryCoverage !== snapshot.registryCoverage?.[entry.kind]) {
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
    if (this.bridgeOnlySession?.sessionId === sessionId || sessionId === undefined) this.invalidate();
  }

  invalidate(): void {
    this.service?.invalidateRuntimeContext();
    this.bot = null;
    this.endpoint = null;
    this.minecraftVersion = null;
    this.epoch = null;
    this.runtimeEpoch = null;
    this.mineflayerSessionId = null;
    this.service = null;
    this.bridgeSession = null;
    this.bridgeOnlySession = null;
  }
}

function isLoopbackEndpoint(value: string): boolean {
  const match = /^(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/i.exec(value.trim());
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 65535;
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
