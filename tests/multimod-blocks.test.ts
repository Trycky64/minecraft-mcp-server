import test from 'ava';
import sinon from 'sinon';
import type mineflayer from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Vec3 } from 'vec3';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { registerWindowTools } from '../src/tools/window-tools.js';
import { createFakeBot, createModdedSession, type FakeBot, type ModdedServerRegistry } from './fixtures/modded-menus.js';

// Vanilla 1.21.1: block IDs 0..1059, state IDs 0..26683; stone is block 1 / state 1, oak_log states 130..132.
// Modded state IDs start after the vanilla range. All values are synthetic; no server is contacted.
const SERVER_A: ModdedServerRegistry = {
  serverIdentity: 'synthetic-block-server-a', menus: [], items: [],
  blocks: [[1060, 'examplemod:ore_block'], [1061, 'anothermod:pipe']],
  blockStates: [[26684, 'examplemod:ore_block', { lit: 'false' }], [26685, 'examplemod:ore_block', { lit: 'true' }], [26686, 'anothermod:pipe', { axis: 'x' }]],
  blockStateCoverage: 'complete',
};
const SERVER_B: ModdedServerRegistry = {
  serverIdentity: 'synthetic-block-server-b', menus: [], items: [],
  blocks: [[1060, 'anothermod:pipe'], [1061, 'examplemod:ore_block']],
  blockStates: [[26684, 'anothermod:pipe', { axis: 'y' }], [26685, 'examplemod:ore_block', { lit: 'false' }]],
  blockStateCoverage: 'complete',
};
/** Adversarial: the server registry contradicts minecraft-data for vanilla-range numbers. */
const SERVER_REORDERED: ModdedServerRegistry = {
  serverIdentity: 'synthetic-block-server-reordered', menus: [], items: [],
  blocks: [[1, 'examplemod:ore_block'], [46, 'anothermod:pipe']],
  blockStates: [[1, 'examplemod:ore_block'], [131, 'anothermod:pipe']],
  blockStateCoverage: 'partial',
};

interface MockBlock { name: string; type: number | undefined; stateId: number; position: Vec3; diggable: boolean; getProperties: () => Record<string, unknown> }
const at = (x: number, y: number, z: number) => `${x},${y},${z}`;

function world(bot: FakeBot, blocks: Record<string, Omit<MockBlock, 'position' | 'diggable' | 'getProperties'> & { properties?: Record<string, unknown> }>) {
  const extended = bot as unknown as mineflayer.Bot;
  Object.assign(extended, {
    entity: { position: new Vec3(0, 64, 0) },
    game: { minY: 60, height: 10 },
    blockAt: (position: Vec3) => {
      const spec = blocks[at(position.x, position.y, position.z)];
      if (!spec) return { name: 'air', type: 0, stateId: 0, position, diggable: false, getProperties: () => ({}) };
      return { ...spec, position, diggable: true, getProperties: sinon.stub().returns(spec.properties ?? {}) };
    },
    canDigBlock: () => true, canSeeBlock: () => true,
    currentWindow: null, heldItem: null, quickBarSlot: 0,
    inventory: { slots: Array(45).fill(null), hotbarStart: 36 },
    activateBlock: sinon.stub().resolves(), waitForTicks: sinon.stub().resolves(), setQuickBarSlot: sinon.stub(),
  });
}

function tools(bot: FakeBot, session: ReturnType<typeof createModdedSession>) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  registerBlockTools(factory, () => bot as unknown as mineflayer.Bot, session.context);
  registerWindowTools(factory, () => bot as unknown as mineflayer.Bot, session.context);
  const run = (name: string) => (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === name)!.args[3] as
    (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const blockInfo = async (x: number, y: number, z: number) => {
    const text = (await run('get-block-info')({ x, y, z })).content[0]!.text;
    return { headline: text.split('\n')[0]!, details: JSON.parse(text.split('Registry details (JSON):\n')[1]!) as Record<string, unknown> };
  };
  const findBlocks = async (blockType: string) => {
    const text = (await run('find-blocks')({ blockType, maxDistance: 4, count: 10 })).content[0]!.text;
    const json = text.includes('(JSON):\n') ? text.split('(JSON):\n')[1]! : text.slice(text.indexOf('{'));
    return JSON.parse(json) as { status: string; reason?: string; mappingConfidence?: string; results?: Array<{ x: number; y: number; z: number; stateId: number }> };
  };
  return { run, blockInfo, findBlocks };
}

function setup(registry: ModdedServerRegistry | null, blocks: Parameters<typeof world>[1]) {
  const bot = createFakeBot();
  world(bot, blocks);
  const session = createModdedSession(bot);
  const bridge = registry ? session.attachBridge(registry) : null;
  return { bot, session, bridge, ...tools(bot, session) };
}

test('modded block states outside the vanilla range are named only by the authenticated state registry, with its properties', async (t) => {
  const { blockInfo } = setup(SERVER_A, {
    [at(1, 64, 0)]: { name: 'unknown', type: undefined, stateId: 26685 },
    [at(2, 64, 0)]: { name: 'unknown', type: undefined, stateId: 26686 },
  });
  const ore = (await blockInfo(1, 64, 0)).details;
  t.like(ore, { rawStateId: 26685, rawBlockId: null, namespacedId: 'examplemod:ore_block', resolutionStatus: 'resolved', identityConfidence: 'session-observed', properties: { lit: 'true' }, runtimeNumericIdVerified: true, mineflayerName: 'unknown' });
  t.like(ore.provenance, { source: 'neoforge-bridge', authority: 'authenticated-runtime', serverIdentity: SERVER_A.serverIdentity });
  t.like((await blockInfo(2, 64, 0)).details, { namespacedId: 'anothermod:pipe', properties: { axis: 'x' } });
});

test('the same block state ID names different mods on different servers', async (t) => {
  const blocks = { [at(1, 64, 0)]: { name: 'unknown', type: undefined, stateId: 26684 } };
  const onA = (await setup(SERVER_A, blocks).blockInfo(1, 64, 0)).details;
  const onB = (await setup(SERVER_B, blocks).blockInfo(1, 64, 0)).details;
  t.like(onA, { namespacedId: 'examplemod:ore_block', properties: { lit: 'false' } });
  t.like(onB, { namespacedId: 'anothermod:pipe', properties: { axis: 'y' } });
  t.like(onB.provenance, { serverIdentity: SERVER_B.serverIdentity });
});

test('unknown numeric state IDs are preserved raw and never given a meaning', async (t) => {
  const { blockInfo } = setup(SERVER_A, { [at(1, 64, 0)]: { name: 'unknown', type: undefined, stateId: 40_000 } });
  const { headline, details } = await blockInfo(1, 64, 0);
  t.like(details, { rawStateId: 40_000, namespacedId: null, resolutionStatus: 'unresolved', identityConfidence: 'unresolved', properties: null, staticCandidate: null, runtimeNumericIdVerified: false });
  t.regex(headline, /^Found unknown/);
});

test('Mineflayer\'s static block.type is never resolved against the server block registry', async (t) => {
  // State 10 (minecraft:dirt in minecraft-data) is absent from the partial runtime state snapshot.
  // Mineflayer derives block.type 1 from its static table; server block 1 is examplemod:ore_block.
  const { blockInfo } = setup(SERVER_REORDERED, { [at(1, 64, 0)]: { name: 'dirt', type: 1, stateId: 10 } });
  const { details } = await blockInfo(1, 64, 0);
  t.is(details.namespacedId, null, 'a static-derived block ID must not borrow a server block identity');
  t.is(details.identityConfidence, 'version-static-candidate');
  t.is(details.runtimeNumericIdVerified, false);
  t.like(details.staticCandidate, { namespacedId: 'minecraft:dirt' });
});

test('a runtime identity that contradicts Mineflayer is reported as a conflict and never receives Mineflayer\'s static properties', async (t) => {
  const { blockInfo } = setup(SERVER_REORDERED, {
    [at(1, 64, 0)]: { name: 'stone', type: 1, stateId: 1 },
    [at(2, 64, 0)]: { name: 'oak_log', type: 46, stateId: 131, properties: { axis: 'y' } },
  });
  const stone = await blockInfo(1, 64, 0);
  t.like(stone.details, { namespacedId: 'examplemod:ore_block', identityConfidence: 'session-observed', mineflayerName: 'stone', mineflayerNameReliable: false, mineflayerNameStatus: 'contradicts-runtime-registry' });
  t.regex(stone.headline, /examplemod:ore_block/);
  const log = (await blockInfo(2, 64, 0)).details;
  t.like(log, { namespacedId: 'anothermod:pipe', mineflayerNameStatus: 'contradicts-runtime-registry' });
  t.is(log.properties, null, 'oak_log axis must not be attributed to anothermod:pipe');
});

test('consistent runtime and Mineflayer identities keep the existing response shape', async (t) => {
  const { blockInfo } = setup({ ...SERVER_REORDERED, blockStates: [[1, 'minecraft:stone']] }, { [at(1, 64, 0)]: { name: 'stone', type: 1, stateId: 1 } });
  const { headline, details } = await blockInfo(1, 64, 0);
  t.regex(headline, /^Found stone \(type: 1\)/);
  t.like(details, { namespacedId: 'minecraft:stone', mineflayerNameReliable: true, mineflayerNameStatus: 'matches-runtime-registry', properties: {} });
});

test('bridge revocation and renewal withdraw runtime block identities in the same Mineflayer session', async (t) => {
  const { session, bridge, blockInfo } = setup(SERVER_A, { [at(1, 64, 0)]: { name: 'unknown', type: undefined, stateId: 26684 } });
  const before = (await blockInfo(1, 64, 0)).details;
  t.is(before.namespacedId, 'examplemod:ore_block');
  session.revokeBridge(bridge!.sessionId);
  const revoked = (await blockInfo(1, 64, 0)).details;
  t.like(revoked, { namespacedId: null, resolutionStatus: 'unresolved', properties: null, runtimeNumericIdVerified: false });
  t.is(revoked.registryEpoch, before.registryEpoch);
  session.attachBridge(SERVER_B);
  t.like((await blockInfo(1, 64, 0)).details, { namespacedId: 'anothermod:pipe' });
});

test('a reconnect drops bridge identities and refuses interactions bound to the previous epoch', async (t) => {
  const { bot, session, blockInfo } = setup(SERVER_A, { [at(1, 64, 0)]: { name: 'unknown', type: undefined, stateId: 26684 } });
  const before = (await blockInfo(1, 64, 0)).details;
  const reconnected = createFakeBot();
  world(reconnected, { [at(1, 64, 0)]: { name: 'unknown', type: undefined, stateId: 26684 } });
  session.state.bot = reconnected;
  const next = tools(reconnected, session);
  const after = (await next.blockInfo(1, 64, 0)).details;
  t.not(after.registryEpoch, before.registryEpoch);
  t.like(after, { namespacedId: null, resolutionStatus: 'unresolved' });
  const interaction = await next.run('interact-block')({ x: 1, y: 64, z: 0, expectedStateId: 26684, registryEpoch: before.registryEpoch, timeoutMs: 50 });
  t.true(interaction.isError);
  t.regex(interaction.content[0]!.text, /stale-registry-epoch/);
  t.false(((reconnected as unknown as mineflayer.Bot).activateBlock as unknown as sinon.SinonStub).called);
  t.false(((bot as unknown as mineflayer.Bot).activateBlock as unknown as sinon.SinonStub).called);
});

test('a contradictory runtime state mapping is ambiguous and yields no identity', async (t) => {
  const { blockInfo } = setup({ ...SERVER_A, blockStates: [[26684, 'examplemod:ore_block'], [26684, 'anothermod:pipe']] },
    { [at(1, 64, 0)]: { name: 'unknown', type: undefined, stateId: 26684 } });
  t.like((await blockInfo(1, 64, 0)).details, { namespacedId: null, resolutionStatus: 'ambiguous', properties: null });
});

test('find-blocks locates modded states from the current session and refuses namespaces the server does not map', async (t) => {
  const { findBlocks } = setup(SERVER_A, {
    [at(1, 64, 0)]: { name: 'unknown', type: undefined, stateId: 26685 },
    [at(0, 64, 2)]: { name: 'unknown', type: undefined, stateId: 26686 },
  });
  const ore = await findBlocks('examplemod:ore_block');
  t.is(ore.status, 'found');
  t.is(ore.mappingConfidence, 'session-observed');
  t.deepEqual(ore.results, [{ x: 1, y: 64, z: 0, stateId: 26685 }]);
  const missing = await findBlocks('anothermod:valve');
  t.not(missing.status, 'found');
  t.is(missing.results, undefined);
});

test('find-blocks never offers a static vanilla candidate whose state the server maps to another block', async (t) => {
  const { findBlocks } = setup(SERVER_REORDERED, { [at(1, 64, 0)]: { name: 'stone', type: 1, stateId: 1 } });
  const result = await findBlocks('minecraft:stone');
  t.not(result.status, 'found-static-candidate-unverified');
  t.deepEqual(result.results ?? [], []);
});
