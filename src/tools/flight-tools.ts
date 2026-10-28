import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import type { RuntimeRegistryContext } from '../services/runtime-registry-service.js';
import { minecraftSessionKey } from '../services/registry-reporting.js';

function createCancellableFlightOperation(
  bot: mineflayer.Bot,
  destination: Vec3,
  controller: AbortController
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let aborted = false;

    controller.signal.addEventListener('abort', () => {
      aborted = true;
      bot.creative.stopFlying();
      reject(new Error("Flight operation cancelled"));
    });

    bot.creative.flyTo(destination)
      .then(() => {
        if (!aborted) {
          resolve(true);
        }
      })
      .catch((err: Error) => {
        if (!aborted) {
          reject(err);
        }
      });
  });
}

export function registerFlightTools(factory: ToolFactory, getBot: () => mineflayer.Bot,
  getRegistryContext: () => RuntimeRegistryContext | null = () => null): void {
  factory.registerTool(
    "fly-to",
    "Make the bot fly to a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const sessionKey = minecraftSessionKey(getRegistryContext());

      // The creative plugin is always loaded; flight movement outside creative mode is illegal movement for the server.
      const gameMode = (bot.game as { gameMode?: unknown } | undefined)?.gameMode;
      if (!bot.creative || gameMode !== 'creative') {
        return factory.createErrorResponse(`Creative mode is not available (game mode: ${typeof gameMode === 'string' && gameMode ? gameMode : 'unknown'}). Cannot fly; no flight movement was sent.`);
      }

      const controller = new AbortController();
      const FLIGHT_TIMEOUT_MS = 20000;

      const timeoutId = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }, FLIGHT_TIMEOUT_MS);

      try {
        const destination = new Vec3(x, y, z);
        await createCancellableFlightOperation(bot, destination, controller);
        if (getBot() !== bot || minecraftSessionKey(getRegistryContext()) !== sessionKey) {
          return factory.createErrorResponse('minecraft-session-changed-during-action: the flight outcome on the previous session is uncertain and was not retried');
        }
        return factory.createResponse(`Successfully flew to position (${x}, ${y}, ${z}).`);
      } catch (error) {
        if (controller.signal.aborted) {
          const currentPosAfterTimeout = bot.entity.position;
          return factory.createErrorResponse(
            `Flight timed out after ${FLIGHT_TIMEOUT_MS / 1000} seconds. The destination may be unreachable. ` +
            `Current position: (${Math.floor(currentPosAfterTimeout.x)}, ${Math.floor(currentPosAfterTimeout.y)}, ${Math.floor(currentPosAfterTimeout.z)})`
          );
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        bot.creative.stopFlying();
      }
    }
  );
}
