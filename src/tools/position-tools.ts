import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import type { RuntimeRegistryContext } from '../services/runtime-registry-service.js';
import { minecraftSessionKey } from '../services/registry-reporting.js';

type Direction = 'forward' | 'back' | 'left' | 'right';
const MAX_MOVE_DISTANCE = 64;
const DEFAULT_MOVE_TIMEOUT_MS = 15_000;
const MAX_MOVE_TIMEOUT_MS = 30_000;
const MAX_DIRECTION_MOVE_MS = 5_000;

export function registerPositionTools(factory: ToolFactory, getBot: () => mineflayer.Bot,
  getRegistryContext: () => RuntimeRegistryContext | null = () => null): void {
  factory.registerTool(
    "get-position",
    "Get the current position of the bot",
    {},
    async () => {
      const bot = getBot();
      const position = bot.entity.position;
      const pos = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
      };
      return factory.createResponse(`Current position: (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "move-to-position",
    "Move the bot to a nearby position with a bounded path and timeout",
    {
      x: z.coerce.number().finite().min(-30_000_000).max(30_000_000).describe("X coordinate"),
      y: z.coerce.number().finite().min(-2048).max(2048).describe("Y coordinate"),
      z: z.coerce.number().finite().min(-30_000_000).max(30_000_000).describe("Z coordinate"),
      range: z.coerce.number().finite().min(0).max(8).optional().describe("How close to get to the target (default: 1, max: 8)"),
      timeoutMs: z.number().int().min(50).max(MAX_MOVE_TIMEOUT_MS).optional().describe("Timeout in milliseconds (default: 15000, max: 30000)"),
      registryEpoch: z.string().min(1).max(200).optional().describe('Optional registry epoch from the observation this move relies on; a different current epoch is refused'),
    },
    async ({ x, y, z, range = 1, timeoutMs = DEFAULT_MOVE_TIMEOUT_MS, registryEpoch }: { x: number; y: number; z: number; range?: number; timeoutMs?: number; registryEpoch?: string }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const context = getRegistryContext();
      if (registryEpoch !== undefined && context?.registryEpoch !== registryEpoch) {
        return factory.createErrorResponse('stale-registry-epoch: re-observe the target in the current session before moving');
      }
      const sessionKey = minecraftSessionKey(context);
      if (bot.entity?.position && bot.entity.position.distanceTo(new Vec3(x, y, z)) > MAX_MOVE_DISTANCE) {
        return factory.createErrorResponse(`Move target is too far; maximum path distance is ${MAX_MOVE_DISTANCE} blocks`);
      }
      const goal = new goals.GoalNear(x, y, z, range);
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let timeoutPromise: Promise<never> | null = null;
      let timedOut = false;

      timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(`move-timeout-result-uncertain: pathfinder stop requested after ${timeoutMs}ms; inspect the current position before retrying`));
        }, timeoutMs);
      });

      const gotoPromise = bot.pathfinder.goto(goal);

      try {
        await Promise.race([gotoPromise, timeoutPromise]);
        // Movement does not depend on modded registries, but a new player session makes the old bot's position meaningless.
        if (getBot() !== bot || minecraftSessionKey(getRegistryContext()) !== sessionKey) {
          return factory.createErrorResponse('minecraft-session-changed-during-action: the movement outcome on the previous session is uncertain and was not retried');
        }
        const position = bot.entity?.position;
        return factory.createResponse(JSON.stringify({ status: 'movement-observed-client-side', actionRequested: true, actionSent: true,
          target: { x, y, z }, currentPosition: position ? { x: position.x, y: position.y, z: position.z } : null,
          pathfinderCompleted: true, serverConfirmed: false,
          note: 'Mineflayer pathfinder completed and the player position was read from the client entity state.' }));
      } catch (error) {
        if (timedOut) {
          throw new Error(`move-timeout-result-uncertain: pathfinder stop requested after ${timeoutMs}ms; inspect the current position before retrying`);
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (timedOut) {
          bot.pathfinder.stop();
          gotoPromise.catch(() => {});
        }
      }
    }
  );

  factory.registerTool(
    "look-at",
    "Make the bot look at a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      if (bot.entity?.position && bot.entity.position.distanceTo(new Vec3(x, y, z)) > MAX_MOVE_DISTANCE) {
        return factory.createErrorResponse(`Look target is too far; maximum distance is ${MAX_MOVE_DISTANCE} blocks`);
      }
      await bot.lookAt(new Vec3(x, y, z), true);
      return factory.createResponse(`Looking at position (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "jump",
    "Make the bot jump",
    {},
    async () => {
      const bot = getBot();
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
      return factory.createResponse("Jump requested (jump control held for 250 ms); the resulting movement is not confirmed");
    }
  );

  factory.registerTool(
    "move-in-direction",
    "Move the bot in a specific direction for a duration",
    {
      direction: z.enum(['forward', 'back', 'left', 'right']).describe("Direction to move"),
      duration: z.number().int().min(50).max(MAX_DIRECTION_MOVE_MS).optional().describe("Duration in milliseconds (default: 1000, max: 5000)")
    },
    async ({ direction, duration = 1000 }: { direction: Direction, duration?: number }) => {
      const bot = getBot();
      bot.setControlState(direction, true);
      try {
        await new Promise(resolve => setTimeout(resolve, duration));
      } finally {
        bot.setControlState(direction, false);
      }
      return factory.createResponse(`Moved ${direction} for ${duration}ms (control state held; the resulting position is not confirmed)`);
    }
  );
}
