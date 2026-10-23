import test from 'ava';
import minecraftData from 'minecraft-data';
import minecraftProtocol from 'minecraft-protocol';

const VERSION = '1.21.1';

interface ParsedRecipePacket {
  data: {
    name: unknown;
    params: { recipes: Array<{ name: string; type: unknown; data: { result: { itemId: number } } }> };
  };
  metadata: { size: number };
}

interface ProtocolSchema {
  play?: { toClient?: { types?: {
    packet?: [string, Array<{ name?: string; type?: unknown }>];
    packet_declare_recipes?: unknown;
  } } };
}

function makeSmeltingPacket(): Buffer {
  const serializer = minecraftProtocol.createSerializer({ state: 'play', isServer: true, version: VERSION });
  return serializer.createPacketBuffer({
    name: 'declare_recipes',
    params: {
      recipes: [{
        name: 'minecraft:iron_ingot_from_smelting_iron_ore',
        type: 'minecraft:smelting',
        data: {
          group: '', category: 0,
          ingredient: [{ itemId: 15, itemCount: 1, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] }],
          result: { itemCount: 1, itemId: 265, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] },
          experience: 0.7, cookTime: 200,
        },
      }],
    },
  });
}

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while ((remaining & ~0x7f) !== 0) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function parse(packet: Buffer, state = 'play', version = VERSION): ParsedRecipePacket {
  return minecraftProtocol.createDeserializer({ state, isServer: false, version, noErrorLogging: true })
    .parsePacketBuffer(packet) as ParsedRecipePacket;
}

test('the installed 1.21.1 schema maps play clientbound packet 0x77 to declare_recipes', (t) => {
  const data = minecraftData(VERSION);
  t.is(data?.version.version, 767);
  const protocol = data?.protocol as unknown as ProtocolSchema | undefined;
  const packet = protocol?.play?.toClient?.types?.packet;
  const nameField = packet?.[1]?.find(field => field.name === 'name');
  const mappings = (nameField?.type as [string, { mappings?: Record<string, string> }])?.[1]?.mappings;
  t.is(mappings?.['0x77'], 'declare_recipes');
  t.truthy(protocol?.play?.toClient?.types?.packet_declare_recipes);
});

test('a synthetic vanilla smelting recipe round-trips through the installed 1.21.1 schema', (t) => {
  const packet = makeSmeltingPacket();
  const parsed = parse(packet);
  t.is(parsed.data.name, 'declare_recipes');
  t.is(parsed.metadata.size, packet.length);
  t.is(parsed.data.params.recipes[0].name, 'minecraft:iron_ingot_from_smelting_iron_ore');
  t.is(parsed.data.params.recipes[0].type, 'minecraft:smelting');
  t.is(parsed.data.params.recipes[0].data.result.itemId, 265);
});

test('an unknown recipe discriminator is preserved numerically and leaves its payload unread', (t) => {
  const name = Buffer.from('minecraft:test', 'utf8');
  const packet = Buffer.concat([Buffer.from([0x77, 1]), encodeVarInt(name.length), name, Buffer.from([24, 0xaa])]);
  const parsed = parse(packet);
  t.is(parsed.data.name, 'declare_recipes');
  t.is(parsed.data.params.recipes[0].type, 24);
  t.is(parsed.metadata.size, packet.length - 1);
});

test('a truncated recipe string is rejected as a partial read', (t) => {
  const name = Buffer.from('minecraft:test', 'utf8');
  const packet = Buffer.concat([Buffer.from([0x77, 1]), encodeVarInt(name.length), name.subarray(0, 3)]);
  const error = t.throws(() => parse(packet));
  t.is(error?.name, 'PartialReadError');
  t.true(error?.message.includes('Missing characters in string'));
  t.true(error?.message.includes(`found size is ${packet.length}`));
});

test('a synthetic oversized recipe-name VarInt reproduces the historical size wording without allocating the claimed string', (t) => {
  // Synthetic only: these bytes were generated for this test and are not the historical packet capture.
  // The encoded string byte count is chosen so Protodef's `strEnd` equals the reported expected size.
  const nameLength = 420_784_376;
  const packet = Buffer.concat([Buffer.from([0x77, 1]), encodeVarInt(nameLength)]);
  const error = t.throws(() => parse(packet));
  t.is(error?.name, 'PartialReadError');
  t.is(packet.length, 7);
  t.true(error?.message.includes('found size is 7 expected size was 420784383'));
});

test('extra bytes remain detectable through parsed size and are not silently part of the recipe', (t) => {
  const packet = Buffer.concat([makeSmeltingPacket(), Buffer.from([0xde, 0xad])]);
  const parsed = parse(packet);
  t.is(parsed.data.name, 'declare_recipes');
  t.is(parsed.metadata.size, packet.length - 2);
  t.not(parsed.metadata.size, packet.length);
});

test('using the wrong protocol state or version does not identify the packet as 1.21.1 declare_recipes', (t) => {
  const packet = makeSmeltingPacket();
  for (const [state, version] of [['configuration', VERSION], ['play', '1.21.4']]) {
    let name: unknown;
    try { name = parse(packet, state, version).data.name; } catch { name = null; }
    t.not(name, 'declare_recipes', `${state}/${version} must not be treated as the selected 1.21.1 Play schema`);
  }
});
