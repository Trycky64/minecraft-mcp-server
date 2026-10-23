import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { monitorProtocolDecode, type ProtocolClientLike } from './services/protocol-decode-monitor.js';

type ConnectionState = 'connected' | 'connecting' | 'disconnected';

interface BotConfig {
  host: string;
  port: number;
  username: string;
  profile?: 'processia-test';
  connectionMode?: 'bot' | 'bridge-only' | 'auto';
}

interface ConnectionCallbacks {
  onLog: (level: string, message: string) => void;
  onChatMessage: (username: string, message: string) => void;
}

export class BotConnection {
  private bot: mineflayer.Bot | null = null;
  private state: ConnectionState = 'disconnected';
  private config: BotConfig;
  private callbacks: ConnectionCallbacks;
  private isReconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs: number;
  private lastKickReason: string | null = null;

  constructor(config: BotConfig, callbacks: ConnectionCallbacks, reconnectDelayMs = 2000) {
    const host = typeof config.host === 'string' ? config.host.trim() : '';
    const username = typeof config.username === 'string' ? config.username.trim() : '';
    if (!host || !username || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error('explicit-minecraft-target-required: host, port, and username must be configured');
    }
    if (config.profile === 'processia-test' && (host !== '127.0.0.1' || config.port !== 25665 || username !== 'CodexBot')) {
      throw new Error('processia-test-target-refused: expected 127.0.0.1:25665 as CodexBot');
    }
    this.config = { ...config, host, username };
    this.callbacks = callbacks;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  getBot(): mineflayer.Bot | null {
    return this.bot;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getConfig(): BotConfig {
    return { ...this.config };
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  getConnectionMode(): 'bot' | 'bridge-only' | 'auto' {
    return this.config.connectionMode ?? 'bot';
  }

  getLastKickReason(): string | null { return this.lastKickReason; }

  useBridgeOnlyMode(): void {
    this.config.connectionMode = 'bridge-only';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const bot = this.bot;
    this.bot = null;
    this.state = 'disconnected';
    if (bot) {
      bot.removeAllListeners();
      try { bot.quit('Switching to authenticated bridge-only mode'); } catch { /* Connection is already closing. */ }
    }
  }

  async waitForConnected(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isConnected()) return true;
      if (this.state === 'disconnected') return false;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return this.isConnected();
  }

  connect(): void {
    if (this.getConnectionMode() === 'bridge-only') return;
    const botOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      // minecraft-protocol otherwise logs parser stacks and, on trailing bytes,
      // decoded packet contents plus the complete packet hex to stdout.
      // Decode monitoring and BotConnection's stable error logger remain active.
      hideErrors: true,
      plugins: { pathfinder },
    };

    this.bot = mineflayer.createBot(botOptions);
    monitorProtocolDecode(this.bot._client as unknown as ProtocolClientLike);
    this.state = 'connecting';
    this.isReconnecting = false;

    this.registerEventHandlers(this.bot);
  }

  private registerEventHandlers(bot: mineflayer.Bot): void {
    bot.once('spawn', async () => {
      this.state = 'connected';
      this.lastKickReason = null;
      this.callbacks.onLog('info', 'Bot spawned in world');

      const mcData = minecraftData(bot.version);
      const defaultMove = new Movements(bot, mcData);
      bot.pathfinder.setMovements(defaultMove);

      this.callbacks.onLog('info', `Bot connected successfully. Username: ${this.config.username}, Server: ${this.config.host}:${this.config.port}`);
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.callbacks.onChatMessage(username, message);
    });

    bot.on('kicked', (reason) => {
      this.lastKickReason = this.formatError(reason);
      this.callbacks.onLog('error', 'Bot was kicked from the Minecraft server.');
      this.state = 'disconnected';
      bot.quit();
    });

    bot.on('error', (err) => {
      const errorCode = (err as { code?: string }).code || 'Unknown error';

      // Protocol/socket error text can contain server-controlled content. Keep only
      // the stable transport code needed by local diagnostics.
      const safeCode = /^[A-Z0-9_]{1,32}$/.test(errorCode) ? errorCode : 'MINECRAFT_ERROR';
      this.callbacks.onLog('error', `Bot connection error [${safeCode}]`);

      if (errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT') {
        this.state = 'disconnected';
      }
    });

    bot.on('login', () => {
      this.callbacks.onLog('info', 'Bot logged in successfully');
    });

    bot.on('end', () => {
      this.callbacks.onLog('info', 'Bot disconnected.');

      if (this.state === 'connected') {
        this.state = 'disconnected';
      }

      if (this.bot === bot) {
        try {
          bot.removeAllListeners();
          this.bot = null;
          this.callbacks.onLog('info', 'Bot instance cleaned up after disconnect');
        } catch {
          this.callbacks.onLog('warn', 'Bot cleanup after disconnect failed.');
        }
      }
    });
  }

  attemptReconnect(): void {
    if (this.isReconnecting || this.state === 'connecting') {
      return;
    }

    this.isReconnecting = true;
    this.state = 'connecting';
    this.callbacks.onLog('info', `Attempting to reconnect to Minecraft server in ${this.reconnectDelayMs}ms...`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      if (this.bot) {
        try {
          this.bot.removeAllListeners();
          this.bot.quit('Reconnecting...');
          this.callbacks.onLog('info', 'Old bot instance cleaned up');
        } catch {
          this.callbacks.onLog('warn', 'Old bot cleanup before reconnect failed.');
        }
      }

      this.callbacks.onLog('info', 'Creating new bot instance...');
      this.connect();
    }, this.reconnectDelayMs);
  }

  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    if (this.getConnectionMode() === 'bridge-only') {
      return { connected: false, message: 'bot-required: this tool requires a connected Minecraft player; the active mode is bridge-only.' };
    }
    const currentState = this.state;

    if (currentState === 'disconnected') {
      this.attemptReconnect();

      const maxWaitTime = this.reconnectDelayMs + 5000;
      const pollInterval = 100;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        if (this.state === 'connected') {
          return { connected: true };
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      const errorMessage =
        `Cannot connect to Minecraft server at ${this.config.host}:${this.config.port}\n\n` +
        `Please ensure:\n` +
        `1. Minecraft server is running on ${this.config.host}:${this.config.port}\n` +
        `2. Server is accessible from this machine\n` +
        `3. Server version is supported by the installed Mineflayer and minecraft-data versions\n\n` +
        `For setup instructions, visit: https://github.com/yuniko-software/minecraft-mcp-server`;

      return { connected: false, message: errorMessage };
    }

    if (currentState === 'connecting') {
      return { connected: false, message: 'Bot is connecting to the Minecraft server. Please wait a moment and try again.' };
    }

    return { connected: true };
  }

  async cleanup(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const bot = this.bot;
    if (!bot) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        bot.removeListener('end', finish);
        resolve();
      };
      const timeout = setTimeout(finish, 1_000);
      bot.once('end', finish);
      try {
        bot.quit('Server shutting down');
      } catch {
        this.callbacks.onLog('warn', 'Bot cleanup failed; bounded shutdown continued.');
        finish();
      }
    });
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
