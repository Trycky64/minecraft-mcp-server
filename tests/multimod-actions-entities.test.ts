import test from 'ava';
import sinon from 'sinon';
import type mineflayer from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Vec3 } from 'vec3';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerPositionTools } from '../src/tools/position-tools.js';
import { registerEntityTools } from '../src/tools/entity-tools.js';
import { registerFlightTools } from '../src/tools/flight-tools.js';
import { registerGameStateTools } from '../src/tools/gamestate-tools.js';
import { registerChatTools } from '../src/tools/chat-tools.js';
import { MessageStore } from '../src/message-store.js';
import { createFakeBot, createModdedSession, type FakeBot, type ModdedServerRegistry } from './fixtures/modded-menus.js';

// minecraft-data 1.21.1 entity type IDs: cow 22, creeper 23, zombie 124 (max 129). Synthetic only; no server contacted.
type MockEntity = { id: number; entityType: number; name: string; type: string; position: Vec3 };
const ZOMBIE: MockEntity = { id: 501, entityType: 124, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0) };
const COW: MockEntity = { id: 502, entityType: 22, name: 'cow', type: 'animal', position: new Vec3(5, 64, 0) };
const UNKNOWN: MockEntity = { id: 503, entityType: 140, name: 'unknown', type: 'other', position: new Vec3(2, 64, 0) };

const REORDERED: ModdedServerRegistry = { serverIdentity: 'synthetic-entities-reordered', menus: [], items: [], entities: [[124, 'examplemod:robot'], [22, 'minecraft:cow']] };
const OTHER_SERVER: ModdedServerRegistry = { serverIdentity: 'synthetic-entities-other', menus: [], items: [], entities: [[124, 'anothermod:drone'], [140, 'examplemod:robot']] };
const CONSISTENT: ModdedServerRegistry = { serverIdentity: 'synthetic-entities-consistent', menus: [], items: [], entities: [[124, 'minecraft:zombie'], [22, 'minecraft:cow']] };
const COMPLETE_WITHOUT_ZOMBIE: ModdedServerRegistry = { serverIdentity: 'synthetic-entities-complete', menus: [], items: [], entityCoverage: 'complete', entities: [[22, 'minecraft:cow'], [140, 'examplemod:robot']] };

interface Hooks { onGoto?: () => void; onFly?: () => void }

function world(bot: FakeBot, entities: MockEntity[], gameMode: string | null, hooks: Hooks = {}) {
  const extended = bot as unknown as mineflayer.Bot;
  Object.assign(extended, {
    entity: { position: new Vec3(0, 64, 0) },
    entities: Object.fromEntries(entities.map(entity => [entity.id, entity])),
    nearestEntity: (filter: (entity: MockEntity) => boolean) => entities
      .filter(filter).sort((a, b) => a.position.distanceTo(new Vec3(0, 64, 0)) - b.position.distanceTo(new Vec3(0, 64, 0)))[0] ?? null,
    game: gameMode === null ? {} : { gameMode },
    pathfinder: { goto: sinon.stub().callsFake(async () => { hooks.onGoto?.(); }), stop: sinon.stub() },
    creative: { flyTo: sinon.stub().callsFake(async () => { hooks.onFly?.(); }), stopFlying: sinon.stub() },
    chat: sinon.stub(),
  });
}

function setup(registry: ModdedServerRegistry | null, entities: MockEntity[] = [ZOMBIE, COW, UNKNOWN], gameMode: string | null = 'survival', hooks: Hooks = {}) {
  const bot = createFakeBot();
  world(bot, entities, gameMode, hooks);
  const session = createModdedSession(bot);
  const bridge = registry ? session.attachBridge(registry) : null;
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  const getBot = () => session.state.bot as unknown as mineflayer.Bot;
  registerPositionTools(factory, getBot, session.context);
  registerEntityTools(factory, getBot, session.context);
  registerFlightTools(factory, getBot, session.context);
  registerGameStateTools(factory, getBot);
  registerChatTools(factory, getBot, new MessageStore());
  const run = (name: string) => (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === name)!.args[3] as
    (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const extended = bot as unknown as { pathfinder: { goto: sinon.SinonStub }; creative: { flyTo: sinon.SinonStub; stopFlying: sinon.SinonStub }; chat: sinon.SinonStub };
  const findEntity = async (type?: string) => {
    const text = (await run('find-entity')(type === undefined ? {} : { type })).content[0]!.text;
    return { text, details: text.includes('(JSON):\n') ? JSON.parse(text.split('(JSON):\n')[1]!) as Record<string, unknown> : null };
  };
  return { bot, session, bridge, run, findEntity, gotoCalls: () => extended.pathfinder.goto.callCount, flyCalls: () => extended.creative.flyTo.callCount, extended };
}

function reconnectDuring(ctx: ReturnType<typeof setup>) {
  const next = createFakeBot();
  world(next, [], 'creative');
  ctx.session.state.bot = next;
  return next;
}

test('move-to-position still reports a completed vanilla movement', async (t) => {
  const ctx = setup(null);
  const result = await ctx.run('move-to-position')({ x: 2, y: 64, z: 0 });
  t.regex(result.content[0]!.text, /movement-observed-client-side/);
  t.is(ctx.gotoCalls(), 1);
});

test('a reconnect during movement is reported as uncertain, never as the old bot\'s success', async (t) => {
  let reconnect = () => {};
  const ctx = setup(null, [], 'survival', { onGoto: () => reconnect() });
  reconnect = () => { reconnectDuring(ctx); };
  const result = await ctx.run('move-to-position')({ x: 2, y: 64, z: 0 });
  t.true(result.isError);
  t.regex(result.content[0]!.text, /minecraft-session-changed-during-action/);
  t.notRegex(result.content[0]!.text, /movement-observed-client-side/);
  t.is(ctx.gotoCalls(), 1, 'the movement is not retried');
});

test('move-to-position refuses a stale caller epoch before pathfinding', async (t) => {
  const ctx = setup(null);
  const result = await ctx.run('move-to-position')({ x: 2, y: 64, z: 0, registryEpoch: 'mineflayer-registry:previous' });
  t.regex(result.content[0]!.text, /stale-registry-epoch/);
  t.is(ctx.gotoCalls(), 0);
});

test('a bridge renewal does not disturb movement, which does not depend on modded registries', async (t) => {
  let renew = () => {};
  const ctx = setup(CONSISTENT, [], 'survival', { onGoto: () => renew() });
  renew = () => { ctx.session.attachBridge({ ...CONSISTENT, serverIdentity: 'synthetic-renewed' }); };
  t.regex((await ctx.run('move-to-position')({ x: 2, y: 64, z: 0 })).content[0]!.text, /movement-observed-client-side/);
});

test('fly-to refuses survival and unknown game modes without sending flight movement', async (t) => {
  const survival = setup(null, [], 'survival');
  t.regex((await survival.run('fly-to')({ x: 0, y: 70, z: 0 })).content[0]!.text, /survival/);
  t.is(survival.flyCalls(), 0);
  const unknown = setup(null, [], null);
  t.regex((await unknown.run('fly-to')({ x: 0, y: 70, z: 0 })).content[0]!.text, /unknown/);
  t.is(unknown.flyCalls(), 0);
});

test('fly-to still flies in creative mode', async (t) => {
  const ctx = setup(null, [], 'creative');
  t.regex((await ctx.run('fly-to')({ x: 0, y: 70, z: 0 })).content[0]!.text, /Successfully flew/);
  t.is(ctx.flyCalls(), 1);
});

test('a reconnect during flight is not reported as success', async (t) => {
  let reconnect = () => {};
  const ctx = setup(null, [], 'creative', { onFly: () => reconnect() });
  reconnect = () => { reconnectDuring(ctx); };
  const result = await ctx.run('fly-to')({ x: 0, y: 70, z: 0 });
  t.true(result.isError);
  t.regex(result.content[0]!.text, /minecraft-session-changed-during-action/);
  t.is(ctx.flyCalls(), 1);
});

test('detect-gamemode never presents an unknown game mode as a value', async (t) => {
  t.is((await setup(null, [], 'creative').run('detect-gamemode')({})).content[0]!.text, 'Bot gamemode: "creative"');
  const unknown = (await setup(null, [], null).run('detect-gamemode')({})).content[0]!.text;
  t.notRegex(unknown, /"undefined"/);
  t.regex(unknown, /unknown/);
  const noGame = setup(null);
  (noGame.bot as unknown as { game: unknown }).game = undefined;
  t.regex((await noGame.run('detect-gamemode')({})).content[0]!.text, /unknown/);
});

test('find-entity keeps vanilla behavior without a bridge and preserves unknown entity type IDs', async (t) => {
  const ctx = setup(null);
  const zombie = await ctx.findEntity('zombie');
  t.like(zombie.details, { entityId: 501, name: 'zombie', type: 'hostile', rawEntityTypeId: 124, namespacedId: null });
  const unknown = await ctx.findEntity();
  t.like(unknown.details, { entityId: 503, rawEntityTypeId: 140, namespacedId: null, mineflayerNameStatus: 'mineflayer-name-unavailable' });
});

test('find-entity never matches a static name the runtime entity registry contradicts', async (t) => {
  const ctx = setup(REORDERED);
  const zombie = await ctx.findEntity('zombie');
  t.regex(zombie.text, /^No zombie found/);
  const robot = await ctx.findEntity('examplemod:robot');
  t.like(robot.details, { entityId: 501, rawEntityTypeId: 124, namespacedId: 'examplemod:robot', mineflayerName: 'zombie', mineflayerNameStatus: 'contradicts-runtime-registry' });
  t.like((await ctx.findEntity('cow')).details, { namespacedId: 'minecraft:cow', mineflayerNameStatus: 'matches-runtime-registry' });
});

test('the same entity type ID names different mods on different servers', async (t) => {
  t.like((await setup(REORDERED).findEntity('examplemod:robot')).details, { entityId: 501 });
  const other = setup(OTHER_SERVER);
  t.like((await other.findEntity('examplemod:robot')).details, { entityId: 503, rawEntityTypeId: 140 });
  t.like((await other.findEntity('anothermod:drone')).details, { entityId: 501 });
});

test('entities absent from a complete runtime registry are not matched by their static name; partial registries keep vanilla matching', async (t) => {
  t.regex((await setup(COMPLETE_WITHOUT_ZOMBIE).findEntity('zombie')).text, /^No zombie found/);
  t.like((await setup({ ...COMPLETE_WITHOUT_ZOMBIE, entityCoverage: 'partial' }).findEntity('zombie')).details, { entityId: 501, mineflayerNameStatus: 'not-checked-against-runtime-registry' });
});

test('bridge revocation withdraws runtime entity identities immediately', async (t) => {
  const ctx = setup(REORDERED);
  t.like((await ctx.findEntity('examplemod:robot')).details, { entityId: 501 });
  ctx.session.revokeBridge(ctx.bridge!.sessionId);
  t.regex((await ctx.findEntity('examplemod:robot')).text, /^No examplemod:robot found/);
  t.like((await ctx.findEntity('zombie')).details, { entityId: 501, namespacedId: null });
});

test('send-chat keeps its single send without retry', async (t) => {
  const ctx = setup(null);
  const result = await ctx.run('send-chat')({ message: 'hello' });
  t.regex(result.content[0]!.text, /chat-send-requested/);
  t.is(ctx.extended.chat.callCount, 1);
});
