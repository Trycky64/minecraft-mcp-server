import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NeoForgeBridgeIntegration } from '../bridge/neoforge-bridge-client.js';
import type { RuntimeRegistryService } from '../services/runtime-registry-service.js';
import type { ToolFactory } from '../tool-factory.js';
import { GuiHarnessClient } from '../gui/gui-harness-client.js';

const machines = ['processia:coal_generator', 'processia:crusher', 'processia:press', 'processia:wiremill', 'processia:basic_battery'] as const;
const processiaBlocks = [...machines, 'processia:energy_cable'] as const;

function json(factory: ToolFactory, value: unknown) { return factory.createResponse(JSON.stringify(value, null, 2)); }
function failed(factory: ToolFactory, error: unknown) {
  const code = error instanceof Error ? error.message : 'gui-operation-failed';
  return json(factory, { status: 'error', error: /^[a-z0-9_-]{1,120}$/.test(code) ? code : 'gui-operation-failed' });
}
function positionSchema() {
  return {
    dimension: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/),
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int(),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  };
}
export function itemAt(inventory: unknown, slot: number): { item: string | null; count: number } | null {
  if (inventory === null || typeof inventory !== 'object') return null;
  const value = inventory as { items?: unknown; faces?: unknown };
  const unsided = Array.isArray(value.faces) ? value.faces.find((face) => face !== null && typeof face === 'object' && (face as { face?: unknown }).face === 'unsided') as { items?: unknown } | undefined : undefined;
  const items = Array.isArray(unsided?.items) ? unsided.items : value.items;
  if (!Array.isArray(items)) return null;
  const row = items.find((item) => item !== null && typeof item === 'object' && (item as { slot?: unknown }).slot === slot) as { item?: unknown; count?: unknown } | undefined;
  return row ? { item: typeof row.item === 'string' ? row.item : null, count: typeof row.count === 'number' ? row.count : 0 } : null;
}

export function unsidedEnergy(capabilities: unknown): { energyStored: number; energyCapacity: number } | null {
  if (!Array.isArray(capabilities)) return null;
  const row = capabilities.find((entry) => entry !== null && typeof entry === 'object' && (entry as { face?: unknown }).face === 'unsided') as { available?: unknown; stored?: unknown; capacity?: unknown } | undefined;
  return row?.available === true && typeof row.stored === 'number' && typeof row.capacity === 'number'
    ? { energyStored: row.stored, energyCapacity: row.capacity } : null;
}

export function outputIncreased(before: { item: string | null; count: number } | null,
  after: { item: string | null; count: number } | null, expectedItem: string, minimumIncrease: number): boolean {
  if (before === null || after === null || after.item !== expectedItem) return false;
  if (before.item !== null && before.item !== expectedItem) return false;
  const baseline = before.item === expectedItem ? before.count : 0;
  return after.count - baseline >= minimumIncrease;
}

export function energySyncTolerance(guiValues: Record<string, unknown>, serverMachine: Record<string, unknown>): number {
  return Math.max(1, Number(guiValues.energyPerTick) * 2 + 1,
    Number(guiValues.inputRate) || 0, Number(serverMachine.currentInput) || 0);
}

export function registerGuiTools(factory: ToolFactory, gui: GuiHarnessClient, bridge: NeoForgeBridgeIntegration, runtime: RuntimeRegistryService): void {
  factory.registerTool('gui-status', 'Inspect the authenticated local GUI client and its link to the NeoForge bridge', {}, async () => json(factory, await gui.status()), { requiresConnection: false });

  factory.registerTool('gui-start-client', 'Start a real isolated NeoForge development client for the configured test server', {}, async () => {
    try { return json(factory, await gui.startClient()); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-stop-client', 'Stop the test client started by this MCP process, revoking its GUI session', {}, async () => {
    try { return json(factory, await gui.stopClient()); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-inspect-screen', 'Inspect the real active Minecraft screen, menu, slots, widgets and client resolution', {}, async () => {
    try { return json(factory, await gui.call('/v1/screen')); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-open-pause', 'Open the normal pause menu from a ready isolated test world', {}, async () => {
    if (gui.config.mode !== 'TEST_MUTATION' || !gui.config.testWorldAcknowledged) return failed(factory, new Error('gui-test-mutation-disabled'));
    try { return json(factory, await gui.call('/v1/open-pause')); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-set-music-zero', 'Set only the isolated GUI test client music category to zero from Music & Sounds', {}, async () => {
    if (gui.config.mode !== 'TEST_MUTATION' || !gui.config.testWorldAcknowledged) return failed(factory, new Error('gui-test-mutation-disabled'));
    try { return json(factory, await gui.call('/v1/set-music-zero')); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-open-machine', 'Open an allowlisted Processia machine through the real client block interaction', {
    ...positionSchema(), expectedBlock: z.enum(machines),
  }, async (request) => {
    if (!gui.config.allowedDimensions.includes(request.dimension) || !gui.config.allowedMachines.includes(request.expectedBlock)) return failed(factory, new Error('gui-target-outside-allowlist'));
    try { return json(factory, await gui.call('/v1/open-machine', request)); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-open-block', 'Open an allowlisted vanilla container or Processia menu through the real client block interaction', {
    ...positionSchema(), expectedBlock: z.string().regex(/^(minecraft|processia):[a-z0-9/._-]+$/),
  }, async (request) => {
    if (!gui.config.allowedDimensions.includes(request.dimension) || !gui.config.allowedBlocks.includes(request.expectedBlock)) return failed(factory, new Error('gui-target-outside-allowlist'));
    try { return json(factory, await gui.call('/v1/open-block', request)); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-click-slot', 'Send a real server-validated left, right or shift click to a menu slot', {
    slotId: z.number().int().min(0).max(255), action: z.enum(['left', 'right', 'shift']),
  }, async (request) => {
    if (gui.config.mode !== 'TEST_MUTATION' || !gui.config.testWorldAcknowledged) return failed(factory, new Error('gui-test-mutation-disabled'));
    try { return json(factory, await gui.call('/v1/click-slot', request)); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-move-items', 'Move an exact count through ordinary client menu pickup clicks; the server remains authoritative', {
    sourceSlot: z.number().int().min(0).max(255),
    targetSlot: z.number().int().min(0).max(255),
    count: z.number().int().min(1).max(64),
  }, async (request) => {
    if (gui.config.mode !== 'TEST_MUTATION' || !gui.config.testWorldAcknowledged) return failed(factory, new Error('gui-test-mutation-disabled'));
    try { return json(factory, await gui.call('/v1/move-items', request)); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-click-widget', 'Click a widget by its current logical screen identifier', {
    widgetId: z.string().min(1).max(160),
  }, async ({ widgetId }) => {
    if (gui.config.mode !== 'TEST_MUTATION' || !gui.config.testWorldAcknowledged) return failed(factory, new Error('gui-test-mutation-disabled'));
    try { return json(factory, await gui.call('/v1/click-widget', { widgetId })); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-hover-slot', 'Move the real client cursor over a live menu slot to reveal its actual rendered tooltip', {
    slotId: z.number().int().min(0).max(255),
  }, async ({ slotId }) => {
    try { return json(factory, await gui.call('/v1/hover-slot', { slotId })); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-hover-widget', 'Move the real client cursor over a live logical GUI widget', {
    widgetId: z.string().min(1).max(160),
  }, async ({ widgetId }) => {
    try { return json(factory, await gui.call('/v1/hover-widget', { widgetId })); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-close-screen', 'Close the active screen through normal Minecraft client lifecycle handling', {}, async () => {
    if (gui.config.mode !== 'TEST_MUTATION' || !gui.config.testWorldAcknowledged) return failed(factory, new Error('gui-test-mutation-disabled'));
    try { return json(factory, await gui.call('/v1/close-screen')); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-screenshot', 'Capture a real Minecraft framebuffer PNG and retain it in the configured evidence directory', {}, async () => {
    try { return json(factory, await gui.screenshot()); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-capture-block', 'Aim the real test client at a loaded Processia block, verify it against P2 and retain a world framebuffer capture', {
    ...positionSchema(), expectedBlock: z.enum(processiaBlocks),
  }, async (request) => {
    if (!gui.config.allowedDimensions.includes(request.dimension)) return failed(factory, new Error('gui-target-outside-allowlist'));
    const session = runtime.getContext().bridgeSession;
    if (!session?.authenticated) return failed(factory, new Error('gui-capture-requires-authenticated-bridge'));
    try {
      const server = await bridge.inspectMachine({ dimension: request.dimension, x: request.x, y: request.y, z: request.z });
      const report: Record<string, unknown> = {
        schemaVersion: 1, scenario: 'processia-block-framebuffer-capture', startedAt: new Date().toISOString(),
        serverIdentity: session.serverIdentity, minecraftEndpoint: session.minecraftEndpoint, serverEpoch: session.sourceRegistryEpoch,
        serverBlock: server.block, serverBlockStateId: server.blockStateId, serverBlockStateProperties: server.blockStateProperties,
        assertions: [] as Array<Record<string, unknown>>,
        limitations: ['The PNG is a genuine Minecraft framebuffer capture. Pixel-level texture/layout correctness still needs a visual review.'],
      };
      const assertions = report.assertions as Array<Record<string, unknown>>;
      const correctBlock = server.block === request.expectedBlock;
      assertions.push({ id: 'bridge-block-identity', status: correctBlock ? 'PASS' : 'FAIL', expected: request.expectedBlock, observed: server.block });
      if (!correctBlock) { report.status = 'FAIL'; report.finishedAt = new Date().toISOString(); return json(factory, report); }
      await gui.call('/v1/look-at-block', { x: request.x, y: request.y, z: request.z });
      const deadline = Date.now() + 5000;
      let screen: Record<string, unknown> | null = null;
      while (Date.now() < deadline) {
        screen = await gui.call('/v1/screen');
        if (screen.crosshairX === request.x && screen.crosshairY === request.y && screen.crosshairZ === request.z) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const visible = screen !== null && screen.crosshairX === request.x && screen.crosshairY === request.y && screen.crosshairZ === request.z && screen.crosshairBlock === request.expectedBlock;
      assertions.push({ id: 'client-raycast-target', status: visible ? 'PASS' : 'FAIL', block: screen?.crosshairBlock ?? null, x: screen?.crosshairX ?? null, y: screen?.crosshairY ?? null, z: screen?.crosshairZ ?? null });
      if (!visible) throw new Error('gui-target-not-visible-to-client');
      report.screen = screen;
      report.screenshot = await gui.screenshot();
      report.finishedAt = new Date().toISOString();
      report.status = 'INCONCLUSIVE';
      await mkdir(gui.config.artifactDirectory, { recursive: true });
      const artifact = path.join(gui.config.artifactDirectory, `block-capture-${Date.now()}-${randomUUID()}.json`);
      await writeFile(artifact, JSON.stringify(report, null, 2), { flag: 'wx' });
      report.reportPath = artifact;
      return json(factory, report);
    } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-set-display', 'Set the isolated test client window resolution and GUI scale for visual regression runs', {
    width: z.number().int().min(640).max(3840),
    height: z.number().int().min(480).max(2160),
    guiScale: z.number().int().min(0).max(6),
  }, async (request) => {
    try { return json(factory, await gui.call('/v1/set-display', request)); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-wait-for', 'Wait for a screen, menu or slot condition with a bounded timeout', {
    condition: z.string().min(1).max(256).refine((value) => ['screen_active', 'screen_closed', 'client_ready', 'interaction_ready'].includes(value) || /^screen:[A-Za-z][A-Za-z0-9]*$/.test(value) || value.startsWith('menu:') || /^slot:\d+:[a-z0-9_.-]+:[a-z0-9/._-]+:\d+$/.test(value) || /^target:-?\d+:-?\d+:-?\d+$/.test(value), 'Unsupported wait condition'),
    timeoutMs: z.number().int().min(50).max(10000).default(3000),
  }, async (request) => {
    try { return json(factory, await gui.call('/v1/wait-for', request)); } catch (error) { return failed(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('gui-run-e2e', 'Run a bounded machine GUI test: bridge snapshot, real menu open, optional real item insertion, visual capture and server-side comparison', {
    ...positionSchema(),
    machine: z.enum(machines),
    inputPlayerSlot: z.number().int().min(0).max(255).optional(),
    machineInputSlot: z.number().int().min(0).max(63).optional(),
    transferCount: z.number().int().min(1).max(64).optional(),
    machineOutputSlot: z.number().int().min(0).max(63).default(1),
    expectedOutputItem: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/).optional(),
    minimumOutputCount: z.number().int().positive().max(64).default(1),
    timeoutMs: z.number().int().min(1000).max(60000).default(30000),
  }, async (request) => {
    if (!gui.config.allowedDimensions.includes(request.dimension) || !gui.config.allowedMachines.includes(request.machine)) return failed(factory, new Error('gui-target-outside-allowlist'));
    if ((request.inputPlayerSlot !== undefined || request.expectedOutputItem !== undefined) && (gui.config.mode !== 'TEST_MUTATION' || !gui.config.testWorldAcknowledged)) return failed(factory, new Error('gui-test-mutation-disabled'));
    const context = runtime.getContext();
    const bridgeSession = context.bridgeSession;
    if (!bridgeSession?.authenticated) return failed(factory, new Error('gui-e2e-requires-authenticated-bridge'));
    const suffix = request.machine.slice('processia:'.length);
    const report: Record<string, unknown> = {
      schemaVersion: 1,
      scenario: `gui-${suffix}`,
      startedAt: new Date().toISOString(),
      serverIdentity: bridgeSession.serverIdentity,
      minecraftEndpoint: bridgeSession.minecraftEndpoint,
      serverEpoch: bridgeSession.sourceRegistryEpoch,
      assertions: [] as Array<Record<string, unknown>>,
      limitations: ['This scenario validates a real screen, a real menu click if requested, and server state. It does not claim automated pixel correctness; visual review remains separate.'],
    };
    const assertions = report.assertions as Array<Record<string, unknown>>;
    try {
      const before = await bridge.inspectMachine({ dimension: request.dimension, x: request.x, y: request.y, z: request.z });
      const outputBefore = request.expectedOutputItem ? itemAt(before.inventory, request.machineOutputSlot) : null;
      const rightBlock = before.block === request.machine;
      assertions.push({ id: 'bridge-machine-identity', status: rightBlock ? 'PASS' : 'FAIL', observed: before.block, expected: request.machine });
      if (!rightBlock || !before.blockEntityPresent) throw new Error('gui-e2e-machine-not-present');

      const opened = await gui.call('/v1/open-machine', { dimension: request.dimension, x: request.x, y: request.y, z: request.z, expectedBlock: request.machine });
      assertions.push({ id: 'real-player-interaction', status: opened.accepted === true ? 'PASS' : 'FAIL', interactionResult: opened.interactionResult });
      const screen = await gui.call('/v1/wait-for', { condition: `menu:${request.machine}`, timeoutMs: 8000 });
      const menuMatched = screen.menuId === request.machine;
      assertions.push({ id: 'menu-server-type', status: menuMatched ? 'PASS' : 'FAIL', observed: screen.menuId, expected: request.machine });
      if (!menuMatched) throw new Error('gui-e2e-menu-mismatch');
      const syncedValues = screen.syncedValues;
      const genericEnergy = unsidedEnergy(before.energyCapabilities);
      const serverMachine = before.processiaMachine ?? genericEnergy;
      if (syncedValues !== null && typeof syncedValues === 'object' && serverMachine != null) {
        const guiValues = syncedValues as Record<string, unknown>;
        const energyDelta = Math.abs(Number(guiValues.energyStored) - Number(serverMachine.energyStored));
        // A live generator/network may transfer one input-rate quantum between
        // the client sync packet and the bridge read. Treat that single-tick
        // delta as concurrency, while still requiring exact capacity agreement.
        const energyTolerance = energySyncTolerance(guiValues, serverMachine);
        const energyCapacityMatches = guiValues.energyCapacity === serverMachine.energyCapacity;
        const energyMatches = Number.isFinite(energyDelta) && energyDelta <= energyTolerance;
        assertions.push({ id: 'synced-energy-vs-server', status: energyMatches && energyCapacityMatches ? 'PASS' : 'FAIL', gui: { energyStored: guiValues.energyStored, energyCapacity: guiValues.energyCapacity }, server: { energyStored: serverMachine.energyStored, energyCapacity: serverMachine.energyCapacity }, allowedEnergyDelta: energyTolerance, observedDelta: energyDelta });
        if (before.processiaMachine) {
          const processiaMachine = before.processiaMachine;
          const progressDelta = Math.abs(Number(guiValues.progress) - Number(processiaMachine.progress));
          const burnDelta = Math.abs(Number(guiValues.burnTime) - Number(processiaMachine.burnTime));
          const progressMatches = Number.isFinite(progressDelta) && progressDelta <= 2;
          const burnMatches = Number.isFinite(burnDelta) && burnDelta <= 2;
          assertions.push({ id: 'synced-progress-burn-redstone-vs-server', status: progressMatches && burnMatches && guiValues.redstoneMode === processiaMachine.redstoneMode ? 'PASS' : 'FAIL', gui: { progress: guiValues.progress, progressMaximum: guiValues.progressMaximum, burnTime: guiValues.burnTime, redstoneMode: guiValues.redstoneMode }, server: { progress: processiaMachine.progress, progressMaximum: processiaMachine.progressMaximum, burnTime: processiaMachine.burnTime, redstoneMode: processiaMachine.redstoneMode }, toleranceTicks: 2 });
        } else {
          assertions.push({ id: 'synced-progress-burn-redstone-vs-server', status: 'INCONCLUSIVE', detail: 'The generic bridge does not expose mod-private progress, combustion or redstone values.' });
        }
        report.bridgeMachineBefore = serverMachine;
        report.guiSyncedValues = guiValues;
      } else {
        assertions.push({ id: 'synced-menu-values-vs-server', status: 'INCONCLUSIVE', detail: 'The active screen or bridge response did not expose comparable machine data.' });
      }

      if (request.inputPlayerSlot !== undefined) {
        const sourceBefore = Array.isArray(screen.slots) ? (screen.slots as Array<Record<string, unknown>>).find((slot) => slot.slotId === request.inputPlayerSlot) : undefined;
        if (request.transferCount !== undefined) {
          if (request.machineInputSlot === undefined) throw new Error('gui-e2e-exact-transfer-requires-machine-input-slot');
          const transfer = await gui.call('/v1/move-items', { sourceSlot: request.inputPlayerSlot, targetSlot: request.machineInputSlot, count: request.transferCount });
          assertions.push({ id: 'exact-client-menu-transfer', status: transfer.accepted === true && transfer.serverConfirmationRequired === true ? 'PASS' : 'FAIL', transfer });
        } else {
          await gui.call('/v1/click-slot', { slotId: request.inputPlayerSlot, action: 'shift' });
          assertions.push({ id: 'real-shift-click-sent', status: 'PASS', playerSlot: request.inputPlayerSlot });
        }
        if (request.machineInputSlot !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const [afterTransfer, machineAfterTransfer] = await Promise.all([
            gui.call('/v1/screen'),
            bridge.inspectMachine({ dimension: request.dimension, x: request.x, y: request.y, z: request.z }),
          ]);
          const guiSlot = Array.isArray(afterTransfer.slots) ? (afterTransfer.slots as Array<Record<string, unknown>>).find((slot) => slot.slotId === request.machineInputSlot) : null;
          const serverSlot = itemAt(machineAfterTransfer.inventory, request.machineInputSlot);
          const transferMatches = guiSlot && serverSlot && guiSlot.item === serverSlot.item && guiSlot.count === serverSlot.count;
          const transferCountMatches = request.transferCount === undefined || (serverSlot?.count ?? 0) >= request.transferCount;
          assertions.push({ id: 'gui-bridge-slot-comparison', status: transferMatches && transferCountMatches ? 'PASS' : 'FAIL', gui: guiSlot ?? null, bridgeAfter: serverSlot, requestedTransferCount: request.transferCount ?? null });
          if (request.transferCount !== undefined) {
            const sourceAfter = Array.isArray(afterTransfer.slots) ? (afterTransfer.slots as Array<Record<string, unknown>>).find((slot) => slot.slotId === request.inputPlayerSlot) : undefined;
            const sourceDecremented = typeof sourceBefore?.count === 'number' && typeof sourceAfter?.count === 'number'
              && sourceBefore.count - sourceAfter.count === request.transferCount;
            assertions.push({ id: 'player-source-decrement', status: sourceDecremented ? 'PASS' : 'FAIL', before: sourceBefore?.count ?? null, after: sourceAfter?.count ?? null, expectedDecrease: request.transferCount });
            if (!sourceDecremented) throw new Error('gui-e2e-player-source-decrement-mismatch');
          }
          if (!transferMatches || !transferCountMatches) throw new Error('gui-e2e-menu-bridge-slot-mismatch');
        }
      }

      const image = await gui.screenshot();
      report.screenshot = image;
      const after = await bridge.inspectMachine({ dimension: request.dimension, x: request.x, y: request.y, z: request.z });
      const sameMachine = after.block === before.block && after.blockEntityType === before.blockEntityType;
      assertions.push({ id: 'bridge-before-after-machine-identity', status: sameMachine ? 'PASS' : 'FAIL', before: { block: before.block, blockStateId: before.blockStateId, blockEntityType: before.blockEntityType }, after: { block: after.block, blockStateId: after.blockStateId, blockEntityType: after.blockEntityType } });

      if (request.expectedOutputItem) {
        if (request.inputPlayerSlot === undefined || request.machineInputSlot === undefined || outputBefore === null) {
          assertions.push({ id: 'server-recipe-output-delta', status: 'INCONCLUSIVE', detail: 'A known input transfer and readable output baseline are required to prove a new recipe output.', outputBefore });
          throw new Error('gui-e2e-recipe-prerequisites-unavailable');
        }
        const deadline = Date.now() + request.timeoutMs;
        let output: { item: string | null; count: number } | null = null;
        while (Date.now() < deadline) {
          const latest = await bridge.inspectMachine({ dimension: request.dimension, x: request.x, y: request.y, z: request.z });
          output = itemAt(latest.inventory, request.machineOutputSlot);
          if (outputIncreased(outputBefore, output, request.expectedOutputItem, request.minimumOutputCount)) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const passed = outputIncreased(outputBefore, output, request.expectedOutputItem, request.minimumOutputCount);
        assertions.push({ id: 'server-recipe-output-delta', status: passed ? 'PASS' : 'FAIL', expectedItem: request.expectedOutputItem, minimumIncrease: request.minimumOutputCount, before: outputBefore, after: output });
        if (!passed) throw new Error('gui-e2e-recipe-output-timeout');
      } else {
        assertions.push({ id: 'recipe-execution', status: 'NOT_REQUESTED', detail: 'No expectedOutputItem was supplied; this run validates GUI/menu and live server comparison only.' });
      }

      report.finishedAt = new Date().toISOString();
      report.status = assertions.some((assertion) => assertion.status === 'FAIL') ? 'FAIL' : assertions.some((assertion) => assertion.status === 'INCONCLUSIVE' || assertion.status === 'NOT_REQUESTED') ? 'PARTIAL' : 'PASS';
      await mkdir(gui.config.artifactDirectory, { recursive: true });
      const artifact = path.join(gui.config.artifactDirectory, `e2e-${suffix}-${Date.now()}-${randomUUID()}.json`);
      await writeFile(artifact, JSON.stringify(report, null, 2), { flag: 'wx' });
      report.reportPath = artifact;
      return json(factory, report);
    } catch (error) {
      report.finishedAt = new Date().toISOString();
      report.status = 'FAIL';
      report.error = error instanceof Error ? error.message : 'gui-e2e-failed';
      const artifact = path.join(gui.config.artifactDirectory, `e2e-${suffix}-${Date.now()}-${randomUUID()}.json`);
      try { await mkdir(gui.config.artifactDirectory, { recursive: true }); await writeFile(artifact, JSON.stringify(report, null, 2), { flag: 'wx' }); report.reportPath = artifact; } catch { /* Original failure remains visible. */ }
      return json(factory, report);
    }
  }, { requiresConnection: false });
}
