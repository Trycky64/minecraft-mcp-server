import test from 'ava';
import minecraftData from 'minecraft-data';

type Field = { name: string; type: unknown };
type PacketSchema = [string, Field[]];

function fields(schema: PacketSchema): Field[] {
  return schema[1];
}

test('installed protocol schema identifies the audited target as Minecraft 1.21.1 protocol 767', (t) => {
  t.is(minecraftData('1.21.1')?.version.version, 767);
});

test('open and close packet schemas separate container ID from numeric menu type', (t) => {
  const protocol = minecraftData('1.21.1')!.protocol as unknown as { play: { toClient: { types: Record<string, PacketSchema> }; toServer: { types: Record<string, PacketSchema> } } };
  t.deepEqual(fields(protocol.play.toClient.types.packet_open_window).map(({ name, type }) => [name, type]), [
    ['windowId', 'varint'], ['inventoryType', 'varint'], ['windowTitle', 'anonymousNbt'],
  ]);
  t.deepEqual(fields(protocol.play.toClient.types.packet_window_items).map(({ name }) => name), ['windowId', 'stateId', 'items', 'carriedItem']);
  t.deepEqual(fields(protocol.play.toClient.types.packet_set_slot).map(({ name }) => name), ['windowId', 'stateId', 'slot', 'item']);
  t.deepEqual(fields(protocol.play.toClient.types.packet_close_window).map(({ name }) => name), ['windowId']);
  t.deepEqual(fields(protocol.play.toClient.types.packet_open_horse_window).map(({ name }) => name), ['windowId', 'nbSlots', 'entityId']);
});

test('slot updates, raw menu properties and slot clicks carry distinct fields', (t) => {
  const protocol = minecraftData('1.21.1')!.protocol as unknown as { play: { toClient: { types: Record<string, PacketSchema> }; toServer: { types: Record<string, PacketSchema> } } };
  t.deepEqual(fields(protocol.play.toClient.types.packet_craft_progress_bar).map(({ name, type }) => [name, type]), [
    ['windowId', 'ContainerID'], ['property', 'i16'], ['value', 'i16'],
  ]);
  t.deepEqual(fields(protocol.play.toServer.types.packet_window_click).map(({ name }) => name), [
    'windowId', 'stateId', 'slot', 'mouseButton', 'mode', 'changedSlots', 'cursorItem',
  ]);
  t.deepEqual(fields(protocol.play.toServer.types.packet_enchant_item).map(({ name }) => name), ['windowId', 'enchantment']);
  t.false('packet_window_property' in protocol.play.toClient.types);
});

test('protocol Slot schema exposes raw item IDs and component counts without a menu layout', (t) => {
  const protocol = minecraftData('1.21.1')!.protocol as unknown as { types: Record<string, unknown> };
  const slotSchema = protocol.types.Slot as [string, Array<{ name?: string }>];
  t.is(slotSchema[0], 'container');
  t.deepEqual(slotSchema[1].map(({ name }) => name ?? null), [
    'itemCount', null,
  ]);
  const packet = minecraftData('1.21.1')!.protocol as unknown as { play: { toClient: { types: Record<string, [string, Array<{ name?: string }>]> } } };
  const windowItems = packet.play.toClient.types.packet_window_items[1];
  t.deepEqual(windowItems.map(({ name }) => name), ['windowId', 'stateId', 'items', 'carriedItem']);
  // Slot component values are payload data; they do not encode slot disposition.
  t.is(slotSchema[1][0]?.name, 'itemCount');
});
