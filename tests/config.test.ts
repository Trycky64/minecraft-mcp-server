import test from 'ava';
import sinon from 'sinon';
import { parseConfig, shouldAutoFallbackToBridge } from '../src/config.js';
import { createBridgeAdapter } from '../src/bridge/bridge-adapters.js';
import { normalizeBridgeError } from '../src/bridge/bridge-adapter-contract.js';
import { NeoForgeBridgeClient, readBridgeClientConfig } from '../src/bridge/neoforge-bridge-client.js';

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

test('processia-test profile has no implicit target and still requires an explicit host, port, and username', (t) => {
  t.throws(() => parseConfig(['--profile', 'processia-test']), { message: /explicit-minecraft-target-required/ });
  t.throws(() => parseConfig(['--profile', 'processia-test', '--host', '127.0.0.1', '--username', 'CodexBot']), { message: /explicit-minecraft-target-required/ });
  t.throws(() => parseConfig(['--profile', 'processia-test', '--port', '26001', '--username', 'CodexBot']), { message: /explicit-minecraft-target-required/ });
});

test('processia-test profile refuses the personal port, the historical test port, and non-loopback hosts', (t) => {
  const profile = ['--profile', 'processia-test', '--username', 'CodexBot'];
  t.throws(() => parseConfig([...profile, '--host', '127.0.0.1', '--port', '25565']), { message: /processia-test-target-refused: personal-server-port-forbidden/ });
  t.throws(() => parseConfig([...profile, '--host', '127.0.0.1', '--port', '25665']), { message: /processia-test-target-refused: historical-test-server-port-forbidden/ });
  t.throws(() => parseConfig([...profile, '--host', 'localhost', '--port', '26001']), { message: /processia-test-target-refused: loopback-host-required/ });
  t.throws(() => parseConfig([...profile, '--host', 'example.net', '--port', '26001']), { message: /processia-test-target-refused: loopback-host-required/ });
});

test('processia-test profile keeps an explicit isolated loopback target unchanged', (t) => {
  const config = parseConfig(['--profile', 'processia-test', '--host', '127.0.0.1', '--port', '26001', '--username', 'OtherBot']);
  t.is(config.profile, 'processia-test');
  t.is(config.host, '127.0.0.1');
  t.is(config.port, 26001);
  t.is(config.username, 'OtherBot');
  t.is(config.connectionMode, 'bot');
});

test('profile restrictions do not apply to explicit generic targets', (t) => {
  const config = parseConfig(['--host', 'mc.example.net', '--port', '25565', '--username', 'TestBot']);
  t.is(config.profile, undefined);
  t.is(config.port, 25565);
});

test('the test profile does not enable the Processia bridge adapter implicitly', async (t) => {
  const config = parseConfig(['--profile', 'processia-test', '--host', '127.0.0.1', '--port', '26001', '--username', 'CodexBot']);
  t.is(config.profile, 'processia-test');
  const bridge = readBridgeClientConfig({});
  t.false(bridge.enabled);
  t.is(bridge.secret, null);
  const adapter = createBridgeAdapter(bridge, (bridgeConfig) => new NeoForgeBridgeClient(bridgeConfig));
  t.is(adapter.state, 'disabled');
  const fetchStub = sinon.stub(globalThis, 'fetch').rejects(new Error('network-must-not-be-used'));
  try {
    const handshakeError = await t.throwsAsync(adapter.handshake('1.21.1', '127.0.0.1:26001'));
    t.is(normalizeBridgeError(handshakeError).code, 'bridge-disabled');
    await t.throwsAsync(adapter.inspectMachine({ dimension: 'minecraft:overworld', x: 0, y: 64, z: 0 }));
    t.is(adapter.session, null);
    t.false(fetchStub.called);
  } finally { fetchStub.restore(); }
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
