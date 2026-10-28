import { z } from "zod";
import mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import type { RuntimeRegistryContext } from '../services/runtime-registry-service.js';
import {
  isUnsafeItemNameStatus, itemMatchesRequest, mineflayerItemNameStatus, resolveItemType, runtimeBlockStateConflict, runtimeContextKey,
} from '../services/registry-reporting.js';

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);
const CONTEXT_CHANGED = 'runtime-context-changed-before-action: the Minecraft session, bridge session or registry generation changed; re-inspect the furnace';

function runtimeName(item: { type: number }, context: RuntimeRegistryContext | null): string | null {
  const resolution = resolveItemType(item.type, context);
  return resolution?.status === 'resolved' && resolution.provenance.source !== 'minecraft-data' ? resolution.entry.namespacedId : null;
}

export function registerFurnaceTools(factory: ToolFactory, getBot: () => mineflayer.Bot,
  getRegistryContext: () => RuntimeRegistryContext | null = () => null): void {
  factory.registerTool(
    "smelt-item",
    "Smelt items using a furnace-like block",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      inputItem: z.string().trim().min(1).describe("Name of item to smelt"),
      inputCount: z.number().int().min(1).max(64).optional().describe("Amount of input to smelt (default: 1, maximum: 64)"),
      fuelItem: z.string().trim().min(1).describe("Name of fuel item"),
      fuelCount: z.number().int().min(1).max(64).optional().describe("Amount of fuel to use (default: 1, maximum: 64)"),
      takeOutput: z.boolean().optional().describe("Whether to take output when ready (default: true)"),
      timeoutMs: z.number().int().min(100).max(120_000).optional().describe("Timeout waiting for output in ms (default: 60000, maximum: 120000)"),
      registryEpoch: z.string().min(1).max(200).optional().describe('Optional registry epoch from the observation this action relies on; a different current epoch is refused'),
    },
    async ({
      x,
      y,
      z,
      inputItem,
      inputCount = 1,
      fuelItem,
      fuelCount = 1,
      takeOutput = true,
      timeoutMs = 60000,
      registryEpoch,
    }: {
      x: number;
      y: number;
      z: number;
      inputItem: string;
      inputCount?: number;
      fuelItem: string;
      fuelCount?: number;
      takeOutput?: boolean;
      timeoutMs?: number;
      registryEpoch?: string;
    }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const context = getRegistryContext();
      const startContextKey = runtimeContextKey(context);
      if (registryEpoch !== undefined && context?.registryEpoch !== registryEpoch) {
        return factory.createErrorResponse('stale-registry-epoch: re-inspect the furnace and inventory in the current session');
      }
      const contextChanged = () => getBot() !== bot || runtimeContextKey(getRegistryContext()) !== startContextKey;

      const furnacePos = new Vec3(x, y, z);
      const furnaceBlock = bot.blockAt(furnacePos);

      if (!furnaceBlock || !FURNACE_BLOCKS.has(furnaceBlock.name)) {
        return factory.createResponse(`No furnace block found at (${x}, ${y}, ${z})`);
      }
      const furnaceConflict = runtimeBlockStateConflict(furnaceBlock, context);
      if (furnaceConflict) {
        return factory.createErrorResponse(`Cannot safely use the block at (${x}, ${y}, ${z}) as a furnace: ${furnaceConflict}; it was not opened`);
      }

      // Static names the runtime registry contradicts are never matched.
      const items = bot.inventory.items();
      const input = items.find((item) => itemMatchesRequest(item, inputItem, context));
      if (!input) {
        return factory.createResponse(`Couldn't find any item matching '${inputItem}' in inventory`);
      }

      const fuel = items.find((item) => itemMatchesRequest(item, fuelItem, context));
      if (!fuel) {
        return factory.createResponse(`Couldn't find any fuel item matching '${fuelItem}' in inventory`);
      }

      const resolvedInputCount = Math.min(inputCount, input.count);
      const resolvedFuelCount = Math.min(fuelCount, fuel.count);

      const furnace = await bot.openFurnace(furnaceBlock);
      const cleanup = () => {
        try {
          furnace.close();
        } catch {
          // ignore
        }
      };

      // Re-validated after every await, immediately before each slot action.
      const stopped = (fuelInserted: boolean, inputInserted: boolean) => factory.createErrorResponse(JSON.stringify({
        status: 'smelt-stopped-before-action', actionSent: fuelInserted || inputInserted, fuelInserted, inputInserted,
        serverConfirmed: false, recoveryRequired: fuelInserted || inputInserted, reason: CONTEXT_CHANGED,
        note: 'No further furnace action was sent and nothing is retried; re-inspect the furnace slots before any new request.',
      }));

      try {
        // Numeric types, not Mineflayer names: distinct modded items can share the name 'unknown'.
        const existingInput = furnace.inputItem();
        if (existingInput && existingInput.type !== input.type) {
          return factory.createResponse(`Furnace input slot is occupied by ${existingInput.name}`);
        }

        const existingFuel = furnace.fuelItem();
        if (existingFuel && existingFuel.type !== fuel.type) {
          return factory.createResponse(`Furnace fuel slot is occupied by ${existingFuel.name}`);
        }

        if (contextChanged()) return stopped(false, false);
        await furnace.putFuel(fuel.type, fuel.metadata ?? null, resolvedFuelCount);
        if (contextChanged()) return stopped(true, false);
        await furnace.putInput(input.type, input.metadata ?? null, resolvedInputCount);

        if (!takeOutput) {
          return factory.createResponse(
            `Smelt request sent for ${resolvedInputCount} ${input.name} with ${resolvedFuelCount} ${fuel.name}; completion is not confirmed`
          );
        }

        const output = await waitForOutput(furnace, timeoutMs);
        if (!output) {
          return factory.createResponse(JSON.stringify({
            status: 'uncertain',
            actionRequested: true,
            actionSent: true,
            clientObserved: false,
            serverConfirmed: false,
            input: { name: input.name, count: resolvedInputCount },
            fuel: { name: fuel.name, count: resolvedFuelCount },
            timeoutMs,
            recoveryRequired: true,
            note: 'No furnace output was observed before timeout. The furnace may still be processing; do not repeat the input or fuel action before re-inspecting its slots and state.',
          }));
        }

        if (contextChanged()) return stopped(true, true);
        const outputStatus = mineflayerItemNameStatus(output, getRegistryContext());
        if (isUnsafeItemNameStatus(outputStatus)) {
          return factory.createErrorResponse(JSON.stringify({
            status: 'output-identity-unverified-not-taken', actionSent: true, serverConfirmed: false, recoveryRequired: true,
            output: { mineflayerName: output.name, rawNumericId: output.type, count: output.count,
              namespacedId: runtimeName(output, getRegistryContext()), mineflayerNameStatus: outputStatus },
            note: 'The runtime registry contradicts or cannot confirm the output identity, so it was left in the furnace.',
          }));
        }

        const taken = await furnace.takeOutput();
        return factory.createResponse(JSON.stringify({
          status: 'output-observed-client-side',
          actionRequested: true,
          actionSent: true,
          clientObservedOutput: { count: taken.count, name: taken.name, rawNumericId: taken.type,
            namespacedId: runtimeName(taken, getRegistryContext()), mineflayerNameStatus: mineflayerItemNameStatus(taken, getRegistryContext()) },
          serverConfirmed: false,
          note: 'The furnace output was observed and taken through Mineflayer; there was no independent server-side inventory confirmation.',
        }));
      } finally {
        cleanup();
      }
    }
  );
}

async function waitForOutput(furnace: mineflayer.Furnace, timeoutMs: number): Promise<Item | null> {
  const existing = furnace.outputItem();
  if (existing) {
    return existing;
  }

  return new Promise((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const onUpdate = () => {
      const output = furnace.outputItem();
      if (output) {
        cleanup();
        resolve(output);
      }
    };

    const cleanup = () => {
      furnace.removeListener('update', onUpdate);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    furnace.on('update', onUpdate);

    timeoutId = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}
