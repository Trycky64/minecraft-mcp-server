import test from 'ava';
import sinon from 'sinon';
import type mineflayer from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { RuntimeRegistryService } from '../src/services/runtime-registry-service.js';
import { registerRegistryTools } from '../src/tools/registry-tools.js';

function register(mockBot: mineflayer.Bot | null, connected: boolean) {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const check = sinon.stub().resolves({ connected: false, message: 'must not reconnect' });
  const connection = { checkConnectionAndReconnect: check } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, connection);
  const runtime = new RuntimeRegistryService({
    getBot: () => mockBot,
    isConnected: () => connected,
    getConfig: () => ({ host: '127.0.0.1', port: 25565 }),
  });
  registerRegistryTools(factory, runtime);
  return { mockServer, check, runtime };
}

test('registry diagnostic tools register exactly status, resolve and inspect', (t) => {
  const { mockServer } = register(null, false);
  t.deepEqual((mockServer.tool as sinon.SinonStub).getCalls().map((call) => call.args[0]), [
    'registry-status', 'registry-resolve', 'registry-inspect',
  ]);
});

test('registry-status works while disconnected and does not trigger reconnect', async (t) => {
  const { mockServer, check } = register(null, false);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'registry-status')!;
  const result = await call.args[3]({});
  const status = JSON.parse(result.content[0].text);
  t.is(status.status, 'disconnected');
  t.is(status.bridgeAvailable, false);
  t.true(Array.isArray(status.limitations));
  t.false(check.called);
});

test('registry-status describes unresolved entries without claiming every Processia mapping is missing', async (t) => {
  const bot = { version: '1.21.1', protocolVersion: 767 } as mineflayer.Bot;
  const { mockServer, runtime } = register(bot, true);
  runtime.bindAuthenticatedBridge({ authenticated: true, serverIdentity: 'test-server', minecraftEndpoint: '127.0.0.1:25565',
    minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', sourceRegistryEpoch: 'source-epoch', sessionId: 'bridge-session', connectedAt: new Date().toISOString() });
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'registry-status')!;
  const result = await call.args[3]({});
  const status = JSON.parse(result.content[0].text);
  t.is(status.bridgeAvailable, true);
  t.true(status.limitations.some((value: string) => value.includes('absent from the authoritative snapshot')));
  t.false(status.limitations.some((value: string) => value === 'Processia item/block IDs remain unresolved until an authoritative runtime source supplies them.'));
});

test('registry-resolve returns a structured vanilla result for the live version and epoch', async (t) => {
  const bot = { version: '1.21.1', protocolVersion: '1.21.1' } as mineflayer.Bot;
  const { mockServer } = register(bot, true);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'registry-resolve')!;
  const result = await call.args[3]({ kind: 'item', namespacedId: 'minecraft:diamond' });
  const resolution = JSON.parse(result.content[0].text);
  t.is(resolution.status, 'resolved');
  t.is(resolution.entry.namespacedId, 'minecraft:diamond');
  t.is(resolution.provenance.source, 'minecraft-data');
  t.is(resolution.identityConfidence, 'version-static');
  t.false(resolution.runtimeNumericIdVerified);
  t.truthy(resolution.registryEpoch);
});

test('registry-resolve rejects a foreign session epoch instead of falling back to static numeric IDs', async (t) => {
  const bot = { version: '1.21.1', protocolVersion: 767 } as mineflayer.Bot;
  const { mockServer } = register(bot, true);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'registry-resolve')!;
  const result = await call.args[3]({ kind: 'item', numericId: 1, registryEpoch: 'session:foreign' });
  const resolution = JSON.parse(result.content[0].text);
  t.is(resolution.status, 'unavailable');
  t.is(resolution.reason, 'registry-not-loaded');
});

test('registry-resolve leaves runtime numeric mappings unobserved without a runtime snapshot', async (t) => {
  const bot = { version: '1.21.1', protocolVersion: 767 } as mineflayer.Bot;
  const { mockServer } = register(bot, true);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'registry-resolve')!;
  const result = await call.args[3]({ kind: 'item', numericId: 1 });
  const resolution = JSON.parse(result.content[0].text);
  t.is(resolution.status, 'unresolved');
  t.is(resolution.reason, 'mapping-not-observed');
});

test('registry-inspect returns a bounded page with source provenance', async (t) => {
  const bot = { version: '1.21.1', protocolVersion: '1.21.1' } as mineflayer.Bot;
  const { mockServer } = register(bot, true);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'registry-inspect')!;
  const result = await call.args[3]({ kind: 'item', offset: 0, limit: 10 });
  const page = JSON.parse(result.content[0].text);
  t.is(page.entries.length, 10);
  t.is(page.entries[0].provenance.source, 'minecraft-data');
  t.true(page.totalMatching >= page.entries.length);
  t.is(page.coverage[0].completeness, 'complete');
});
