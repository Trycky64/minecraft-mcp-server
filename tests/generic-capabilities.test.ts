import test from 'ava';
import sinon from 'sinon';
import type mineflayer from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerBridgeTools } from '../src/tools/bridge-tools.js';
import { NeoForgeBridgeIntegration, readBridgeClientConfig } from '../src/bridge/neoforge-bridge-client.js';
import { RuntimeRegistryService } from '../src/services/runtime-registry-service.js';

// Synthetic generic-bridge responses; fetch is stubbed, so no bridge or server is contacted.
const secret = 'synthetic-generic-bridge-secret-with-more-than-32-chars';
const endpoint = '127.0.0.1:26001';
const serverIdentity = 'synthetic-capability-server';
const javaEpoch = '6f1c2b8e-1d2a-4c8b-9e4f-2a7d3c5b9e10';
const sessionIds = ['3b8f6c1a-5d2e-4f7a-8c9b-1e2d3f4a5b6c', '9a7b6c5d-4e3f-4a1b-8c2d-3e4f5a6b7c8d'];
const position = { dimension: 'minecraft:overworld', x: 10, y: 64, z: -3 };

function base() {
  return { schemaVersion: 1, minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', serverIdentity, minecraftEndpoint: endpoint, registryEpoch: javaEpoch, observedAt: '2026-10-23T00:00:00.000Z' };
}
function reply(init: RequestInit | undefined, body: Record<string, unknown>, status = 200): Response {
  const headers = new Headers(init?.headers);
  const header = headers.has('X-Minecraft-MCP-Request-Id') ? 'X-Minecraft-MCP-Request-Id' : 'X-Processia-Request-Id';
  const requestId = headers.get(header) ?? '';
  return new Response(JSON.stringify({ ...body, requestId }), { status, headers: { [header]: requestId } });
}
function block(capabilities: Record<string, unknown>) {
  return { ...base(), ...position, block: 'examplemod:tank', blockStateId: 30_001, blockStateProperties: {}, blockEntityType: 'examplemod:tank', blockEntityPresent: true, ...capabilities };
}

function setup(mode: 'generic' | 'processia', inspection: () => { body: Record<string, unknown>; status?: number }) {
  let handshakes = 0;
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/handshake')) return reply(init, { ...base(), sessionId: sessionIds[Math.min(handshakes++, 1)] });
    const response = inspection();
    return reply(init, response.body, response.status);
  });
  const env = mode === 'generic'
    ? { MINECRAFT_MCP_BRIDGE_ENABLED: 'true', MINECRAFT_MCP_BRIDGE_SECRET: secret, MINECRAFT_MCP_BRIDGE_SERVER_IDENTITY: serverIdentity,
      MINECRAFT_MCP_SERVER_ENDPOINT: endpoint, MINECRAFT_MCP_BRIDGE_NEOFORGE_VERSION: '21.1.259' }
    : { PROCESSIA_BRIDGE_ENABLED: 'true', PROCESSIA_BRIDGE_SECRET: secret, PROCESSIA_BRIDGE_SERVER_IDENTITY: serverIdentity,
      PROCESSIA_MINECRAFT_ENDPOINT: endpoint, PROCESSIA_BRIDGE_NEOFORGE_VERSION: '21.1.259' };
  const bot = { version: '1.21.1', protocolVersion: '1.21.1' } as mineflayer.Bot;
  const runtime = new RuntimeRegistryService({ getBot: () => bot, isConnected: () => true, getConfig: () => ({ host: '127.0.0.1', port: 26001 }) });
  const integration = new NeoForgeBridgeIntegration(runtime, readBridgeClientConfig(env));
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  registerBridgeTools(new ToolFactory(server, connection), integration, runtime);
  const tool = (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === 'minecraft-inspect-capabilities')!.args[3] as
    (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  return { fetch, inspect: async () => JSON.parse((await tool(position)).content[0]!.text) as Record<string, unknown> & { capabilityReports?: Record<string, string> } };
}

test.serial('reported item, FE and fluid capabilities are passed through verbatim with explicit report status', async (t) => {
  const rows = {
    itemCapabilities: [{ face: 'unsided', available: true, slots: 2, items: [{ slot: 0, count: 3, empty: false, item: 'examplemod:copper_gear' }] }],
    energyCapabilities: [{ face: 'north', available: true, stored: 1200, capacity: 50_000, canReceive: true, canExtract: false }],
    fluidCapabilities: [{ face: 'unsided', available: true, tanks: [{ tank: 0, fluid: 'minecraft:water', amount: 1000, capacity: 32_000 }] }],
  };
  const { fetch, inspect } = setup('generic', () => ({ body: block(rows) }));
  t.teardown(() => fetch.restore());
  const result = await inspect();
  t.is(result.status, 'available');
  t.deepEqual([result.itemCapabilities, result.energyCapabilities, result.fluidCapabilities], [rows.itemCapabilities, rows.energyCapabilities, rows.fluidCapabilities]);
  t.deepEqual(result.capabilityReports, { item: 'entries-reported', energy: 'entries-reported', fluid: 'entries-reported' });
});

test.serial('absent and partial capabilities stay distinct from zero and no value is synthesized', async (t) => {
  const partialEnergy = [{ face: 'unsided', available: false }];
  const { fetch, inspect } = setup('generic', () => ({ body: block({ itemCapabilities: [], energyCapabilities: partialEnergy }) }));
  t.teardown(() => fetch.restore());
  const result = await inspect();
  t.deepEqual(result.itemCapabilities, []);
  t.deepEqual(result.energyCapabilities, partialEnergy, 'an unavailable FE face must not gain stored/capacity values');
  t.is(result.fluidCapabilities, null);
  t.deepEqual(result.capabilityReports, { item: 'empty-list-in-bridge-response', energy: 'entries-reported', fluid: 'not-present-in-bridge-response' });
  t.regex(String(result.caveat), /unknown, not zero/);
});

test.serial('the Processia adapter never reports fluids as empty: the protocol does not support them', async (t) => {
  const { fetch, inspect } = setup('processia', () => ({ body: block({ energyCapabilities: [{ face: 'unsided', available: true, stored: 5, capacity: 10 }] }) }));
  t.teardown(() => fetch.restore());
  const result = await inspect();
  t.is(result.fluidCapabilities, null);
  t.deepEqual(result.capabilityReports, { item: 'not-present-in-bridge-response', energy: 'entries-reported', fluid: 'not-supported-by-adapter' });
});

test.serial('capabilities become unavailable after a session change instead of returning stale values', async (t) => {
  let call = 0;
  const { fetch, inspect } = setup('generic', () => (++call === 1
    ? { body: block({ energyCapabilities: [{ face: 'unsided', available: true, stored: 7, capacity: 9 }] }) }
    : { body: { schemaVersion: 1, error: 'session_expired' }, status: 409 }));
  t.teardown(() => fetch.restore());
  t.is((await inspect()).status, 'available');
  const expired = await inspect();
  t.is(expired.status, 'error');
  t.is(expired.error, 'session-expired');
  t.false('energyCapabilities' in expired);
});

test.serial('a capability response from another server identity is refused', async (t) => {
  const { fetch, inspect } = setup('generic', () => ({ body: { ...block({ energyCapabilities: [] }), serverIdentity: 'another-server' } }));
  t.teardown(() => fetch.restore());
  const result = await inspect();
  t.is(result.status, 'error');
  t.false('energyCapabilities' in result);
});
