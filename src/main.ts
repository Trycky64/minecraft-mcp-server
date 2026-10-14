#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { registerChatTools } from './tools/chat-tools.js';
import { registerFlightTools } from './tools/flight-tools.js';
import { registerGameStateTools } from './tools/gamestate-tools.js';
import { registerCraftingTools } from './tools/crafting-tools.js';
import { registerFurnaceTools } from './tools/furnace-tools.js';
import { RuntimeRegistryService } from './services/runtime-registry-service.js';
import { registerRegistryTools } from './tools/registry-tools.js';
import { NeoForgeBridgeIntegration } from './bridge/neoforge-bridge-client.js';
import { registerBridgeTools } from './tools/bridge-tools.js';
import { GuiHarnessClient, readGuiClientConfig } from './gui/gui-harness-client.js';
import { registerGuiTools } from './tools/gui-tools.js';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

async function main() {
  const config = parseConfig();
  const messageStore = new MessageStore();

  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: (username, message) => messageStore.addMessage(username, message)
    }
  );

  connection.connect();

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.0.4"
  });

  const factory = new ToolFactory(server, connection);
  const getBot = () => connection.getBot()!;
  const runtimeRegistry = new RuntimeRegistryService(connection);
  const getRegistryContext = () => runtimeRegistry.getContext();
  const bridge = new NeoForgeBridgeIntegration(runtimeRegistry);
  const guiHarness = new GuiHarnessClient(readGuiClientConfig(), runtimeRegistry);

  registerPositionTools(factory, getBot);
  registerInventoryTools(factory, getBot, getRegistryContext);
  registerBlockTools(factory, getBot, getRegistryContext);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore);
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  registerRegistryTools(factory, runtimeRegistry, bridge);
  registerBridgeTools(factory, bridge);
  registerGuiTools(factory, guiHarness, bridge, runtimeRegistry);

  process.stdin.on('end', () => {
    void Promise.allSettled([bridge.close(), guiHarness.shutdown()]).finally(() => {
      connection.cleanup();
      log('info', 'MCP Client has disconnected. Shutting down...');
      process.exit(0);
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
