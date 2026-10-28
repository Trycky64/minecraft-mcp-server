import test from 'ava';
import type mineflayer from 'mineflayer';
import { RuntimeRegistryService } from '../src/services/runtime-registry-service.js';

function createConnection() {
  const state: { bot: mineflayer.Bot | null; connected: boolean; host: string; port: number } = {
    bot: { version: '1.21.1', protocolVersion: '1.21.1' } as mineflayer.Bot,
    connected: true,
    host: '127.0.0.1',
    port: 25565,
  };
  return {
    state,
    access: {
      getBot: () => state.bot,
      isConnected: () => state.connected,
      getConfig: () => ({ host: state.host, port: state.port }),
    },
  };
}

test('initializes static data from the connected bot version and exposes its protocol number', (t) => {
  const { access } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  const context = runtime.getContext();
  t.true(context.connected);
  t.is(context.minecraftVersion, '1.21.1');
  t.is(context.protocolNumber, 767);
  t.truthy(context.registryEpoch);
  t.truthy(context.runtimeEpoch);
  t.truthy(context.mineflayerSessionId);
  t.is(context.mineflayerRegistryEpoch, context.registryEpoch);
  t.not(context.runtimeEpoch, context.registryEpoch);
  t.is(context.serverIdentity, null);
  t.is(context.bridgeAvailable, false);
  t.is(context.registryService?.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'minecraft:diamond' }).status, 'resolved');
});

test('creates a fresh registry epoch and baseline when the bot reconnects', (t) => {
  const { access, state } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  const before = runtime.getContext();
  state.bot = { version: '1.21.1', protocolVersion: '1.21.1' } as mineflayer.Bot;
  const after = runtime.getContext();
  t.not(after.registryEpoch, before.registryEpoch);
  t.is(after.registryService?.getSnapshots().length, 1);
});

test('does not carry runtime snapshot entries into a reconnect session and revokes the old resolver', (t) => {
  const { access, state } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  const before = runtime.getContext();
  runtime.replaceRuntimeSnapshot({
    source: 'protocol', authority: 'protocol-observed', minecraftVersion: '1.21.1', registryEpoch: before.registryEpoch!,
    runtimeEpoch: before.runtimeEpoch!, minecraftEndpoint: before.minecraftEndpoint!,
    mineflayerSessionId: before.mineflayerSessionId!, mineflayerRegistryEpoch: before.mineflayerRegistryEpoch!,
    availableRegistries: ['item'], registryCoverage: { item: 'partial' },
    entries: [{ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:session_only', numericId: 9900, registryEpoch: before.registryEpoch!,
      provenance: { source: 'protocol', authority: 'protocol-observed', minecraftVersion: '1.21.1', registryEpoch: before.registryEpoch!,
        runtimeEpoch: before.runtimeEpoch!, minecraftEndpoint: before.minecraftEndpoint!, mineflayerSessionId: before.mineflayerSessionId!,
        mineflayerRegistryEpoch: before.mineflayerRegistryEpoch! } }],
  });
  t.is(before.registryService?.getEntries({ kind: 'item', namespacedId: 'processia:session_only', limit: null }).length, 1);
  state.bot = { version: '1.21.1', protocolVersion: '1.21.1' } as mineflayer.Bot;
  const after = runtime.getContext();
  t.not(after.registryEpoch, before.registryEpoch);
  t.is(after.registryService?.getEntries({ kind: 'item', namespacedId: 'processia:session_only', limit: null }).length, 0);
  const stale = before.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:session_only', registryEpoch: before.registryEpoch! });
  t.is(stale.status, 'unavailable');
  if (stale.status === 'unavailable') t.is(stale.reason, 'stale-context');
});

test('invalidates the runtime service when disconnected', (t) => {
  const { access, state } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  t.truthy(runtime.getContext().registryService);
  state.connected = false;
  const context = runtime.getContext();
  t.false(context.connected);
  t.is(context.registryEpoch, null);
  t.is(context.registryService, null);
});

test('does not reuse session data when the server endpoint changes', (t) => {
  const { access, state } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  const before = runtime.getContext();
  state.host = 'mc.example.net';
  const after = runtime.getContext();
  t.not(after.registryEpoch, before.registryEpoch);
  t.is(after.minecraftEndpoint, 'mc.example.net:25565');
  t.is(after.serverIdentity, null, 'endpoint alone must not be presented as server identity');
});

test('loopback aliases are one canonical endpoint and do not split the session', (t) => {
  const { access, state } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  const before = runtime.getContext();
  state.host = 'localhost';
  const after = runtime.getContext();
  t.is(after.minecraftEndpoint, '127.0.0.1:25565');
  t.is(after.registryEpoch, before.registryEpoch);
});

test('a Mineflayer version change creates new registry and runtime epochs and revokes the old resolver', (t) => {
  const { access, state } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  const before = runtime.getContext();
  (state.bot as unknown as { version: string }).version = '1.20.1';
  const after = runtime.getContext();
  t.is(after.minecraftVersion, '1.20.1');
  t.not(after.registryEpoch, before.registryEpoch);
  t.not(after.runtimeEpoch, before.runtimeEpoch);
  const stale = before.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'minecraft:diamond', registryEpoch: before.registryEpoch! });
  t.is(stale.status, 'unavailable');
  if (stale.status === 'unavailable') t.is(stale.reason, 'stale-context');
});

test('accepts verified snapshot injection only for the active version and epoch', (t) => {
  const { access } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  const context = runtime.getContext();
  t.truthy(context.registryService);
  const snapshot = {
    source: 'protocol' as const,
    authority: 'protocol-observed' as const,
    minecraftVersion: '1.21.1',
    registryEpoch: context.registryEpoch!,
    runtimeEpoch: context.runtimeEpoch!,
    minecraftEndpoint: context.minecraftEndpoint!,
    mineflayerSessionId: context.mineflayerSessionId!,
    mineflayerRegistryEpoch: context.mineflayerRegistryEpoch!,
    availableRegistries: ['item'],
    registryCoverage: { item: 'partial' as const },
    entries: [{
      kind: 'item' as const,
      minecraftVersion: '1.21.1',
      namespacedId: 'processia:test_only',
      numericId: 9000,
      registryEpoch: context.registryEpoch!,
      provenance: { source: 'protocol' as const, authority: 'protocol-observed' as const, minecraftVersion: '1.21.1', registryEpoch: context.registryEpoch!,
        runtimeEpoch: context.runtimeEpoch!, minecraftEndpoint: context.minecraftEndpoint!, mineflayerSessionId: context.mineflayerSessionId!,
        mineflayerRegistryEpoch: context.mineflayerRegistryEpoch! },
    }],
  };
  runtime.replaceRuntimeSnapshot(snapshot);
  t.is(context.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:test_only', registryEpoch: context.registryEpoch! }).status, 'resolved');
  t.throws(() => runtime.replaceRuntimeSnapshot({ ...snapshot, registryEpoch: 'old-session' }));
  t.throws(() => runtime.replaceRuntimeSnapshot({ ...snapshot, source: 'neoforge-bridge', entries: snapshot.entries.map(entry => ({
    ...entry, provenance: { ...entry.provenance, source: 'neoforge-bridge' },
  })) }), { message: 'NeoForge bridge snapshots require authenticated session linkage' });
});

test('rejects protocol registry entries that lack the current Mineflayer provenance linkage', (t) => {
  const { access } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  const context = runtime.getContext();
  t.throws(() => runtime.replaceRuntimeSnapshot({ source: 'protocol', authority: 'protocol-observed', minecraftVersion: '1.21.1',
    registryEpoch: context.registryEpoch!, availableRegistries: ['item'], registryCoverage: { item: 'partial' },
    entries: [{ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'example:item', registryEpoch: context.registryEpoch!,
      provenance: { source: 'protocol', authority: 'protocol-observed', minecraftVersion: '1.21.1', registryEpoch: context.registryEpoch! } }],
  }), { message: 'Protocol snapshot provenance is not linked to the active Mineflayer session' });
});

test('activates an authenticated bridge-only registry context without a player or bot epoch', (t) => {
  const state = { bot: null as mineflayer.Bot | null, connected: false };
  const runtime = new RuntimeRegistryService({
    getBot: () => state.bot,
    isConnected: () => state.connected,
    getConfig: () => ({ host: '127.0.0.1', port: 25665 }),
    getConnectionMode: () => 'bridge-only',
  });
  const session = {
    authenticated: true as const, serverIdentity: 'test-server-id', minecraftEndpoint: '127.0.0.1:25665',
    minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', sourceRegistryEpoch: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002', connectedAt: new Date(0).toISOString(),
  };
  runtime.activateBridgeOnly(session);
  const context = runtime.getContext();
  t.false(context.connected);
  t.true(context.sessionAvailable);
  t.false(context.playerAvailable);
  t.is(context.connectionMode, 'bridge-only');
  t.is(context.serverIdentity, session.serverIdentity);
  t.is(context.minecraftEndpoint, session.minecraftEndpoint);
  t.is(context.minecraftVersion, '1.21.1');
  t.is(context.mineflayerSessionId, null);
  t.is(context.mineflayerRegistryEpoch, null);
  t.is(context.bridgeSessionId, session.sessionId);
  t.is(context.sourceRegistryEpoch, session.sourceRegistryEpoch);
  t.not(context.runtimeEpoch, context.registryEpoch);
  t.not(context.registryEpoch, session.sourceRegistryEpoch);
  t.not(context.registryEpoch, session.sourceRegistryEpoch);
  t.truthy(context.registryService);
  t.is(context.registryService!.resolve({ kind: 'block', minecraftVersion: '1.21.1', namespacedId: 'minecraft:stone' }).status, 'resolved');
});

test('rejects non-loopback or unauthenticated bridge-only sessions', (t) => {
  const runtime = new RuntimeRegistryService({ getBot: () => null, isConnected: () => false, getConfig: () => ({ host: 'localhost', port: 25665 }) });
  const session = {
    authenticated: true as const, serverIdentity: 'test-server-id', minecraftEndpoint: '192.168.1.20:25665',
    minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', sourceRegistryEpoch: 'source-epoch',
    sessionId: 'session-id', connectedAt: new Date(0).toISOString(),
  };
  t.throws(() => runtime.activateBridgeOnly(session), { message: 'bridge-only-endpoint-must-be-loopback' });
  t.throws(() => runtime.activateBridgeOnly({ ...session, minecraftEndpoint: '127.0.0.1:25665', authenticated: false as true }), { message: 'bridge-session-not-authenticated-or-incomplete' });
});

test('revoking a bridge-only session invalidates its runtime numeric mappings immediately', (t) => {
  const runtime = new RuntimeRegistryService({ getBot: () => null, isConnected: () => false,
    getConfig: () => ({ host: '127.0.0.1', port: 25665 }), getConnectionMode: () => 'bridge-only' });
  const session = {
    authenticated: true as const, serverIdentity: 'test-server-id', minecraftEndpoint: '127.0.0.1:25665',
    minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', sourceRegistryEpoch: '00000000-0000-4000-8000-000000000003',
    sessionId: '00000000-0000-4000-8000-000000000004', connectedAt: new Date(0).toISOString(),
  };
  runtime.activateBridgeOnly(session);
  const before = runtime.getContext();
  runtime.replaceBridgeSnapshot({ source: 'neoforge-bridge', authority: 'authenticated-runtime', minecraftVersion: '1.21.1', registryEpoch: before.registryEpoch!,
    runtimeEpoch: before.runtimeEpoch!, minecraftEndpoint: session.minecraftEndpoint, bridgeSessionId: session.sessionId,
    sourceRegistryEpoch: session.sourceRegistryEpoch, serverIdentity: session.serverIdentity, neoForgeVersion: session.neoForgeVersion,
    observedAt: new Date(0).toISOString(),
    availableRegistries: ['block'], registryCoverage: { block: 'partial' }, entries: [{ kind: 'block', minecraftVersion: '1.21.1',
      namespacedId: 'sample:machine', numericId: 500, numericIdScope: 'server-registry-generation', registryEpoch: before.registryEpoch!,
      provenance: { source: 'neoforge-bridge', authority: 'authenticated-runtime', minecraftVersion: '1.21.1', registryEpoch: before.registryEpoch!,
        runtimeEpoch: before.runtimeEpoch!, minecraftEndpoint: session.minecraftEndpoint, bridgeSessionId: session.sessionId,
        sourceRegistryEpoch: session.sourceRegistryEpoch, serverIdentity: session.serverIdentity, neoForgeVersion: session.neoForgeVersion,
        registryCoverage: 'partial' } }],
  }, session.sessionId);
  t.is(before.registryService!.resolve({ kind: 'block', minecraftVersion: '1.21.1', registryEpoch: before.registryEpoch!, namespacedId: 'sample:machine' }).status, 'resolved');
  runtime.clearBridgeSession(session.sessionId);
  const after = runtime.getContext();
  t.false(after.sessionAvailable);
  t.is(after.registryService, null);
  t.is(after.registryEpoch, null);
});
