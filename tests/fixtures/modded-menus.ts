/**
 * Synthetic Minecraft 1.21.1 (protocol 767) fixtures for two independent,
 * fictitious mods. Vanilla 1.21.1 menu type IDs end at 24 (minecraft:stonecutter)
 * and vanilla item IDs at 1332, so the modded IDs below are server-assigned
 * registry IDs that only an authenticated bridge snapshot can name.
 * Nothing here contacts a server; these are not runtime evidence.
 */
import { EventEmitter } from 'node:events';
import type mineflayer from 'mineflayer';
import { RuntimeRegistryService } from '../../src/services/runtime-registry-service.js';
import type { RegistryEntry, RegistryKind } from '../../src/services/minecraft-registry-service.js';

export const MINECRAFT_VERSION = '1.21.1';
export const PROTOCOL_VERSION = 767;
/** Isolated synthetic endpoint; never the personal (25565) or historical (25665) port. */
export const TEST_ENDPOINT = { host: '127.0.0.1', port: 26001 };

export interface PacketItem { itemCount: number; itemId?: number; addedComponentCount?: number; removedComponentCount?: number; components?: unknown[]; removeComponents?: unknown[] }
export const emptySlot = (): PacketItem => ({ itemCount: 0 });
export const stack = (itemId: number, itemCount: number, componentTypes: Array<number | string> = []): PacketItem => ({
  itemCount, itemId, addedComponentCount: componentTypes.length, removedComponentCount: 0,
  components: componentTypes.map(type => ({ type, data: 'opaque-component-payload' })), removeComponents: [],
});

/** examplemod:machine_menu — 2 machine slots + 36 player slots, 4 synchronized data slots. */
export const EXAMPLE_MACHINE = {
  windowId: 7, title: { text: 'Example Machine' }, slotCount: 38,
  items: (): PacketItem[] => [stack(1400, 3, [42]), emptySlot(), ...Array.from({ length: 36 }, (_, index) => index === 0 ? stack(1, 64) : emptySlot())],
  properties: [[0, 120], [1, 400], [2, -1], [3, 32767]] as Array<[number, number]>,
};

/** anothermod:custom_container — 5 container slots + 36 player slots, no synchronized data. */
export const ANOTHER_CONTAINER = {
  windowId: 9, title: 'Custom Container', slotCount: 41,
  items: (): PacketItem[] => [stack(1500, 1), stack(1401, 16), emptySlot(), emptySlot(), stack(2, 8), ...Array.from({ length: 36 }, emptySlot)],
};

export interface FakeBot extends EventEmitter { _client: EventEmitter; version: string; currentWindow: unknown }

export function createFakeBot(): FakeBot {
  const bot = new EventEmitter() as FakeBot;
  bot._client = new EventEmitter();
  bot.version = MINECRAFT_VERSION;
  bot.currentWindow = null;
  return bot;
}

export const packets = {
  openWindow: (client: EventEmitter, windowId: number, menuTypeId: number, windowTitle: unknown) =>
    client.emit('packet', { windowId, inventoryType: menuTypeId, windowTitle }, { name: 'open_window' }),
  windowItems: (client: EventEmitter, windowId: number, stateId: number, items: PacketItem[], carriedItem: PacketItem = emptySlot()) =>
    client.emit('packet', { windowId, stateId, items, carriedItem }, { name: 'window_items' }),
  setSlot: (client: EventEmitter, windowId: number, stateId: number, slot: number, item: PacketItem) =>
    client.emit('packet', { windowId, stateId, slot, item }, { name: 'set_slot' }),
  property: (client: EventEmitter, windowId: number, property: number, value: number) =>
    client.emit('packet', { windowId, property, value }, { name: 'craft_progress_bar' }),
  closeWindow: (client: EventEmitter, windowId: number) => client.emit('packet', { windowId }, { name: 'close_window' }),
};

export interface ModdedServerRegistry {
  serverIdentity: string;
  menus: Array<[number, string]>;
  items: Array<[number, string]>;
  menuCoverage?: 'complete' | 'partial';
  itemCoverage?: 'complete' | 'partial';
  /** Server block registry IDs (not Mineflayer's static block.type). */
  blocks?: Array<[number, string]>;
  /** Server block state IDs with their authoritative properties, when the bridge reports them. */
  blockStates?: Array<[number, string, Record<string, string>?]>;
  blockStateCoverage?: 'complete' | 'partial';
}

let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

/**
 * A real RuntimeRegistryService for one Mineflayer session, with an authenticated
 * bridge snapshot passed through the same validation as production snapshots.
 */
export function createModdedSession(bot: FakeBot) {
  const state = { bot: bot as FakeBot | null, connected: true };
  const runtime = new RuntimeRegistryService({
    getBot: () => state.bot as unknown as mineflayer.Bot | null,
    isConnected: () => state.connected,
    getConfig: () => TEST_ENDPOINT,
    getConnectionMode: () => 'bot',
  });
  const endpoint = `${TEST_ENDPOINT.host}:${TEST_ENDPOINT.port}`;

  function attachBridge(registry: ModdedServerRegistry) {
    const session = {
      authenticated: true as const, serverIdentity: registry.serverIdentity, minecraftEndpoint: endpoint,
      minecraftVersion: MINECRAFT_VERSION, neoForgeVersion: '21.1.259', sourceRegistryEpoch: uuid(), sessionId: uuid(),
      connectedAt: new Date(0).toISOString(),
    };
    runtime.bindAuthenticatedBridge(session);
    const context = runtime.getContext();
    const menuCoverage = registry.menuCoverage ?? 'partial';
    const itemCoverage = registry.itemCoverage ?? 'partial';
    const blockStateCoverage = registry.blockStateCoverage ?? 'partial';
    const entry = (kind: RegistryKind, numericId: number, namespacedId: string, coverage: 'complete' | 'partial', blockStateProperties?: Record<string, string>): RegistryEntry => ({
      kind, minecraftVersion: MINECRAFT_VERSION, namespacedId, numericId, registryEpoch: context.registryEpoch!,
      numericIdScope: kind === 'blockState' ? 'server-block-state-generation' : 'server-registry-generation',
      ...(blockStateProperties ? { blockStateProperties } : {}),
      provenance: {
        source: 'neoforge-bridge', authority: 'authenticated-runtime', minecraftVersion: MINECRAFT_VERSION,
        registryEpoch: context.registryEpoch!, runtimeEpoch: context.runtimeEpoch!, minecraftEndpoint: endpoint,
        mineflayerSessionId: context.mineflayerSessionId!, mineflayerRegistryEpoch: context.mineflayerRegistryEpoch!,
        bridgeSessionId: session.sessionId, sourceRegistryEpoch: session.sourceRegistryEpoch, serverIdentity: session.serverIdentity,
        neoForgeVersion: session.neoForgeVersion, observedAt: new Date(0).toISOString(), registryCoverage: coverage,
      },
    });
    runtime.replaceBridgeSnapshot({
      source: 'neoforge-bridge', authority: 'authenticated-runtime', minecraftVersion: MINECRAFT_VERSION,
      registryEpoch: context.registryEpoch!, runtimeEpoch: context.runtimeEpoch!, minecraftEndpoint: endpoint,
      mineflayerSessionId: context.mineflayerSessionId!, mineflayerRegistryEpoch: context.mineflayerRegistryEpoch!,
      bridgeSessionId: session.sessionId, sourceRegistryEpoch: session.sourceRegistryEpoch, serverIdentity: session.serverIdentity,
      neoForgeVersion: session.neoForgeVersion, observedAt: new Date(0).toISOString(),
      availableRegistries: ['menu', 'item', ...(registry.blocks ? ['block'] : []), ...(registry.blockStates ? ['blockState'] : [])],
      registryCoverage: { menu: menuCoverage, item: itemCoverage, ...(registry.blocks ? { block: 'partial' as const } : {}),
        ...(registry.blockStates ? { blockState: blockStateCoverage } : {}) },
      entries: [
        ...registry.menus.map(([id, name]) => entry('menu', id, name, menuCoverage)),
        ...registry.items.map(([id, name]) => entry('item', id, name, itemCoverage)),
        ...(registry.blocks ?? []).map(([id, name]) => entry('block', id, name, 'partial')),
        ...(registry.blockStates ?? []).map(([id, name, properties]) => entry('blockState', id, name, blockStateCoverage, properties)),
      ],
    }, session.sessionId);
    return session;
  }

  return {
    runtime,
    state,
    attachBridge,
    revokeBridge: (sessionId?: string) => runtime.clearBridgeSession(sessionId),
    context: () => runtime.getContext(),
  };
}

/** Server A and server B assign the same numeric IDs to different mods' content. */
export const SERVER_A: ModdedServerRegistry = {
  serverIdentity: 'synthetic-server-a',
  menus: [[25, 'examplemod:machine_menu'], [26, 'anothermod:custom_container']],
  items: [[1400, 'examplemod:copper_gear'], [1401, 'anothermod:widget'], [1500, 'anothermod:sealed_crate']],
};
/**
 * Adversarial synthetic server whose authenticated registries contradict the
 * vanilla static tables: menu 2 is not generic_9x3, menu 5 does not exist at all
 * (complete menu coverage), and item 1 is not minecraft:stone.
 */
export const SERVER_REORDERED: ModdedServerRegistry = {
  serverIdentity: 'synthetic-server-reordered',
  menus: [[0, 'minecraft:generic_9x1'], [1, 'minecraft:generic_9x2'], [2, 'examplemod:machine_menu'], [3, 'anothermod:custom_container']],
  menuCoverage: 'complete',
  items: [[1, 'examplemod:copper_gear']],
};
export const SERVER_B: ModdedServerRegistry = {
  serverIdentity: 'synthetic-server-b',
  menus: [[25, 'anothermod:custom_container'], [26, 'examplemod:machine_menu']],
  items: [[1400, 'anothermod:widget'], [1401, 'examplemod:copper_gear']],
};
