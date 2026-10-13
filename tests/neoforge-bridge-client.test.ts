import test from 'ava';
import sinon from 'sinon';
import { NeoForgeBridgeClient, NeoForgeBridgeIntegration, readBridgeClientConfig } from '../src/bridge/neoforge-bridge-client.js';
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
  const requestId = headers.get('X-Processia-Request-Id') ?? '';
  return new Response(JSON.stringify({ ...body, requestId }), { status, headers: { 'X-Processia-Request-Id': requestId } });
}
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
  await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-session-metadata-changed' });
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
  await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-session-metadata-changed' });
  t.false(runtime.getContext().bridgeAvailable);
  corruptEndpoint = false;
  await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-registry-numeric-id-collision' });
  t.false(runtime.getContext().bridgeAvailable);
});

test.serial('registry pagination rejects a snapshot beyond the bounded memory limit', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/handshake')) return bridgeReply(init, handshake());
    return bridgeReply(init, { ...base(), kind: 'item', completeness: 'complete', offset: 0, limit: 500, total: 50_001, entries: [] });
  });
  t.teardown(() => fetch.restore());
  const { runtime } = mockRuntime(); const integration = new NeoForgeBridgeIntegration(runtime, config());
  await t.throwsAsync(integration.refreshRegistries(), { message: 'bridge-registry-total-exceeds-safety-limit' });
  t.false(runtime.getContext().bridgeAvailable);
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
  await t.throwsAsync(refresh, { message: 'bridge-operation-invalidated-by-runtime-session-change' });
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

test.serial('bridge client reports timeouts and malformed replies without exposing secret', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').rejects(new DOMException('timeout', 'TimeoutError'));
  t.teardown(() => fetch.restore());
  const client = new NeoForgeBridgeClient(config());
  await t.throwsAsync(client.handshake('1.21.1', '127.0.0.1:25565'), { message: 'bridge-request-timeout' });
  t.false(String(client.getSession()).includes(secret));
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
