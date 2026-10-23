import test from 'ava';
import sinon from 'sinon';
import type mineflayer from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { RuntimeRegistryService } from '../src/services/runtime-registry-service.js';
import { registerRegistryTools } from '../src/tools/registry-tools.js';
import type { NeoForgeBridgeIntegration } from '../src/bridge/neoforge-bridge-client.js';

function register(mockBot: mineflayer.Bot | null, connected: boolean, bridge?: NeoForgeBridgeIntegration) {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const check = sinon.stub().resolves({ connected: false, message: 'must not reconnect' });
  const connection = { checkConnectionAndReconnect: check } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, connection);
  const runtime = new RuntimeRegistryService({
    getBot: () => mockBot,
    isConnected: () => connected,
    getConfig: () => ({ host: '127.0.0.1', port: 25565 }),
  });
  registerRegistryTools(factory, runtime, bridge);
  return { mockServer, check, runtime };
}

test('registry diagnostic tools register the generic discovery surface plus backward-compatible registry names', (t) => {
  const { mockServer } = register(null, false);
  t.deepEqual((mockServer.tool as sinon.SinonStub).getCalls().map((call) => call.args[0]), [
    'minecraft-get-server-info', 'minecraft-get-capabilities', 'minecraft-list-namespaces', 'minecraft-search-registry',
    'registry-status', 'registry-resolve', 'registry-inspect',
  ]);
});

test('capability report separates adapter inspection support from server and position availability', async (t) => {
  const bot = { version: '1.21.1', protocolVersion: 767 } as mineflayer.Bot;
  let serverCapabilityCalls = 0;
  const bridge = {
    adapter: { state: 'authenticated', supports: (capability: string) => [
      'registry.dynamic-index', 'capability.item-handler', 'capability.energy-storage', 'capability.fluid-handler',
    ].includes(capability) },
    capabilities: async () => {
      serverCapabilityCalls += 1;
      return { status: 'available', itemHandler: true, energyStorage: true, fluidHandler: false };
    },
  } as unknown as NeoForgeBridgeIntegration;
  const { mockServer, runtime } = register(bot, true, bridge);
  runtime.bindAuthenticatedBridge({ authenticated: true, serverIdentity: '127.0.0.1:25565', minecraftEndpoint: '127.0.0.1:25565',
    minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', sourceRegistryEpoch: 'source-epoch', sessionId: 'bridge-session', connectedAt: new Date().toISOString() });
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'minecraft-get-capabilities')!;
  const report = JSON.parse((await call.args[3]({})).content[0].text);
  const item = report.capabilities.find((capability: { id: string }) => capability.id === 'neoforge.capability.item');
  const energy = report.capabilities.find((capability: { id: string }) => capability.id === 'neoforge.capability.energy');
  const fluid = report.capabilities.find((capability: { id: string }) => capability.id === 'neoforge.capability.fluid');
  t.is(serverCapabilityCalls, 1);
  t.true(item.inspectionAvailable);
  t.true(item.serverAdvertised);
  t.is(item.availableAtPosition, null);
  t.true(energy.available);
  t.is(energy.availableAtPosition, null);
  t.false(fluid.serverAdvertised);
  t.is(fluid.availableAtPosition, null);
});

test('Processia capability report does not claim a generic server advertisement or fluid inspection', async (t) => {
  const bot = { version: '1.21.1', protocolVersion: 767 } as mineflayer.Bot;
  let genericCapabilityCalls = 0;
  const bridge = {
    adapter: { state: 'authenticated', supports: (capability: string) => ['capability.item-handler', 'capability.energy-storage'].includes(capability) },
    capabilities: async () => { genericCapabilityCalls += 1; throw new Error('generic endpoint must not be called'); },
  } as unknown as NeoForgeBridgeIntegration;
  const { mockServer, runtime } = register(bot, true, bridge);
  runtime.bindAuthenticatedBridge({ authenticated: true, serverIdentity: '127.0.0.1:25565', minecraftEndpoint: '127.0.0.1:25565',
    minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', sourceRegistryEpoch: 'source-epoch', sessionId: 'bridge-session', connectedAt: new Date().toISOString() });
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'minecraft-get-capabilities')!;
  const report = JSON.parse((await call.args[3]({})).content[0].text);
  const energy = report.capabilities.find((capability: { id: string }) => capability.id === 'neoforge.capability.energy');
  const fluid = report.capabilities.find((capability: { id: string }) => capability.id === 'neoforge.capability.fluid');
  t.is(genericCapabilityCalls, 0);
  t.true(energy.inspectionAvailable);
  t.is(energy.serverAdvertised, null);
  t.is(energy.availableAtPosition, null);
  t.false(fluid.inspectionAvailable);
  t.is(fluid.serverAdvertised, null);
});

test('generic server info and capability discovery work disconnected without reconnecting', async (t) => {
  const { mockServer, check } = register(null, false);
  const calls = (mockServer.tool as sinon.SinonStub).getCalls();
  const info = JSON.parse((await calls.find((item) => item.args[0] === 'minecraft-get-server-info')!.args[3]({})).content[0].text);
  const report = JSON.parse((await calls.find((item) => item.args[0] === 'minecraft-get-capabilities')!.args[3]({})).content[0].text);
  t.is(info.status, 'disconnected');
  t.is(info.bridge, null);
  t.is(info.serverIdentity, null);
  t.is(info.runtimeEpoch, null);
  t.false(report.capabilities.find((c: { id: string }) => c.id === 'world.block.read.loaded').available);
  t.false(report.capabilities.find((c: { id: string }) => c.id === 'neoforge.bridge.authenticated').available);
  t.false(check.called);
});

test('namespace listing is data-driven and search returns bounded vanilla registry pages', async (t) => {
  const bot = { version: '1.21.1', protocolVersion: 767 } as mineflayer.Bot;
  const { mockServer } = register(bot, true);
  const calls = (mockServer.tool as sinon.SinonStub).getCalls();
  const namespaces = JSON.parse((await calls.find((item) => item.args[0] === 'minecraft-list-namespaces')!.args[3]({})).content[0].text);
  t.true(namespaces.namespaces.some((row: { namespace: string }) => row.namespace === 'minecraft'));
  const search = JSON.parse((await calls.find((item) => item.args[0] === 'minecraft-search-registry')!.args[3]({ kind: 'item', prefix: 'minecraft:diamond', offset: 0, limit: 5 })).content[0].text);
  t.is(search.status, 'available');
  t.true(search.returned <= 5);
  t.true(search.entries.some((entry: { namespacedId: string }) => entry.namespacedId === 'minecraft:diamond'));
  t.true(search.entries.every((entry: { provenance: { source: string } }) => entry.provenance.source === 'minecraft-data'));
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

test('registry-status adds safe selected-adapter and last-error diagnostics when bridge integration exists', async (t) => {
  const bridge = { status: () => ({ adapter: 'generic-neoforge', adapterState: 'disconnected', protocolVersion: 1,
    enabled: true, configured: true, authenticated: false, lastError: 'bridge-timeout', secretConfigured: true,
    bridgeSessionId: 'must-not-be-copied' }) } as unknown as NeoForgeBridgeIntegration;
  const { mockServer } = register(null, false, bridge);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'registry-status')!;
  const status = JSON.parse((await call.args[3]({})).content[0].text);
  t.deepEqual(status.bridgeDiagnostic, { adapter: 'generic-neoforge', adapterState: 'disconnected', protocolVersion: 1,
    enabled: true, configured: true, authenticated: false, lastError: 'bridge-timeout' });
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
  t.is(resolution.provenance.authority, 'static-baseline');
  t.is(resolution.identityConfidence, 'version-static');
  t.false(resolution.runtimeNumericIdVerified);
  t.truthy(resolution.registryEpoch);
  t.truthy(resolution.runtimeEpoch);
});

test('registry-resolve rejects a foreign session epoch instead of falling back to static numeric IDs', async (t) => {
  const bot = { version: '1.21.1', protocolVersion: 767 } as mineflayer.Bot;
  const { mockServer } = register(bot, true);
  const call = (mockServer.tool as sinon.SinonStub).getCalls().find((item) => item.args[0] === 'registry-resolve')!;
  const result = await call.args[3]({ kind: 'item', numericId: 1, registryEpoch: 'session:foreign' });
  const resolution = JSON.parse(result.content[0].text);
  t.is(resolution.status, 'unavailable');
  t.is(resolution.reason, 'stale-context');
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
