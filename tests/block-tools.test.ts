import test from 'ava';
import sinon from 'sinon';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { MinecraftRegistryService } from '../src/services/minecraft-registry-service.js';
import type { RuntimeRegistryContext } from '../src/services/runtime-registry-service.js';
import { RuntimeRegistryService } from '../src/services/runtime-registry-service.js';

function staticRegistryContext(version: string): RuntimeRegistryContext {
  return {
    connected: true,
    sessionAvailable: true,
    playerAvailable: true,
    connectionMode: 'bot',
    minecraftVersion: version,
    minecraftEndpoint: '127.0.0.1:25565',
    protocolVersion: version,
    protocolNumber: null,
    registryEpoch: null,
    runtimeEpoch: null,
    mineflayerSessionId: null,
    mineflayerRegistryEpoch: null,
    bridgeSessionId: null,
    sourceRegistryEpoch: null,
    serverIdentity: null,
    registryService: MinecraftRegistryService.withMinecraftData([version]),
    bridgeAvailable: false,
    bridgeSession: null,
    protocolDecode: { inventory: 'unverified', issues: [] },
  };
}

function injectSyntheticBridgeSnapshot(
  runtime: RuntimeRegistryService,
  registryCoverage: Record<string, 'complete' | 'partial'>,
  rows: Array<{ kind: 'item' | 'block' | 'blockState'; namespacedId: string; numericId?: number }>,
): void {
  const context = runtime.getContext();
  const session = { authenticated: true as const, serverIdentity: 'synthetic-test-server',
    minecraftEndpoint: context.minecraftEndpoint!, minecraftVersion: context.minecraftVersion!, neoForgeVersion: 'test',
    sourceRegistryEpoch: 'synthetic-java-generation', sessionId: 'synthetic-bridge-session', connectedAt: new Date(0).toISOString() };
  runtime.bindAuthenticatedBridge(session);
  const entries = rows.map(row => ({ ...row, minecraftVersion: context.minecraftVersion!, registryEpoch: context.registryEpoch!,
    provenance: { source: 'neoforge-bridge' as const, authority: 'authenticated-runtime' as const, minecraftVersion: context.minecraftVersion!,
      registryEpoch: context.registryEpoch!, runtimeEpoch: context.runtimeEpoch!, minecraftEndpoint: session.minecraftEndpoint,
      mineflayerSessionId: context.mineflayerSessionId!, mineflayerRegistryEpoch: context.mineflayerRegistryEpoch!,
      bridgeSessionId: session.sessionId, sourceRegistryEpoch: session.sourceRegistryEpoch, serverIdentity: session.serverIdentity,
      neoForgeVersion: session.neoForgeVersion, registryCoverage: registryCoverage[row.kind]! } }));
  runtime.replaceBridgeSnapshot({ source: 'neoforge-bridge', authority: 'authenticated-runtime', minecraftVersion: context.minecraftVersion!,
    registryEpoch: context.registryEpoch!, runtimeEpoch: context.runtimeEpoch!, minecraftEndpoint: session.minecraftEndpoint,
    mineflayerSessionId: context.mineflayerSessionId!, mineflayerRegistryEpoch: context.mineflayerRegistryEpoch!,
    bridgeSessionId: session.sessionId, sourceRegistryEpoch: session.sourceRegistryEpoch, serverIdentity: session.serverIdentity,
    neoForgeVersion: session.neoForgeVersion, observedAt: new Date(0).toISOString(), availableRegistries: Object.keys(registryCoverage),
    registryCoverage, entries }, session.sessionId);
}

test('registerBlockTools registers place-block tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const placeBlockCall = toolCalls.find(call => call.args[0] === 'place-block');

  t.truthy(placeBlockCall);
  t.is(placeBlockCall!.args[1], 'Place a block at the specified position');
});

test('registerBlockTools registers dig-block tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const digBlockCall = toolCalls.find(call => call.args[0] === 'dig-block');

  t.truthy(digBlockCall);
  t.is(digBlockCall!.args[1], 'Dig a loaded block within 32 blocks with a bounded timeout and state confirmation');
});

test('registerBlockTools registers get-block-info tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getBlockInfoCall = toolCalls.find(call => call.args[0] === 'get-block-info');

  t.truthy(getBlockInfoCall);
  t.is(getBlockInfoCall!.args[1], 'Get information about a block at the specified position');
});

test('registerBlockTools registers find-blocks tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');

  t.truthy(findBlockCall);
  t.is(findBlockCall!.args[1], 'Find one or more nearby blocks of a specific type');
});

test('get-block-info returns block information', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBlock = {
    name: 'stone',
    type: 1,
    position: new Vec3(10, 64, 20)
  };
  const mockBot = {
    blockAt: sinon.stub().returns(mockBlock)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getBlockInfoCall = toolCalls.find(call => call.args[0] === 'get-block-info');
  const executor = getBlockInfoCall!.args[3];

  const result = await executor({ x: 10, y: 64, z: 20 });

  t.true(result.content[0].text.includes('stone'));
  t.true(result.content[0].text.includes('10'));
  t.true(result.content[0].text.includes('64'));
  t.true(result.content[0].text.includes('20'));
});

test('get-block-info handles missing block', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBot = {
    blockAt: sinon.stub().returns(null)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getBlockInfoCall = toolCalls.find(call => call.args[0] === 'get-block-info');
  const executor = getBlockInfoCall!.args[3];

  const result = await executor({ x: 10, y: 64, z: 20 });

  t.true(result.content[0].text.includes('No block information found'));
});

test('get-block-info preserves raw unknown state IDs and reports Mineflayer undefined type', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {
    version: '1.21.1', protocolVersion: '1.21.1',
    blockAt: sinon.stub().returns({ name: 'unknown', type: undefined, stateId: 999999, position: new Vec3(1, 2, 3) }),
  } as unknown as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => mockBot, isConnected: () => true, getConfig: () => ({ host: 'localhost', port: 25565 }) });
  registerBlockTools(factory, () => mockBot, () => runtime.getContext());
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'get-block-info')!;
  const result = await call.args[3]({ x: 1, y: 2, z: 3 });
  const details = JSON.parse(result.content[0].text.split('Registry details (JSON):\n')[1]);
  t.is(details.rawStateId, 999999);
  t.is(details.rawBlockId, null);
  t.is(details.namespacedId, null);
  t.is(details.resolutionStatus, 'unresolved');
  t.false(details.mineflayerNameReliable);
});

test('get-block-info keeps static vanilla candidates separate from runtime numeric resolution', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {
    version: '1.21.1', entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().returns({ name: 'stone', type: 1, stateId: 1, position: new Vec3(0, 64, 0), getProperties: () => ({}) }),
  } as unknown as mineflayer.Bot;
  const context = staticRegistryContext('1.21.1');
  context.registryEpoch = 'session:runtime';
  registerBlockTools(factory, () => mockBot, () => context);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'get-block-info')!;
  const result = await call.args[3]({ x: 0, y: 64, z: 0 });
  const details = JSON.parse(result.content[0].text.split('Registry details (JSON):\n')[1]);
  t.is(details.rawStateId, 1);
  t.is(details.namespacedId, null);
  t.is(details.resolutionStatus, 'unresolved');
  t.is(details.staticCandidate.namespacedId, 'minecraft:stone');
  t.false(details.runtimeNumericIdVerified);
});

test('get-block-info distinguishes an unloaded chunk from an air block', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = { blockAt: sinon.stub().returns(null) } as unknown as mineflayer.Bot;
  registerBlockTools(factory, () => mockBot);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'get-block-info')!;
  const result = await call.args[3]({ x: 1, y: 2, z: 3 });
  t.true(result.content[0].text.includes('chunk is not loaded'));
});

test('dig-block handles air blocks', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBlock = {
    name: 'air'
  };
  const mockBot = {
    blockAt: sinon.stub().returns(mockBlock)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const digBlockCall = toolCalls.find(call => call.args[0] === 'dig-block');
  const executor = digBlockCall!.args[3];

  const result = await executor({ x: 10, y: 64, z: 20 });

  t.true(result.content[0].text.includes('No block found'));
});

test('dig-block refuses distant targets before pathfinding', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().returns({ name: 'stone', stateId: 1, position: new Vec3(40, 64, 0) }),
    canDigBlock: sinon.stub().returns(false), canSeeBlock: sinon.stub().returns(false),
    pathfinder: { goto: sinon.stub(), stop: sinon.stub() },
  } as unknown as mineflayer.Bot;
  registerBlockTools(factory, () => mockBot);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find(item => item.args[0] === 'dig-block')!;
  const result = await call.args[3]({ x: 40, y: 64, z: 0 });
  t.true(result.isError);
  t.true(result.content[0].text.includes('maximum distance is 32'));
  t.false((mockBot.pathfinder.goto as sinon.SinonStub).called);
});

test('dig-block rechecks the target state after bounded pathfinding and sends no stale dig', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const original = { name: 'stone', stateId: 1, position: new Vec3(2, 64, 0) };
  const changed = { name: 'air', stateId: 0, position: new Vec3(2, 64, 0) };
  const blockAt = sinon.stub().onFirstCall().returns(original).onSecondCall().returns(changed);
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) }, blockAt,
    canDigBlock: sinon.stub().returns(false), canSeeBlock: sinon.stub().returns(false),
    pathfinder: { goto: sinon.stub().resolves(), stop: sinon.stub() }, dig: sinon.stub().resolves(),
  } as unknown as mineflayer.Bot;
  registerBlockTools(factory, () => mockBot);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find(item => item.args[0] === 'dig-block')!;
  const result = await call.args[3]({ x: 2, y: 64, z: 0 });
  t.true(result.isError);
  t.true(result.content[0].text.includes('target changed'));
  t.false((mockBot.dig as sinon.SinonStub).called);
});

test('place-block blocks placing at bot position and one block above', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    entity: { position: new Vec3(10.4, 64, 20.7) },
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const placeBlockCall = toolCalls.find(call => call.args[0] === 'place-block');
  const executor = placeBlockCall!.args[3];

  const resultAtFeet = await executor({ x: 10, y: 64, z: 20 });
  const resultAtHead = await executor({ x: 10, y: 65, z: 20 });

  t.true(resultAtFeet.content[0].text.includes("can't place a block"));
  t.true(resultAtHead.content[0].text.includes("can't place a block"));
});

test('place-block floors input coordinates before self-placement guard', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    entity: { position: new Vec3(10.4, 64, 20.7) },
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const placeBlockCall = toolCalls.find(call => call.args[0] === 'place-block');
  const executor = placeBlockCall!.args[3];

  const result = await executor({ x: 10.4, y: 64, z: 20.7 });

  t.true(result.content[0].text.includes("can't place a block"));
});

test('place-block refuses a modded item until its runtime mapping is authoritative for the session', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {
    version: '1.21.1', entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub(), inventory: { items: sinon.stub().returns([]) },
    placeBlock: sinon.stub(),
  } as unknown as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => mockBot, isConnected: () => true, getConfig: () => ({ host: '127.0.0.1', port: 25565 }) });
  registerBlockTools(factory, () => mockBot, () => runtime.getContext());
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'place-block')!;
  const result = await call.args[3]({ x: 3, y: 64, z: 3, itemId: 'processia:crusher' });
  t.true(result.content[0].text.includes('authoritative item-to-ID mapping has not been observed'));
  t.false(mockBot.placeBlock.called);
});

test('place-block selects a modded stack only from an authoritative current-epoch mapping', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const stack = { type: 7001, name: 'unknown', count: 1, slot: 36 };
  const reference = { name: 'stone' };
  let placed = false;
  const mockBot = {
    version: '1.21.1', entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().callsFake((pos: Vec3) => pos.x === 3 && pos.y === 64 && pos.z === 3
      ? (placed ? { name: 'unknown', stateId: 9900 } : { name: 'air', stateId: 0 })
      : reference),
    inventory: { items: sinon.stub().returns([stack]) }, heldItem: null,
    canSeeBlock: sinon.stub().returns(true), lookAt: sinon.stub().resolves(),
    equip: sinon.stub().resolves(), placeBlock: sinon.stub().callsFake(async () => { placed = true; }),
  } as unknown as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => mockBot, isConnected: () => true, getConfig: () => ({ host: '127.0.0.1', port: 25565 }) });
  injectSyntheticBridgeSnapshot(runtime, { item: 'partial' }, [
    { kind: 'item', namespacedId: 'processia:crusher', numericId: 7001 },
  ]);
  registerBlockTools(factory, () => mockBot, () => runtime.getContext());
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'place-block')!;
  const result = await call.args[3]({ x: 3, y: 64, z: 3, itemId: 'processia:crusher' });
  t.true(result.content[0].text.includes('placement-observed-client-cache'));
  t.true(result.content[0].text.includes('"rawStateId":9900'));
  t.true(mockBot.equip.calledWith(stack, 'hand'));
  t.true(mockBot.placeBlock.calledOnce);
});

test('dig-block distinguishes confirmed mining from an unobserved drop and collection', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, connection);
  const mined = { name: 'oak_log', stateId: 1, position: new Vec3(1, 64, 0) };
  let dug = false;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().callsFake(() => dug ? { name: 'air', stateId: 0, position: mined.position } : mined),
    canDigBlock: sinon.stub().returns(true), canSeeBlock: sinon.stub().returns(true),
    dig: sinon.stub().callsFake(async () => { dug = true; }), waitForTicks: sinon.stub().resolves(), entities: {},
    inventory: { items: sinon.stub().returns([]) },
  } as unknown as mineflayer.Bot;
  registerBlockTools(factory, () => bot);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'dig-block')!;
  const result = await call.args[3]({ x: 1, y: 64, z: 0 });
  const response = JSON.parse(result.content[0]!.text) as { status: string; dropObservation: string; collectionStatus: string };
  t.is(response.status, 'block-mined-observed-client-cache');
  t.is(response.dropObservation, 'no-drop-observed');
  t.is(response.collectionStatus, 'not-confirmed');
  t.true((bot.waitForTicks as sinon.SinonStub).calledOnceWith(10));
});

test('dig-block uses an empty hand and restores the selected slot without touching an unresolved held stack', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, connection);
  const held = { name: 'unknown', type: 1373, count: 1, slot: 36 };
  const slots = Array(45).fill(null);
  slots[36] = held;
  const inventoryItem = { items: sinon.stub().returns([held]), slots, hotbarStart: 36 };
  const mined = { name: 'oak_log', stateId: 131, position: new Vec3(1, 64, 0) };
  let dug = false;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().callsFake(() => dug ? { name: 'air', stateId: 0, position: mined.position } : mined),
    canDigBlock: sinon.stub().returns(true), canSeeBlock: sinon.stub().returns(true),
    dig: sinon.stub().callsFake(async () => { t.is(bot.quickBarSlot, 1); t.is(bot.heldItem, null); dug = true; }),
    waitForTicks: sinon.stub().resolves(), entities: {}, inventory: inventoryItem,
    quickBarSlot: 0, heldItem: held,
    setQuickBarSlot: sinon.stub().callsFake((slot: number) => { bot.quickBarSlot = slot; bot.heldItem = slot === 1 ? null : held; }),
  } as unknown as mineflayer.Bot;
  registerBlockTools(factory, () => bot);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'dig-block')!;
  const result = await call.args[3]({ x: 1, y: 64, z: 0 });
  t.falsy(result.isError);
  t.is(bot.quickBarSlot, 0);
  t.is(bot.heldItem, held);
  t.is((bot.setQuickBarSlot as sinon.SinonStub).callCount, 2);
  t.is(inventoryItem.items().length, 1);
  t.is(inventoryItem.items()[0]!.type, 1373);
});

test('place-block does not report success until a changed non-air state is observed', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const reference = { name: 'stone' };
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().callsFake((pos: Vec3) => pos.x === 3 && pos.y === 64 && pos.z === 3 ? { name: 'air', stateId: 0 } : reference),
    canSeeBlock: sinon.stub().returns(true), lookAt: sinon.stub().resolves(), placeBlock: sinon.stub().resolves(),
  } as unknown as mineflayer.Bot;
  registerBlockTools(factory, () => mockBot);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'place-block')!;
  const result = await call.args[3]({ x: 3, y: 64, z: 3 });
  t.true(result.isError);
  t.true(result.content[0].text.includes('was not confirmed'));
  t.true(mockBot.placeBlock.calledOnce);
});

test('place-block cancels timed-out pathfinding before sending any placement packet', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, connection);
  const target = new Vec3(3, 64, 3);
  const reference = { name: 'stone' };
  const pathfinder = { goto: sinon.stub().returns(new Promise<void>(() => undefined)), stop: sinon.stub() };
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().callsFake((pos: Vec3) => pos.equals(target) ? { name: 'air', stateId: 0 } : reference),
    canSeeBlock: sinon.stub().returns(false), lookAt: sinon.stub().resolves(), placeBlock: sinon.stub().resolves(),
    pathfinder,
  } as unknown as mineflayer.Bot;
  registerBlockTools(factory, () => mockBot);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'place-block')!;
  const result = await call.args[3]({ x: 3, y: 64, z: 3, timeoutMs: 100 });
  t.true(result.isError);
  t.true(result.content[0].text.includes('pathfinding was stopped and no placement packet was sent'));
  t.true(pathfinder.stop.calledOnce);
  t.false(mockBot.placeBlock.called);
});

test('place-block rechecks the target after pathfinding and sends no packet if it changed', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, connection);
  const target = new Vec3(3, 64, 3);
  let targetReads = 0;
  const blockAt = sinon.stub().callsFake((position: Vec3) => position.equals(target)
    ? (++targetReads === 1 ? { name: 'air', stateId: 0 } : { name: 'stone', stateId: 1 })
    : { name: 'stone', stateId: 2 });
  const pathfinder = { goto: sinon.stub().resolves(), stop: sinon.stub() };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, blockAt, pathfinder,
    canSeeBlock: sinon.stub().returns(false), lookAt: sinon.stub().resolves(), placeBlock: sinon.stub().resolves(),
  } as unknown as mineflayer.Bot;
  registerBlockTools(factory, () => bot);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((entry) => entry.args[0] === 'place-block')!;
  const result = await call.args[3]({ x: 3, y: 64, z: 3, timeoutMs: 1000 });
  t.true(result.isError);
  t.true(result.content[0]!.text.includes('target changed while approaching'));
  t.true(pathfinder.goto.calledOnce);
  t.false(bot.placeBlock.called);
});

test('find-blocks returns not found when block not found', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    game: { minY: 0, height: 256 },
    blockAt: sinon.stub().returns({ stateId: 0, type: 0, name: 'air' }),
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot, () => staticRegistryContext('1.21'));

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');
  const executor = findBlockCall!.args[3];

  const result = await executor({ blockType: 'diamond_ore', maxDistance: 16 });

  t.true(result.content[0].text.includes('Search for diamond_ore inconclusive'));
  const details = JSON.parse(result.content[0].text.split('\n').at(-1)!);
  t.is(details.mappingConfidence, 'version-static-unverified');
});

test('find-blocks returns multiple results when count is greater than one', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    game: { minY: 0, height: 256 },
    blockAt: sinon.stub().returns({ stateId: 1, type: 1, name: 'stone' }),
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot, () => staticRegistryContext('1.21'));

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');
  const executor = findBlockCall!.args[3];

  const result = await executor({ blockType: 'stone', maxDistance: 16, count: 2 });

  t.true(result.content[0].text.includes('Static candidate 2 stone block(s)'));
  const details = JSON.parse(result.content[0].text.split('Registry search details (JSON):\n')[1]);
  t.is(details.results.length, 2);
  t.is(details.status, 'found-static-candidate-unverified');
});

test('find-blocks clamps oversized count during bounded loaded-world scanning', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    game: { minY: 0, height: 256 },
    blockAt: sinon.stub().returns({ stateId: 1, type: 1, name: 'stone' }),
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot, () => staticRegistryContext('1.21'));

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');
  const executor = findBlockCall!.args[3];

  const result = await executor({ blockType: 'stone', maxDistance: 16, count: 10_000 });

  const details = JSON.parse(result.content[0].text.split('Registry search details (JSON):\n')[1]);
  t.is(details.results.length, 256);
  t.true(details.scanned <= 150_000);
});

test('find-blocks scans known synthetic Processia state IDs in loaded blocks only', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {
    version: '1.21.1', protocolVersion: '1.21.1',
    entity: { position: new Vec3(0, 64, 0) }, game: { minY: 0, height: 256 },
    world: { getColumnAt: sinon.stub().returns(null) },
    blockAt: sinon.stub().returns({ stateId: 9101, type: undefined, name: 'unknown' }),
  } as unknown as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => mockBot, isConnected: () => true, getConfig: () => ({ host: '127.0.0.1', port: 25565 }) });
  injectSyntheticBridgeSnapshot(runtime, { block: 'partial', blockState: 'partial' }, [
    { kind: 'block', namespacedId: 'processia:crusher', numericId: 810 },
    { kind: 'blockState', namespacedId: 'processia:crusher', numericId: 9100 },
    { kind: 'blockState', namespacedId: 'processia:crusher', numericId: 9101 },
  ]);
  registerBlockTools(factory, () => mockBot, () => runtime.getContext());
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'find-blocks')!;
  const result = await call.args[3]({ blockType: 'processia:crusher', maxDistance: 2, count: 1 });
  t.true(result.content[0].text.includes('Found 1 processia:crusher block(s)'));
  t.false((mockBot.world.getColumnAt as sinon.SinonStub).called);
});

test('find-blocks reports a complete runtime no-match with the matching reason', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {
    version: '1.21.1', protocolVersion: '1.21.1',
    entity: { position: new Vec3(0, 64, 0) }, game: { minY: 0, height: 256 },
    blockAt: sinon.stub().returns({ stateId: 9101, type: undefined, name: 'unknown' }),
  } as unknown as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => mockBot, isConnected: () => true, getConfig: () => ({ host: '127.0.0.1', port: 25565 }) });
  injectSyntheticBridgeSnapshot(runtime, { block: 'complete', blockState: 'complete' }, [
    { kind: 'block', namespacedId: 'processia:crusher', numericId: 810 },
    { kind: 'blockState', namespacedId: 'processia:crusher', numericId: 9100 },
  ]);
  registerBlockTools(factory, () => mockBot, () => runtime.getContext());
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'find-blocks')!;
  const result = await call.args[3]({ blockType: 'processia:crusher', maxDistance: 1 });
  const details = JSON.parse(result.content[0].text.split('\n').at(-1)!);
  t.is(details.status, 'not-found-in-loaded-area');
  t.is(details.reason, 'no-match-in-loaded-area');
  t.is(details.mappingConfidence, 'session-observed');
});

test('find-blocks does not claim a modded block is absent without a state mapping', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = { version: '1.21.1', entity: { position: new Vec3(0, 64, 0) } } as unknown as mineflayer.Bot;
  const context = staticRegistryContext('1.21.1');
  registerBlockTools(factory, () => mockBot, () => context);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'find-blocks')!;
  const result = await call.args[3]({ blockType: 'processia:crusher' });
  const details = JSON.parse(result.content[0].text);
  t.is(details.status, 'unresolved');
  t.is(details.requested, 'processia:crusher');
});

test('find-blocks reports incomplete coverage when the bounded area contains unloaded chunks', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {
    version: '1.21', entity: { position: new Vec3(0, 64, 0) }, game: { minY: 0, height: 256 },
    blockAt: sinon.stub().returns(null),
  } as unknown as mineflayer.Bot;
  registerBlockTools(factory, () => mockBot, () => staticRegistryContext('1.21'));
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'find-blocks')!;
  const result = await call.args[3]({ blockType: 'stone', maxDistance: 2 });
  t.true(result.content[0].text.includes('Search for stone inconclusive'));
  const details = JSON.parse(result.content[0].text.split('\n').at(-1)!);
  t.is(details.status, 'inconclusive');
  t.is(details.reason, 'loaded-area-incomplete');
});
