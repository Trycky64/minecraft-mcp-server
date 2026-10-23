import test from 'ava';
import sinon from 'sinon';
import { registerEntityTools } from '../src/tools/entity-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

test('registerEntityTools registers find-entity tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');

  t.truthy(findEntityCall);
  t.is(findEntityCall!.args[1], 'Find the nearest entity of a specific type');
});

test('find-entity returns entity when found', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockEntity = {
    name: 'zombie',
    type: 'mob',
    position: new Vec3(5, 64, 8)
  };
  const mockBot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');
  const executor = findEntityCall!.args[3];

  const result = await executor({ type: 'zombie', maxDistance: 16 });

  t.true(result.content[0].text.includes('zombie'));
  t.true(result.content[0].text.includes('5'));
  t.true(result.content[0].text.includes('64'));
  t.true(result.content[0].text.includes('8'));
});

test('find-entity exposes a dropped stack with raw ID and marks its name as unverified', async (t) => {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  const entity = {
    id: 42, name: 'item', type: 'object', position: new Vec3(0.5, 64, 0.5),
    getDroppedItem: () => ({ type: 1373, count: 1, name: 'unknown' }),
  };
  const bot = { entity: { position: new Vec3(0, 64, 0) }, nearestEntity: sinon.stub().returns(entity) } as unknown as mineflayer.Bot;
  registerEntityTools(factory, () => bot);
  const call = (server.tool as sinon.SinonStub).getCalls().find((entry) => entry.args[0] === 'find-entity')!;
  const result = await call.args[3]({ type: 'item', maxDistance: 16 });
  const data = JSON.parse(result.content[0]!.text.split('Entity details (JSON):\n')[1]!) as { droppedItem: { rawNumericId: number; identity: string } };
  t.is(data.droppedItem.rawNumericId, 1373);
  t.is(data.droppedItem.identity, 'unresolved');
});

test('find-entity returns not found when entity too far', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockEntity = {
    name: 'zombie',
    type: 'mob',
    position: new Vec3(100, 64, 100)
  };
  const mockBot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');
  const executor = findEntityCall!.args[3];

  const result = await executor({ type: 'zombie', maxDistance: 16 });

  t.true(result.content[0].text.includes('No zombie found within 16 blocks'));
});

test('find-entity returns not found when no entity exists', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(null)
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');
  const executor = findEntityCall!.args[3];

  const result = await executor({ type: 'zombie', maxDistance: 16 });

  t.true(result.content[0].text.includes('No zombie found'));
});

test('find-entity handles player type', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockEntity = {
    username: 'TestPlayer',
    type: 'player',
    position: new Vec3(5, 64, 5)
  };
  const mockBot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');
  const executor = findEntityCall!.args[3];

  const result = await executor({ type: 'player', maxDistance: 16 });

  t.true(result.content[0].text.includes('TestPlayer'));
});

test('find-entity searches any entity when type not specified', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockEntity = {
    name: 'cow',
    type: 'mob',
    position: new Vec3(5, 64, 5)
  };
  const mockBot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');
  const executor = findEntityCall!.args[3];

  const result = await executor({ maxDistance: 16 });

  t.true(result.content[0].text.includes('cow'));
});
