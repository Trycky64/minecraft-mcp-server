import test from 'ava';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { GuiHarnessClient } from '../src/gui/gui-harness-client.js';
import { NeoForgeBridgeIntegration } from '../src/bridge/neoforge-bridge-client.js';
import { RuntimeRegistryService } from '../src/services/runtime-registry-service.js';
import { ToolFactory } from '../src/tool-factory.js';
import { energySyncTolerance, itemAt, outputIncreased, unsidedEnergy, registerGuiTools } from '../src/tools/gui-tools.js';

function setup(mode: 'READ_ONLY' | 'TEST_MUTATION' = 'READ_ONLY') {
  const registrations: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> = [];
  const server = { tool: (name: string, _description: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => registrations.push({ name, handler }) } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  const gui = {
    config: { mode, testWorldAcknowledged: mode === 'TEST_MUTATION', allowedDimensions: ['minecraft:overworld'], allowedMachines: ['processia:crusher'], allowedBlocks: ['minecraft:chest'] },
    call: sinon.stub().resolves({ accepted: true }), screenshot: sinon.stub().resolves({ mediaType: 'image/png' }),
    status: sinon.stub().resolves({ authenticated: false }), startClient: sinon.stub().resolves({ status: 'starting' }),
    stopClient: sinon.stub().resolves({ status: 'stopped' }),
  } as unknown as GuiHarnessClient;
  const bridge = { inspectMachine: sinon.stub() } as unknown as NeoForgeBridgeIntegration;
  const runtime = { getContext: () => ({ bridgeSession: null }) } as unknown as RuntimeRegistryService;
  registerGuiTools(factory, gui, bridge, runtime);
  return { registrations, gui };
}

test('registers all GUI test tools without replacing existing MCP tools', (t) => {
  const { registrations } = setup();
  t.deepEqual(registrations.map((tool) => tool.name), [
    'gui-status', 'gui-start-client', 'gui-stop-client', 'gui-inspect-screen', 'gui-open-pause', 'gui-set-music-zero', 'gui-open-machine', 'gui-open-block',
    'gui-click-slot', 'gui-move-items', 'gui-click-widget', 'gui-hover-slot', 'gui-hover-widget', 'gui-close-screen',
    'gui-screenshot', 'gui-capture-block', 'gui-set-display', 'gui-wait-for', 'gui-run-e2e',
  ]);
});

test('READ_ONLY mode refuses slot interaction before sending it to the Minecraft client', async (t) => {
  const { registrations, gui } = setup('READ_ONLY');
  const clickSlot = registrations.find((tool) => tool.name === 'gui-click-slot')!;
  const result = await clickSlot.handler({ slotId: 0, action: 'left' }) as { content: Array<{ text: string }> };
  t.true(result.content[0]!.text.includes('gui-test-mutation-disabled'));
  t.false((gui.call as sinon.SinonStub).called);
});

test('READ_ONLY mode refuses exact item transfer before sending menu clicks', async (t) => {
  const { registrations, gui } = setup('READ_ONLY');
  const move = registrations.find((tool) => tool.name === 'gui-move-items')!;
  const result = await move.handler({ sourceSlot: 30, targetSlot: 0, count: 1 }) as { content: Array<{ text: string }> };
  t.true(result.content[0]!.text.includes('gui-test-mutation-disabled'));
  t.false((gui.call as sinon.SinonStub).called);
});

test('generic vanilla block opening is constrained to the configured block allowlist', async (t) => {
  const { registrations, gui } = setup('TEST_MUTATION');
  const openBlock = registrations.find((tool) => tool.name === 'gui-open-block')!;
  const result = await openBlock.handler({ dimension: 'minecraft:overworld', x: 0, y: 64, z: 0, expectedBlock: 'minecraft:furnace' }) as { content: Array<{ text: string }> };
  t.true(result.content[0]!.text.includes('gui-target-outside-allowlist'));
  t.false((gui.call as sinon.SinonStub).called);
});

test('live GUI/server energy comparison tolerates one observed FE input-rate quantum', (t) => {
  t.is(energySyncTolerance({ energyPerTick: 0, inputRate: 20 }, { currentInput: 20 }), 20);
  t.is(energySyncTolerance({ energyPerTick: 16, inputRate: 0 }, { currentInput: 0 }), 33);
  t.is(energySyncTolerance({ energyPerTick: 0 }, {}), 1);
});

test('GUI E2E reads the generic bridge unsided inventory without confusing side-local slots', (t) => {
  const inventory = { available: true, faces: [
    { face: 'down', items: [{ slot: 0, item: 'processia:iron_dust', count: 2 }] },
    { face: 'unsided', items: [{ slot: 0, empty: true, count: 0 }, { slot: 1, item: 'processia:iron_dust', count: 2 }] },
  ] };
  t.deepEqual(itemAt(inventory, 1), { item: 'processia:iron_dust', count: 2 });
  t.deepEqual(itemAt(inventory, 0), { item: null, count: 0 });
  t.is(itemAt({ available: true, faces: [{ face: 'down', items: [{ slot: 0, item: 'minecraft:stone', count: 1 }] }] }, 0), null);
});

test('GUI E2E reads only an available unsided FE capability', (t) => {
  t.deepEqual(unsidedEnergy([{ face: 'north', available: true, stored: 3, capacity: 10 }, { face: 'unsided', available: true, stored: 10000, capacity: 10000 }]), { energyStored: 10000, energyCapacity: 10000 });
  t.is(unsidedEnergy([{ face: 'north', available: true, stored: 3, capacity: 10 }]), null);
  t.is(unsidedEnergy([{ face: 'unsided', available: false, stored: 3, capacity: 10 }]), null);
});

test('preexisting machine output is never proof that this GUI run executed a recipe', (t) => {
  t.false(outputIncreased({ item: 'processia:iron_dust', count: 2 }, { item: 'processia:iron_dust', count: 2 }, 'processia:iron_dust', 1));
  t.true(outputIncreased({ item: 'processia:iron_dust', count: 2 }, { item: 'processia:iron_dust', count: 3 }, 'processia:iron_dust', 1));
  t.true(outputIncreased({ item: null, count: 0 }, { item: 'processia:iron_dust', count: 1 }, 'processia:iron_dust', 1));
  t.false(outputIncreased(null, { item: 'processia:iron_dust', count: 1 }, 'processia:iron_dust', 1));
  t.false(outputIncreased({ item: 'minecraft:stone', count: 1 }, { item: 'processia:iron_dust', count: 3 }, 'processia:iron_dust', 1));
});

test('gui-wait-for accepts explicit client and interaction readiness conditions', async (t) => {
  const { registrations, gui } = setup();
  const waitFor = registrations.find((tool) => tool.name === 'gui-wait-for')!;
  await waitFor.handler({ condition: 'client_ready', timeoutMs: 1000 });
  await waitFor.handler({ condition: 'interaction_ready', timeoutMs: 1000 });
  t.is((gui.call as sinon.SinonStub).callCount, 2);
  t.deepEqual((gui.call as sinon.SinonStub).firstCall.args, ['/v1/wait-for', { condition: 'client_ready', timeoutMs: 1000 }]);
});

test('ready world with no active screen can open pause through a normal GUI action', async (t) => {
  const { registrations, gui } = setup('TEST_MUTATION');
  const openPause = registrations.find((tool) => tool.name === 'gui-open-pause')!;
  const result = await openPause.handler({}) as { content: Array<{ text: string }> };
  t.true(result.content[0]!.text.includes('accepted'));
  t.deepEqual((gui.call as sinon.SinonStub).firstCall.args, ['/v1/open-pause']);
});

test('music adjustment is refused outside the acknowledged isolated mutation mode', async (t) => {
  const { registrations, gui } = setup('READ_ONLY');
  const adjust = registrations.find((tool) => tool.name === 'gui-set-music-zero')!;
  const result = await adjust.handler({}) as { content: Array<{ text: string }> };
  t.true(result.content[0]!.text.includes('gui-test-mutation-disabled'));
  t.false((gui.call as sinon.SinonStub).called);
});

test('wait-for supports a specific screen transition', async (t) => {
  const { registrations, gui } = setup('TEST_MUTATION');
  const waitFor = registrations.find((tool) => tool.name === 'gui-wait-for')!;
  await waitFor.handler({ condition: 'screen:SoundOptionsScreen', timeoutMs: 1000 });
  t.deepEqual((gui.call as sinon.SinonStub).firstCall.args, ['/v1/wait-for', { condition: 'screen:SoundOptionsScreen', timeoutMs: 1000 }]);
});
