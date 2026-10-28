import test from 'ava';
import sinon from 'sinon';
import type mineflayer from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Vec3 } from 'vec3';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { createFakeBot, createModdedSession, type FakeBot, type ModdedServerRegistry } from './fixtures/modded-menus.js';

// Synthetic 1.21.1 state IDs: 0 = air, 1 = stone, 10 = dirt in minecraft-data. No server is contacted.
const VANILLA_CONSISTENT: ModdedServerRegistry = {
  serverIdentity: 'synthetic-vanilla-consistent', menus: [], items: [],
  blockStates: [[0, 'minecraft:air'], [1, 'minecraft:stone'], [10, 'minecraft:dirt']],
};
const REORDERED: ModdedServerRegistry = {
  serverIdentity: 'synthetic-reordered', menus: [], items: [[1400, 'examplemod:copper_gear']],
  blockStates: [[0, 'minecraft:air'], [1, 'examplemod:ore_block'], [10, 'minecraft:dirt']],
};
const AIR_IS_MODDED: ModdedServerRegistry = {
  serverIdentity: 'synthetic-air-is-modded', menus: [], items: [],
  blockStates: [[0, 'anothermod:pipe'], [1, 'minecraft:stone']],
};
const COMPLETE_WITHOUT_STONE: ModdedServerRegistry = {
  serverIdentity: 'synthetic-complete', menus: [], items: [], blockStateCoverage: 'complete',
  blockStates: [[0, 'minecraft:air'], [26684, 'examplemod:ore_block']],
};
const MODDED_ITEM_A: ModdedServerRegistry = { ...VANILLA_CONSISTENT, serverIdentity: 'synthetic-items-a', items: [[1400, 'examplemod:copper_gear']] };
const MODDED_ITEM_B: ModdedServerRegistry = { ...VANILLA_CONSISTENT, serverIdentity: 'synthetic-items-b', items: [[1401, 'examplemod:copper_gear']] };

type Spec = { name: string; type: number; stateId: number };
const AIR: Spec = { name: 'air', type: 0, stateId: 0 };
const STONE: Spec = { name: 'stone', type: 1, stateId: 1 };
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const DIG_TARGET = new Vec3(2, 64, 0);
const PLACE_TARGET = new Vec3(2, 65, 0);

function createWorld(bot: FakeBot, blocks: Map<string, Spec>, options: { needsPath?: boolean; onPath?: () => void; onTick?: () => void } = {}) {
  let reachable = !options.needsPath;
  const gear = { name: 'unknown', type: 1400, count: 4, slot: 36 };
  const extended = bot as unknown as mineflayer.Bot;
  Object.assign(extended, {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    heldItem: null, quickBarSlot: 0,
    inventory: { slots: Array(45).fill(null), hotbarStart: 36, items: () => [gear] },
    blockAt: (position: Vec3) => {
      const spec = blocks.get(key(position)) ?? AIR;
      return { ...spec, position, diggable: spec.name !== 'air', getProperties: () => ({}) };
    },
    canDigBlock: () => reachable, canSeeBlock: () => reachable,
    pathfinder: { goto: sinon.stub().callsFake(async () => { options.onPath?.(); reachable = true; }), stop: sinon.stub() },
    waitForTicks: sinon.stub().callsFake(async () => { options.onTick?.(); }),
    setQuickBarSlot: sinon.stub(), stopDigging: sinon.stub(), lookAt: sinon.stub().resolves(), equip: sinon.stub().resolves(),
    dig: sinon.stub().callsFake(async (block: { position: Vec3 }) => { blocks.set(key(block.position), AIR); }),
    placeBlock: sinon.stub().callsFake(async () => { blocks.set(key(PLACE_TARGET), STONE); }),
  });
  return { gear };
}

function setup(registry: ModdedServerRegistry | null, options: Parameters<typeof createWorld>[2] = {}, blocks = new Map([[key(DIG_TARGET), STONE]])) {
  const bot = createFakeBot();
  const world = createWorld(bot, blocks, options);
  const session = createModdedSession(bot);
  const bridge = registry ? session.attachBridge(registry) : null;
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  registerBlockTools(new ToolFactory(server, connection), () => session.state.bot as unknown as mineflayer.Bot, session.context);
  const run = (name: string) => (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === name)!.args[3] as
    (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const extended = bot as unknown as { dig: sinon.SinonStub; placeBlock: sinon.SinonStub; equip: sinon.SinonStub };
  return {
    bot, session, bridge, world, blocks,
    dig: (extra: Record<string, unknown> = {}) => run('dig-block')({ x: DIG_TARGET.x, y: DIG_TARGET.y, z: DIG_TARGET.z, timeoutMs: 1000, ...extra }),
    place: (extra: Record<string, unknown> = {}) => run('place-block')({ x: PLACE_TARGET.x, y: PLACE_TARGET.y, z: PLACE_TARGET.z, timeoutMs: 1000, ...extra }),
    digCalls: () => extended.dig.callCount, placeCalls: () => extended.placeBlock.callCount, equipCalls: () => extended.equip.callCount,
  };
}

test('vanilla without a bridge still digs and places when nothing contradicts the observation', async (t) => {
  const dig = setup(null);
  const dug = await dig.dig();
  t.falsy(dug.isError);
  t.is(dig.digCalls(), 1);
  const place = setup(null, {}, new Map([[key(DIG_TARGET), STONE]]));
  const placed = await place.place();
  t.falsy(placed.isError);
  t.is(place.placeCalls(), 1);
});

test('a consistent runtime state registry keeps dig and place available', async (t) => {
  const dig = setup(VANILLA_CONSISTENT);
  t.falsy((await dig.dig({ registryEpoch: dig.session.context().registryEpoch })).isError);
  t.is(dig.digCalls(), 1);
  const place = setup(VANILLA_CONSISTENT);
  t.falsy((await place.place()).isError);
  t.is(place.placeCalls(), 1);
});

test('dig-block refuses a block whose runtime identity contradicts Mineflayer', async (t) => {
  const { dig, digCalls } = setup(REORDERED);
  const result = await dig();
  t.true(result.isError);
  t.regex(result.content[0]!.text, /runtime-identity-contradicts-mineflayer/);
  t.regex(result.content[0]!.text, /examplemod:ore_block/);
  t.is(digCalls(), 0);
});

test('dig-block refuses a state absent from a complete runtime registry and an ambiguous mapping', async (t) => {
  const absent = setup(COMPLETE_WITHOUT_STONE);
  t.regex((await absent.dig()).content[0]!.text, /block-state-absent-from-complete-runtime-registry/);
  t.is(absent.digCalls(), 0);
  const ambiguous = setup({ ...VANILLA_CONSISTENT, blockStates: [[1, 'minecraft:stone'], [1, 'examplemod:ore_block']] });
  t.regex((await ambiguous.dig()).content[0]!.text, /runtime-block-state-mapping-ambiguous/);
  t.is(ambiguous.digCalls(), 0);
});

test('an unknown raw state ID is still refused for digging', async (t) => {
  const unknown = setup(REORDERED, {}, new Map([[key(DIG_TARGET), { name: 'unknown', type: -1, stateId: 40_000 }]]));
  t.true((await unknown.dig()).isError);
  t.is(unknown.digCalls(), 0);
});

test('place-block refuses a reference block whose runtime identity contradicts Mineflayer', async (t) => {
  const { place, placeCalls } = setup(REORDERED);
  const result = await place();
  t.true(result.isError);
  t.regex(result.content[0]!.text, /contradict/);
  t.is(placeCalls(), 0);
});

test('place-block refuses a target that Mineflayer calls air but the server maps to a modded block', async (t) => {
  const { place, placeCalls } = setup(AIR_IS_MODDED);
  const result = await place();
  t.true(result.isError);
  t.regex(result.content[0]!.text, /anothermod:pipe/);
  t.is(placeCalls(), 0);
});

test('a bridge revoked during dig pathfinding cancels the dig', async (t) => {
  let revoke = () => {};
  const ctx = setup(VANILLA_CONSISTENT, { needsPath: true, onPath: () => revoke() });
  revoke = () => ctx.session.revokeBridge(ctx.bridge!.sessionId);
  const result = await ctx.dig();
  t.true(result.isError);
  t.regex(result.content[0]!.text, /runtime-context-changed-before-action/);
  t.is(ctx.digCalls(), 0);
});

test('a bridge renewed during dig pathfinding in the same Mineflayer session cancels the dig', async (t) => {
  let renew = () => {};
  const ctx = setup(VANILLA_CONSISTENT, { needsPath: true, onPath: () => renew() });
  renew = () => { ctx.session.attachBridge({ ...VANILLA_CONSISTENT, serverIdentity: 'synthetic-renewed' }); };
  const before = ctx.session.context().registryEpoch;
  const result = await ctx.dig();
  t.is(ctx.session.context().registryEpoch, before, 'the Mineflayer epoch alone does not reveal the renewal');
  t.regex(result.content[0]!.text, /runtime-context-changed-before-action/);
  t.is(ctx.digCalls(), 0);
});

test('a server change or reconnect during pathfinding cancels the dig on the old bot', async (t) => {
  let reconnect = () => {};
  const ctx = setup(VANILLA_CONSISTENT, { needsPath: true, onPath: () => reconnect() });
  reconnect = () => {
    const next = createFakeBot();
    createWorld(next, new Map([[key(DIG_TARGET), STONE]]));
    ctx.session.state.bot = next;
  };
  const result = await ctx.dig();
  t.true(result.isError);
  t.regex(result.content[0]!.text, /runtime-context-changed-before-action/);
  t.is(ctx.digCalls(), 0);
  t.is(((ctx.session.state.bot as unknown as { dig: sinon.SinonStub }).dig).callCount, 0);
});

test('a stale caller epoch is refused before any approach, and an epoch change during the hand-switch tick stops the dig', async (t) => {
  const stale = setup(VANILLA_CONSISTENT);
  const refused = await stale.dig({ registryEpoch: 'mineflayer-registry:previous-session' });
  t.regex(refused.content[0]!.text, /stale-registry-epoch/);
  t.is(stale.digCalls(), 0);

  let revoke = () => {};
  const ctx = setup(VANILLA_CONSISTENT, { onTick: () => revoke() });
  (ctx.bot as unknown as { heldItem: unknown }).heldItem = { name: 'stick', type: 900, count: 1 };
  revoke = () => ctx.session.revokeBridge(ctx.bridge!.sessionId);
  const result = await ctx.dig();
  t.regex(result.content[0]!.text, /runtime-context-changed-before-action/);
  t.is(ctx.digCalls(), 0);
});

test('place-block refuses when the bridge item mapping is renewed before the placement packet', async (t) => {
  let renew = () => {};
  const ctx = setup(MODDED_ITEM_A, { needsPath: true, onPath: () => renew() });
  renew = () => { ctx.session.attachBridge(MODDED_ITEM_B); };
  const result = await ctx.place({ itemId: 'examplemod:copper_gear' });
  t.true(result.isError);
  t.regex(result.content[0]!.text, /runtime-context-changed-before-action/);
  t.is(ctx.placeCalls(), 0);
  t.is(ctx.equipCalls(), 0);
});

test('place-block refuses a stale caller epoch without sending anything', async (t) => {
  const ctx = setup(VANILLA_CONSISTENT);
  const result = await ctx.place({ registryEpoch: 'mineflayer-registry:previous-session' });
  t.regex(result.content[0]!.text, /stale-registry-epoch/);
  t.is(ctx.placeCalls(), 0);
});
