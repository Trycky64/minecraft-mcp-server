import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  profile?: 'processia-test';
  connectionMode: 'bot' | 'bridge-only' | 'auto';
  bridgeMinecraftVersion: string | null;
}

export function parseConfig(argv: string[] = hideBin(process.argv)): ServerConfig {
  const parsed = yargs(argv)
    .option('host', {
      type: 'string',
      description: 'Explicit Minecraft server host',
    })
    .option('port', {
      type: 'number',
      description: 'Explicit Minecraft server port',
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
    })
    .option('profile', {
      type: 'string',
      choices: ['processia-test'] as const,
      description: 'Apply strict Processia test endpoint safeguards',
    })
    .option('connection-mode', {
      type: 'string',
      choices: ['bot', 'bridge-only', 'auto'] as const,
      description: 'Minecraft connection mode (default preserves the Mineflayer bot behavior)',
      default: process.env.MINECRAFT_MCP_CONNECTION_MODE ?? 'bot',
    })
    .option('bridge-minecraft-version', {
      type: 'string',
      description: 'Expected Minecraft version for bridge-only mode',
      default: process.env.MINECRAFT_MCP_BRIDGE_MINECRAFT_VERSION,
    })
    .help()
    .alias('help', 'h')
    .parseSync();
  const host = parsed.host?.trim();
  const username = parsed.username?.trim();
  const port = parsed.port;
  if (!host || !username || port === undefined) {
    throw new Error('explicit-minecraft-target-required: provide --host, --port, and --username; no connection defaults are used');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('invalid-minecraft-port: --port must be an integer from 1 to 65535');
  }
  if (parsed.profile === 'processia-test' && (host !== '127.0.0.1' || port !== 25665 || username !== 'CodexBot')) {
    throw new Error('processia-test-target-refused: expected --host 127.0.0.1 --port 25665 --username CodexBot');
  }
  const connectionMode = parsed.connectionMode;
  const bridgeMinecraftVersion = parsed.bridgeMinecraftVersion;
  return {
    host,
    port,
    username,
    profile: parsed.profile,
    connectionMode: connectionMode === 'bridge-only' || connectionMode === 'auto' ? connectionMode : 'bot',
    bridgeMinecraftVersion: bridgeMinecraftVersion ?? null,
  };
}

export function shouldAutoFallbackToBridge(input: {
  mode: ServerConfig['connectionMode'];
  botConnected: boolean;
  bridgeEnabled: boolean;
  bridgeConfigurationError: string | null;
  kickReason: string | null;
}): boolean {
  if (input.mode !== 'auto' || input.botConnected || !input.bridgeEnabled || input.bridgeConfigurationError || !input.kickReason) return false;
  // Do not infer that a login-decoder failure means NeoForge: vanilla also
  // produces it for malformed or overlong player names. Only explicit server
  // text requiring a NeoForge client is sufficient to trigger fallback.
  return /neoforge.{0,120}(?:install|client)|(?:install|client).{0,120}neoforge/i.test(input.kickReason);
}
