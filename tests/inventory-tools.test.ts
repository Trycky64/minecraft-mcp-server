import test from 'ava';
import sinon from 'sinon';
import { registerInventoryTools } from '../src/tools/inventory-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';
import { RuntimeRegistryService } from '../src/services/runtime-registry-service.js';
import { EventEmitter } from 'node:events';
import { monitorProtocolDecode } from '../src/services/protocol-decode-monitor.js';

test('registerInventoryTools registers list-inventory tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const listInventoryCall = toolCalls.find(call => call.args[0] === 'list-inventory');

  t.truthy(listInventoryCall);
  t.is(listInventoryCall!.args[1], 'List all items in the bot\'s inventory');
});

test('registerInventoryTools registers equip-item tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const equipItemCall = toolCalls.find(call => call.args[0] === 'equip-item');

  t.truthy(equipItemCall);
  t.is(equipItemCall!.args[1], 'Equip a specific item');
});

test('list-inventory does not call an unverified local snapshot empty', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    inventory: {
      items: () => []
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const listInventoryCall = toolCalls.find(call => call.args[0] === 'list-inventory');
  const executor = listInventoryCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('not verified'));
});

test('list-inventory reports empty only after a full player window snapshot', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const protocol = Object.assign(new EventEmitter(), { state: 'play', version: '1.21.1' });
  monitorProtocolDecode(protocol);
  protocol.emit('packet', { windowId: 0 }, { name: 'window_items' });
  const mockBot = { _client: protocol, inventory: { items: () => [], slots: [] } } as unknown as mineflayer.Bot;
  registerInventoryTools(factory, () => mockBot);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find(item => item.args[0] === 'list-inventory')!;
  const result = await call.args[3]({});
  t.true(result.content[0].text.includes('Inventory is empty'));
});

test('list-inventory returns items with counts', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    inventory: {
      items: () => [
        { name: 'diamond_pickaxe', count: 1, slot: 0 },
        { name: 'cobblestone', count: 64, slot: 1 }
      ]
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const listInventoryCall = toolCalls.find(call => call.args[0] === 'list-inventory');
  const executor = listInventoryCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('diamond_pickaxe'));
  t.true(result.content[0].text.includes('cobblestone'));
  t.true(result.content[0].text.includes('64'));
});

test('list-inventory marks a snapshot incomplete after a dropped inventory packet', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const protocol = Object.assign(new EventEmitter(), {
    state: 'play', version: '1.21.1',
    deserializer: { parsePacketBuffer() { throw Object.assign(new Error('Malformed slot'), { name: 'PartialReadError' }); } },
  });
  monitorProtocolDecode(protocol);
  t.throws(() => protocol.deserializer.parsePacketBuffer(Buffer.from([0x13])), { name: 'PartialReadError' });
  const mockBot = { version: '1.21.1', _client: protocol, inventory: { items: () => [] } } as unknown as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => mockBot, isConnected: () => true, getConfig: () => ({ host: '127.0.0.1', port: 25565 }) });
  registerInventoryTools(factory, () => mockBot, () => runtime.getContext());
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find(item => item.args[0] === 'list-inventory')!;
  const result = await call.args[3]({});
  const details = JSON.parse(result.content[0].text.split('Registry details (JSON):\n')[1]);
  t.true(result.content[0].text.includes('INCOMPLETE'));
  t.is(details.snapshotStatus, 'incomplete');
  t.is(details.items.length, 0);
});

test('list-inventory separates observed numeric IDs from static vanilla candidates', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {
    version: '1.21.1',
    protocolVersion: '1.21.1',
    inventory: { items: () => [{ name: 'diamond', type: 805, count: 3, slot: 9, components: { custom: 'test' } }] },
  } as unknown as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => mockBot, isConnected: () => true, getConfig: () => ({ host: '127.0.0.1', port: 25565 }) });
  registerInventoryTools(factory, () => mockBot, () => runtime.getContext());
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'list-inventory')!;
  const result = await call.args[3]({});
  const details = JSON.parse(result.content[0].text.split('Registry details (JSON):\n')[1]);
  t.is(details.items[0].rawNumericId, 805);
  t.is(details.items[0].quantity, 3);
  t.is(details.items[0].slot, 9);
  t.is(details.items[0].namespacedId, null);
  t.is(details.items[0].staticCandidate.namespacedId, 'minecraft:diamond');
  t.is(details.items[0].staticCandidate.numericId, 805);
  t.is(details.items[0].identityConfidence, 'version-static-candidate');
  t.is(details.items[0].mineflayerNameConfidence, 'version-static');
  t.false(details.items[0].runtimeNumericIdVerified);
  t.deepEqual(details.items[0].components, { custom: 'test' });
});

test('raw item ID 1373 remains unresolved without runtime provenance and is never given an invented name', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {
    version: '1.21.1', protocolVersion: '1.21.1',
    inventory: { items: () => [{ name: 'unknown', type: 1373, count: 1, slot: 4 }] },
  } as unknown as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => mockBot, isConnected: () => true, getConfig: () => ({ host: 'localhost', port: 25565 }) });
  registerInventoryTools(factory, () => mockBot, () => runtime.getContext());
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'list-inventory')!;
  const result = await call.args[3]({});
  const details = JSON.parse(result.content[0].text.split('Registry details (JSON):\n')[1]);
  t.is(details.items[0].rawNumericId, 1373);
  t.is(details.items[0].namespacedId, null);
  t.is(details.items[0].resolutionStatus, 'unresolved');
  t.is(details.items[0].provenance, null);
  t.is(details.items[0].identityConfidence, 'unresolved');
  t.is(details.items[0].staticCandidate, null);
  t.false(details.items[0].runtimeNumericIdVerified);
  t.false(details.items[0].mineflayerNameReliable);
});

test('equip-item calls bot.equip', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const equipStub = sinon.stub().resolves();
  const mockBot = {
    inventory: {
      items: () => [
        { name: 'diamond_sword', type: 1 }
      ]
    },
    equip: equipStub
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const equipItemCall = toolCalls.find(call => call.args[0] === 'equip-item');
  const executor = equipItemCall!.args[3];

  const result = await executor({ itemName: 'diamond_sword', destination: 'hand' });

  t.true(equipStub.calledOnce);
  const data = JSON.parse(result.content[0].text) as { status: string; serverConfirmed: boolean; item: { mineflayerName: string } };
  t.is(data.status, 'uncertain');
  t.false(data.serverConfirmed);
  t.is(data.item.mineflayerName, 'diamond_sword');
});

test('equip-item returns message when item not found', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    inventory: {
      items: () => []
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const equipItemCall = toolCalls.find(call => call.args[0] === 'equip-item');
  const executor = equipItemCall!.args[3];

  const result = await executor({ itemName: 'diamond_sword', destination: 'hand' });

  t.true(result.content[0].text.includes('Couldn\'t find'));
});
