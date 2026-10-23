import test from 'ava';
import sinon from 'sinon';
import type { Bot } from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerWindowTools } from '../src/tools/window-tools.js';
import type { RuntimeRegistryContext } from '../src/services/runtime-registry-service.js';
import {
  ANOTHER_CONTAINER, EXAMPLE_MACHINE, PROTOCOL_VERSION, SERVER_A, SERVER_B, SERVER_REORDERED,
  createFakeBot, createModdedSession, emptySlot, packets, stack, type FakeBot,
} from './fixtures/modded-menus.js';
import minecraftData from 'minecraft-data';

type ToolResult = { content: { text: string }[]; isError?: boolean };
interface RawSlot { slot: number; empty: boolean; rawNumericItemId: number | null; count: number | null; namespacedId: string | null; identity: string; componentTypeIds: unknown[]; componentPayloads: string }
interface RawWindow {
  mode: string; interactionsAllowed: boolean; interactionCapability: string; windowId: number; menuTypeId: number | null;
  menuIdentity: { status: string; namespacedId?: string; reason?: string; provenance?: { serverIdentity?: string; authority?: string; bridgeSessionId?: string } };
  runtimeContextStatus: string; titleDataTrust: string; stateId: number | null; contentStatus: string; observedSlotCount: number | null;
  layout: { status: string }; slots: RawSlot[] | null; syncedProperties: Array<{ propertyId: number; value: number; semanticField: string | null; semanticsStatus: string }>;
}
interface Inspection { status: string; registryEpoch: string | null; rawWindow: RawWindow | null; window: Record<string, unknown> | null }

function tools(bot: FakeBot, getContext: () => RuntimeRegistryContext | null) {
  const extended = bot as unknown as Partial<Bot>;
  extended.clickWindow = sinon.stub().resolves() as unknown as Bot['clickWindow'];
  extended.closeWindow = sinon.stub().resolves() as unknown as Bot['closeWindow'];
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  registerWindowTools(new ToolFactory(server, connection), () => bot as unknown as Bot, getContext);
  const run = (name: string) => (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === name)!.args[3] as (args: Record<string, unknown>) => Promise<ToolResult>;
  const inspect = async () => JSON.parse((await run('inspect-open-window')({})).content[0]!.text) as Inspection;
  return { run, inspect, clickWindow: extended.clickWindow as unknown as sinon.SinonStub };
}

function openExampleMachine(bot: FakeBot, menuTypeId: number) {
  packets.openWindow(bot._client, EXAMPLE_MACHINE.windowId, menuTypeId, EXAMPLE_MACHINE.title);
  packets.windowItems(bot._client, EXAMPLE_MACHINE.windowId, 3, EXAMPLE_MACHINE.items());
  for (const [property, value] of EXAMPLE_MACHINE.properties) packets.property(bot._client, EXAMPLE_MACHINE.windowId, property, value);
}

test('fixtures target Minecraft 1.21.1 protocol 767 with modded IDs outside the vanilla menu and item tables', (t) => {
  const data = minecraftData('1.21.1');
  t.is(data.version.version, PROTOCOL_VERSION);
  t.true(Math.max(...data.itemsArray.map(item => item.id)) < 1400);
  t.is(EXAMPLE_MACHINE.items().length, EXAMPLE_MACHINE.slotCount);
  t.is(ANOTHER_CONTAINER.items().length, ANOTHER_CONTAINER.slotCount);
});

test('examplemod:machine_menu is observed raw-only with authenticated identities, unresolved data kept raw, and no click path', async (t) => {
  const bot = createFakeBot();
  const session = createModdedSession(bot);
  const bridge = session.attachBridge(SERVER_A);
  const { run, inspect, clickWindow } = tools(bot, session.context);
  openExampleMachine(bot, 25);

  const view = await inspect();
  const raw = view.rawWindow!;
  t.is(view.status, 'raw-only-window-observed');
  t.is(raw.mode, 'raw-only-read-only');
  t.false(raw.interactionsAllowed);
  t.is(raw.interactionCapability, 'unsupported-for-raw-only-window');
  t.is(raw.menuTypeId, 25);
  t.is(raw.menuIdentity.status, 'resolved');
  t.is(raw.menuIdentity.namespacedId, 'examplemod:machine_menu');
  t.is(raw.menuIdentity.provenance?.authority, 'authenticated-runtime');
  t.is(raw.menuIdentity.provenance?.serverIdentity, SERVER_A.serverIdentity);
  t.is(raw.menuIdentity.provenance?.bridgeSessionId, bridge.sessionId);
  t.is(raw.runtimeContextStatus, 'current');
  t.is(raw.titleDataTrust, 'untrusted-display-data');
  t.is(raw.layout.status, 'unknown');
  t.is(raw.contentStatus, 'complete-packet-observed');
  t.is(raw.observedSlotCount, EXAMPLE_MACHINE.slotCount);
  t.is(raw.stateId, 3);
  t.deepEqual(
    raw.slots!.slice(0, 2).map(slot => [slot.rawNumericItemId, slot.count, slot.namespacedId, slot.identity, slot.componentTypeIds, slot.componentPayloads]),
    [[1400, 3, 'examplemod:copper_gear', 'authenticated-runtime-registry', [42], 'omitted-bounded-summary-only'], [null, 0, null, 'empty', [], 'omitted-bounded-summary-only']],
  );
  // Vanilla item 1 is absent from the partial bridge item snapshot: it stays a raw ID, not a guessed static name.
  t.deepEqual([raw.slots![2]!.rawNumericItemId, raw.slots![2]!.namespacedId, raw.slots![2]!.identity], [1, null, 'unresolved-raw-protocol-item-id']);
  // Signed raw values are kept verbatim; no provider names properties of an unknown modded layout.
  t.deepEqual(raw.syncedProperties.map(property => [property.propertyId, property.value, property.semanticField, property.semanticsStatus]),
    [[0, 120, null, 'raw-property-only'], [1, 400, null, 'raw-property-only'], [2, -1, null, 'raw-property-only'], [3, 32767, null, 'raw-property-only']]);

  const click = await run('click-window-slot')({ windowId: EXAMPLE_MACHINE.windowId, slot: 0, action: 'left', registryEpoch: view.registryEpoch });
  t.true(click.isError);
  t.regex(click.content[0]!.text, /no-window-open/);
  const shift = await run('click-window-slot')({ windowId: EXAMPLE_MACHINE.windowId, slot: 0, action: 'shift', registryEpoch: view.registryEpoch });
  t.true(shift.isError);
  t.false(clickWindow.called);
});

test('raw-only stateId only moves forward and malformed slot updates invalidate content instead of fabricating it', async (t) => {
  const bot = createFakeBot();
  const session = createModdedSession(bot);
  session.attachBridge(SERVER_A);
  const { inspect } = tools(bot, session.context);
  openExampleMachine(bot, 25);

  packets.setSlot(bot._client, EXAMPLE_MACHINE.windowId, 5, 1, stack(1401, 2));
  packets.setSlot(bot._client, EXAMPLE_MACHINE.windowId, 4, 1, stack(1500, 9));
  let raw = (await inspect()).rawWindow!;
  t.is(raw.stateId, 5);
  t.deepEqual([raw.slots![1]!.rawNumericItemId, raw.slots![1]!.count, raw.slots![1]!.namespacedId], [1401, 2, 'anothermod:widget']);

  packets.windowItems(bot._client, EXAMPLE_MACHINE.windowId, 4, EXAMPLE_MACHINE.items());
  raw = (await inspect()).rawWindow!;
  t.is(raw.stateId, 5, 'an older full snapshot must not roll back a newer server state');
  t.is(raw.slots![1]!.rawNumericItemId, 1401);

  packets.setSlot(bot._client, EXAMPLE_MACHINE.windowId, 6, 1, { itemCount: 2 });
  raw = (await inspect()).rawWindow!;
  t.is(raw.contentStatus, 'oversized-or-malformed');
  t.is(raw.slots, null);
});

test('anothermod:custom_container without an authenticated bridge stays unresolved and is never named from vanilla tables', async (t) => {
  const bot = createFakeBot();
  const session = createModdedSession(bot);
  const { inspect } = tools(bot, session.context);
  packets.openWindow(bot._client, ANOTHER_CONTAINER.windowId, 26, ANOTHER_CONTAINER.title);
  packets.windowItems(bot._client, ANOTHER_CONTAINER.windowId, 1, ANOTHER_CONTAINER.items());

  const raw = (await inspect()).rawWindow!;
  t.is(raw.menuIdentity.status, 'unresolved');
  t.is(raw.menuIdentity.namespacedId, undefined);
  t.is(raw.layout.status, 'unknown');
  t.false(raw.interactionsAllowed);
  t.deepEqual(raw.slots!.filter(slot => !slot.empty).map(slot => [slot.rawNumericItemId, slot.namespacedId, slot.identity]),
    [[1500, null, 'unresolved-raw-protocol-item-id'], [1401, null, 'unresolved-raw-protocol-item-id'], [2, null, 'unresolved-raw-protocol-item-id']]);
  t.deepEqual(raw.syncedProperties, []);
});

test('the same numeric menu and item IDs resolve per server, never across servers', async (t) => {
  const observe = async (registry: typeof SERVER_A) => {
    const bot = createFakeBot();
    const session = createModdedSession(bot);
    session.attachBridge(registry);
    const { inspect } = tools(bot, session.context);
    openExampleMachine(bot, 25);
    return (await inspect()).rawWindow!;
  };
  const onA = await observe(SERVER_A);
  const onB = await observe(SERVER_B);
  t.is(onA.menuIdentity.namespacedId, 'examplemod:machine_menu');
  t.is(onB.menuIdentity.namespacedId, 'anothermod:custom_container');
  t.is(onA.menuIdentity.provenance?.serverIdentity, SERVER_A.serverIdentity);
  t.is(onB.menuIdentity.provenance?.serverIdentity, SERVER_B.serverIdentity);
  t.is(onA.slots![0]!.namespacedId, 'examplemod:copper_gear');
  t.is(onB.slots![0]!.namespacedId, 'anothermod:widget');
});

test('bridge revocation after observation withholds every mapping, including the static vanilla menu table', async (t) => {
  const bot = createFakeBot();
  const session = createModdedSession(bot);
  const bridge = session.attachBridge(SERVER_REORDERED);
  const { inspect } = tools(bot, session.context);
  openExampleMachine(bot, 2);
  t.is((await inspect()).rawWindow!.menuIdentity.namespacedId, 'examplemod:machine_menu');

  session.revokeBridge(bridge.sessionId);
  const raw = (await inspect()).rawWindow!;
  t.is(raw.runtimeContextStatus, 'changed-or-unavailable');
  t.is(raw.menuIdentity.status, 'unresolved');
  t.is(raw.menuIdentity.reason, 'runtime-context-changed-since-menu-was-observed');
  t.is(raw.menuIdentity.namespacedId, undefined, 'menu 2 must not be renamed minecraft:generic_9x3');
  t.is(raw.layout.status, 'unknown');
  t.true(raw.slots!.every(slot => slot.namespacedId === null));
});

test('a renewed bridge session invalidates earlier observations, and new observations use only the new mapping', async (t) => {
  const bot = createFakeBot();
  const session = createModdedSession(bot);
  session.attachBridge(SERVER_A);
  const { inspect } = tools(bot, session.context);
  openExampleMachine(bot, 25);
  t.is((await inspect()).rawWindow!.menuIdentity.namespacedId, 'examplemod:machine_menu');

  // Same Mineflayer session, new authenticated bridge generation with a different registry.
  session.attachBridge(SERVER_B);
  const stale = (await inspect()).rawWindow!;
  t.is(stale.menuIdentity.status, 'unresolved');
  t.is(stale.slots![0]!.namespacedId, null);

  openExampleMachine(bot, 25);
  const fresh = (await inspect()).rawWindow!;
  t.is(fresh.runtimeContextStatus, 'current');
  t.is(fresh.menuIdentity.namespacedId, 'anothermod:custom_container');
  t.is(fresh.menuIdentity.provenance?.serverIdentity, SERVER_B.serverIdentity);
  t.is(fresh.slots![0]!.namespacedId, 'anothermod:widget');
});

test('session boundaries and reconnects drop raw observations instead of carrying them into the next session', async (t) => {
  const bot = createFakeBot();
  const session = createModdedSession(bot);
  session.attachBridge(SERVER_A);
  const { inspect } = tools(bot, session.context);
  openExampleMachine(bot, 25);
  const before = await inspect();
  t.is(before.status, 'raw-only-window-observed');

  bot._client.emit('login');
  t.is((await inspect()).status, 'no-window');

  // Reconnect: a new Bot object gets a fresh tracker and a fresh registry epoch.
  const reconnected = createFakeBot();
  session.state.bot = reconnected;
  const next = tools(reconnected, session.context);
  const after = await next.inspect();
  t.is(after.status, 'no-window');
  t.not(after.registryEpoch, before.registryEpoch);
  t.is(session.context().bridgeSessionId, null, 'the reconnect must not inherit the earlier bridge session');
});

test('a closed raw window is no longer reported and later packets for it are ignored', async (t) => {
  const bot = createFakeBot();
  const session = createModdedSession(bot);
  session.attachBridge(SERVER_A);
  const { inspect } = tools(bot, session.context);
  openExampleMachine(bot, 25);
  packets.closeWindow(bot._client, EXAMPLE_MACHINE.windowId);
  packets.windowItems(bot._client, EXAMPLE_MACHINE.windowId, 9, EXAMPLE_MACHINE.items());
  t.is((await inspect()).status, 'no-window');
});

test('a complete authenticated menu registry that lacks an ID blocks the static vanilla table', async (t) => {
  const bot = createFakeBot();
  const session = createModdedSession(bot);
  session.attachBridge(SERVER_REORDERED);
  const { inspect } = tools(bot, session.context);
  packets.openWindow(bot._client, 11, 5, 'Unregistered menu');
  packets.windowItems(bot._client, 11, 1, Array.from({ length: 90 }, emptySlot));
  const raw = (await inspect()).rawWindow!;
  t.is(raw.menuIdentity.status, 'unresolved');
  t.is(raw.menuIdentity.reason, 'menu-type-id-absent-from-complete-runtime-registry');
  t.is(raw.layout.status, 'unknown', 'minecraft:generic_9x6 must not be inferred');
});

test('a contradictory authenticated menu mapping is ambiguous and never falls back to a static name', async (t) => {
  const bot = createFakeBot();
  const session = createModdedSession(bot);
  session.attachBridge({ serverIdentity: 'synthetic-contradictory', menus: [[2, 'examplemod:machine_menu'], [2, 'anothermod:custom_container']], items: [] });
  const { inspect } = tools(bot, session.context);
  openExampleMachine(bot, 2);
  const raw = (await inspect()).rawWindow!;
  t.is(raw.menuIdentity.status, 'unresolved');
  t.is(raw.menuIdentity.reason, 'ambiguous-runtime-menu-mapping');
});

test('a Mineflayer-built vanilla window names slot items from the authenticated registry and flags contradicting Mineflayer names', async (t) => {
  const bot = createFakeBot();
  const session = createModdedSession(bot);
  const bridge = session.attachBridge(SERVER_REORDERED);
  const { run, inspect, clickWindow } = tools(bot, session.context);
  const slots = Array.from({ length: 45 }, () => null as null | { name: string; type: number; count: number; metadata: number });
  slots[0] = { name: 'stone', type: 1, count: 5, metadata: 0 };
  slots[1] = { name: 'dirt', type: 28, count: 2, metadata: 0 };
  const window = { id: 4, type: 'minecraft:generic_9x1', title: 'Chest', slots, inventoryStart: 9, inventoryEnd: 45, selectedItem: null };
  bot.currentWindow = window;
  packets.openWindow(bot._client, 4, 0, 'Chest');
  packets.windowItems(bot._client, 4, 2, slots.map(item => item ? stack(item.type, item.count) : emptySlot()));
  bot.emit('windowOpen', window);

  const view = await inspect();
  const snapshot = view.window as { menuIdentity: { namespacedId: string; provenance: { authority: string } }; capabilities: { indexedLeftRightClick: boolean }; slots: Array<Record<string, unknown>> };
  t.is(snapshot.menuIdentity.namespacedId, 'minecraft:generic_9x1');
  t.is(snapshot.menuIdentity.provenance.authority, 'authenticated-runtime');
  t.like(snapshot.slots[0], { name: 'stone', rawNumericId: 1, namespacedId: 'examplemod:copper_gear', identity: 'authenticated-runtime-registry', mineflayerNameStatus: 'contradicts-runtime-registry' });
  t.like(snapshot.slots[1], { name: 'dirt', rawNumericId: 28, namespacedId: null, identity: 'mineflayer-name-only', mineflayerNameStatus: 'not-checked-against-runtime-registry' });
  t.true(snapshot.capabilities.indexedLeftRightClick);

  session.revokeBridge(bridge.sessionId);
  const stale = (await inspect()).window as { menuIdentity: { status: string; reason: string }; capabilities: { indexedLeftRightClick: boolean }; slots: Array<Record<string, unknown>> };
  t.is(stale.menuIdentity.reason, 'runtime-context-changed-since-menu-was-observed');
  t.false(stale.capabilities.indexedLeftRightClick);
  t.like(stale.slots[0], { namespacedId: null, identity: 'mineflayer-name-only' });
  const click = await run('click-window-slot')({ windowId: 4, slot: 0, action: 'left', registryEpoch: view.registryEpoch });
  t.true(click.isError);
  t.regex(click.content[0]!.text, /stale-window-runtime-context/);
  t.false(clickWindow.called);
});
