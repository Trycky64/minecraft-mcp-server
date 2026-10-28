import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

export function registerGameStateTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "detect-gamemode",
    "Detect the gamemode on game",
    {},
    async () => {
      const bot = getBot();
      const gameMode = (bot.game as { gameMode?: unknown } | undefined)?.gameMode;
      if (typeof gameMode !== 'string' || gameMode.length === 0) {
        return factory.createResponse('Bot gamemode: unknown (no game mode has been reported to this session)');
      }
      return factory.createResponse(`Bot gamemode: "${gameMode}"`);
    }
  );
}
