import minecraftProtocol, { type NewPingResult, type PingOptions } from 'minecraft-protocol';

export type MinecraftStatusPing = (options: PingOptions) => Promise<NewPingResult | { isModded?: boolean }>;

/**
 * Detects the modded marker advertised by the Minecraft status ping. This is
 * only a routing hint: callers must still authenticate and validate the
 * NeoForge bridge identity before using any bridge data.
 */
export async function isExplicitlyModdedMinecraftServer(
  host: string,
  port: number,
  pingServer: MinecraftStatusPing = minecraftProtocol.ping as MinecraftStatusPing,
): Promise<boolean> {
  const response = await pingServer({ host, port, closeTimeout: 1_500, noPongTimeout: 1_000 });
  return 'isModded' in response && response.isModded === true;
}
