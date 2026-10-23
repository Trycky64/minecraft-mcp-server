import test from 'ava';
import sinon from 'sinon';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NeoForgeBridgeClient, NeoForgeBridgeIntegration, readBridgeClientConfig } from '../src/bridge/neoforge-bridge-client.js';
import type { BridgeAdapterError } from '../src/bridge/bridge-adapter-contract.js';
import { RuntimeRegistryService } from '../src/services/runtime-registry-service.js';
import type mineflayer from 'mineflayer';

const secret = 'local-development-secret-with-more-than-32-chars';
const serverIdentity = 'processia-dev-01';
const javaEpoch = 'b4490c33-6321-4e6c-8a5d-3d57244c885d';
const observedAt = '2026-10-13T10:00:00.000Z';
function config(env: Record<string, string | undefined> = {}) {
  return readBridgeClientConfig({ ...env, PROCESSIA_BRIDGE_ENABLED: 'true', PROCESSIA_BRIDGE_SECRET: secret,
    PROCESSIA_BRIDGE_SERVER_IDENTITY: serverIdentity, PROCESSIA_MINECRAFT_ENDPOINT: '127.0.0.1:25565',
    PROCESSIA_BRIDGE_NEOFORGE_VERSION: '21.1.259', ...env });
}
function base() { return { schemaVersion: 1, minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', serverIdentity,
  minecraftEndpoint: '127.0.0.1:25565', registryEpoch: javaEpoch, observedAt }; }
function handshake() { return { ...base(), sessionId: '267318c8-a93c-48e9-8d92-6d30d78528b8' }; }
function bridgeReply(init: RequestInit | undefined, body: Record<string, unknown>, status = 200): Response {
  const headers = new Headers(init?.headers);
  const responseHeader = headers.has('X-Minecraft-MCP-Request-Id') ? 'X-Minecraft-MCP-Request-Id' : 'X-Processia-Request-Id';
  const requestId = headers.get(responseHeader) ?? '';
  return new Response(JSON.stringify({ ...body, requestId }), { status, headers: { [responseHeader]: requestId } });
}

test('generic bridge mode loads owner-only ephemeral credentials and uses generic protocol headers', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'minecraft-mcp-bridge-test-'));
  const credentialFile = join(directory, 'bridge.credentials.json');
  const generatedSecret = 'generated-ephemeral-test-secret-with-at-least-32-characters';
  writeFileSync(credentialFile, JSON.stringify({ format: 'minecraft-mcp-bridge-credential-v1', secret: generatedSecret,
    serverIdentity, minecraftEndpoint: '127.0.0.1:25565', neoForgeVersion: '21.1.259' }));
  chmodSync(credentialFile, 0o600);
  t.teardown(() => rmSync(directory, { recursive: true, force: true }));
  t.false(readFileSync(credentialFile, 'utf8').includes('should-not-be-logged'));
  const cfg = readBridgeClientConfig({ MINECRAFT_MCP_BRIDGE_ENABLED: 'true', MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE: credentialFile });
  t.is(cfg.mode, 'generic');
  t.is(cfg.headerPrefix, 'X-Minecraft-MCP');
  t.is(cfg.secret, generatedSecret);
  t.is(cfg.configurationError, null);

  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (_input, init) => bridgeReply(init, handshake()));
  t.teardown(() => fetch.restore());
  const client = new NeoForgeBridgeClient(cfg);
  await client.handshake('1.21.1', '127.0.0.1:25565');
  const headers = new Headers(fetch.firstCall.args[1]?.headers);
  t.truthy(headers.get('X-Minecraft-MCP-Request-Id'));
  t.is(headers.get('X-Processia-Request-Id'), null);
  const { runtime } = mockRuntime();
  const integration = new NeoForgeBridgeIntegration(runtime, cfg);
  t.false(JSON.stringify(integration.status()).includes(generatedSecret));
});

test('generic bridge credential loading rejects oversized files before parsing', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'minecraft-mcp-bridge-test-'));
  const credentialFile = join(directory, 'bridge.credentials.json');
  writeFileSync(credentialFile, `${JSON.stringify({ format: 'minecraft-mcp-bridge-credential-v1', secret,
    serverIdentity, minecraftEndpoint: '127.0.0.1:25565', neoForgeVersion: '21.1.259' })}${' '.repeat(16 * 1024)}`);
  chmodSync(credentialFile, 0o600);
  t.teardown(() => rmSync(directory, { recursive: true, force: true }));

  const cfg = readBridgeClientConfig({ MINECRAFT_MCP_BRIDGE_ENABLED: 'true', MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE: credentialFile });
  t.is(cfg.configurationError, 'credential-file-unavailable-or-invalid');
  t.is(cfg.secret, null);
  t.false(JSON.stringify(cfg).includes(secret));
});

test.serial('generic registry index accepts additional registry types with stable pagination semantics', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    return bridgeReply(init, { ...base(), completeness: 'complete', registries: ['blockState', 'item', 'registry:example:custom'] });
  });
  t.teardown(() => fetch.restore());
  const genericConfig = readBridgeClientConfig({ MINECRAFT_MCP_BRIDGE_ENABLED: 'true', MINECRAFT_MCP_BRIDGE_SECRET: secret,
    MINECRAFT_MCP_BRIDGE_SERVER_IDENTITY: serverIdentity, MINECRAFT_MCP_SERVER_ENDPOINT: '127.0.0.1:25565',
    MINECRAFT_MCP_BRIDGE_NEOFORGE_VERSION: '21.1.259' });
  const client = new NeoForgeBridgeClient(genericConfig);
  await client.handshake('1.21.1', '127.0.0.1:25565');
  t.deepEqual(await client.registryKinds(), ['blockState', 'item', 'registry:example:custom']);
});

test.serial('generic registry refresh preserves per-session numeric-ID scope and mod namespaces', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    if (url.pathname.endsWith('/registry-kinds')) return bridgeReply(init, { ...base(), completeness: 'complete', registries: ['item', 'registry:thirdparty:tools'] });
    const kind = url.searchParams.get('kind')!;
    const entries = kind === 'item'
      ? [{ namespacedId: 'thirdparty:steel_ingot', numericId: 1200, numericIdScope: 'server-registry-generation', kind }]
      : [{ namespacedId: 'thirdparty:hammer', numericId: 4, numericIdScope: 'server-registry-generation', kind }];
    return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset: 0, limit: 500, total: entries.length, entries });
  });
  t.teardown(() => fetch.restore());
  const genericConfig = readBridgeClientConfig({ MINECRAFT_MCP_BRIDGE_ENABLED: 'true', MINECRAFT_MCP_BRIDGE_SECRET: secret,
    MINECRAFT_MCP_BRIDGE_SERVER_IDENTITY: serverIdentity, MINECRAFT_MCP_SERVER_ENDPOINT: '127.0.0.1:25565',
    MINECRAFT_MCP_BRIDGE_NEOFORGE_VERSION: '21.1.259' });
  const { runtime } = mockRuntime();
  const before = runtime.getContext();
  const integration = new NeoForgeBridgeIntegration(runtime, genericConfig);
  await integration.refreshRegistries();
  t.true(fetch.getCalls().some((call) => new URL(String(call.args[0])).searchParams.get('limit') === '500'));
  const result = runtime.getContext().registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1',
    registryEpoch: before.registryEpoch!, namespacedId: 'thirdparty:steel_ingot' });
  t.is(result.status, 'resolved');
  if (result.status === 'resolved') {
    t.is(result.provenance.source, 'neoforge-bridge');
    t.is(result.provenance.authority, 'authenticated-runtime');
    t.is(result.entry.numericId, 1200);
    t.is(result.entry.numericIdScope, 'server-registry-generation');
    t.is(result.provenance.registryEpoch, before.registryEpoch);
    t.is(result.provenance.runtimeEpoch, before.runtimeEpoch);
    t.is(result.provenance.mineflayerSessionId, before.mineflayerSessionId);
    t.is(result.provenance.mineflayerRegistryEpoch, before.registryEpoch);
    t.is(result.provenance.bridgeSessionId, runtime.getContext().bridgeSessionId);
    t.is(result.provenance.sourceRegistryEpoch, javaEpoch);
    t.is(result.provenance.minecraftEndpoint, '127.0.0.1:25565');
    t.is(result.provenance.registryCoverage, 'complete');
  }
});
function mockRuntime() {
  let bot = { version: '1.21.1', protocolVersion: '1.21.1' } as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => bot, isConnected: () => true, getConfig: () => ({ host: '127.0.0.1', port: 25565 }) });
  return { runtime, replaceBot: () => { bot = { version: '1.21.1', protocolVersion: '1.21.1' } as mineflayer.Bot; } };
}

test('bridge client is disabled by default and never exposes configured secret in status', (t) => {
  const disabled = readBridgeClientConfig({});
  t.false(disabled.enabled);
  const integration = new NeoForgeBridgeIntegration(mockRuntime().runtime, config());
  t.false(JSON.stringify(integration.status()).includes(secret));
  t.true(JSON.stringify(integration.status()).includes('secretConfigured'));
});

test.serial('bridge-only authenticates and creates a registry context without Mineflayer', async (t) => {
  const expectedEndpoint = '127.0.0.1:25665';
  const bridgeOnlyConfig = readBridgeClientConfig({
    MINECRAFT_MCP_BRIDGE_ENABLED: 'true', MINECRAFT_MCP_BRIDGE_URL: 'http://127.0.0.1:25677',
    MINECRAFT_MCP_BRIDGE_SECRET: secret, MINECRAFT_MCP_BRIDGE_SERVER_IDENTITY: serverIdentity,
    MINECRAFT_MCP_SERVER_ENDPOINT: expectedEndpoint, MINECRAFT_MCP_BRIDGE_NEOFORGE_VERSION: '21.1.259',
    MINECRAFT_MCP_BRIDGE_MINECRAFT_VERSION: '1.21.1', MINECRAFT_MCP_CONNECTION_MODE: 'bridge-only',
  });
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (_input, init) => bridgeReply(init, { ...handshake(), minecraftEndpoint: expectedEndpoint }));
  t.teardown(() => fetch.restore());
  const runtime = new RuntimeRegistryService({ getBot: () => null, isConnected: () => false,
    getConfig: () => ({ host: '127.0.0.1', port: 25665 }), getConnectionMode: () => 'bridge-only' });
  const bridge = new NeoForgeBridgeIntegration(runtime, bridgeOnlyConfig);
  const result = await bridge.connectBridgeOnly('1.21.1');
  t.is(result.status, 'authenticated');
  t.is(fetch.callCount, 1);
  t.is(runtime.getContext().connectionMode, 'bridge-only');
  t.false(runtime.getContext().playerAvailable);
  t.true(runtime.getContext().bridgeAvailable);
  t.is(runtime.getContext().registryService!.resolve({ kind: 'block', minecraftVersion: '1.21.1', namespacedId: 'minecraft:stone' }).status, 'resolved');
  t.false(JSON.stringify(bridge.status()).includes(secret));
});

test('enabled client rejects non-loopback bridge URLs and weak secrets', (t) => {
  const outside = config({ PROCESSIA_BRIDGE_URL: 'http://192.0.2.1:25576' });
  t.is(outside.configurationError, 'bridge-url-must-be-loopback-http');
  const weak = config({ PROCESSIA_BRIDGE_SECRET: 'short' });
  t.is(weak.configurationError, 'bridge-secret-must-have-at-least-32-characters');
  const invalidIdentity = config({ PROCESSIA_BRIDGE_SERVER_IDENTITY: 'line\nbreak' });
  t.is(invalidIdentity.configurationError, 'bridge-server-identity-invalid');
});

test.serial('handshake checks protocol, identity, endpoint and both runtime versions', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (_input, init) => bridgeReply(init, handshake()));
  t.teardown(() => fetch.restore());
  const client = new NeoForgeBridgeClient(config());
  const result = await client.handshake('1.21.1', 'localhost:25565');
  t.is(result.serverIdentity, serverIdentity);
  const sent = JSON.parse(String(fetch.firstCall.args[1]?.body));
  t.is(sent.expectedServerIdentity, serverIdentity);
  t.is(sent.expectedMinecraftEndpoint, '127.0.0.1:25565');
  t.is((fetch.firstCall.args[1]?.headers as Record<string, string>).Authorization, `Bearer ${secret}`);
  t.regex((fetch.firstCall.args[1]?.headers as Record<string, string>)['X-Processia-Request-Id']!, /^[0-9a-f-]{36}$/);
});

test.serial('bridge client rejects a response with a different request ID', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (_input, _init) => {
    const wrong = '5321adca-8b54-447f-8fba-dfd8f3c51396';
    return new Response(JSON.stringify({ ...handshake(), requestId: wrong }), { status: 200, headers: { 'X-Processia-Request-Id': wrong } });
  });
  t.teardown(() => fetch.restore());
  const client = new NeoForgeBridgeClient(config());
  await t.throwsAsync(client.handshake('1.21.1', '127.0.0.1:25565'), { message: /bridge-response-header-request-id-mismatch/ });
  t.is(client.getSession(), null);
});

test.serial('handshake rejects wrong server, Minecraft or NeoForge identity', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch');
  t.teardown(() => fetch.restore());
  const client = new NeoForgeBridgeClient(config());
  fetch.callsFake(async (_input, init) => bridgeReply(init, { ...handshake(), serverIdentity: 'other-server' }));
  await t.throwsAsync(client.handshake('1.21.1', '127.0.0.1:25565'), { message: 'bridge-server-identity-mismatch' });
  fetch.callsFake(async (_input, init) => bridgeReply(init, { ...handshake(), minecraftVersion: '1.21.11' }));
  await t.throwsAsync(client.handshake('1.21.1', '127.0.0.1:25565'), { message: 'bridge-minecraft-version-mismatch' });
  fetch.callsFake(async (_input, init) => bridgeReply(init, { ...handshake(), neoForgeVersion: '21.1.258' }));
  await t.throwsAsync(client.handshake('1.21.1', '127.0.0.1:25565'), { message: 'bridge-neoforge-version-mismatch' });
});

test.serial('refresh maps Java generation into current bot epoch without conflating the two', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    const kind = url.searchParams.get('kind')!;
    const entries = kind === 'item' ? [{ namespacedId: 'processia:crusher', numericId: 9001, kind }] : [];
    return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset: 0, limit: 500, total: entries.length, entries });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime(); const before = runtime.getContext();
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  const refresh = await integration.refreshRegistries();
  const after = runtime.getContext();
  t.true(after.bridgeAvailable);
  t.is(after.registryEpoch, before.registryEpoch);
  t.is(after.bridgeSession?.sourceRegistryEpoch, javaEpoch);
  t.not(after.registryEpoch, after.bridgeSession?.sourceRegistryEpoch);
  const mapping = after.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', registryEpoch: after.registryEpoch!, namespacedId: 'processia:crusher' });
  t.is(mapping.status, 'resolved');
  if (mapping.status === 'resolved') {
    t.is(mapping.entry.numericId, 9001);
    t.is(mapping.provenance.serverIdentity, serverIdentity);
    t.is(mapping.provenance.sourceRegistryEpoch, javaEpoch);
  }
  t.is((refresh as { registries: unknown[] }).registries.length, 8);
});

test.serial('registry page metadata changes are rejected before injection', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/handshake')) return bridgeReply(init, handshake());
    return bridgeReply(init, { ...base(), registryEpoch: '7b786a3e-a399-44e4-b18f-e6950f4b949d', kind: 'item', completeness: 'partial', offset: 0, limit: 500, total: 0, entries: [] });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime(); const integration = new NeoForgeBridgeIntegration(runtime, config());
  const staleEpoch = await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-session-metadata-changed' });
  t.is((staleEpoch as BridgeAdapterError).code, 'stale-registry-epoch');
  t.false(runtime.getContext().bridgeAvailable);
});

test.serial('every data response validates endpoint identity and numeric ID collisions fail closed', async (t) => {
  let corruptEndpoint = true;
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/handshake')) return bridgeReply(init, handshake());
    const kind = new URL(String(input)).searchParams.get('kind')!;
    const badRows = kind === 'item' ? [
      { namespacedId: 'processia:one', numericId: 500, kind },
      { namespacedId: 'processia:two', numericId: 500, kind },
    ] : [];
    return bridgeReply(init, { ...base(), ...(corruptEndpoint ? { minecraftEndpoint: '127.0.0.1:25566' } : {}), kind,
      completeness: 'complete', offset: 0, limit: 500, total: badRows.length, entries: badRows });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime(); const integration = new NeoForgeBridgeIntegration(runtime, config());
  const wrongIdentity = await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-session-metadata-changed' });
  t.is((wrongIdentity as BridgeAdapterError).code, 'server-identity-mismatch');
  t.false(runtime.getContext().bridgeAvailable);
  corruptEndpoint = false;
  const collision = await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-registry-numeric-id-collision' });
  t.is((collision as BridgeAdapterError).code, 'invalid-bridge-response');
  t.false(runtime.getContext().bridgeAvailable);
});

test.serial('registry pagination rejects a snapshot beyond the bounded memory limit', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    return bridgeReply(init, { ...base(), kind: 'item', completeness: 'complete', offset: 0, limit: 500, total: 100_001, entries: [] });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime(); const integration = new NeoForgeBridgeIntegration(runtime, config());
  await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-registry-total-exceeds-safety-limit' });
  t.false(runtime.getContext().bridgeAvailable);
});

test.serial('registry snapshot is not published when the Java source epoch changes between pages', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    const kind = url.searchParams.get('kind')!;
    const offset = Number(url.searchParams.get('offset'));
    const rows = offset === 0
      ? Array.from({ length: 500 }, (_, index) => ({ namespacedId: `processia:item_${index}`, numericId: index, kind }))
      : [{ namespacedId: 'processia:item_500', numericId: 500, kind }];
    return bridgeReply(init, { ...base(), ...(offset ? { registryEpoch: '78ea6b8d-40b5-4c9f-8bf0-bdb54ad3fa9c' } : {}), kind,
      completeness: 'complete', offset, limit: 500, total: 501, entries: rows });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime();
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  const error = await t.throwsAsync(integration.refreshRegistries());
  t.is((error as BridgeAdapterError).code, 'stale-registry-epoch');
  t.is(runtime.getContext().registryService!.getEntries({ source: 'neoforge-bridge', limit: null }).length, 0);
  t.false(runtime.getContext().bridgeAvailable);
});

test.serial('closing the bridge during paginated refresh prevents later publication', async (t) => {
  let resolvePage!: (response: Response) => void;
  let pageRequested!: () => void;
  let pageInit: RequestInit | undefined;
  const pendingPage = new Promise<Response>(resolve => { resolvePage = resolve; });
  const requested = new Promise<void>(resolve => { pageRequested = resolve; });
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    const kind = url.searchParams.get('kind')!;
    if (url.pathname.endsWith('/close')) return bridgeReply(init, { closed: true });
    if (kind === 'item') { pageInit = init; pageRequested(); return pendingPage; }
    return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset: 0, limit: 500, total: 0, entries: [] });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime();
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  const refresh = integration.refreshRegistries();
  await requested;
  await integration.close();
  resolvePage(bridgeReply(pageInit, { ...base(), kind: 'item', completeness: 'complete', offset: 0, limit: 500, total: 1,
    entries: [{ namespacedId: 'processia:late', numericId: 91, kind: 'item' }] }));
  await t.throwsAsync(refresh, { message: 'bridge-session-expired' });
  t.is(runtime.getContext().registryService!.getEntries({ source: 'neoforge-bridge', limit: null }).length, 0);
  t.false(runtime.getContext().bridgeAvailable);
});

test.serial('duplicate rows across pages fail closed without publishing a snapshot', async (t) => {
  const duplicate = { namespacedId: 'processia:duplicate', numericId: 1373, kind: 'item' };
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    const kind = url.searchParams.get('kind')!;
    if (kind === 'item') {
      const offset = Number(url.searchParams.get('offset'));
      return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset, limit: 500, total: 2, entries: [duplicate] });
    }
    return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset: 0, limit: 500, total: 0, entries: [] });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime();
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  await t.throwsAsync(integration.refreshRegistries(), { message: /bridge-registry-duplicate/ });
  t.is(runtime.getContext().registryService!.getEntries({ source: 'neoforge-bridge', limit: null }).length, 0);
  t.false(runtime.getContext().bridgeAvailable);
});

test.serial('an omitted page before the reported total cannot produce an empty complete snapshot', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    const kind = url.searchParams.get('kind')!;
    return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset: Number(url.searchParams.get('offset')), limit: 500,
      total: kind === 'item' ? 2 : 0, entries: [] });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime();
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-registry-pagination-inconsistent' });
  t.is(runtime.getContext().registryService!.getEntries({ source: 'neoforge-bridge', limit: null }).length, 0);
});

test.serial('a changed page total invalidates the entire registry read', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    const kind = url.searchParams.get('kind')!;
    const offset = Number(url.searchParams.get('offset'));
    const entries = kind === 'item' ? [{ namespacedId: `processia:page_${offset}`, numericId: offset, kind }] : [];
    return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset, limit: 500,
      total: kind === 'item' && offset === 0 ? 2 : kind === 'item' ? 3 : 0, entries });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime();
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-registry-pagination-inconsistent' });
  t.is(runtime.getContext().registryService!.getEntries({ source: 'neoforge-bridge', limit: null }).length, 0);
});

test.serial('a newer concurrent registry refresh wins and an older completion cannot replace it', async (t) => {
  let resolveOldPage!: (response: Response) => void;
  let oldPageRequested!: () => void;
  const oldPage = new Promise<Response>(resolve => { resolveOldPage = resolve; });
  const pageRequested = new Promise<void>(resolve => { oldPageRequested = resolve; });
  let pageCalls = 0;
  let oldPageInit: RequestInit | undefined;
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    const kind = url.searchParams.get('kind')!;
    if (kind !== 'item') return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset: 0, limit: 500, total: 0, entries: [] });
    pageCalls += 1;
    if (pageCalls === 1) {
      oldPageRequested();
      oldPageInit = init;
      return oldPage;
    }
    return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset: 0, limit: 500, total: 1,
      entries: [{ namespacedId: 'processia:current', numericId: 222, kind }] });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime();
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  const olderRefresh = integration.refreshRegistries();
  await pageRequested;
  await integration.refreshRegistries();
  resolveOldPage(bridgeReply(oldPageInit, { ...base(), kind: 'item', completeness: 'complete', offset: 0, limit: 500, total: 1,
    entries: [{ namespacedId: 'processia:stale', numericId: 111, kind: 'item' }] }));
  const superseded = await t.throwsAsync(olderRefresh, { message: 'bridge-registry-refresh-superseded' });
  t.is((superseded as BridgeAdapterError).code, 'operation-superseded');
  const context = runtime.getContext();
  t.true(context.bridgeAvailable);
  t.truthy(integration.adapter.session);
  t.is(context.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', registryEpoch: context.registryEpoch!, namespacedId: 'processia:current' }).status, 'resolved');
  t.is(context.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', registryEpoch: context.registryEpoch!, namespacedId: 'processia:stale' }).status, 'unresolved');
});

test.serial('a partial runtime snapshot keeps unknown IDs unobserved and exposes its provenance', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    const kind = url.searchParams.get('kind')!;
    const entries = kind === 'item' ? [{ namespacedId: 'processia:known', numericId: 12, kind }] : [];
    return bridgeReply(init, { ...base(), kind, completeness: 'partial', offset: 0, limit: 500, total: entries.length, entries });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime();
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  await integration.refreshRegistries();
  const context = runtime.getContext();
  const snapshot = context.registryService!.getSnapshots().find(item => item.source === 'neoforge-bridge');
  t.is(snapshot?.registryCoverage?.item, 'partial');
  const known = context.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', registryEpoch: context.registryEpoch!, namespacedId: 'processia:known' });
  t.is(known.status, 'resolved');
  if (known.status === 'resolved') {
    t.is(known.provenance.registryCoverage, 'partial');
    t.is(known.provenance.authority, 'authenticated-runtime');
  }
  const unknown = context.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', registryEpoch: context.registryEpoch!, numericId: 1373 });
  t.is(unknown.status, 'unresolved');
  if (unknown.status === 'unresolved') t.is(unknown.reason, 'mapping-not-observed');
});

test.serial('a reconnected bot with the same version but a different server identity cannot reuse the old snapshot', async (t) => {
  const { runtime, replaceBot } = mockRuntime();
  let handshakes = 0;
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/handshake')) {
      handshakes += 1;
      return bridgeReply(init, handshakes === 1 ? handshake() : { ...handshake(), serverIdentity: 'another-server' });
    }
    const kind = url.searchParams.get('kind')!;
    const entries = handshakes === 1 && kind === 'item' ? [{ namespacedId: 'processia:old_identity', numericId: 44, kind }] : [];
    return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset: 0, limit: 500, total: entries.length, entries });
  });
  t.teardown(() => fetch.restore());
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  const oldContext = runtime.getContext();
  await integration.refreshRegistries();
  t.is(runtime.getContext().serverIdentity, serverIdentity);
  replaceBot();
  const next = runtime.getContext();
  t.not(next.registryEpoch, oldContext.registryEpoch);
  await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-server-identity-mismatch' });
  const current = runtime.getContext();
  t.is(current.serverIdentity, null);
  t.false(current.bridgeAvailable);
  t.is(current.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', registryEpoch: current.registryEpoch!, namespacedId: 'processia:old_identity' }).status, 'unresolved');
  t.is(handshakes, 2);
});

test.serial('reconnect during a pending registry page cannot publish stale mappings', async (t) => {
  const { runtime, replaceBot } = mockRuntime();
  let releasePage!: (response: Response) => void;
  let requestedPage!: () => void;
  const pageRequested = new Promise<void>(resolve => { requestedPage = resolve; });
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    requestedPage();
    return await new Promise<Response>(resolve => { releasePage = resolve; });
  });
  t.teardown(() => fetch.restore());
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  const oldEpoch = runtime.getContext().registryEpoch!;
  const refresh = integration.refreshRegistries();
  await pageRequested;
  replaceBot();
  releasePage(bridgeReply(fetch.lastCall.args[1], { ...base(), kind: 'item', completeness: 'complete', offset: 0, limit: 500, total: 1,
    entries: [{ namespacedId: 'processia:crusher', numericId: 1234, kind: 'item' }] }));
  const staleRuntime = await t.throwsAsync(refresh, { message: 'bridge-operation-invalidated-by-runtime-session-change' });
  t.is((staleRuntime as BridgeAdapterError).code, 'stale-registry-epoch');
  const context = runtime.getContext();
  t.not(context.registryEpoch, oldEpoch);
  t.false(context.bridgeAvailable);
  t.is(context.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', registryEpoch: context.registryEpoch!, namespacedId: 'processia:crusher' }).status, 'unresolved');
});

test.serial('bot reconnect requires a fresh bridge handshake and invalidates prior mappings', async (t) => {
  const { runtime, replaceBot } = mockRuntime();
  let generation = 0;
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/handshake')) {
      generation += 1;
      return bridgeReply(init, { ...handshake(), registryEpoch: generation === 1 ? javaEpoch : 'a2f6b000-6e68-48e0-b76b-44ded8d97e0e', sessionId: generation === 1 ? handshake().sessionId : 'f3ac08b0-5227-4d5b-ab42-f562e13207d6' });
    }
    const kind = new URL(String(input)).searchParams.get('kind')!;
    const entries = generation === 1 && kind === 'item' ? [{ namespacedId: 'processia:crusher', numericId: 9001, kind }] : [];
    return bridgeReply(init, { ...base(), registryEpoch: generation === 1 ? javaEpoch : 'a2f6b000-6e68-48e0-b76b-44ded8d97e0e', kind, completeness: 'partial', offset: 0, limit: 500, total: entries.length, entries });
  });
  t.teardown(() => fetch.restore());
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  const before = runtime.getContext(); await integration.refreshRegistries();
  t.is(runtime.getContext().registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', registryEpoch: before.registryEpoch!, namespacedId: 'processia:crusher' }).status, 'resolved');
  replaceBot(); const after = runtime.getContext();
  t.not(after.registryEpoch, before.registryEpoch);
  await integration.refreshRegistries();
  t.is(runtime.getContext().bridgeSession?.sourceRegistryEpoch, 'a2f6b000-6e68-48e0-b76b-44ded8d97e0e');
  t.is(runtime.getContext().registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', registryEpoch: after.registryEpoch!, namespacedId: 'processia:crusher' }).status, 'unresolved');
  t.is(generation, 2);
});

test.serial('superseded integration handshake cannot clear a newer authenticated session', async (t) => {
  let resolveFirst!: (response: Response) => void;
  let resolveSecond!: (response: Response) => void;
  const firstHandshake = new Promise<Response>(resolve => { resolveFirst = resolve; });
  const secondHandshake = new Promise<Response>(resolve => { resolveSecond = resolve; });
  let handshakeCalls = 0;
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/handshake')) {
      handshakeCalls += 1;
      return handshakeCalls === 1 ? firstHandshake : secondHandshake;
    }
    const kind = new URL(String(input)).searchParams.get('kind')!;
    return bridgeReply(init, { ...base(), kind, completeness: 'complete', offset: 0, limit: 500, total: 0, entries: [] });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime();
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  const earlierRefresh = integration.refreshRegistries();
  const latestRefresh = integration.refreshRegistries();
  const secondId = 'f3ac08b0-5227-4d5b-ab42-f562e13207d6';
  resolveSecond(bridgeReply(fetch.secondCall.args[1], { ...handshake(), sessionId: secondId }));
  await latestRefresh;
  t.is(runtime.getContext().bridgeSession?.sessionId, secondId);
  resolveFirst(bridgeReply(fetch.firstCall.args[1], handshake()));
  const stale = await t.throwsAsync(earlierRefresh);
  t.is((stale as BridgeAdapterError).code, 'session-expired');
  t.is(runtime.getContext().bridgeSession?.sessionId, secondId);
  t.is(integration.status().bridgeAvailable, true);
});

test.serial('bridge client reports timeouts and malformed replies without exposing secret', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').rejects(new DOMException('timeout', 'TimeoutError'));
  t.teardown(() => fetch.restore());
  const client = new NeoForgeBridgeClient(config());
  await t.throwsAsync(client.handshake('1.21.1', '127.0.0.1:25565'), { message: 'bridge-request-timeout' });
  t.false(String(client.getSession()).includes(secret));
});

test.serial('local deadline wins over a late fetch response and the late session is never installed', async (t) => {
  let resolveResponse!: (response: Response) => void;
  const pendingResponse = new Promise<Response>(resolve => { resolveResponse = resolve; });
  const fetch = sinon.stub(globalThis, 'fetch').returns(pendingResponse);
  t.teardown(() => fetch.restore());
  const client = new NeoForgeBridgeClient({ ...config(), timeoutMs: 25 });
  const handshakePromise = client.handshake('1.21.1', '127.0.0.1:25565');
  await t.throwsAsync(handshakePromise, { message: 'bridge-request-timeout' });
  resolveResponse(bridgeReply(fetch.firstCall.args[1], handshake()));
  await new Promise(resolve => setTimeout(resolve, 0));
  t.is(client.getSession(), null);
});

test.serial('request deadline cancels a response body that never finishes', async (t) => {
  let cancelled = false;
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (_input, init) => {
    const requestId = new Headers(init?.headers).get('X-Processia-Request-Id') ?? '';
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"requestId":"' + requestId + '"}')); },
      cancel() { cancelled = true; },
    });
    return new Response(body, { status: 200, headers: { 'X-Processia-Request-Id': requestId } });
  });
  t.teardown(() => fetch.restore());
  const client = new NeoForgeBridgeClient({ ...config(), timeoutMs: 25 });
  await t.throwsAsync(client.handshake('1.21.1', '127.0.0.1:25565'), { message: 'bridge-request-timeout' });
  t.true(cancelled);
  t.is(client.getSession(), null);
});

test.serial('oversized streaming responses are cancelled at the byte limit', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').resolves(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_500_000));
      controller.enqueue(new Uint8Array(1_000_000));
      controller.close();
    },
  }), { status: 200 }));
  t.teardown(() => fetch.restore());
  const client = new NeoForgeBridgeClient(config());
  await t.throwsAsync(client.handshake('1.21.1', '127.0.0.1:25565'), { message: 'bridge-response-too-large' });
});

test.serial('machine absence returns the bridge structured chunk error and keeps the authenticated session', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    return bridgeReply(init, { schemaVersion: 1, error: 'chunk_not_loaded', message: 'Chunk is not already loaded' }, 404);
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime(); const integration = new NeoForgeBridgeIntegration(runtime, config());
  await t.throwsAsync(integration.inspectMachine({ dimension: 'minecraft:overworld', x: 1, y: 64, z: 1 }), { message: 'bridge-chunk_not_loaded' });
  t.true(runtime.getContext().bridgeAvailable);
  t.is(integration.status().lastError, 'bridge-chunk_not_loaded');
});

test.serial('machine, inventory, FE and recipe payloads are schema-checked and preserved', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/handshake')) return bridgeReply(init, handshake());
    if (path.endsWith('/inspect-machine')) return bridgeReply(init, { ...base(), dimension: 'minecraft:overworld', x: 1, y: 64, z: 2,
      block: 'processia:crusher', blockStateId: 9001, blockStateProperties: { facing: 'north' }, blockEntityType: 'processia:crusher', blockEntityPresent: true,
      inventory: { available: true, slots: 2, items: [{ slot: 0, count: 1, empty: false, item: 'processia:copper_dust', components: ['minecraft:custom_name'] }] },
      energyCapabilities: [{ face: 'north', available: true, stored: 50, capacity: 10000, canReceive: true, canExtract: false }],
      energyNetwork: { available: true, cables: [{ x: 1, y: 64, z: 2 }], energyEndpoints: [], transferMeasurement: 'observed_this_tick', transferredThisTick: 12, transferLimitPerTick: 128 },
      processiaMachine: { kind: 'crusher', energyStored: 50, energyCapacity: 10000, progress: 2, burnTime: 0, redstoneMode: 'ignored', active: true, locked: true } });
    return bridgeReply(init, { ...base(), completeness: 'complete', offset: 0, limit: 100, total: 1,
      recipes: [{ id: 'processia:crushing/copper_dust', type: 'processia:crushing', processingTime: 80, energyPerTick: 40 }] });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime(); const integration = new NeoForgeBridgeIntegration(runtime, config());
  const machine = await integration.inspectMachine({ dimension: 'minecraft:overworld', x: 1, y: 64, z: 2 });
  t.is((machine.inventory as { slots: number }).slots, 2);
  t.is((machine.energyCapabilities?.[0] as { stored: number }).stored, 50);
  t.is(machine.energyNetwork?.transferredThisTick, 12);
  t.is(machine.processiaMachine?.['progress'], 2);
  const recipes = await integration.inspectRecipes();
  t.is(recipes.total, 1);
  t.is(recipes.recipes[0]?.['id'], 'processia:crushing/copper_dust');
});

test.serial('machine inspection accepts a block without a block entity and normalizes its type to null', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    return bridgeReply(init, { ...base(), dimension: 'minecraft:overworld', x: 10, y: 80, z: 4,
      block: 'minecraft:air', blockStateId: 0, blockStateProperties: {}, blockEntityPresent: false });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime();
  const integration = new NeoForgeBridgeIntegration(runtime, config());
  const machine = await integration.inspectMachine({ dimension: 'minecraft:overworld', x: 10, y: 80, z: 4 });
  t.is(machine.blockEntityType, null);
  t.is(machine.blockEntityPresent, false);
});

test.serial('machine search validates bounded pagination and preserves partial loaded-chunk coverage', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/handshake')) return bridgeReply(init, handshake());
    return bridgeReply(init, { ...base(), dimension: 'minecraft:overworld', centerX: 10, centerY: 64, centerZ: -2,
      radius: 8, coverage: 'partial', unloadedChunkCount: 2, total: 1, offset: 0, limit: 20,
      machines: [{ x: 11, y: 64, z: -2, block: 'processia:crusher', blockStateId: 9001, blockEntityPresent: true }] });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime(); const integration = new NeoForgeBridgeIntegration(runtime, config());
  const result = await integration.listMachines({ dimension: 'minecraft:overworld', x: 10, y: 64, z: -2, radius: 8, offset: 0, limit: 20 });
  t.is(result.coverage, 'partial');
  t.is(result.unloadedChunkCount, 2);
  t.is(result.machines[0]?.['block'], 'processia:crusher');
  await t.throwsAsync(integration.listMachines({ dimension: 'minecraft:overworld', x: 0, y: 64, z: 0, radius: 17, offset: 0, limit: 20 }), { message: 'bridge-invalid-machine-search-request' });
});

test.serial('malformed registry response drops session and injected runtime bridge state', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    return new Response('{broken-json', { status: 200, headers: { 'X-Processia-Request-Id': new Headers(init?.headers).get('X-Processia-Request-Id')! } });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime(); const integration = new NeoForgeBridgeIntegration(runtime, config());
  await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-invalid-json' });
  t.false(runtime.getContext().bridgeAvailable);
  t.is(integration.status().lastError, 'bridge-invalid-json');
});
