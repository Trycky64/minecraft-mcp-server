import test from 'ava';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerBridgeTools } from '../src/tools/bridge-tools.js';
import { NeoForgeBridgeIntegration } from '../src/bridge/neoforge-bridge-client.js';
import { RuntimeRegistryService } from '../src/services/runtime-registry-service.js';
import type mineflayer from 'mineflayer';

test('registers the read-only bridge, machine and capability diagnostics', (t) => {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const bot = { version: '1.21.1', protocolVersion: '1.21.1' } as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => bot, isConnected: () => true, getConfig: () => ({ host: '127.0.0.1', port: 25565 }) });
  registerBridgeTools(new ToolFactory(server, connection), new NeoForgeBridgeIntegration(runtime));
  const names = (server.tool as sinon.SinonStub).getCalls().map(call => call.args[0]);
  t.deepEqual(names, ['bridge-status', 'bridge-refresh-registries', 'inspect-processia-machine', 'inspect-processia-capabilities', 'list-processia-machines', 'inspect-processia-recipes']);
});

test('bridge-status is readable while disconnected and reports disabled without reconnecting', async (t) => {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: false }) } as unknown as BotConnection;
  const runtime = new RuntimeRegistryService({ getBot: () => null, isConnected: () => false, getConfig: () => ({ host: '127.0.0.1', port: 25565 }) });
  registerBridgeTools(new ToolFactory(server, connection), new NeoForgeBridgeIntegration(runtime, { enabled: false, url: null, secret: null, expectedServerIdentity: null, expectedMinecraftEndpoint: null, expectedNeoForgeVersion: null, timeoutMs: 1000, configurationError: null }));
  const call = (server.tool as sinon.SinonStub).getCalls().find(value => value.args[0] === 'bridge-status')!;
  const result = await call.args[3]({});
  const status = JSON.parse(result.content[0].text);
  t.false(status.enabled);
  t.is(status.bridgeAvailable, false);
  t.is((connection.checkConnectionAndReconnect as sinon.SinonStub).callCount, 0);
});
