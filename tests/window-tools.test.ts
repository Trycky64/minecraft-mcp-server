import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerWindowTools } from '../src/tools/window-tools.js';
import { createProcessiaMenuLayoutProvider } from '../src/services/processia-menu-layout-provider.js';
import type { MenuLayoutProvider } from '../src/services/menu-layout-registry.js';
import type { RuntimeRegistryContext } from '../src/services/runtime-registry-service.js';
import { Vec3 } from 'vec3';

function setup(
  bot: Partial<Bot> & EventEmitter,
  context: Partial<RuntimeRegistryContext> = { connected: true, registryEpoch: 'test-epoch' },
  providers: readonly MenuLayoutProvider[] = [],
) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  registerWindowTools(factory, () => bot as Bot, () => context as RuntimeRegistryContext, providers);
  const calls = (server.tool as sinon.SinonStub).getCalls();
  const executor = (name: string) => calls.find(call => call.args[0] === name)!.args[3] as (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  return { calls, executor };
}

function mockBot() {
  const bot = new EventEmitter() as Partial<Bot> & EventEmitter;
  (bot as unknown as { _client: EventEmitter })._client = new EventEmitter();
  bot.version = '1.21.1';
  bot.entity = { position: new Vec3(0, 64, 1) } as Bot['entity'];
  bot.blockAt = sinon.stub().returns({ name: 'unknown', stateId: 1700, position: new Vec3(0, 64, 0) }) as unknown as Bot['blockAt'];
  bot.currentWindow = null;
  bot.inventory = { slots: Array(45).fill(null), hotbarStart: 36 } as unknown as Bot['inventory'];
  bot.heldItem = null;
  bot.activateBlock = sinon.stub().resolves() as unknown as Bot['activateBlock'];
  bot.clickWindow = sinon.stub().resolves() as unknown as Bot['clickWindow'];
  bot.closeWindow = sinon.stub().resolves() as unknown as Bot['closeWindow'];
  bot.waitForTicks = sinon.stub().resolves() as unknown as Bot['waitForTicks'];
  bot.setQuickBarSlot = sinon.stub() as unknown as Bot['setQuickBarSlot'];
  return bot;
}

function primeWindow(bot: Partial<Bot> & EventEmitter, window: { id: number; type: string | number; slots: unknown[]; inventoryStart: number; inventoryEnd: number }, rawMenuTypeId: number) {
  bot.currentWindow = window as unknown as Bot['currentWindow'];
  const client = (bot as unknown as { _client: EventEmitter })._client;
  client.emit('packet', { windowId: window.id, inventoryType: rawMenuTypeId }, { name: 'open_window' });
  client.emit('packet', { windowId: window.id, stateId: 1, items: [...window.slots], carriedItem: null }, { name: 'window_items' });
  bot.emit('windowOpen', window as unknown as Bot['currentWindow']);
}

test('registerWindowTools exposes protocol-level block and container interaction tools', (t) => {
  const bot = mockBot();
  const { calls } = setup(bot);
  t.deepEqual(calls.map(call => call.args[0]), ['interact-block', 'inspect-open-window', 'click-window-slot', 'close-open-window']);
});

test('interact-block rejects an unloaded or changed target before sending an interaction', async (t) => {
  const bot = mockBot();
  const { executor } = setup(bot);
  const result = await executor('interact-block')({ x: 0, y: 64, z: 0, expectedStateId: 4, registryEpoch: 'test-epoch', timeoutMs: 50 });
  t.true(result.isError);
  t.true(result.content[0]!.text.includes('state-changed'));
  t.false((bot.activateBlock as unknown as sinon.SinonStub).called);
});

test('interact-block refuses an observation from a previous registry epoch', async (t) => {
  const bot = mockBot();
  const { executor } = setup(bot);
  const result = await executor('interact-block')({ x: 0, y: 64, z: 0, expectedStateId: 1700, registryEpoch: 'old-session', timeoutMs: 50 });
  t.true(result.isError);
  t.true(result.content[0]!.text.includes('stale-registry-epoch'));
  t.false((bot.activateBlock as unknown as sinon.SinonStub).called);
});

test('interact-block sends normal activation and reports unknown menu slots as raw IDs', async (t) => {
  const bot = mockBot();
  const window = {
    id: 2, type: 'processia:machine', title: 'Machine', slots: [{ name: 'unknown', type: 1373, count: 1, metadata: 0 }, null],
    inventoryStart: 1, inventoryEnd: 2, selectedItem: null,
  };
  (bot.activateBlock as unknown as sinon.SinonStub).callsFake(async () => {
    bot.currentWindow = window as unknown as Bot['currentWindow'];
    setImmediate(() => bot.emit('windowOpen', window));
  });
  const { executor } = setup(bot);
  const result = await executor('interact-block')({ x: 0, y: 64, z: 0, expectedStateId: 1700, registryEpoch: 'test-epoch', timeoutMs: 500 });
  const data = JSON.parse(result.content[0]!.text) as { status: string; target: { identity: string }; window: { slots: { rawNumericId?: number; identity?: string }[] } };
  t.is(data.status, 'menu-opened');
  t.is(data.target.identity, 'unresolved-raw-state-only');
  t.is(data.window.slots[0]!.rawNumericId, 1373);
  t.is(data.window.slots[0]!.identity, 'unresolved');
  t.true((bot.activateBlock as unknown as sinon.SinonStub).calledOnce);
});

test('unknown menu packets remain inspectable raw-only when Mineflayer has no Window model', async (t) => {
  const bot = mockBot();
  const client = (bot as unknown as { _client: EventEmitter })._client;
  (bot.activateBlock as unknown as sinon.SinonStub).callsFake(async () => {
    client.emit('packet', { windowId: 21, inventoryType: 901, windowTitle: { text: 'A third-party menu' } }, { name: 'open_window' });
    client.emit('packet', {
      windowId: 21, stateId: 5,
      items: [{ itemCount: 4, itemId: 8123, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] }],
      carriedItem: { itemCount: 0 },
    }, { name: 'window_items' });
    // Mineflayer did not construct a Window for this unknown numeric type.
    bot.currentWindow = null;
  });
  const { executor } = setup(bot);
  const interacted = await executor('interact-block')({ x: 0, y: 64, z: 0, expectedStateId: 1700, registryEpoch: 'test-epoch', timeoutMs: 50 });
  const action = JSON.parse(interacted.content[0]!.text) as { status: string; serverConfirmed: boolean; rawWindow: { mode: string; menuTypeId: number; contentStatus: string; layout: { status: string }; interactionsAllowed: boolean; slots: Array<{ rawNumericItemId: number; count: number; identity: string }> } };
  t.is(action.status, 'raw-only-window-observed');
  t.false(action.serverConfirmed);
  t.is(action.rawWindow.mode, 'raw-only-read-only');
  t.is(action.rawWindow.menuTypeId, 901);
  t.is(action.rawWindow.contentStatus, 'complete-packet-observed');
  t.is(action.rawWindow.layout.status, 'unknown');
  t.false(action.rawWindow.interactionsAllowed);
  t.deepEqual(action.rawWindow.slots.map(slot => ({ rawNumericItemId: slot.rawNumericItemId, count: slot.count, identity: slot.identity })), [
    { rawNumericItemId: 8123, count: 4, identity: 'unresolved-raw-protocol-item-id' },
  ]);
  const inspected = await executor('inspect-open-window')({});
  const inspection = JSON.parse(inspected.content[0]!.text) as { status: string; rawWindow: { interactionCapability: string } };
  t.is(inspection.status, 'raw-only-window-observed');
  t.is(inspection.rawWindow.interactionCapability, 'unsupported-for-raw-only-window');
  const click = await executor('click-window-slot')({ windowId: 21, slot: 0, action: 'left', registryEpoch: 'test-epoch' });
  t.true(click.isError);
  t.true(click.content[0]!.text.includes('no-window-open'));
  t.false((bot.clickWindow as unknown as sinon.SinonStub).called);
});

test('raw-only observations use current authenticated registry mappings generically across mod namespaces', async (t) => {
  const bot = mockBot();
  const provenance = {
    source: 'neoforge-bridge', authority: 'authenticated-runtime', minecraftVersion: '1.21.1', registryEpoch: 'test-epoch',
    runtimeEpoch: 'runtime-a', minecraftEndpoint: '127.0.0.1:25665', bridgeSessionId: 'bridge-a',
    sourceRegistryEpoch: 'java-a', serverIdentity: 'server-a',
  };
  const service = { resolve: sinon.stub().callsFake((lookup: { kind: string; numericId: number }) => {
    const namespacedId = lookup.kind === 'menu' ? 'anothermod:custom_container' : 'anothermod:widget';
    return {
      status: 'resolved', kind: lookup.kind, minecraftVersion: '1.21.1', registryEpoch: 'test-epoch', runtimeEpoch: 'runtime-a', lookup,
      entry: { kind: lookup.kind, minecraftVersion: '1.21.1', namespacedId, numericId: lookup.numericId, numericIdScope: 'server-registry-generation', registryEpoch: 'test-epoch', provenance },
      provenance,
    };
  }) };
  const context = {
    connected: true, registryEpoch: 'test-epoch', runtimeEpoch: 'runtime-a', mineflayerSessionId: 'bot-a',
    minecraftVersion: '1.21.1', minecraftEndpoint: '127.0.0.1:25665', bridgeAvailable: true,
    bridgeSessionId: 'bridge-a', sourceRegistryEpoch: 'java-a', serverIdentity: 'server-a',
    bridgeSession: { authenticated: true, sessionId: 'bridge-a', serverIdentity: 'server-a', minecraftEndpoint: '127.0.0.1:25665', minecraftVersion: '1.21.1', sourceRegistryEpoch: 'java-a' },
    registryService: service,
  } as unknown as Partial<RuntimeRegistryContext>;
  const client = (bot as unknown as { _client: EventEmitter })._client;
  (bot.activateBlock as unknown as sinon.SinonStub).callsFake(async () => {
    client.emit('packet', { windowId: 30, inventoryType: 1200, windowTitle: 'Example menu' }, { name: 'open_window' });
    client.emit('packet', { windowId: 30, stateId: 1, items: [{ itemCount: 1, itemId: 7002 }], carriedItem: { itemCount: 0 } }, { name: 'window_items' });
  });
  const { executor } = setup(bot, context);
  const action = await executor('interact-block')({ x: 0, y: 64, z: 0, expectedStateId: 1700, registryEpoch: 'test-epoch', timeoutMs: 50 });
  const result = JSON.parse(action.content[0]!.text) as { rawWindow: { menuIdentity: { namespacedId: string }; layout: { status: string }; interactionsAllowed: boolean; slots: Array<{ rawNumericItemId: number; namespacedId: string; identity: string }> } };
  t.is(result.rawWindow.menuIdentity.namespacedId, 'anothermod:custom_container');
  t.is(result.rawWindow.layout.status, 'unknown');
  t.false(result.rawWindow.interactionsAllowed);
  t.deepEqual(result.rawWindow.slots.map(slot => ({ rawNumericItemId: slot.rawNumericItemId, namespacedId: slot.namespacedId, identity: slot.identity })), [
    { rawNumericItemId: 7002, namespacedId: 'anothermod:widget', identity: 'authenticated-runtime-registry' },
  ]);
});

test('raw-only identity mapping is withheld when the bridge epoch changes after the window was observed', async (t) => {
  const bot = mockBot();
  const provenance = {
    source: 'neoforge-bridge', authority: 'authenticated-runtime', minecraftVersion: '1.21.1', registryEpoch: 'test-epoch',
    runtimeEpoch: 'runtime-a', minecraftEndpoint: '127.0.0.1:25665', bridgeSessionId: 'bridge-a',
    sourceRegistryEpoch: 'java-a', serverIdentity: 'server-a',
  };
  const service = { resolve: sinon.stub().callsFake((lookup: { kind: string; numericId: number }) => {
    const namespacedId = lookup.kind === 'menu' ? 'examplemod:machine_menu' : 'examplemod:item';
    return {
      status: 'resolved', kind: lookup.kind, minecraftVersion: '1.21.1', registryEpoch: 'test-epoch', runtimeEpoch: 'runtime-a', lookup,
      entry: { kind: lookup.kind, minecraftVersion: '1.21.1', namespacedId, numericId: lookup.numericId, numericIdScope: 'server-registry-generation', registryEpoch: 'test-epoch', provenance }, provenance,
    };
  }) };
  const context = {
    connected: true, registryEpoch: 'test-epoch', runtimeEpoch: 'runtime-a', mineflayerSessionId: 'bot-a',
    minecraftVersion: '1.21.1', minecraftEndpoint: '127.0.0.1:25665', bridgeAvailable: true,
    bridgeSessionId: 'bridge-a', sourceRegistryEpoch: 'java-a', serverIdentity: 'server-a',
    bridgeSession: { authenticated: true, sessionId: 'bridge-a', serverIdentity: 'server-a', minecraftEndpoint: '127.0.0.1:25665', minecraftVersion: '1.21.1', sourceRegistryEpoch: 'java-a' },
    registryService: service,
  } as unknown as Partial<RuntimeRegistryContext>;
  const client = (bot as unknown as { _client: EventEmitter })._client;
  (bot.activateBlock as unknown as sinon.SinonStub).callsFake(async () => {
    client.emit('packet', { windowId: 32, inventoryType: 1201 }, { name: 'open_window' });
    client.emit('packet', { windowId: 32, stateId: 1, items: [{ itemCount: 1, itemId: 7003 }], carriedItem: { itemCount: 0 } }, { name: 'window_items' });
  });
  const { executor } = setup(bot, context);
  const operation = executor('interact-block')({ x: 0, y: 64, z: 0, expectedStateId: 1700, registryEpoch: 'test-epoch', timeoutMs: 50 });
  setTimeout(() => { Object.assign(context, { runtimeEpoch: 'runtime-b', bridgeSessionId: 'bridge-b' }); }, 0);
  const result = JSON.parse((await operation).content[0]!.text) as { rawWindow: { runtimeContextStatus: string; menuIdentity: { status: string; namespacedId?: string }; slots: Array<{ namespacedId: string | null; identity: string }> } };
  t.is(result.rawWindow.runtimeContextStatus, 'changed-or-unavailable');
  t.is(result.rawWindow.menuIdentity.status, 'unresolved');
  t.is(result.rawWindow.menuIdentity.namespacedId, undefined);
  t.deepEqual(result.rawWindow.slots.map(slot => ({ namespacedId: slot.namespacedId, identity: slot.identity })), [
    { namespacedId: null, identity: 'unresolved-raw-protocol-item-id' },
  ]);
});

test('an unknown raw menu remains inspectable before its first content snapshot and cannot be clicked', async (t) => {
  const bot = mockBot();
  const { executor } = setup(bot);
  (bot as unknown as { _client: EventEmitter })._client.emit('packet', { windowId: 27, inventoryType: 1900 }, { name: 'open_window' });
  const inspected = await executor('inspect-open-window')({});
  const data = JSON.parse(inspected.content[0]!.text) as { status: string; rawWindow: { contentStatus: string; slots: unknown; capabilities?: unknown; interactionsAllowed: boolean } };
  t.is(data.status, 'raw-only-window-observed');
  t.is(data.rawWindow.contentStatus, 'not-observed');
  t.is(data.rawWindow.slots, null);
  t.false(data.rawWindow.interactionsAllowed);
  const clicked = await executor('click-window-slot')({ windowId: 27, slot: 0, action: 'left', registryEpoch: 'test-epoch' });
  t.true(clicked.isError);
  t.true(clicked.content[0]!.text.includes('no-window-open'));
});

test('interact-block refuses out-of-reach targets', async (t) => {
  const bot = mockBot();
  bot.entity = { position: new Vec3(20, 64, 0) } as Bot['entity'];
  const { executor } = setup(bot);
  const result = await executor('interact-block')({ x: 0, y: 64, z: 0, expectedStateId: 1700, registryEpoch: 'test-epoch', timeoutMs: 50 });
  t.true(result.isError);
  t.true(result.content[0]!.text.includes('out-of-reach'));
  t.false((bot.activateBlock as unknown as sinon.SinonStub).called);
});

test('interact-block temporarily selects an empty hand and restores the prior hotbar slot', async (t) => {
  const bot = mockBot();
  const unknownHeldItem = { name: 'unknown', type: 1373, count: 1, metadata: 0 };
  (bot.inventory as Bot['inventory']).slots[36] = unknownHeldItem as never;
  bot.heldItem = unknownHeldItem as never;
  bot.quickBarSlot = 0;
  (bot.setQuickBarSlot as unknown as sinon.SinonStub).callsFake((slot: number) => {
    bot.quickBarSlot = slot;
    bot.heldItem = slot === 1 ? null : unknownHeldItem as never;
  });
  (bot.activateBlock as unknown as sinon.SinonStub).callsFake(async () => {
    t.is(bot.quickBarSlot, 1);
    t.is(bot.heldItem, null);
  });
  const { executor } = setup(bot);
  const result = await executor('interact-block')({ x: 0, y: 64, z: 0, expectedStateId: 1700, registryEpoch: 'test-epoch', timeoutMs: 50 });
  t.falsy(result.isError);
  t.is(bot.quickBarSlot, 0);
  t.is(bot.heldItem, unknownHeldItem);
  t.deepEqual((bot.setQuickBarSlot as unknown as sinon.SinonStub).args, [[1], [0]]);
});

test('interact-block restores the previous hotbar slot even if activation changes held-item state', async (t) => {
  const bot = mockBot();
  const held = { name: 'stick', type: 1, count: 1 };
  (bot.inventory as Bot['inventory']).slots[36] = held as never;
  (bot.inventory as Bot['inventory']).slots[37] = null;
  bot.heldItem = held as never;
  bot.quickBarSlot = 0;
  (bot.setQuickBarSlot as unknown as sinon.SinonStub).callsFake((slot: number) => { bot.quickBarSlot = slot; });
  (bot.activateBlock as unknown as sinon.SinonStub).callsFake(async () => { bot.heldItem = held as never; });
  const { executor } = setup(bot);
  await executor('interact-block')({ x: 0, y: 64, z: 0, expectedStateId: 1700, registryEpoch: 'test-epoch', timeoutMs: 50 });
  t.is(bot.quickBarSlot, 0);
  t.deepEqual((bot.setQuickBarSlot as unknown as sinon.SinonStub).args, [[1], [0]]);
});

test('click-window-slot validates active window and maps shift clicks to Minecraft mode 1', async (t) => {
  const bot = mockBot();
  const window = { id: 3, type: 'minecraft:generic_9x1', title: 'Chest', slots: Array(45).fill(null), inventoryStart: 9, inventoryEnd: 45, selectedItem: null };
  const { executor } = setup(bot);
  primeWindow(bot, window, 0);
  const stale = await executor('click-window-slot')({ windowId: 2, slot: 0, action: 'left', registryEpoch: 'test-epoch' });
  t.true(stale.isError);
  const oldEpoch = await executor('click-window-slot')({ windowId: 3, slot: 0, action: 'left', registryEpoch: 'old-session' });
  t.true(oldEpoch.isError);
  t.false((bot.clickWindow as unknown as sinon.SinonStub).called);
  const result = await executor('click-window-slot')({ windowId: 3, windowGeneration: 1, slot: 0, action: 'shift', registryEpoch: 'test-epoch', timeoutMs: 50 });
  t.falsy(result.isError);
  const response = JSON.parse(result.content[0]!.text) as { status: string; transferStatus: string; serverConfirmed: boolean; recoveryRequired: boolean; clickConfirmation: string };
  t.is(response.status, 'uncertain');
  t.is(response.transferStatus, 'no-transfer-confirmed-outcome-uncertain');
  t.false(response.serverConfirmed);
  t.true(response.recoveryRequired);
  t.true(response.clickConfirmation.includes('reported separately'));
  t.deepEqual((bot.clickWindow as unknown as sinon.SinonStub).firstCall.args, [0, 0, 1]);
});

test('click-window-slot treats a Mineflayer local mutation without a server packet as uncertain', async (t) => {
  const bot = mockBot();
  const window = { id: 8, type: 1000, title: 'Mod menu', slots: [{ name: 'oak_log', type: 17, count: 1 }], inventoryStart: 1, inventoryEnd: 1, selectedItem: null };
  const { executor } = setup(bot);
  primeWindow(bot, window, 1000);
  (bot.clickWindow as unknown as sinon.SinonStub).callsFake(async () => {
    window.slots[0] = null;
    window.selectedItem = { name: 'oak_log', type: 17, count: 1 } as never;
  });
  const result = await executor('click-window-slot')({ windowId: 8, slot: 0, action: 'left', registryEpoch: 'test-epoch', timeoutMs: 50 });
  const response = JSON.parse(result.content[0]!.text) as { transferStatus: string; changedSlots: Array<{ slot: number }> };
  t.is(response.transferStatus, 'client-slot-or-cursor-delta-only');
  t.deepEqual(response.changedSlots.map((change) => change.slot), [0]);
});

test('click-window-slot timeout reports uncertainty and never retries the click', async (t) => {
  const bot = mockBot();
  const window = { id: 9, type: 1001, title: 'Unknown', slots: [null], inventoryStart: 1, inventoryEnd: 1, selectedItem: null };
  const { executor } = setup(bot);
  primeWindow(bot, window, 1001);
  (bot.clickWindow as unknown as sinon.SinonStub).returns(new Promise(() => {}));
  const result = await executor('click-window-slot')({ windowId: 9, slot: 0, action: 'left', registryEpoch: 'test-epoch', timeoutMs: 50 });
  t.falsy(result.isError);
  t.is(JSON.parse(result.content[0]!.text).status, 'uncertain');
  t.true((bot.clickWindow as unknown as sinon.SinonStub).calledOnce);
});

test('click-window-slot refuses shift-click when menu identity or slot layout is unknown', async (t) => {
  const bot = mockBot();
  const window = { id: 10, type: 170, title: 'Unknown mod menu', slots: [null, null], inventoryStart: 2, inventoryEnd: 2, selectedItem: null };
  const { executor } = setup(bot);
  primeWindow(bot, window, 170);
  const result = await executor('click-window-slot')({ windowId: 10, windowGeneration: 1, slot: 0, action: 'shift', registryEpoch: 'test-epoch' });
  t.true(result.isError);
  t.true(result.content[0]!.text.includes('shift-click-refused'));
  t.false((bot.clickWindow as unknown as sinon.SinonStub).called);
});

test('click-window-slot rejects a stale generation when a numeric window ID is reused', async (t) => {
  const bot = mockBot();
  const oldWindow = { id: 14, type: 1002, title: 'Old', slots: [null], inventoryStart: 1, inventoryEnd: 1, selectedItem: null };
  const { executor } = setup(bot);
  primeWindow(bot, oldWindow, 1002);
  const newWindow = { id: 14, type: 1003, title: 'New', slots: [null], inventoryStart: 1, inventoryEnd: 1, selectedItem: null };
  primeWindow(bot, newWindow, 1003);
  const result = await executor('click-window-slot')({ windowId: 14, windowGeneration: 1, slot: 0, action: 'left', registryEpoch: 'test-epoch' });
  t.true(result.isError);
  t.true(result.content[0]!.text.includes('stale-or-missing-window-generation'));
  t.false((bot.clickWindow as unknown as sinon.SinonStub).called);
});

test('click-window-slot refuses a still-open window after its bridge/runtime binding changes', async (t) => {
  const bot = mockBot();
  const window = { id: 26, type: 901, title: 'Modded', slots: [null], inventoryStart: 1, inventoryEnd: 1, selectedItem: null };
  const context = {
    connected: true, registryEpoch: 'same-registry', runtimeEpoch: 'runtime-a', mineflayerSessionId: 'bot-a',
    minecraftVersion: '1.21.1', minecraftEndpoint: '127.0.0.1:25665', bridgeSessionId: 'bridge-a',
  } as unknown as Partial<RuntimeRegistryContext>;
  const { executor } = setup(bot, context);
  primeWindow(bot, window, 901);
  Object.assign(context, { runtimeEpoch: 'runtime-b', bridgeSessionId: 'bridge-b' });
  const result = await executor('click-window-slot')({ windowId: 26, slot: 0, action: 'left', registryEpoch: 'same-registry' });
  t.true(result.isError);
  t.true(result.content[0]!.text.includes('stale-window-runtime-context'));
  t.false((bot.clickWindow as unknown as sinon.SinonStub).called);
});

test('click-window-slot refuses a window whose initial full content has not been observed', async (t) => {
  const bot = mockBot();
  bot.currentWindow = { id: 15, type: 1004, slots: [null], inventoryStart: 1, inventoryEnd: 1, selectedItem: null } as unknown as Bot['currentWindow'];
  const { executor } = setup(bot);
  const result = await executor('click-window-slot')({ windowId: 15, slot: 0, action: 'left', registryEpoch: 'test-epoch' });
  t.true(result.isError);
  t.true(result.content[0]!.text.includes('window-content-not-authoritatively-synchronized'));
  t.false((bot.clickWindow as unknown as sinon.SinonStub).called);
});

test('window inspection keeps an unknown menu numeric ID and rejects Mineflayer layout hints as authority', async (t) => {
  const bot = mockBot();
  const window = { id: 11, type: 900, title: 'Unknown mod menu', slots: [null, null], inventoryStart: 2, inventoryEnd: 2, selectedItem: null };
  const { executor } = setup(bot);
  primeWindow(bot, window, 900);
  (bot as unknown as { _client: EventEmitter })._client.emit('packet', { windowId: 11, property: 4, value: 12 }, { name: 'craft_progress_bar' });
  const result = await executor('inspect-open-window')({});
  const data = JSON.parse(result.content[0]!.text) as { window: { menuTypeId: number; menuIdentity: { status: string }; layout: { status: string }; stateId: number; synchronization: string; syncedProperties: Array<{ propertyId: number; value: number; semanticField: string | null }> } };
  t.is(data.window.menuTypeId, 900);
  t.is(data.window.menuIdentity.status, 'unresolved');
  t.is(data.window.layout.status, 'unknown');
  t.is(data.window.stateId, 1);
  t.is(data.window.synchronization, 'complete-window-items-observed');
  t.deepEqual(data.window.syncedProperties, [{ propertyId: 4, value: 12, semanticField: null, semanticsStatus: 'raw-property-only' }]);
});

test('known vanilla layout requires a version-specific raw type ID and matching Mineflayer window model', async (t) => {
  const bot = mockBot();
  const window = { id: 12, type: 'minecraft:furnace', title: 'Furnace', slots: Array(39).fill(null), inventoryStart: 3, inventoryEnd: 39, selectedItem: null };
  const { executor } = setup(bot);
  primeWindow(bot, window, 14);
  const result = await executor('inspect-open-window')({});
  const data = JSON.parse(result.content[0]!.text) as { window: { menuIdentity: { status: string; namespacedId: string; provenance: { source: string } }; layout: { status: string; menuSlots: { endExclusive: number }; playerInventory: { start: number; endExclusive: number }; hotbar: { start: number; endExclusive: number } } } };
  t.is(data.window.menuIdentity.status, 'resolved');
  t.is(data.window.menuIdentity.namespacedId, 'minecraft:furnace');
  t.is(data.window.menuIdentity.provenance.source, 'version-specific-prismarine-windows-menu-type');
  t.is(data.window.layout.status, 'known');
  t.is(data.window.layout.menuSlots.endExclusive, 3);
  t.deepEqual(data.window.layout.playerInventory, { start: 3, endExclusive: 30 });
  t.deepEqual(data.window.layout.hotbar, { start: 30, endExclusive: 39 });
});

test('the raw versioned menu type ID outranks a contradictory Mineflayer type hint', async (t) => {
  const bot = mockBot();
  const window = { id: 17, type: 'minecraft:furnace', title: 'Unknown', slots: Array(39).fill(null), inventoryStart: 3, inventoryEnd: 39, selectedItem: null };
  const { executor } = setup(bot);
  primeWindow(bot, window, 15);
  const result = await executor('inspect-open-window')({});
  const data = JSON.parse(result.content[0]!.text) as { window: { menuTypeId: number; mineflayerTypeHint: string; menuIdentity: { status: string; namespacedId: string }; layout: { status: string } } };
  t.is(data.window.menuTypeId, 15);
  t.is(data.window.mineflayerTypeHint, 'minecraft:furnace');
  t.is(data.window.menuIdentity.status, 'resolved');
  t.is(data.window.menuIdentity.namespacedId, 'minecraft:grindstone');
  t.is(data.window.layout.status, 'known');
});

test('an authenticated Processia menu mapping enables only its explicit Java-derived slot contract', async (t) => {
  const bot = mockBot();
  const window = { id: 13, type: 1500, title: 'Crusher', slots: Array(38).fill(null), inventoryStart: 2, inventoryEnd: 38, selectedItem: null };
  const provenance = {
    source: 'neoforge-bridge', authority: 'authenticated-runtime', minecraftVersion: '1.21.1', registryEpoch: 'test-epoch',
    runtimeEpoch: 'runtime-1', minecraftEndpoint: '127.0.0.1:25665', bridgeSessionId: 'bridge-1',
    sourceRegistryEpoch: 'java-registry-1', serverIdentity: 'test-server',
  };
  const service = { resolve: sinon.stub().returns({
    status: 'resolved', kind: 'menu', minecraftVersion: '1.21.1', registryEpoch: 'test-epoch', runtimeEpoch: 'runtime-1',
    lookup: { kind: 'menu', minecraftVersion: '1.21.1', numericId: 1500, registryEpoch: 'test-epoch' },
    entry: { kind: 'menu', minecraftVersion: '1.21.1', namespacedId: 'processia:crusher', numericId: 1500, numericIdScope: 'server-registry-generation', registryEpoch: 'test-epoch', provenance }, provenance,
  }) };
  const context = {
    connected: true, registryEpoch: 'test-epoch', runtimeEpoch: 'runtime-1', minecraftVersion: '1.21.1', minecraftEndpoint: '127.0.0.1:25665',
    bridgeAvailable: true, bridgeSessionId: 'bridge-1', sourceRegistryEpoch: 'java-registry-1', serverIdentity: 'test-server',
    bridgeSession: { authenticated: true, sessionId: 'bridge-1', serverIdentity: 'test-server', minecraftEndpoint: '127.0.0.1:25665', minecraftVersion: '1.21.1', sourceRegistryEpoch: 'java-registry-1' }, registryService: service,
  } as unknown as Partial<RuntimeRegistryContext>;
  const { executor } = setup(bot, context, [createProcessiaMenuLayoutProvider()]);
  primeWindow(bot, window, 1500);
  (bot as unknown as { _client: EventEmitter })._client.emit('packet', { windowId: 13, property: 4, value: 19 }, { name: 'craft_progress_bar' });
  const result = await executor('inspect-open-window')({});
  const data = JSON.parse(result.content[0]!.text) as { window: { menuIdentity: { status: string; namespacedId: string }; layout: { status: string; machineInputSlots: number[]; machineOutputSlots: number[] }; syncedProperties: Array<{ semanticField: string | null; value: number }> } };
  t.is(data.window.menuIdentity.status, 'resolved');
  t.is(data.window.menuIdentity.namespacedId, 'processia:crusher');
  t.is(data.window.layout.status, 'known');
  t.deepEqual(data.window.layout.machineInputSlots, [0]);
  t.deepEqual(data.window.layout.machineOutputSlots, [1]);
  t.deepEqual(data.window.syncedProperties.map(({ semanticField, value }) => ({ semanticField, value })), [{ semanticField: 'progress', value: 19 }]);
});

test('a menu mapping from another server cannot be bypassed by Mineflayer vanilla type hints', async (t) => {
  const bot = mockBot();
  const window = { id: 16, type: 'minecraft:furnace', title: 'Furnace', slots: Array(39).fill(null), inventoryStart: 3, inventoryEnd: 39, selectedItem: null };
  const wrongServerProvenance = {
    source: 'neoforge-bridge', authority: 'authenticated-runtime', minecraftVersion: '1.21.1', registryEpoch: 'test-epoch',
    runtimeEpoch: 'runtime-1', minecraftEndpoint: '127.0.0.1:25665', bridgeSessionId: 'bridge-1',
    sourceRegistryEpoch: 'java-registry-1', serverIdentity: 'different-server',
  };
  const context = {
    connected: true, registryEpoch: 'test-epoch', runtimeEpoch: 'runtime-1', minecraftVersion: '1.21.1', minecraftEndpoint: '127.0.0.1:25665',
    bridgeAvailable: true, bridgeSessionId: 'bridge-1', sourceRegistryEpoch: 'java-registry-1', serverIdentity: 'current-server',
    bridgeSession: { authenticated: true, sessionId: 'bridge-1', serverIdentity: 'current-server', minecraftEndpoint: '127.0.0.1:25665', minecraftVersion: '1.21.1', sourceRegistryEpoch: 'java-registry-1' },
    registryService: { resolve: sinon.stub().returns({
      status: 'resolved', kind: 'menu', minecraftVersion: '1.21.1', registryEpoch: 'test-epoch', runtimeEpoch: 'runtime-1',
      lookup: { kind: 'menu', minecraftVersion: '1.21.1', numericId: 14, registryEpoch: 'test-epoch' },
      entry: { kind: 'menu', minecraftVersion: '1.21.1', namespacedId: 'processia:crusher', numericId: 14, numericIdScope: 'server-registry-generation', registryEpoch: 'test-epoch', provenance: wrongServerProvenance },
      provenance: wrongServerProvenance,
    }) },
  } as unknown as Partial<RuntimeRegistryContext>;
  const { executor } = setup(bot, context);
  primeWindow(bot, window, 14);
  const result = await executor('inspect-open-window')({});
  const data = JSON.parse(result.content[0]!.text) as { window: { menuIdentity: { status: string; reason: string }; layout: { status: string } } };
  t.is(data.window.menuIdentity.status, 'unresolved');
  t.is(data.window.menuIdentity.reason, 'menu-mapping-provenance-not-linked-to-current-authenticated-bridge');
  t.is(data.window.layout.status, 'unknown');
});

test('click-window-slot rejects an out-of-range slot and close-open-window closes only matching window', async (t) => {
  const bot = mockBot();
  const window = { id: 5, type: 1005, title: 'Unknown', slots: [null], inventoryStart: 1, inventoryEnd: 1, selectedItem: null };
  const { executor } = setup(bot);
  primeWindow(bot, window, 1005);
  const invalid = await executor('click-window-slot')({ windowId: 5, slot: 1, action: 'left', registryEpoch: 'test-epoch' });
  t.true(invalid.isError);
  const stale = await executor('close-open-window')({ windowId: 4, registryEpoch: 'test-epoch' });
  t.true(stale.isError);
  const closed = await executor('close-open-window')({ windowId: 5, windowGeneration: 1, registryEpoch: 'test-epoch' });
  t.falsy(closed.isError);
  t.true((bot.closeWindow as unknown as sinon.SinonStub).calledOnceWith(window));
});
