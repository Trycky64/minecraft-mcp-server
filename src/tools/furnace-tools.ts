import { z } from "zod";
import mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);

export function registerFurnaceTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
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
      timeoutMs: z.number().int().min(100).max(120_000).optional().describe("Timeout waiting for output in ms (default: 60000, maximum: 120000)")
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
      timeoutMs = 60000
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
    }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();

      const furnacePos = new Vec3(x, y, z);
      const furnaceBlock = bot.blockAt(furnacePos);

      if (!furnaceBlock || !FURNACE_BLOCKS.has(furnaceBlock.name)) {
        return factory.createResponse(`No furnace block found at (${x}, ${y}, ${z})`);
      }

      const items = bot.inventory.items();
      const input = items.find((item) => item.name.includes(inputItem.toLowerCase()));
      if (!input) {
        return factory.createResponse(`Couldn't find any item matching '${inputItem}' in inventory`);
      }

      const fuel = items.find((item) => item.name.includes(fuelItem.toLowerCase()));
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

      try {
        const existingInput = furnace.inputItem();
        if (existingInput && existingInput.name !== input.name) {
          return factory.createResponse(`Furnace input slot is occupied by ${existingInput.name}`);
        }

        const existingFuel = furnace.fuelItem();
        if (existingFuel && existingFuel.name !== fuel.name) {
          return factory.createResponse(`Furnace fuel slot is occupied by ${existingFuel.name}`);
        }

        await furnace.putFuel(fuel.type, fuel.metadata ?? null, resolvedFuelCount);
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

        const taken = await furnace.takeOutput();
        return factory.createResponse(JSON.stringify({
          status: 'output-observed-client-side',
          actionRequested: true,
          actionSent: true,
          clientObservedOutput: { count: taken.count, name: taken.name },
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
