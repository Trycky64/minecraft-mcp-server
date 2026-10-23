import test from 'ava';
import sinon from 'sinon';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { BridgeAdapterError } from '../src/bridge/bridge-adapter-contract.js';

test('createResponse returns proper MCP response format', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createResponse('Test message');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Test message' }]
  });
});

test('createResponse handles empty string', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createResponse('');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: '' }]
  });
});

test('createErrorResponse with Error object', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const error = new Error('Connection timeout');
  const response = factory.createErrorResponse(error);
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Connection timeout' }],
    isError: true,
    _meta: { diagnostic: { code: 'operation-timeout', category: 'timeout', retryable: false, temporary: true, sessionInvalidated: null } },
  });
});

test('createErrorResponse with string', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createErrorResponse('Invalid argument');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Invalid argument' }],
    isError: true,
    _meta: { diagnostic: { code: 'operation-failed', category: 'operation', retryable: false, temporary: null, sessionInvalidated: null } },
  });
});

test('public tool errors redact secret-shaped text and remove control characters', (t) => {
  const factory = new ToolFactory({} as McpServer, {} as BotConnection);
  const response = factory.createErrorResponse(new Error('bridge failed\nAuthorization: Bearer private-token secret=private-token'));
  const text = response.content[0]!.text;
  t.false(text.includes('private-token'));
  t.false(text.includes('\n'));
  t.true(text.includes('[redacted]'));
  t.true(response.isError);
  t.deepEqual(response._meta, { diagnostic: { code: 'operation-failed', category: 'operation', retryable: false, temporary: null, sessionInvalidated: null } });
});

test('bridge tool errors expose only stable codes, never adapter diagnostics', (t) => {
  const factory = new ToolFactory({} as McpServer, {} as BotConnection);
  const secret = 'diagnostic-secret-that-must-not-be-returned';
  const response = factory.createErrorResponse(new BridgeAdapterError('authentication-refused', secret));
  t.is(response.content[0]!.text, 'Failed: authentication-refused');
  t.deepEqual(response._meta, { diagnostic: { code: 'authentication-refused', category: 'authentication', retryable: false, temporary: false, sessionInvalidated: true } });
  t.false(JSON.stringify(response).includes(secret));
});

test('createErrorResponse includes isError flag', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createErrorResponse('Error occurred');
  
  t.true(response.isError === true);
});

test('registerTool calls server.tool with correct parameters', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const schema = { type: 'object', properties: {} };
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', schema, executor);
  
  t.true((mockServer.tool as sinon.SinonStub).calledOnce);
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[0], 'test_tool');
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[1], 'A test tool');
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[2], schema);
});

test('registerTool executor checks connection before executing', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  await registeredExecutor({ arg: 'value' });
  
  t.true((mockConnection.checkConnectionAndReconnect as sinon.SinonStub).calledOnce);
});

test('registerTool executor returns error when not connected', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ 
      connected: false, 
      message: 'Bot is not connected' 
    })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Bot is not connected' }],
    isError: true,
    _meta: { diagnostic: { code: 'minecraft-session-unavailable', category: 'connection', retryable: true, temporary: true, sessionInvalidated: null } },
  });
  t.true((executor as sinon.SinonStub).notCalled);
});

test('registerTool executor calls executor when connected', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const args = { arg: 'value' };
  await registeredExecutor(args);
  
  t.true((executor as sinon.SinonStub).calledOnceWith(args));
});

test('registerTool executor returns executor result when successful', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const expectedResponse = { content: [{ type: 'text', text: 'Tool executed' }] };
  const executor = sinon.stub().resolves(expectedResponse);
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, expectedResponse);
});

test('registerTool executor catches and returns error response on exception', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const error = new Error('Execution failed');
  const executor = sinon.stub().rejects(error);
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Execution failed' }],
    isError: true,
    _meta: { diagnostic: { code: 'operation-failed', category: 'operation', retryable: false, temporary: null, sessionInvalidated: null } },
  });
});
