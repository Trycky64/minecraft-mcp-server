import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import type { RuntimeRegistryService } from '../services/runtime-registry-service.js';

const PROTOCOL = 1;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const screenshotPrefix = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface GuiSession {
  sessionId: string;
  clientId: string;
  graphEpoch: string;
  serverEpoch: string;
  serverIdentity: string;
  minecraftEndpoint: string;
  minecraftVersion: string;
  neoForgeVersion: string;
  connectedAt: string;
}

export interface GuiClientConfig {
  enabled: boolean;
  url: string | null;
  secret: string | null;
  serverIdentity: string | null;
  minecraftEndpoint: string | null;
  neoForgeVersion: string | null;
  minecraftVersion: string;
  mode: 'READ_ONLY' | 'TEST_MUTATION';
  testWorldAcknowledged: boolean;
  allowedDimensions: string[];
  allowedMachines: string[];
  allowedBlocks: string[];
  projectDirectory: string | null;
  artifactDirectory: string;
  timeoutMs: number;
  error: string | null;
}

export function readGuiClientConfig(env: Record<string, string | undefined> = process.env): GuiClientConfig {
  const enabled = env.PROCESSIA_GUI_ENABLED === 'true';
  const urlValue = env.PROCESSIA_GUI_URL ?? 'http://127.0.0.1:25578';
  let url: URL | null = null;
  try { url = new URL(urlValue); } catch { /* Safe validation error below, without echoing the value. */ }
  const loopback = url !== null && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password;
  const secret = env.PROCESSIA_GUI_SECRET ?? '';
  const serverIdentity = env.PROCESSIA_GUI_SERVER_IDENTITY ?? '';
  const minecraftEndpoint = env.PROCESSIA_GUI_MINECRAFT_ENDPOINT ?? '';
  const neoForgeVersion = env.PROCESSIA_GUI_NEOFORGE_VERSION ?? '';
  const minecraftVersion = env.PROCESSIA_GUI_MINECRAFT_VERSION ?? '1.21.1';
  const requestedMode = env.PROCESSIA_GUI_MODE ?? 'READ_ONLY';
  const mode = requestedMode === 'TEST_MUTATION' ? 'TEST_MUTATION' : 'READ_ONLY';
  const endpoint = parseEndpoint(minecraftEndpoint);
  const dimensions = split(env.PROCESSIA_GUI_ALLOWED_DIMENSIONS ?? 'minecraft:overworld');
  const machines = split(env.PROCESSIA_GUI_ALLOWED_MACHINES ?? 'processia:coal_generator,processia:crusher,processia:press,processia:wiremill,processia:basic_battery');
  const defaultBlocks = 'minecraft:chest,minecraft:barrel,minecraft:furnace,minecraft:blast_furnace,minecraft:smoker,minecraft:crafting_table,minecraft:smithing_table,minecraft:anvil,minecraft:loom,minecraft:stonecutter,minecraft:grindstone,minecraft:cartography_table,minecraft:brewing_stand,minecraft:hopper,minecraft:dispenser,minecraft:dropper';
  const blocks = split(env.PROCESSIA_GUI_ALLOWED_BLOCKS ?? `${defaultBlocks},${machines.join(',')}`);
  const projectDirectory = env.PROCESSIA_GUI_PROJECT_DIR ? path.resolve(env.PROCESSIA_GUI_PROJECT_DIR) : null;
  const timeoutMs = Number(env.PROCESSIA_GUI_TIMEOUT_MS ?? 5000);
  const error = !enabled ? null
    : !loopback ? 'gui-url-must-be-loopback-http'
      : secret.length < 32 ? 'gui-secret-must-have-at-least-32-characters'
        : !/^[A-Za-z0-9._-]{1,128}$/.test(serverIdentity) ? 'gui-server-identity-invalid'
          : endpoint === null || endpoint.port === 25565 ? 'gui-test-endpoint-must-be-local-and-not-25565'
        : !neoForgeVersion || !minecraftVersion ? 'gui-runtime-versions-required'
              : !['READ_ONLY', 'TEST_MUTATION'].includes(requestedMode) ? 'gui-mode-invalid'
                : mode === 'TEST_MUTATION' && env.PROCESSIA_GUI_TEST_WORLD_ACK !== 'true' ? 'gui-test-world-acknowledgement-required'
                : dimensions.length === 0 || dimensions.some((value) => !/^[a-z0-9_.-]+:[a-z0-9/._-]+$/.test(value)) ? 'gui-dimension-allowlist-invalid'
                    : machines.length === 0 || machines.some((value) => !/^processia:[a-z0-9/._-]+$/.test(value)) ? 'gui-machine-allowlist-invalid'
                      : blocks.length === 0 || blocks.some((value) => !/^(minecraft|processia):[a-z0-9/._-]+$/.test(value)) ? 'gui-block-allowlist-invalid'
                        : !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000 ? 'gui-timeout-out-of-range'
                      : null;
  return {
    enabled, url: loopback ? url!.toString().replace(/\/$/, '') : null, secret: secret || null,
    serverIdentity: serverIdentity || null, minecraftEndpoint: endpoint ? `${endpoint.host}:${endpoint.port}` : null,
    neoForgeVersion: neoForgeVersion || null, minecraftVersion, mode, testWorldAcknowledged: env.PROCESSIA_GUI_TEST_WORLD_ACK === 'true',
    allowedDimensions: dimensions, allowedMachines: machines, allowedBlocks: blocks, projectDirectory,
    artifactDirectory: path.resolve(env.PROCESSIA_GUI_ARTIFACT_DIR ?? path.join(process.cwd(), 'artifacts', 'p3')),
    timeoutMs, error,
  };
}

function parseEndpoint(value: string): { host: string; port: number } | null {
  const match = /^(127\.0\.0\.1|localhost):(\d{1,5})$/i.exec(value.trim());
  if (!match) return null;
  const port = Number(match[2]);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? { host: '127.0.0.1', port }
    : null;
}

function split(value: string): string[] { return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))]; }

export class GuiHarnessClient {
  private session: GuiSession | null = null;
  private readonly clientId = randomUUID();
  private child: ChildProcess | null = null;
  private childStartedAt: string | null = null;
  private activeGameDirectory: string | null = null;

  constructor(readonly config: GuiClientConfig, private readonly registry: RuntimeRegistryService) {}

  async status(): Promise<Record<string, unknown>> {
    let handshakeError: string | null = null;
    if (this.config.enabled && !this.session) {
      try { await this.handshake(); }
      catch (error) { handshakeError = error instanceof Error ? error.message : 'gui-status-handshake-failed'; }
    }
    const bridge = this.registry.getContext().bridgeSession;
    const linkedSession = bridge?.authenticated && this.session?.serverIdentity === bridge.serverIdentity &&
      this.session.serverEpoch === bridge.sourceRegistryEpoch && sameEndpoint(this.session.minecraftEndpoint, bridge.minecraftEndpoint);
    if (this.session && !linkedSession) this.clearSession();
    return {
      enabled: this.config.enabled,
      configured: !this.config.error && this.config.url !== null && this.config.secret !== null,
      configurationError: this.config.error,
      mode: this.config.mode,
      testWorldAcknowledged: this.config.testWorldAcknowledged,
      allowedDimensions: this.config.allowedDimensions,
      allowedMachines: this.config.allowedMachines,
      allowedBlocks: this.config.allowedBlocks,
      serverIdentity: this.session?.serverIdentity ?? null,
      minecraftEndpoint: this.session?.minecraftEndpoint ?? null,
      graphEpoch: this.session?.graphEpoch ?? null,
      serverEpoch: this.session?.serverEpoch ?? null,
      authenticated: linkedSession === true,
      clientReachable: this.session !== null,
      lastError: handshakeError,
      clientProcess: this.child ? { pid: this.child.pid ?? null, startedAt: this.childStartedAt, gameDirectory: this.activeGameDirectory } : null,
      bridgeLink: bridge ? { authenticated: true, serverIdentity: bridge.serverIdentity, minecraftEndpoint: bridge.minecraftEndpoint, serverEpoch: bridge.sourceRegistryEpoch } : { authenticated: false },
      artifactsDirectory: this.config.artifactDirectory,
    };
  }

  async startClient(): Promise<Record<string, unknown>> {
    this.assertConfigured();
    if (this.child && this.child.exitCode === null) throw new Error('gui-client-process-already-started');
    await this.cleanupGameDirectory();
    const { projectDirectory, minecraftEndpoint } = this.config;
    if (!projectDirectory || !minecraftEndpoint) throw new Error('gui-project-directory-and-endpoint-required');
    const bridge = this.requireBridgeLink();
    const [host, portText] = minecraftEndpoint.split(':');
    const port = Number(portText);
    if (port === 25565 || host !== '127.0.0.1') throw new Error('gui-start-client-refuses-non-test-endpoint');
    const wrapper = path.join(projectDirectory, 'gradlew.bat');
    if (!/^[A-Za-z0-9_ .:\\/-]+$/.test(wrapper)) throw new Error('gui-project-path-contains-unsupported-characters');
    if (!(await stat(wrapper).catch(() => null))?.isFile()) throw new Error('gui-gradle-wrapper-not-found');
    const gameDirectory = path.join(os.tmpdir(), `processia-gui-client-${randomUUID()}`);
    await mkdir(gameDirectory, { recursive: true });
    // cmd.exe /s /c treats a quoted first token specially; prefix `call` so the
    // Gradle wrapper path with spaces remains a single executable token.
    const command = `call "${wrapper}" runClient --no-daemon --offline --console=plain`;
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
      // Node's normal Windows argument quoting escapes the embedded quotes for
      // cmd.exe, making the whole quoted path look like a literal command.
      windowsVerbatimArguments: true,
      cwd: projectDirectory,
      env: {
        ...process.env,
        PROCESSIA_GUI_ENABLED: 'true',
        PROCESSIA_GUI_SECRET: this.config.secret!,
        PROCESSIA_GUI_SERVER_IDENTITY: bridge.serverIdentity,
        PROCESSIA_GUI_MINECRAFT_ENDPOINT: bridge.minecraftEndpoint,
        PROCESSIA_GUI_SERVER_EPOCH: bridge.sourceRegistryEpoch,
        PROCESSIA_GUI_MODE: this.config.mode,
        PROCESSIA_GUI_TEST_WORLD_ACK: String(this.config.testWorldAcknowledged),
        PROCESSIA_GUI_ALLOWED_DIMENSIONS: this.config.allowedDimensions.join(','),
        PROCESSIA_GUI_ALLOWED_MACHINES: this.config.allowedMachines.join(','),
        PROCESSIA_GUI_ALLOWED_BLOCKS: this.config.allowedBlocks.join(','),
        PROCESSIA_GUI_PORT: new URL(this.config.url!).port || '25578',
        PROCESSIA_GUI_TARGET_SERVER: `${host}:${port}`,
        PROCESSIA_GUI_GAME_DIR: gameDirectory,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutLog = createWriteStream(path.join(gameDirectory, 'gui-client.stdout.log'), { flags: 'a' });
    const stderrLog = createWriteStream(path.join(gameDirectory, 'gui-client.stderr.log'), { flags: 'a' });
    child.stdout?.pipe(stdoutLog);
    child.stderr?.pipe(stderrLog);
    child.once('close', () => { stdoutLog.end(); stderrLog.end(); });
    child.on('error', () => { this.child = null; });
    child.on('exit', () => { if (this.child === child) { this.child = null; this.session = null; } });
    this.child = child;
    this.childStartedAt = new Date().toISOString();
    this.activeGameDirectory = gameDirectory;
    this.session = null;
    return {
      status: 'starting', pid: child.pid ?? null, startedAt: this.childStartedAt, gameDirectory,
      logFiles: { stdout: path.join(gameDirectory, 'gui-client.stdout.log'), stderr: path.join(gameDirectory, 'gui-client.stderr.log') },
      target: `${host}:${port}`, serverIdentity: bridge.serverIdentity, serverEpoch: bridge.sourceRegistryEpoch,
    };
  }

  async stopClient(): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child) {
      if (this.session) await this.fetchJson('/v1/close', { method: 'POST', authenticated: true });
      this.clearSession();
      await this.cleanupGameDirectory();
      return { status: 'harness-session-released', stopped: false, detail: 'This MCP process did not launch the client.' };
    }
    if (this.session) {
      try { await this.request('/v1/client-stop', {}); } catch { /* Process exit is checked below. */ }
    }
    const pid = child.pid;
    await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 12_000))]);
    if (child.exitCode === null && pid) {
      try { await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); } catch { /* It may already have exited. */ }
    }
    await this.cleanupGameDirectory();
    this.child = null; this.clearSession();
    return { status: 'stopped', stopped: true, pid };
  }

  async shutdown(): Promise<void> {
    if (this.child) { await this.stopClient(); return; }
    if (this.session && this.config.url && this.config.secret) {
      try { await this.fetchJson('/v1/close', { method: 'POST', authenticated: true }); } catch { /* The client may already be disconnected. */ }
    }
    this.clearSession();
  }

  private async cleanupGameDirectory(): Promise<void> {
    const directory = this.activeGameDirectory;
    if (!directory) return;
    const resolved = path.resolve(directory);
    if (path.basename(resolved).startsWith('processia-gui-client-') && path.dirname(resolved) === path.resolve(os.tmpdir())) {
      await rm(resolved, { recursive: true, force: true });
    }
    this.activeGameDirectory = null;
  }

  async handshake(): Promise<Record<string, unknown>> {
    this.assertConfigured();
    const bridge = this.requireBridgeLink();
    if (this.session) {
      try { await this.fetchJson('/v1/close', { method: 'POST', authenticated: true }); } catch { /* A new handshake replaces the old local session. */ }
      this.clearSession();
    }
    const response = await this.fetchJson('/v1/handshake', {
      method: 'POST', authenticated: false,
      body: JSON.stringify({ protocolVersion: PROTOCOL, clientId: this.clientId, expectedServerIdentity: bridge.serverIdentity, expectedMinecraftEndpoint: bridge.minecraftEndpoint, expectedServerEpoch: bridge.sourceRegistryEpoch }),
    });
    const result = handshakeSchema(response);
    if (result.clientId !== this.clientId) throw new Error('gui-session-client-id-mismatch');
    this.validateBridgeMetadata(result as unknown as Record<string, unknown>, bridge);
    this.session = result;
    return { ...result, authenticated: true };
  }

  async call(pathname: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.assertConfigured();
    const bridge = this.requireBridgeLink();
    if (!this.session) await this.handshake();
    const result = await this.request(pathname, body);
    this.validateBridgeMetadata(result, bridge);
    return result;
  }

  async screenshot(): Promise<Record<string, unknown>> {
    const raw = await this.call('/v1/screenshot');
    if (raw.mediaType !== 'image/png' || typeof raw.base64 !== 'string' || typeof raw.sha256 !== 'string') throw new Error('gui-invalid-screenshot-response');
    const image = Buffer.from(raw.base64, 'base64');
    if (image.length < screenshotPrefix.length || !image.subarray(0, screenshotPrefix.length).equals(screenshotPrefix)) throw new Error('gui-screenshot-is-not-png');
    const hash = createHash('sha256').update(image).digest('hex');
    if (hash !== raw.sha256) throw new Error('gui-screenshot-hash-mismatch');
    const fileName = `gui-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.png`;
    await mkdir(this.config.artifactDirectory, { recursive: true });
    const target = path.resolve(this.config.artifactDirectory, fileName);
    await writeFile(target, image, { flag: 'wx' });
    const metadata = { ...raw };
    delete metadata.base64;
    return { ...metadata, path: target, bytes: image.length, sha256: hash, retainedByMcp: true };
  }

  clearSession(): void { this.session = null; }

  private async request(pathname: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.session) throw new Error('gui-handshake-required');
    const result = await this.fetchJson(pathname, { method: 'POST', body: JSON.stringify(body), authenticated: true });
    return objectResponse(result);
  }

  private async fetchJson(pathname: string, options: { method: string; body?: string; authenticated: boolean }): Promise<unknown> {
    if (!this.config.url || !this.config.secret) throw new Error(this.config.error ?? 'gui-not-configured');
    if (options.authenticated && !this.session) throw new Error('gui-handshake-required');
    let response: Response;
    try {
      response = await fetch(`${this.config.url}${pathname}`, {
        method: options.method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.config.secret}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.authenticated && this.session ? { 'X-Processia-Gui-Session': this.session.sessionId } : {}) },
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: AbortSignal.timeout(this.config.timeoutMs), redirect: 'error',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error('gui-request-timeout');
      throw new Error('gui-bridge-unavailable');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('gui-empty-response');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('gui-response-too-large'); }
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('gui-invalid-json'); }
    const value = objectResponse(parsed);
    if (value.schemaVersion !== PROTOCOL) throw new Error('gui-protocol-version-mismatch');
    this.validateResponseMetadata(value);
    if (response.status === 401 || response.status === 403 && value.error === 'unauthorized') this.clearSession();
    if (!response.ok) throw new Error(typeof value.error === 'string' ? `gui-${value.error}` : `gui-http-${response.status}`);
    return value;
  }

  private assertConfigured(): void {
    if (!this.config.enabled) throw new Error('gui-harness-disabled');
    if (this.config.error) throw new Error(this.config.error);
  }

  private requireBridgeLink() {
    const session = this.registry.getContext().bridgeSession;
    if (!session?.authenticated) throw new Error('gui-requires-authenticated-neoforge-bridge-session');
    if (this.config.serverIdentity && session.serverIdentity !== this.config.serverIdentity) throw new Error('gui-bridge-server-identity-mismatch');
    if (!sameEndpoint(session.minecraftEndpoint, this.config.minecraftEndpoint ?? '')) throw new Error('gui-bridge-endpoint-mismatch');
    if (this.config.neoForgeVersion && session.neoForgeVersion !== this.config.neoForgeVersion) throw new Error('gui-bridge-neoforge-version-mismatch');
    return session;
  }

  private validateBridgeMetadata(gui: Record<string, unknown>, bridge: NonNullable<ReturnType<RuntimeRegistryService['getContext']>['bridgeSession']>): void {
    if (gui.serverIdentity !== bridge.serverIdentity || !sameEndpoint(String(gui.minecraftEndpoint), bridge.minecraftEndpoint) || gui.serverEpoch !== bridge.sourceRegistryEpoch) {
      this.clearSession(); throw new Error('gui-session-does-not-match-neoforge-bridge-epoch');
    }
    if (typeof gui.graphEpoch !== 'string' || (typeof gui.observedAt !== 'string' && typeof gui.connectedAt !== 'string')) throw new Error('gui-response-missing-session-metadata');
    if (gui.minecraftVersion !== this.config.minecraftVersion || gui.neoForgeVersion !== this.config.neoForgeVersion) throw new Error('gui-runtime-version-mismatch');
    if (this.session && gui.graphEpoch !== this.session.graphEpoch) { this.clearSession(); throw new Error('gui-session-invalidated-by-client-reconnect'); }
  }

  private validateResponseMetadata(value: Record<string, unknown>): void {
    if (typeof value.serverIdentity === 'string' && this.config.serverIdentity && value.serverIdentity !== this.config.serverIdentity) {
      this.clearSession(); throw new Error('gui-response-server-identity-mismatch');
    }
    if (typeof value.minecraftEndpoint === 'string' && this.config.minecraftEndpoint && !sameEndpoint(value.minecraftEndpoint, this.config.minecraftEndpoint)) {
      this.clearSession(); throw new Error('gui-response-endpoint-mismatch');
    }
    if (this.session) {
      if (typeof value.serverEpoch === 'string' && value.serverEpoch !== this.session.serverEpoch) { this.clearSession(); throw new Error('gui-response-server-epoch-mismatch'); }
      if (typeof value.graphEpoch === 'string' && value.graphEpoch !== this.session.graphEpoch) { this.clearSession(); throw new Error('gui-response-client-epoch-mismatch'); }
    }
  }
}

function objectResponse(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('gui-invalid-response-shape');
  return value as Record<string, unknown>;
}

function handshakeSchema(value: unknown): GuiSession {
  const row = objectResponse(value);
  if (row.schemaVersion !== PROTOCOL || typeof row.sessionId !== 'string' || typeof row.clientId !== 'string' || typeof row.graphEpoch !== 'string' ||
      typeof row.serverEpoch !== 'string' || typeof row.serverIdentity !== 'string' || typeof row.minecraftEndpoint !== 'string' ||
      typeof row.minecraftVersion !== 'string' || typeof row.neoForgeVersion !== 'string' ||
      typeof row.observedAt !== 'string' || typeof row.player !== 'string') throw new Error('gui-invalid-handshake-response');
  return { sessionId: row.sessionId, clientId: row.clientId, graphEpoch: row.graphEpoch, serverEpoch: row.serverEpoch,
    serverIdentity: row.serverIdentity, minecraftEndpoint: row.minecraftEndpoint, minecraftVersion: row.minecraftVersion,
    neoForgeVersion: row.neoForgeVersion, connectedAt: row.observedAt };
}

function sameEndpoint(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const endpoint = parseEndpoint(value);
    return endpoint ? `${endpoint.host}:${endpoint.port}` : '';
  };
  return normalize(left) !== '' && normalize(left) === normalize(right);
}
