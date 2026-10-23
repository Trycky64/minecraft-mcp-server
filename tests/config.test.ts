import test from 'ava';
import { parseConfig, shouldAutoFallbackToBridge } from '../src/config.js';

const target = ['--host', 'example.net', '--port', '25566', '--username', 'TestBot'];

test('parseConfig rejects missing and incomplete Minecraft targets instead of applying defaults', (t) => {
  t.throws(() => parseConfig([]), { message: /explicit-minecraft-target-required/ });
  t.throws(() => parseConfig(['--host', '127.0.0.1']), { message: /explicit-minecraft-target-required/ });
  t.throws(() => parseConfig(['--port', '25665', '--username', 'CodexBot']), { message: /explicit-minecraft-target-required/ });
});

test('parseConfig parses an explicit generic target without substituting a port', (t) => {
  const config = parseConfig(target);
  t.is(config.host, 'example.net');
  t.is(config.port, 25566);
  t.is(config.username, 'TestBot');
  t.is(config.profile, undefined);
});

test('parseConfig preserves individually supplied target fields when all required fields are explicit', (t) => {
  const hostConfig = parseConfig(['--host', 'example.org', '--port', '25577', '--username', 'TestBot']);
  t.is(hostConfig.host, 'example.org');
  const portConfig = parseConfig(['--host', 'localhost', '--port', '12345', '--username', 'TestBot']);
  t.is(portConfig.port, 12345);
  const usernameConfig = parseConfig(['--host', 'localhost', '--port', '25566', '--username', 'CustomBot']);
  t.is(usernameConfig.username, 'CustomBot');
});

test('parseConfig accepts explicit bridge-only mode and expected Minecraft version', (t) => {
  const config = parseConfig(['--host', '127.0.0.1', '--port', '25677', '--username', 'BridgeClient', '--connection-mode', 'bridge-only', '--bridge-minecraft-version', '1.21.1']);
  t.is(config.connectionMode, 'bridge-only');
  t.is(config.bridgeMinecraftVersion, '1.21.1');
  t.is(typeof config.port, 'number');
});

test('processia-test profile pins loopback endpoint and identity and refuses port 25565', (t) => {
  const config = parseConfig(['--profile', 'processia-test', '--host', '127.0.0.1', '--port', '25665', '--username', 'CodexBot']);
  t.is(config.profile, 'processia-test');
  t.throws(() => parseConfig(['--profile', 'processia-test', '--host', '127.0.0.1', '--port', '25565', '--username', 'CodexBot']), { message: /processia-test-target-refused/ });
  t.throws(() => parseConfig(['--profile', 'processia-test', '--host', 'localhost', '--port', '25665', '--username', 'CodexBot']), { message: /processia-test-target-refused/ });
  t.throws(() => parseConfig(['--profile', 'processia-test', '--host', '127.0.0.1', '--port', '25665', '--username', 'OtherBot']), { message: /processia-test-target-refused/ });
});

test('parseConfig refuses invalid ports', (t) => {
  t.throws(() => parseConfig(['--host', '127.0.0.1', '--port', '65536', '--username', 'Bot']), { message: /invalid-minecraft-port/ });
  t.throws(() => parseConfig(['--host', '127.0.0.1', '--port', '2.5', '--username', 'Bot']), { message: /invalid-minecraft-port/ });
});

test('auto bridge fallback still requires an explicit eligible NeoForge rejection', (t) => {
  const base = { mode: 'auto' as const, botConnected: false, bridgeEnabled: true, bridgeConfigurationError: null,
    kickReason: 'You are trying to connect to a server that is running NeoForge, but you are not. Please install NeoForge Version: 21.1.259.' };
  t.true(shouldAutoFallbackToBridge(base));
  t.false(shouldAutoFallbackToBridge({ ...base, bridgeConfigurationError: 'bridge-secret-invalid' }));
  t.false(shouldAutoFallbackToBridge({ ...base, bridgeEnabled: false }));
  t.false(shouldAutoFallbackToBridge({ ...base, kickReason: 'Connection refused' }));
  t.false(shouldAutoFallbackToBridge({ ...base, botConnected: true }));
  t.false(shouldAutoFallbackToBridge({ ...base, mode: 'bot' }));
});
