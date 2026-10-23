import test from 'ava';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import type { Window } from 'prismarine-windows';
import { InventoryActionConfirmationTracker, snapshotWindow } from '../src/services/inventory-action-confirmation.js';

function fixture() {
  const client = new EventEmitter();
  const bot = new EventEmitter() as EventEmitter & Partial<Bot>;
  (bot as unknown as { _client: EventEmitter })._client = client;
  const window = { id: 4, slots: [null, null], selectedItem: null } as unknown as Window;
  bot.currentWindow = window;
  const tracker = new InventoryActionConfirmationTracker(bot as Bot);
  client.on('packet', (packet: { windowId: number; slot?: number; item?: unknown; items?: unknown[]; carriedItem?: unknown }, metadata: { name: string }) => {
    if (metadata.name === 'set_slot' && packet.windowId === window.id && packet.slot !== undefined) window.slots[packet.slot] = packet.item as never;
    if (metadata.name === 'set_slot' && packet.windowId === -1 && packet.slot === -1) window.selectedItem = packet.item as never;
    if (metadata.name === 'window_items' && packet.windowId === window.id && packet.items) {
      window.slots = [...packet.items] as never[];
      window.selectedItem = (packet.carriedItem as never) ?? null;
    }
  });
  const item = { type: 5, count: 3, name: 'stone', metadata: 0 };
  const emitBaseline = () => client.emit('packet', { windowId: window.id, stateId: 10, items: [null, null], carriedItem: null }, { name: 'window_items' });
  return { bot, client, window, tracker, item, emitBaseline };
}

test('newer matching server slot update confirms the optimistic window result', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 100);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  client.emit('packet', { windowId: window.id, stateId: 11, slot: 0, item }, { name: 'set_slot' });
  const result = await action.promise;
  t.is(result.status, 'server-confirmed');
  t.is(result.operationGeneration, 1);
  t.is(result.baselineStateId, 10);
  t.deepEqual(result.serverStateIdsObserved, [11]);
  t.true(result.serverConfirmed);
  t.is(result.actionCausality, 'not-provable-from-container-protocol');
  t.deepEqual(result.serverPacketsObserved, ['set_slot']);
});

test('matching state does not claim the click caused an unrelated server update', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 100);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  // The protocol carries a new stateId and resulting slot state, but no click correlation ID.
  client.emit('packet', { windowId: window.id, stateId: 11, slot: 0, item }, { name: 'set_slot' });
  const result = await action.promise;
  t.is(result.status, 'server-confirmed');
  t.is(result.actionCausality, 'not-provable-from-container-protocol');
});

test('timeout without a matching server update is uncertain and blocks another click', async (t) => {
  const { window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 5);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  const result = await action.promise;
  t.is(result.status, 'uncertain');
  t.true(result.recoveryRequired);
  t.false(tracker.canStart(window));
});

test('a fresh full server snapshot reconciles a timed-out action for a later request', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 5);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  await action.promise;
  client.emit('packet', { windowId: window.id, stateId: 11, items: [item, null], carriedItem: null }, { name: 'window_items' });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  t.true(tracker.canStart(window));
});

test('a repeated complete snapshot with the same stateId cannot clear an unresolved click lock', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 5);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  await action.promise;
  client.emit('packet', { windowId: window.id, stateId: 10, items: [null, null], carriedItem: null }, { name: 'window_items' });
  t.false(tracker.canStart(window));
});

test('a partial window_items packet cannot clear an unresolved click lock', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 5);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  await action.promise;
  client.emit('packet', { windowId: window.id, stateId: 11, items: [item], carriedItem: null }, { name: 'window_items' });
  t.false(tracker.canStart(window));
});

test('an incomplete initial window_items packet does not establish a usable window snapshot', (t) => {
  const { bot, client, window, tracker } = fixture();
  client.emit('packet', { windowId: window.id, inventoryType: 100 }, { name: 'open_window' });
  client.emit('packet', { windowId: window.id, stateId: 1, items: [null], carriedItem: null }, { name: 'window_items' });
  bot.emit('windowOpen', window);
  const observation = tracker.getWindowObservation(window);
  t.false(observation?.completeContentObserved ?? false);
  t.not(tracker.getStateId(window.id), undefined);
});

test('open-window metadata preserves the raw menu type and increments on numeric window ID reuse', (t) => {
  const { bot, client, window, tracker } = fixture();
  client.emit('packet', { windowId: window.id, inventoryType: 14 }, { name: 'open_window' });
  client.emit('packet', { windowId: window.id, stateId: 3, items: [null, null], carriedItem: null }, { name: 'window_items' });
  bot.emit('windowOpen', window);
  const first = tracker.getWindowObservation(window);
  t.is(first?.rawMenuTypeId, 14);
  t.is(first?.generation, 1);
  t.true(first?.completeContentObserved);

  const replacement = { id: window.id, slots: [null, null], selectedItem: null } as unknown as Window;
  bot.currentWindow = replacement;
  client.emit('packet', { windowId: window.id, inventoryType: 15 }, { name: 'open_window' });
  client.emit('packet', { windowId: window.id, stateId: 0, items: [null, null], carriedItem: null }, { name: 'window_items' });
  bot.emit('windowOpen', replacement);
  const second = tracker.getWindowObservation(replacement);
  t.is(second?.rawMenuTypeId, 15);
  t.is(second?.generation, 2);
  t.is(second?.stateId, 0);
  t.notDeepEqual(first, second);
});

test('full content arriving before open_window is associated only after the client binds the matching window', (t) => {
  const { bot, client, window, tracker } = fixture();
  bot.currentWindow = null;
  client.emit('packet', { windowId: window.id, stateId: 8, items: [null, null], carriedItem: null }, { name: 'window_items' });
  bot.currentWindow = window;
  bot.emit('windowOpen', window);
  client.emit('packet', { windowId: window.id, inventoryType: 14 }, { name: 'open_window' });
  const observation = tracker.getWindowObservation(window);
  t.is(observation?.rawMenuTypeId, 14);
  t.is(observation?.stateId, 8);
  t.true(observation?.completeContentObserved);
  t.is(tracker.getStateId(window.id), 8);
});

test('horse windows retain entity and raw slot metadata without claiming a menu layout', (t) => {
  const { bot, client, tracker } = fixture();
  const horseWindow = { id: 4, slots: Array(53).fill(null), selectedItem: null } as unknown as Window;
  bot.currentWindow = horseWindow;
  client.emit('packet', { windowId: horseWindow.id, nbSlots: 17, entityId: 42 }, { name: 'open_horse_window' });
  client.emit('packet', { windowId: horseWindow.id, stateId: 2, items: Array(53).fill(null), carriedItem: null }, { name: 'window_items' });
  bot.emit('windowOpen', horseWindow);
  const observation = tracker.getWindowObservation(horseWindow);
  t.is(observation?.kind, 'horse');
  t.is(observation?.rawEntityId, 42);
  t.is(observation?.declaredContainerSlotCount, 17);
  t.is(observation?.rawMenuTypeId, null);
});

test('raw menu observation captures bounded protocol contents without requiring a Mineflayer Window', (t) => {
  const { client, tracker } = fixture();
  client.emit('packet', { windowId: 19, inventoryType: 900, windowTitle: { text: 'Unknown menu' } }, { name: 'open_window' });
  client.emit('packet', {
    windowId: 19, stateId: 4,
    items: [
      { itemCount: 2, itemId: 1373, addedComponentCount: 1, removedComponentCount: 0, components: [{ type: 7, data: { privatePayload: 'omitted' } }], removeComponents: [] },
      { itemCount: 0 },
    ],
    carriedItem: { itemCount: 0 },
  }, { name: 'window_items' });
  const snapshot = tracker.getRawMenuObservation();
  t.is(snapshot?.windowId, 19);
  t.is(snapshot?.rawMenuTypeId, 900);
  t.is(snapshot?.generation, 1);
  t.is(snapshot?.contentStatus, 'complete-packet-observed');
  t.is(snapshot?.observedSlotCount, 2);
  t.is(snapshot?.slots?.[0]?.rawNumericItemId, 1373);
  t.is(snapshot?.slots?.[0]?.count, 2);
  t.deepEqual(snapshot?.slots?.[0]?.componentTypeIds, [7]);
  t.is(snapshot?.slots?.[0]?.componentPayloads, 'omitted-bounded-summary-only');
  t.is(snapshot?.slots?.[1]?.empty, true);
  t.is(snapshot?.cursor?.empty, true);
  snapshot!.slots![0]!.count = 99;
  t.is(tracker.getRawMenuObservation()?.slots?.[0]?.count, 2);
  client.emit('packet', { windowId: 19 }, { name: 'close_window' });
  t.is(tracker.getRawMenuObservation(), null);
});

test('raw menu observations reject oversized and malformed slot arrays without partial promotion', (t) => {
  const { client, tracker } = fixture();
  client.emit('packet', { windowId: 20, inventoryType: 901 }, { name: 'open_window' });
  client.emit('packet', { windowId: 20, stateId: 1, items: [{ itemCount: 1, itemId: -4 }], carriedItem: { itemCount: 0 } }, { name: 'window_items' });
  const snapshot = tracker.getRawMenuObservation();
  t.is(snapshot?.contentStatus, 'oversized-or-malformed');
  t.is(snapshot?.slots, null);
});

test('menu identity evidence is frozen to the runtime epoch and bridge session at open time', (t) => {
  const client = new EventEmitter();
  const bot = new EventEmitter() as EventEmitter & Partial<Bot>;
  (bot as unknown as { _client: EventEmitter })._client = client;
  const window = { id: 23, slots: [null], selectedItem: null } as unknown as Window;
  bot.currentWindow = window;
  let runtime = {
    minecraftVersion: '1.21.1', minecraftEndpoint: '127.0.0.1:25665', serverIdentity: 'server-a',
    registryEpoch: 'registry-a', runtimeEpoch: 'runtime-a', mineflayerSessionId: 'bot-a', mineflayerRegistryEpoch: 'bot-registry-a',
    bridgeSessionId: 'bridge-a', sourceRegistryEpoch: 'java-a', bridgeAvailable: true, bridgeAuthenticated: true,
  };
  const tracker = new InventoryActionConfirmationTracker(bot as Bot, () => ({ ...runtime }));
  client.emit('packet', { windowId: 23, inventoryType: 901 }, { name: 'open_window' });
  runtime = { ...runtime, registryEpoch: 'registry-b', runtimeEpoch: 'runtime-b', bridgeSessionId: 'bridge-b' };
  client.emit('packet', { windowId: 23, stateId: 3, items: [{ itemCount: 0 }], carriedItem: { itemCount: 0 } }, { name: 'window_items' });
  bot.emit('windowOpen', window);
  t.is(tracker.getWindowObservation(window)?.runtimeBinding?.registryEpoch, 'registry-a');
  t.is(tracker.getWindowObservation(window)?.runtimeBinding?.bridgeSessionId, 'bridge-a');
  t.is(tracker.getRawMenuObservation()?.runtimeBinding?.runtimeEpoch, 'runtime-a');
});

test('raw windows use a new generation when a numeric window ID is reused and discard regressing snapshots', (t) => {
  const { client, tracker } = fixture();
  client.emit('packet', { windowId: 24, inventoryType: 910 }, { name: 'open_window' });
  client.emit('packet', { windowId: 24, stateId: 5, items: [{ itemCount: 1, itemId: 80 }], carriedItem: { itemCount: 0 } }, { name: 'window_items' });
  const first = tracker.getRawMenuObservation();
  t.is(first?.generation, 1);
  client.emit('packet', { windowId: 24 }, { name: 'close_window' });
  t.is(tracker.getRawMenuObservation(), null);
  client.emit('packet', { windowId: 24, inventoryType: 911 }, { name: 'open_window' });
  client.emit('packet', { windowId: 24, stateId: 1, items: [{ itemCount: 0 }], carriedItem: { itemCount: 0 } }, { name: 'window_items' });
  const second = tracker.getRawMenuObservation();
  t.is(second?.generation, 2);
  t.is(second?.rawMenuTypeId, 911);
  t.is(second?.stateId, 1);
  t.is(second?.slots?.[0]?.empty, true);
});

test('properties before initial contents remain raw and respawn invalidates raw menu state', (t) => {
  const { client, bot, tracker } = fixture();
  client.emit('packet', { windowId: 25, inventoryType: 912 }, { name: 'open_window' });
  client.emit('packet', { windowId: 25, property: 77, value: 1234 }, { name: 'craft_progress_bar' });
  t.is(tracker.getRawMenuObservation()?.syncedProperties[77], 1234);
  t.is(tracker.getRawMenuObservation()?.contentStatus, 'not-observed');
  bot.emit('respawn');
  t.is(tracker.getRawMenuObservation(), null);
});

test('a close received before the initial snapshot prevents later packets from reopening the raw observation', (t) => {
  const { client, tracker } = fixture();
  client.emit('packet', { windowId: 29, inventoryType: 920 }, { name: 'open_window' });
  client.emit('packet', { windowId: 29 }, { name: 'close_window' });
  client.emit('packet', { windowId: 29, stateId: 1, items: [{ itemCount: 0 }], carriedItem: { itemCount: 0 } }, { name: 'window_items' });
  t.is(tracker.getRawMenuObservation(), null);
});

test('raw set_slot deltas update a synchronized slot and an out-of-range delta invalidates the snapshot', (t) => {
  const { client, tracker } = fixture();
  client.emit('packet', { windowId: 31, inventoryType: 921 }, { name: 'open_window' });
  client.emit('packet', { windowId: 31, stateId: 1, items: [{ itemCount: 0 }], carriedItem: { itemCount: 0 } }, { name: 'window_items' });
  client.emit('packet', { windowId: 31, stateId: 2, slot: 0, item: { itemCount: 3, itemId: 99 } }, { name: 'set_slot' });
  t.is(tracker.getRawMenuObservation()?.slots?.[0]?.rawNumericItemId, 99);
  t.is(tracker.getRawMenuObservation()?.slots?.[0]?.count, 3);
  client.emit('packet', { windowId: 31, stateId: 3, slot: 4, item: { itemCount: 1, itemId: 100 } }, { name: 'set_slot' });
  t.is(tracker.getRawMenuObservation()?.contentStatus, 'oversized-or-malformed');
  t.is(tracker.getRawMenuObservation()?.slots, null);
});

test('a regressing full snapshot cannot unlock a timed-out window action', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 5);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  await action.promise;
  client.emit('packet', { windowId: window.id, stateId: 9, items: [null, null], carriedItem: null }, { name: 'window_items' });
  t.false(tracker.canStart(window));
  t.is(tracker.getStateId(window.id), 10);
});

test('a stateId at or before the baseline is not a confirmation', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 5);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  client.emit('packet', { windowId: window.id, stateId: 10, slot: 0, item }, { name: 'set_slot' });
  const result = await action.promise;
  t.is(result.status, 'uncertain');
  t.false(result.serverConfirmed);
});

test('a slot update without stateId cannot provide strong confirmation', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 5);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  client.emit('packet', { windowId: window.id, slot: 0, item }, { name: 'set_slot' });
  const result = await action.promise;
  t.is(result.status, 'uncertain');
  t.false(result.serverConfirmed);
});

test('without a known baseline stateId, a matching slot packet remains uncertain', async (t) => {
  const { client, window, tracker, item } = fixture();
  const action = tracker.start(window, snapshotWindow(window), 5);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  client.emit('packet', { windowId: window.id, stateId: 11, slot: 0, item }, { name: 'set_slot' });
  const result = await action.promise;
  t.is(result.status, 'uncertain');
  t.deepEqual(result.serverStateIdsObserved, [11]);
});

test('an old window object cannot be confirmed after a replacement reuses its numeric ID', async (t) => {
  const { bot, client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 50);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  bot.currentWindow = { id: window.id, slots: [null, null], selectedItem: null } as unknown as Window;
  client.emit('packet', { windowId: window.id, stateId: 11, slot: 0, item }, { name: 'set_slot' });
  const result = await action.promise;
  t.is(result.status, 'uncertain');
  t.false(result.serverConfirmed);
});

test('all changed slots must be observed before a multi-slot transfer is confirmed', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  const source = { type: 5, count: 1, name: 'stone', metadata: 0 };
  emitBaseline();
  window.slots[0] = source as never;
  const action = tracker.start(window, snapshotWindow(window), 100);
  window.slots[0] = null;
  window.slots[1] = item as never;
  action.markSent(snapshotWindow(window));
  client.emit('packet', { windowId: window.id, stateId: 11, slot: 0, item: null }, { name: 'set_slot' });
  t.false((await Promise.race([action.promise.then(() => true), Promise.resolve(false)])));
  client.emit('packet', { windowId: window.id, stateId: 12, slot: 1, item }, { name: 'set_slot' });
  const result = await action.promise;
  t.is(result.status, 'server-confirmed');
  t.deepEqual(result.changedSlots, [0, 1]);
});

test('a contradictory server update is not reported as a server rejection', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 50);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  client.emit('packet', { windowId: window.id, stateId: 11, slot: 0, item: null }, { name: 'set_slot' });
  const result = await action.promise;
  t.is(result.status, 'server-state-conflict');
  t.false(result.serverConfirmed);
  t.true(result.recoveryRequired);
});

test('closing the active window invalidates its pending action', async (t) => {
  const { bot, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 100);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  bot.emit('windowClose', window);
  const result = await action.promise;
  t.is(result.status, 'uncertain');
  t.true(result.recoveryRequired);
});

test('separate Bot objects have isolated epoch state', (t) => {
  const first = fixture();
  first.emitBaseline();
  const second = fixture();
  t.is(second.tracker.getStateId(second.window.id), undefined);
  first.tracker.dispose();
  second.tracker.dispose();
});

test('ending a Mineflayer session invalidates its in-flight confirmation', async (t) => {
  const { bot, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 100);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  bot.emit('end');
  const result = await action.promise;
  t.is(result.status, 'uncertain');
  t.true(result.recoveryRequired);
  t.is(tracker.getStateId(window.id), undefined);
});

test('protocol client end invalidates tracking even if Bot teardown removes its listeners', async (t) => {
  const { client, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 100);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  client.emit('end');
  const result = await action.promise;
  t.is(result.status, 'uncertain');
  t.true(result.recoveryRequired);
});

test('respawn invalidates the old stateId baseline before window ID reuse', async (t) => {
  const { bot, window, tracker, item, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 100);
  window.slots[0] = item as never;
  action.markSent(snapshotWindow(window));
  bot.emit('respawn');
  const result = await action.promise;
  t.is(result.status, 'uncertain');
  t.is(tracker.getStateId(window.id), undefined);
});

test('two concurrent operations on one window cannot both start', (t) => {
  const { window, tracker, emitBaseline } = fixture();
  emitBaseline();
  const action = tracker.start(window, snapshotWindow(window), 100);
  t.throws(() => tracker.start(window, snapshotWindow(window), 100), { message: /window-action-in-progress/ });
  action.cancel();
});
