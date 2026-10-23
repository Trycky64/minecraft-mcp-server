import test from 'ava';
import { isExplicitlyModdedMinecraftServer } from '../src/services/minecraft-server-ping.js';

test('modded server status is only a hint and uses a bounded loopback caller timeout', async (t) => {
  let seen: unknown;
  const modded = await isExplicitlyModdedMinecraftServer('127.0.0.1', 25665, async (options) => {
    seen = options;
    return { isModded: true };
  });
  t.true(modded);
  t.deepEqual(seen, { host: '127.0.0.1', port: 25665, closeTimeout: 1500, noPongTimeout: 1000 });
});

test('vanilla status ping does not authorize bridge fallback', async (t) => {
  t.false(await isExplicitlyModdedMinecraftServer('127.0.0.1', 25665, async () => ({
    description: 'A Minecraft Server', players: { max: 20, online: 0 }, version: { name: '1.21.1', protocol: 767 }, latency: 1,
  })));
  t.false(await isExplicitlyModdedMinecraftServer('127.0.0.1', 25665, async () => ({ isModded: false })));
});

test('malformed status ping fails instead of authorizing bridge fallback', async (t) => {
  await t.throwsAsync(isExplicitlyModdedMinecraftServer('127.0.0.1', 25665, async () => { throw new Error('status-unavailable'); }), { message: 'status-unavailable' });
});
