#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log, logEvent } from './logger.js';
import { normalizeBridgeError } from './bridge/bridge-adapter-contract.js';
import { parseConfig, shouldAutoFallbackToBridge } from './config.js';
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
import { registerWindowTools } from './tools/window-tools.js';
import { createProcessiaMenuLayoutProvider } from './services/processia-menu-layout-provider.js';
import { isExplicitlyModdedMinecraftServer } from './services/minecraft-server-ping.js';
import { PACKAGE_VERSION } from './package-version.js';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  logEvent('error', 'process', 'unhandled-rejection', { code: normalizeBridgeError(reason).code, outcome: 'failure' });
});

process.on('uncaughtException', (error) => {
  logEvent('error', 'process', 'uncaught-exception', { code: normalizeBridgeError(error).code, outcome: 'failure' });
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

  if (config.connectionMode !== 'bridge-only') connection.connect();

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: PACKAGE_VERSION
  });

  const factory = new ToolFactory(server, connection);
  const getBot = () => connection.getBot()!;
  const runtimeRegistry = new RuntimeRegistryService(connection);
  const getRegistryContext = () => runtimeRegistry.getContext();
  const bridge = new NeoForgeBridgeIntegration(runtimeRegistry);
  const guiHarness = new GuiHarnessClient(readGuiClientConfig(), runtimeRegistry);

  if (config.connectionMode === 'bridge-only') {
    try {
      if (!config.bridgeMinecraftVersion) throw new Error('bridge-minecraft-version-required');
      await bridge.connectBridgeOnly(config.bridgeMinecraftVersion);
      log('info', 'Authenticated bridge-only runtime initialized; no Mineflayer client was created.');
    } catch (error) {
      logEvent('error', 'bridge', 'startup', { code: normalizeBridgeError(error).code, outcome: 'failure', connectionMode: 'bridge-only', adapter: bridge.adapter.kind });
    }
  } else if (config.connectionMode === 'auto') {
    const connected = await connection.waitForConnected(5000);
    const kickReason = connection.getLastKickReason() ?? '';
    let moddedStatus = false;
    const adapterState = bridge.adapter.state;
    const bridgeEnabled = adapterState !== 'disabled';
    const bridgeConfigurationError = adapterState === 'unconfigured' ? 'bridge-configuration-invalid' : null;
    const eligibleForBridge = !connected && bridgeEnabled && bridgeConfigurationError === null;
    if (eligibleForBridge && !shouldAutoFallbackToBridge({ mode: config.connectionMode, botConnected: connected, bridgeEnabled,
      bridgeConfigurationError, kickReason })) {
      try { moddedStatus = await isExplicitlyModdedMinecraftServer(config.host, config.port); }
      catch { log('warn', 'Minecraft status ping failed; automatic bridge fallback was not attempted.'); }
    }
    const explicitRejection = shouldAutoFallbackToBridge({ mode: config.connectionMode, botConnected: connected, bridgeEnabled,
      bridgeConfigurationError, kickReason });
    if (eligibleForBridge && (explicitRejection || moddedStatus)) {
      log('warn', 'Server status indicates modded protocol; attempting one authenticated bridge-only fallback.');
      connection.useBridgeOnlyMode();
      try {
        if (!config.bridgeMinecraftVersion) throw new Error('bridge-minecraft-version-required');
        await bridge.connectBridgeOnly(config.bridgeMinecraftVersion);
      } catch (error) {
        logEvent('error', 'bridge', 'fallback', { code: normalizeBridgeError(error).code, outcome: 'failure', connectionMode: 'auto', adapter: bridge.adapter.kind });
      }
    }
  }

  registerPositionTools(factory, getBot);
  registerInventoryTools(factory, getBot, getRegistryContext);
  registerBlockTools(factory, getBot, getRegistryContext);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore, { profile: config.profile });
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot, getRegistryContext);
  registerFurnaceTools(factory, getBot, getRegistryContext);
  registerRegistryTools(factory, runtimeRegistry, bridge);
  registerBridgeTools(factory, bridge, runtimeRegistry);
  registerGuiTools(factory, guiHarness, bridge, runtimeRegistry);
  // Processia's layout contracts are an opt-in extension; generic and vanilla
  // operation does not depend on them or on the mod being installed server-side.
  registerWindowTools(factory, getBot, getRegistryContext, [createProcessiaMenuLayoutProvider()]);

  process.stdin.on('end', () => {
    void Promise.allSettled([bridge.close(), guiHarness.shutdown()]).finally(() => {
      void connection.cleanup().finally(() => {
        log('info', 'MCP Client has disconnected. Shutting down...');
        process.exit(0);
      });
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logEvent('error', 'process', 'main-failed', { code: normalizeBridgeError(error).code, outcome: 'failure' });
  process.exit(1);
});
