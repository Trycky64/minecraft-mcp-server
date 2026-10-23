import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { MessageStore } from '../message-store.js';

const MAX_CHAT_MESSAGE_LENGTH = 256;

export function registerChatTools(factory: ToolFactory, getBot: () => mineflayer.Bot, messageStore: MessageStore, options: { profile?: 'processia-test' } = {}): void {
  factory.registerTool(
    "send-chat",
    "Send a chat message in-game",
    {
      message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_LENGTH).describe(`Message to send in chat (1-${MAX_CHAT_MESSAGE_LENGTH} characters)`)
    },
    async ({ message }) => {
      if (options.profile === 'processia-test' && message.startsWith('/')) {
        return factory.createErrorResponse('processia-test-command-chat-refused: slash commands are not allowed');
      }
      const bot = getBot();
      bot.chat(message);
      return factory.createResponse(JSON.stringify({ status: 'chat-send-requested', actionSent: true, serverConfirmed: false, message }));
    }
  );

  factory.registerTool(
    "read-chat",
    "Get recent chat messages from players",
    {
      count: z.number().optional().describe("Number of recent messages to retrieve (default: 10, max: 100)")
    },
    async ({ count = 10 }) => {
      const maxCount = Math.min(count, messageStore.getMaxMessages());
      const messages = messageStore.getRecentMessages(maxCount);

      if (messages.length === 0) {
        return factory.createResponse("No chat messages found");
      }

      let output = `Found ${messages.length} chat message(s):\n\n`;
      messages.forEach((msg, index) => {
        const timestamp = new Date(msg.timestamp).toISOString();
        output += `${index + 1}. ${timestamp} - ${msg.username}: ${msg.content}\n`;
      });

      return factory.createResponse(output);
    }
  );
}
