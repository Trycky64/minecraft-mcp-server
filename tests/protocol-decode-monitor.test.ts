import test from 'ava';
import { EventEmitter } from 'node:events';
import { getProtocolDecodeStatus, monitorProtocolDecode, type ProtocolClientLike } from '../src/services/protocol-decode-monitor.js';

class FakeDecoder {
  parsePacketBuffer(): unknown { throw Object.assign(new Error('Malformed packet body'), { name: 'PartialReadError' }); }
}

class FakeProtocolClient extends EventEmitter implements ProtocolClientLike {
  state = 'play';
  version = '1.21.1';
  deserializer: FakeDecoder = new FakeDecoder();
  setSerializer(_state: string): void { this.deserializer = new FakeDecoder(); }
}

test('decoder errors are recorded with packet metadata and rethrown, not swallowed', (t) => {
  const client = new FakeProtocolClient();
  monitorProtocolDecode(client);
  const decoder = client.deserializer;
  t.throws(() => decoder.parsePacketBuffer(Buffer.from([0x13])), { name: 'PartialReadError' });
  const status = getProtocolDecodeStatus(client);
  t.is(status.inventory, 'incomplete');
  t.is(status.issues[0]?.packetName, 'window_items');
  t.is(status.issues[0]?.packetId, 0x13);
});

test('an unrelated recipe decode error is reported without invalidating inventory', (t) => {
  const client = new FakeProtocolClient();
  monitorProtocolDecode(client);
  t.throws(() => client.deserializer.parsePacketBuffer(Buffer.from([0x77])), { name: 'PartialReadError' });
  const status = getProtocolDecodeStatus(client);
  t.is(status.issues[0]?.packetName, 'declare_recipes');
  t.is(status.inventory, 'unverified');
});

test('a valid full inventory packet restores inventory snapshot reliability', (t) => {
  const client = new FakeProtocolClient();
  monitorProtocolDecode(client);
  t.throws(() => client.deserializer.parsePacketBuffer(Buffer.from([0x15])), { name: 'PartialReadError' });
  client.emit('packet', {}, { name: 'window_items' });
  t.is(getProtocolDecodeStatus(client).inventory, 'complete');
});

test('the monitor follows protocol-state decoder replacement', (t) => {
  const client = new FakeProtocolClient();
  monitorProtocolDecode(client);
  client.setSerializer('play');
  t.throws(() => client.deserializer.parsePacketBuffer(Buffer.from([0x13])), { name: 'PartialReadError' });
  t.is(getProtocolDecodeStatus(client).issues.length, 1);
});
