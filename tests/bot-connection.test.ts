import test from 'ava';
import sinon from 'sinon';
import { BotConnection } from '../src/bot-connection.js';
import mineflayer from 'mineflayer';
import { EventEmitter } from 'node:events';
import { getProtocolDecodeStatus } from '../src/services/protocol-decode-monitor.js';

test('constructor initializes with correct state', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getState(), 'disconnected');
  t.deepEqual(connection.getConfig(), config);
  t.is(connection.getBot(), null);
  t.false(connection.isConnected());
});

test('connection rejects missing or unsafe test-profile targets and protects the validated target from caller mutation', (t) => {
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  t.throws(() => new BotConnection({ host: '', port: 26001, username: 'CodexBot' }, callbacks), { message: /explicit-minecraft-target-required/ });
  t.throws(() => new BotConnection({ host: '127.0.0.1', port: 25565, username: 'CodexBot', profile: 'processia-test' }, callbacks), { message: /processia-test-target-refused: personal-server-port-forbidden/ });
  t.throws(() => new BotConnection({ host: '127.0.0.1', port: 25665, username: 'CodexBot', profile: 'processia-test' }, callbacks), { message: /processia-test-target-refused: historical-test-server-port-forbidden/ });
  t.throws(() => new BotConnection({ host: 'localhost', port: 26001, username: 'CodexBot', profile: 'processia-test' }, callbacks), { message: /processia-test-target-refused: loopback-host-required/ });
  const connection = new BotConnection({ host: '127.0.0.1', port: 26001, username: 'CodexBot', profile: 'processia-test' }, callbacks);
  const returned = connection.getConfig();
  returned.port = 25565;
  t.is(connection.getConfig().port, 26001);
  t.is(connection.getConfig().host, '127.0.0.1');
  t.is(connection.getConfig().username, 'CodexBot');
});

test('automatic bridge fallback can change mode without mutating the validated connection target', (t) => {
  const connection = new BotConnection({ host: '127.0.0.1', port: 25665, username: 'CodexBot', connectionMode: 'auto' },
    { onLog: sinon.stub(), onChatMessage: sinon.stub() });
  connection.useBridgeOnlyMode();
  t.is(connection.getConnectionMode(), 'bridge-only');
  t.deepEqual(connection.getConfig(), { host: '127.0.0.1', port: 25665, username: 'CodexBot', connectionMode: 'bridge-only' });
});

test('connection installs protocol decode monitoring on each new bot', (t) => {
  const client = Object.assign(new EventEmitter(), {
    state: 'play', version: '1.21.1',
    deserializer: { parsePacketBuffer() { throw Object.assign(new Error('Malformed inventory packet'), { name: 'PartialReadError' }); } },
    setSerializer() { this.deserializer = { parsePacketBuffer() { return {}; } }; },
  });
  const bot = Object.assign(new EventEmitter(), { _client: client }) as unknown as mineflayer.Bot;
  const createBot = sinon.stub(mineflayer, 'createBot').returns(bot);
  try {
    const connection = new BotConnection(
      { host: '127.0.0.1', port: 25565, username: 'TestBot' },
      { onLog: sinon.stub(), onChatMessage: sinon.stub() },
    );
    connection.connect();
    t.throws(() => client.deserializer.parsePacketBuffer(Buffer.from([0x13])), { name: 'PartialReadError' });
    const status = getProtocolDecodeStatus(client);
    t.is(status.inventory, 'incomplete');
    t.is(status.issues[0]?.packetName, 'window_items');
  } finally {
    createBot.restore();
  }
});

test('every bot creation, including reconnect creation, uses the validated explicit target', (t) => {
  const client = Object.assign(new EventEmitter(), { state: 'play', version: '1.21.1', deserializer: { parsePacketBuffer() { return {}; } }, setSerializer() {} });
  const bot = Object.assign(new EventEmitter(), { _client: client });
  const createBot = sinon.stub(mineflayer, 'createBot').returns(bot as unknown as mineflayer.Bot);
  try {
    const connection = new BotConnection({ host: '127.0.0.1', port: 26001, username: 'CodexBot', profile: 'processia-test' },
      { onLog: sinon.stub(), onChatMessage: sinon.stub() });
    connection.connect();
    connection.connect();
    t.is(createBot.callCount, 2);
    for (const call of createBot.getCalls()) {
      t.is(call.args[0].host, '127.0.0.1');
      t.is(call.args[0].port, 26001);
      t.is(call.args[0].username, 'CodexBot');
      t.true(call.args[0].hideErrors);
      t.truthy(call.args[0].plugins?.pathfinder);
    }
  } finally {
    createBot.restore();
  }
});

test('constructor accepts custom reconnect delay', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const customDelay = 5000;
  const connection = new BotConnection(config, callbacks, customDelay);

  t.is(connection.getState(), 'disconnected');
});

test('getState returns current state', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getState(), 'disconnected');
});

test('getConfig returns configuration', (t) => {
  const config = { host: 'example.com', port: 30000, username: 'MyBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const returnedConfig = connection.getConfig();
  t.is(returnedConfig.host, 'example.com');
  t.is(returnedConfig.port, 30000);
  t.is(returnedConfig.username, 'MyBot');
});

test('getBot returns null initially', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getBot(), null);
});

test('bridge-only mode never creates a Mineflayer bot and refuses player-required checks', async (t) => {
  const createBot = sinon.stub(mineflayer, 'createBot');
  const connection = new BotConnection({ host: '127.0.0.1', port: 25665, username: 'BridgeOnly', connectionMode: 'bridge-only' },
    { onLog: sinon.stub(), onChatMessage: sinon.stub() });
  try {
    connection.connect();
    const result = await connection.checkConnectionAndReconnect();
    t.false(createBot.called);
    t.is(connection.getBot(), null);
    t.false(result.connected);
    t.true(result.message!.startsWith('bot-required:'));
  } finally {
    createBot.restore();
  }
});

test('isConnected returns false when state is disconnected', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.false(connection.isConnected());
});

test('formatError handles Error objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const error = new Error('Test error');
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(error);

  t.is(formatted, 'Test error');
});

test('formatError handles plain objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const errorObj = { code: 'ECONNREFUSED', message: 'Connection refused' };
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(errorObj);

  t.true(formatted.includes('ECONNREFUSED'));
  t.true(formatted.includes('Connection refused'));
});

test('formatError handles strings', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError('Simple error');

  t.is(formatted, '"Simple error"');
});

test('formatError handles non-serializable objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(circular);

  t.is(typeof formatted, 'string');
});

test('checkConnectionAndReconnect returns connected when already connected', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);
  
  (connection as unknown as { state: string }).state = 'connected';

  const result = await connection.checkConnectionAndReconnect();

  t.true(result.connected);
  t.is(result.message, undefined);
});

test('checkConnectionAndReconnect returns message when connecting', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  (connection as unknown as { state: string }).state = 'connecting';

  const result = await connection.checkConnectionAndReconnect();

  t.false(result.connected);
  t.true(result.message!.includes('connecting'));
});

test('checkConnectionAndReconnect includes setup instructions on failure', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks, 100);

  (connection as unknown as { state: string }).state = 'disconnected';

  // Stub attemptReconnect to prevent actual connection attempt
  const attemptReconnectStub = sinon.stub(connection as unknown as { attemptReconnect: () => void }, 'attemptReconnect').callsFake(() => {
    (connection as unknown as { state: string }).state = 'connecting';
  });

  const result = await connection.checkConnectionAndReconnect();

  t.true(attemptReconnectStub.calledOnce);
  t.false(result.connected);
  t.true(result.message!.includes('Cannot connect'));
  t.true(result.message!.includes('localhost:25565'));
  t.true(result.message!.includes('github.com'));

  attemptReconnectStub.restore();
});

test('cleanup clears reconnect timer', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  (connection as unknown as { reconnectTimer: ReturnType<typeof setTimeout> }).reconnectTimer = setTimeout(() => {}, 10000);

  await t.notThrowsAsync(() => connection.cleanup());
});

test('cleanup waits for a bot disconnect before resolving', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);
  const botEmitter = Object.assign(new EventEmitter(), {
    quit: sinon.stub().callsFake(() => setImmediate(() => botEmitter.emit('end'))),
  });
  const bot = botEmitter as unknown as mineflayer.Bot;
  (connection as unknown as { bot: mineflayer.Bot | null }).bot = bot;

  await connection.cleanup();

  t.true(botEmitter.quit.calledOnce);
  t.false(botEmitter.listenerCount('end') > 0);
});

test('cleanup does not throw when no bot exists', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  await t.notThrowsAsync(() => connection.cleanup());
});
