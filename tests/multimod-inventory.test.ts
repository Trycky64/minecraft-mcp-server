import test from 'ava';
import sinon from 'sinon';
import type mineflayer from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerInventoryTools } from '../src/tools/inventory-tools.js';
import { registerCraftingTools } from '../src/tools/crafting-tools.js';
import { createFakeBot, createModdedSession, type FakeBot, type ModdedServerRegistry } from './fixtures/modded-menus.js';

// minecraft-data 1.21.1 item IDs: stone 1, oak_planks 36, stick 848. Modded IDs start at 1333.
// All registries are synthetic; no server is contacted.
const CONSISTENT: ModdedServerRegistry = { serverIdentity: 'synthetic-items-consistent', menus: [], items: [[1, 'minecraft:stone'], [36, 'minecraft:oak_planks'], [848, 'minecraft:stick']] };
const SERVER_A: ModdedServerRegistry = { serverIdentity: 'synthetic-items-a', menus: [], items: [[1400, 'examplemod:copper_gear'], [1401, 'anothermod:widget']] };
const SERVER_B: ModdedServerRegistry = { serverIdentity: 'synthetic-items-b', menus: [], items: [[1400, 'anothermod:widget'], [1401, 'examplemod:copper_gear']] };
const REORDERED: ModdedServerRegistry = { serverIdentity: 'synthetic-items-reordered', menus: [], items: [[1, 'examplemod:copper_gear'], [36, 'anothermod:widget'], [848, 'minecraft:stick']] };
const OUTPUT_REORDERED: ModdedServerRegistry = { serverIdentity: 'synthetic-output-reordered', menus: [], items: [[36, 'minecraft:oak_planks'], [848, 'anothermod:widget']] };
const COMPLETE_WITHOUT_STONE: ModdedServerRegistry = { serverIdentity: 'synthetic-items-complete', menus: [], itemCoverage: 'complete', items: [[36, 'minecraft:oak_planks'], [848, 'minecraft:stick'], [1400, 'examplemod:copper_gear']] };
const AMBIGUOUS: ModdedServerRegistry = { serverIdentity: 'synthetic-items-ambiguous', menus: [], items: [[1, 'minecraft:stone'], [1, 'examplemod:copper_gear']] };

type Stack = { name: string; type: number; count: number; slot: number };
const STONE: Stack = { name: 'stone', type: 1, count: 5, slot: 36 };
const PLANKS: Stack = { name: 'oak_planks', type: 36, count: 8, slot: 37 };
const MODDED: Stack = { name: 'unknown', type: 1400, count: 3, slot: 38 };

function inventory(bot: FakeBot, stacks: Stack[], hooks: { onCraft?: (call: number) => void } = {}) {
  const slots: Array<Stack | null> = Array(46).fill(null);
  for (const stack of stacks) slots[stack.slot] = stack;
  let crafts = 0;
  Object.assign(bot as unknown as mineflayer.Bot, {
    inventory: { items: () => slots.filter((stack): stack is Stack => stack !== null), slots, hotbarStart: 36, selectedItem: null },
    quickBarSlot: 0, heldItem: null, currentWindow: null,
    equip: sinon.stub().resolves(), getEquipmentDestSlot: () => 36,
    craft: sinon.stub().callsFake(async () => { crafts += 1; hooks.onCraft?.(crafts); }),
  });
}

function setup(registry: ModdedServerRegistry | null, stacks: Stack[], hooks: Parameters<typeof inventory>[2] = {}) {
  const bot = createFakeBot();
  inventory(bot, stacks, hooks);
  const session = createModdedSession(bot);
  const bridge = registry ? session.attachBridge(registry) : null;
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  const getBot = () => session.state.bot as unknown as mineflayer.Bot;
  registerInventoryTools(factory, getBot, session.context);
  registerCraftingTools(factory, getBot, session.context);
  const run = (name: string) => (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === name)!.args[3] as
    (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const extended = bot as unknown as { equip: sinon.SinonStub; craft: sinon.SinonStub };
  return {
    bot, session, bridge, run,
    listed: async () => {
      const text = (await run('list-inventory')({})).content[0]!.text;
      return { text, json: JSON.parse(text.split('Registry details (JSON):\n')[1]!) as { items: Array<Record<string, unknown>> } };
    },
    equipCalls: () => extended.equip.callCount, craftCalls: () => extended.craft.callCount,
  };
}

test('a consistent vanilla inventory without a bridge keeps finding, equipping and crafting', async (t) => {
  const ctx = setup(null, [STONE, PLANKS]);
  t.regex((await ctx.run('find-item')({ nameOrType: 'minecraft:stone' })).content[0]!.text, /Found 5 stone/);
  t.falsy((await ctx.run('equip-item')({ itemName: 'stone' })).isError);
  t.is(ctx.equipCalls(), 1);
  const crafted = await ctx.run('craft-item')({ outputItem: 'stick' });
  t.falsy(crafted.isError);
  t.is(ctx.craftCalls(), 1);
});

test('a consistent authenticated registry keeps the same behavior and reports the match', async (t) => {
  const ctx = setup(CONSISTENT, [STONE, PLANKS]);
  const stone = (await ctx.listed()).json.items.find(item => item.rawNumericId === 1)!;
  t.like(stone, { namespacedId: 'minecraft:stone', identityConfidence: 'session-observed', mineflayerNameReliable: true, mineflayerNameStatus: 'matches-runtime-registry' });
  t.falsy((await ctx.run('equip-item')({ itemName: 'minecraft:stone', registryEpoch: ctx.session.context().registryEpoch })).isError);
  t.is(ctx.equipCalls(), 1);
  t.falsy((await ctx.run('craft-item')({ outputItem: 'stick' })).isError);
  t.is(ctx.craftCalls(), 1);
});

test('two independent mod namespaces resolve per server for the same numeric IDs', async (t) => {
  const onA = setup(SERVER_A, [MODDED]);
  const onB = setup(SERVER_B, [MODDED]);
  t.like((await onA.listed()).json.items[0], { rawNumericId: 1400, namespacedId: 'examplemod:copper_gear', mineflayerName: 'unknown' });
  t.like((await onB.listed()).json.items[0], { rawNumericId: 1400, namespacedId: 'anothermod:widget' });
  t.regex((await onA.run('find-item')({ nameOrType: 'examplemod:copper_gear' })).content[0]!.text, /^Found 3/);
  t.regex((await onB.run('find-item')({ nameOrType: 'examplemod:copper_gear' })).content[0]!.text, /Couldn't find/);
  t.falsy((await onB.run('equip-item')({ itemName: 'anothermod:widget' })).isError);
  t.is(onB.equipCalls(), 1);
});

test('a contradicted Mineflayer name is flagged and never used to find or equip the stack', async (t) => {
  const ctx = setup(REORDERED, [STONE]);
  const { text, json } = await ctx.listed();
  t.like(json.items[0], { rawNumericId: 1, namespacedId: 'examplemod:copper_gear', mineflayerName: 'stone', mineflayerNameReliable: false, mineflayerNameStatus: 'contradicts-runtime-registry' });
  t.regex(text, /contradict/);
  t.regex((await ctx.run('find-item')({ nameOrType: 'minecraft:stone' })).content[0]!.text, /Couldn't find/);
  t.regex((await ctx.run('find-item')({ nameOrType: 'stone' })).content[0]!.text, /Couldn't find/);
  await ctx.run('equip-item')({ itemName: 'minecraft:stone' });
  await ctx.run('equip-item')({ itemName: 'stone' });
  t.is(ctx.equipCalls(), 0);
  t.falsy((await ctx.run('equip-item')({ itemName: 'examplemod:copper_gear' })).isError);
  t.is(ctx.equipCalls(), 1, 'the runtime identity itself remains usable');
});

test('items absent from a complete registry or with an ambiguous mapping are not selectable by name', async (t) => {
  const absent = setup(COMPLETE_WITHOUT_STONE, [STONE]);
  t.like((await absent.listed()).json.items[0], { resolutionStatus: 'unresolved', resolutionReason: 'identifier-not-found', mineflayerNameStatus: 'absent-from-complete-runtime-registry', mineflayerNameReliable: false });
  await absent.run('equip-item')({ itemName: 'minecraft:stone' });
  t.is(absent.equipCalls(), 0);
  const ambiguous = setup(AMBIGUOUS, [STONE]);
  t.like((await ambiguous.listed()).json.items[0], { resolutionStatus: 'ambiguous', namespacedId: null, mineflayerNameStatus: 'ambiguous-runtime-mapping' });
  await ambiguous.run('equip-item')({ itemName: 'stone' });
  t.is(ambiguous.equipCalls(), 0);
});

test('unknown numeric item IDs stay raw and partial coverage is distinguished from unavailable registries', async (t) => {
  const partial = setup(SERVER_A, [{ name: 'unknown', type: 9999, count: 1, slot: 36 }]);
  t.like((await partial.listed()).json.items[0], { rawNumericId: 9999, namespacedId: null, resolutionStatus: 'unresolved', resolutionReason: 'mapping-not-observed', identityConfidence: 'unresolved', mineflayerNameStatus: 'mineflayer-name-unavailable' });
  const noBridge = setup(null, [{ name: 'unknown', type: 9999, count: 1, slot: 36 }]);
  const item = (await noBridge.listed()).json.items[0]!;
  t.is(item.namespacedId, null);
  t.not(item.resolutionReason, 'identifier-not-found');
});

test('craft-item refuses a recipe whose ingredients the server identifies differently, without crafting', async (t) => {
  const ctx = setup(REORDERED, [STONE, PLANKS]);
  const result = await ctx.run('craft-item')({ outputItem: 'stick' });
  t.true(result.isError);
  t.regex(result.content[0]!.text, /anothermod:widget/);
  t.is(ctx.craftCalls(), 0);
});

test('craft-item refuses a static output that the server registry maps to another item', async (t) => {
  const ctx = setup(OUTPUT_REORDERED, [PLANKS]);
  const result = await ctx.run('craft-item')({ outputItem: 'stick' });
  t.true(result.isError);
  t.regex(result.content[0]!.text, /output.*anothermod:widget/);
  t.is(ctx.craftCalls(), 0);
});

test('craft-item stops before the next operation when the bridge is revoked or renewed mid-request', async (t) => {
  let change = () => {};
  const revoked = setup(CONSISTENT, [PLANKS], { onCraft: () => change() });
  change = () => revoked.session.revokeBridge(revoked.bridge!.sessionId);
  const result = await revoked.run('craft-item')({ outputItem: 'stick', amount: 3 });
  t.is(revoked.craftCalls(), 1);
  t.true(result.isError);
  t.regex(result.content[0]!.text, /runtime-context-changed-before-action/);
  t.regex(result.content[0]!.text, /"completedOperations":1/);

  let renew = () => {};
  const renewed = setup(CONSISTENT, [PLANKS], { onCraft: () => renew() });
  renew = () => { renewed.session.attachBridge({ ...CONSISTENT, serverIdentity: 'synthetic-renewed' }); };
  await renewed.run('craft-item')({ outputItem: 'stick', amount: 3 });
  t.is(renewed.craftCalls(), 1);
});

test('craft-item stops on reconnect or server change and never crafts on the new bot', async (t) => {
  let reconnect = () => {};
  const ctx = setup(CONSISTENT, [PLANKS], { onCraft: () => reconnect() });
  const next = createFakeBot();
  inventory(next, [PLANKS]);
  reconnect = () => { ctx.session.state.bot = next; };
  const result = await ctx.run('craft-item')({ outputItem: 'stick', amount: 2 });
  t.regex(result.content[0]!.text, /runtime-context-changed-before-action/);
  t.is(ctx.craftCalls(), 1);
  t.is(((next as unknown as { craft: sinon.SinonStub }).craft).callCount, 0);
});

test('stale caller epochs are refused before equip or craft', async (t) => {
  const ctx = setup(CONSISTENT, [STONE, PLANKS]);
  const equip = await ctx.run('equip-item')({ itemName: 'stone', registryEpoch: 'mineflayer-registry:previous' });
  const craft = await ctx.run('craft-item')({ outputItem: 'stick', registryEpoch: 'mineflayer-registry:previous' });
  t.regex(equip.content[0]!.text, /stale-registry-epoch/);
  t.regex(craft.content[0]!.text, /stale-registry-epoch/);
  t.is(ctx.equipCalls(), 0);
  t.is(ctx.craftCalls(), 0);
});
