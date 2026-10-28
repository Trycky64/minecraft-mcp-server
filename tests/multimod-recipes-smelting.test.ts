import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import type mineflayer from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Vec3 } from 'vec3';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';
import { registerCraftingTools } from '../src/tools/crafting-tools.js';
import { createFakeBot, createModdedSession, type FakeBot, type ModdedServerRegistry } from './fixtures/modded-menus.js';

// minecraft-data 1.21.1: raw_iron 810, coal 803, iron_ingot 811, oak_planks 36, stick 848; furnace states 4294..4301.
// All registries are synthetic; no server or furnace is contacted.
const items = (overrides: Array<[number, string]> = []): Array<[number, string]> => {
  const base = new Map<number, string>([[810, 'minecraft:raw_iron'], [803, 'minecraft:coal'], [811, 'minecraft:iron_ingot'], [36, 'minecraft:oak_planks'], [848, 'minecraft:stick']]);
  for (const [id, name] of overrides) base.set(id, name);
  return [...base];
};
const registry = (serverIdentity: string, itemOverrides: Array<[number, string]> = [], extra: Partial<ModdedServerRegistry> = {}): ModdedServerRegistry => ({
  serverIdentity, menus: [], items: items(itemOverrides), blockStates: [[4294, 'minecraft:furnace']], ...extra,
});
const CONSISTENT = registry('synthetic-smelt-consistent');

type Stack = { name: string; type: number; count: number; slot: number; metadata: number };
const RAW_IRON: Stack = { name: 'raw_iron', type: 810, count: 3, slot: 36, metadata: 0 };
const COAL: Stack = { name: 'coal', type: 803, count: 2, slot: 37, metadata: 0 };
const PLANKS: Stack = { name: 'oak_planks', type: 36, count: 8, slot: 38, metadata: 0 };
const INGOT = { name: 'iron_ingot', type: 811, count: 1, metadata: 0 };
const FURNACE_POS = new Vec3(1, 64, 0);

interface Hooks { onOpen?: () => void; onPutFuel?: () => void; onWait?: () => void; existingInput?: unknown; output?: unknown }

function world(bot: FakeBot, stacks: Stack[], hooks: Hooks = {}) {
  const furnace = new EventEmitter() as EventEmitter & Record<string, sinon.SinonStub>;
  let outputReady = false;
  Object.assign(furnace, {
    inputItem: sinon.stub().returns(hooks.existingInput ?? null), fuelItem: sinon.stub().returns(null),
    outputItem: sinon.stub().callsFake(() => outputReady ? (hooks.output ?? INGOT) : null),
    putFuel: sinon.stub().callsFake(async () => { hooks.onPutFuel?.(); }),
    putInput: sinon.stub().callsFake(async () => { setImmediate(() => { hooks.onWait?.(); outputReady = true; furnace.emit('update'); }); }),
    takeOutput: sinon.stub().callsFake(async () => hooks.output ?? INGOT), close: sinon.stub(),
  });
  Object.assign(bot as unknown as mineflayer.Bot, {
    blockAt: (position: Vec3) => position.equals(FURNACE_POS) ? { name: 'furnace', type: 185, stateId: 4294, position } : null,
    openFurnace: sinon.stub().callsFake(async () => { hooks.onOpen?.(); return furnace; }),
    inventory: { items: () => stacks, slots: [], hotbarStart: 36 },
    findBlock: () => null,
  });
  return furnace;
}

function setup(reg: ModdedServerRegistry | null, stacks: Stack[] = [RAW_IRON, COAL], hooks: Hooks = {}) {
  const bot = createFakeBot();
  const furnace = world(bot, stacks, hooks);
  const session = createModdedSession(bot);
  const bridge = reg ? session.attachBridge(reg) : null;
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  const getBot = () => session.state.bot as unknown as mineflayer.Bot;
  registerFurnaceTools(factory, getBot, session.context);
  registerCraftingTools(factory, getBot, session.context);
  const run = (name: string) => (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === name)!.args[3] as
    (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const smelt = (extra: Record<string, unknown> = {}) => run('smelt-item')({ x: 1, y: 64, z: 0, inputItem: 'raw_iron', fuelItem: 'coal', timeoutMs: 500, ...extra });
  const opened = () => ((bot as unknown as { openFurnace: sinon.SinonStub }).openFurnace).callCount;
  const text = async (name: string, args: Record<string, unknown>) => (await run(name)(args)).content[0]!.text;
  return { bot, session, bridge, furnace, smelt, opened, text };
}

test('vanilla smelting without a bridge is unchanged', async (t) => {
  const ctx = setup(null);
  const result = await ctx.smelt();
  t.regex(result.content[0]!.text, /output-observed-client-side/);
  t.is(ctx.furnace.putFuel.callCount, 1);
  t.is(ctx.furnace.putInput.callCount, 1);
  t.is(ctx.furnace.takeOutput.callCount, 1);
});

test('a consistent runtime registry keeps smelting and reports the verified output identity', async (t) => {
  const ctx = setup(CONSISTENT);
  const result = await ctx.smelt({ registryEpoch: ctx.session.context().registryEpoch });
  t.regex(result.content[0]!.text, /output-observed-client-side/);
  t.regex(result.content[0]!.text, /minecraft:iron_ingot/);
  t.is(ctx.furnace.takeOutput.callCount, 1);
});

for (const [label, reg] of [
  ['input', registry('synthetic-input-reordered', [[810, 'examplemod:copper_gear']])],
  ['fuel', registry('synthetic-fuel-reordered', [[803, 'anothermod:widget']])],
  ['furnace block', registry('synthetic-furnace-reordered', [], { blockStates: [[4294, 'examplemod:ore_block']] })],
] as const) {
  test(`a contradicted ${label} identity refuses smelting before the furnace is opened`, async (t) => {
    const ctx = setup(reg);
    const result = await ctx.smelt();
    t.not(result.content[0]!.text.includes('output-observed-client-side'), true);
    t.regex(result.content[0]!.text, /examplemod|anothermod|contradict|Couldn't find/);
    t.is(ctx.opened(), 0);
  });
}

test('ambiguous and complete-registry-absent input mappings are never smelted', async (t) => {
  const ambiguous = setup(registry('synthetic-ambiguous', [], { items: [...items(), [810, 'examplemod:copper_gear']] }));
  await ambiguous.smelt();
  t.is(ambiguous.opened(), 0);
  const absent = setup(registry('synthetic-absent', [], { items: items().filter(([id]) => id !== 810), itemCoverage: 'complete' }));
  await absent.smelt();
  t.is(absent.opened(), 0);
});

test('a contradicted output identity is reported and not taken into the inventory', async (t) => {
  const ctx = setup(registry('synthetic-output-reordered', [[811, 'anothermod:widget']]));
  const result = await ctx.smelt();
  t.regex(result.content[0]!.text, /anothermod:widget/);
  t.is(ctx.furnace.takeOutput.callCount, 0);
  t.is(ctx.furnace.close.callCount, 1);
});

test('different unresolved modded stacks are not treated as the same furnace input', async (t) => {
  const ctx = setup(registry('synthetic-modded-input', [[1400, 'examplemod:copper_gear'], [1401, 'anothermod:widget']]),
    [{ name: 'unknown', type: 1400, count: 2, slot: 36, metadata: 0 }, COAL],
    { existingInput: { name: 'unknown', type: 1401, count: 1 } });
  const result = await ctx.smelt({ inputItem: 'examplemod:copper_gear' });
  t.regex(result.content[0]!.text, /occupied/);
  t.is(ctx.furnace.putFuel.callCount, 0);
  t.is(ctx.furnace.putInput.callCount, 0);
});

test('bridge revocation while opening the furnace sends no slot action', async (t) => {
  let revoke = () => {};
  const ctx = setup(CONSISTENT, [RAW_IRON, COAL], { onOpen: () => revoke() });
  revoke = () => ctx.session.revokeBridge(ctx.bridge!.sessionId);
  const result = await ctx.smelt();
  t.regex(result.content[0]!.text, /runtime-context-changed-before-action/);
  t.is(ctx.furnace.putFuel.callCount, 0);
  t.is(ctx.furnace.putInput.callCount, 0);
  t.is(ctx.furnace.close.callCount, 1);
});

test('bridge renewal after the fuel was inserted stops before the input and reports the partial action', async (t) => {
  let renew = () => {};
  const ctx = setup(CONSISTENT, [RAW_IRON, COAL], { onPutFuel: () => renew() });
  renew = () => { ctx.session.attachBridge({ ...CONSISTENT, serverIdentity: 'synthetic-renewed' }); };
  const result = await ctx.smelt();
  t.regex(result.content[0]!.text, /runtime-context-changed-before-action/);
  t.regex(result.content[0]!.text, /"fuelInserted":true/);
  t.is(ctx.furnace.putFuel.callCount, 1);
  t.is(ctx.furnace.putInput.callCount, 0);
});

test('a reconnect or server change while waiting for output prevents taking it', async (t) => {
  let reconnect = () => {};
  const ctx = setup(CONSISTENT, [RAW_IRON, COAL], { onWait: () => reconnect() });
  reconnect = () => { ctx.session.state.bot = createFakeBot(); };
  const result = await ctx.smelt();
  t.regex(result.content[0]!.text, /runtime-context-changed-before-action/);
  t.is(ctx.furnace.takeOutput.callCount, 0);
});

test('a stale caller epoch is refused before the furnace is opened', async (t) => {
  const ctx = setup(CONSISTENT);
  const result = await ctx.smelt({ registryEpoch: 'mineflayer-registry:previous' });
  t.regex(result.content[0]!.text, /stale-registry-epoch/);
  t.is(ctx.opened(), 0);
});

test('recipe tools label static recipes and keep vanilla answers without a bridge', async (t) => {
  const ctx = setup(null, [PLANKS]);
  t.regex(await ctx.text('can-craft', { itemName: 'stick' }), /^Yes, can craft stick/);
  const recipe = await ctx.text('get-recipe', { itemName: 'stick' });
  t.regex(recipe, /\[craftable\]/);
  t.regex(recipe, /static minecraft-data/);
  t.regex(await ctx.text('list-recipes', { outputItem: 'stick' }), /stick/);
});

test('recipe tools do not count contradicted ingredient stacks as available', async (t) => {
  const ctx = setup(registry('synthetic-planks-reordered', [[36, 'anothermod:widget']]), [PLANKS]);
  const can = await ctx.text('can-craft', { itemName: 'stick' });
  t.notRegex(can, /^Yes/);
  t.notRegex(await ctx.text('get-recipe', { itemName: 'stick' }), /\[craftable\]/);
  t.regex(await ctx.text('list-recipes', { outputItem: 'stick' }), /No craftable recipes/);
});

test('recipe tools never present a recipe whose output the server contradicts as craftable', async (t) => {
  const ctx = setup(registry('synthetic-stick-reordered', [[848, 'examplemod:copper_gear']]), [PLANKS]);
  const can = await ctx.text('can-craft', { itemName: 'stick' });
  t.notRegex(can, /^Yes/);
  t.regex(can, /examplemod:copper_gear/);
  const recipe = await ctx.text('get-recipe', { itemName: 'stick' });
  t.notRegex(recipe, /\[craftable\]/);
  t.regex(recipe, /examplemod:copper_gear/);
  t.notRegex(await ctx.text('list-recipes', { outputItem: 'stick' }), /^Found/);
});

test('a consistent runtime registry confirms output IDs but still labels the recipe itself as static', async (t) => {
  const ctx = setup(CONSISTENT, [PLANKS]);
  const recipe = await ctx.text('get-recipe', { itemName: 'stick' });
  t.regex(recipe, /\[craftable\]/);
  t.regex(recipe, /static minecraft-data/);
  t.regex(recipe, /output ID confirmed by the runtime registry/);
});
