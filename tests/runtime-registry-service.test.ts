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

test('does not carry runtime snapshot entries into a reconnect session', (t) => {
  const { access, state } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  const before = runtime.getContext();
  runtime.replaceRuntimeSnapshot({
    source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: before.registryEpoch!,
    availableRegistries: ['item'], registryCoverage: { item: 'partial' },
    entries: [{ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:session_only', numericId: 9900, registryEpoch: before.registryEpoch!, provenance: { source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: before.registryEpoch! } }],
  });
  t.is(before.registryService?.getEntries({ kind: 'item', namespacedId: 'processia:session_only', limit: null }).length, 1);
  state.bot = { version: '1.21.1', protocolVersion: '1.21.1' } as mineflayer.Bot;
  const after = runtime.getContext();
  t.not(after.registryEpoch, before.registryEpoch);
  t.is(after.registryService?.getEntries({ kind: 'item', namespacedId: 'processia:session_only', limit: null }).length, 0);
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
  state.host = 'localhost';
  const after = runtime.getContext();
  t.not(after.registryEpoch, before.registryEpoch);
  t.is(after.serverIdentity, 'localhost:25565');
});

test('accepts verified snapshot injection only for the active version and epoch', (t) => {
  const { access } = createConnection();
  const runtime = new RuntimeRegistryService(access);
  const context = runtime.getContext();
  t.truthy(context.registryService);
  const snapshot = {
    source: 'neoforge-bridge' as const,
    minecraftVersion: '1.21.1',
    registryEpoch: context.registryEpoch!,
    availableRegistries: ['item'],
    registryCoverage: { item: 'partial' as const },
    entries: [{
      kind: 'item' as const,
      minecraftVersion: '1.21.1',
      namespacedId: 'processia:test_only',
      numericId: 9000,
      registryEpoch: context.registryEpoch!,
      provenance: { source: 'neoforge-bridge' as const, minecraftVersion: '1.21.1', registryEpoch: context.registryEpoch! },
    }],
  };
  runtime.replaceRuntimeSnapshot(snapshot);
  t.is(context.registryService!.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:test_only', registryEpoch: context.registryEpoch! }).status, 'resolved');
  t.throws(() => runtime.replaceRuntimeSnapshot({ ...snapshot, registryEpoch: 'old-session' }));
});
