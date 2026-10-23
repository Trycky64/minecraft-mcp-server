import type { Bot } from 'mineflayer';
import type { Window } from 'prismarine-windows';
import { randomUUID } from 'node:crypto';

export type InventoryActionStatus = 'server-confirmed' | 'server-state-conflict' | 'uncertain';

export interface ItemState {
  type: number;
  count: number;
  name: string;
  metadata: number | null;
  nbt: string | null;
  components: string | null;
}

export interface WindowState {
  slots: Array<ItemState | null>;
  cursor: ItemState | null;
}

export interface InventoryActionResult {
  operationGeneration: number;
  status: InventoryActionStatus;
  /** Container state packets have no action correlation ID; matching state does not prove causality. */
  actionCausality: 'not-provable-from-container-protocol';
  actionRequested: true;
  actionSent: boolean;
  clientObserved: boolean;
  serverConfirmed: boolean;
  serverPacketsObserved: string[];
  windowId: number;
  baselineStateId: number | null;
  serverStateIdsObserved: number[];
  changedSlots: number[];
  cursorChanged: boolean;
  recoveryRequired: boolean;
  note: string;
}

interface ServerPacket {
  windowId?: number;
  stateId?: number;
  slot?: number;
  inventoryType?: number;
  items?: unknown[];
  carriedItem?: unknown;
  property?: number;
  value?: number;
  entityId?: number;
  nbSlots?: number;
  windowTitle?: unknown;
  item?: unknown;
}

type WindowListener = (window: Window) => void;

export interface MenuWindowRuntimeBinding {
  minecraftVersion: string | null;
  minecraftEndpoint: string | null;
  serverIdentity: string | null;
  registryEpoch: string | null;
  runtimeEpoch: string | null;
  mineflayerSessionId: string | null;
  mineflayerRegistryEpoch: string | null;
  bridgeSessionId: string | null;
  sourceRegistryEpoch: string | null;
  bridgeAvailable: boolean;
  bridgeAuthenticated: boolean;
}

export interface WindowProtocolObservation {
  /** Per-Bot open-window generation; never reused as a server registry epoch. */
  generation: number;
  kind: 'container' | 'horse';
  rawMenuTypeId: number | null;
  rawEntityId: number | null;
  declaredContainerSlotCount: number | null;
  stateId: number | null;
  completeContentObserved: boolean;
  observedSlotCount: number | null;
  syncedProperties: Record<number, number>;
  runtimeBinding: MenuWindowRuntimeBinding | null;
}

export interface RawMenuSlotObservation {
  slot: number;
  empty: boolean;
  rawNumericItemId: number | null;
  count: number | null;
  componentCount: number | null;
  removedComponentCount: number | null;
  componentTypeIds: Array<number | string>;
  componentPayloads: 'omitted-bounded-summary-only';
}

export interface RawMenuObservation {
  observationSessionId: string;
  windowId: number;
  generation: number;
  kind: 'container' | 'horse';
  rawMenuTypeId: number | null;
  rawEntityId: number | null;
  declaredContainerSlotCount: number | null;
  titleData: unknown;
  titleDataStatus: 'bounded-observed' | 'omitted-over-size-limit' | 'unobserved';
  stateId: number | null;
  contentStatus: 'not-observed' | 'complete-packet-observed' | 'oversized-or-malformed';
  observedSlotCount: number | null;
  slots: RawMenuSlotObservation[] | null;
  cursor: RawMenuSlotObservation | null;
  syncedProperties: Record<number, number>;
  runtimeBinding: MenuWindowRuntimeBinding | null;
}

const MAX_RAW_MENU_SLOTS = 256;
const MAX_RAW_COMPONENT_TYPES = 32;

function boundedValue(value: unknown, limit: number): { value: unknown; oversized: boolean } {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || json.length > limit) return { value: null, oversized: true };
    return { value: JSON.parse(json) as unknown, oversized: false };
  } catch { return { value: null, oversized: true }; }
}

function rawSlot(value: unknown, slot: number): RawMenuSlotObservation | null {
  if (!value || typeof value !== 'object') return null;
  const packetItem = value as { itemCount?: unknown; itemId?: unknown; addedComponentCount?: unknown; removedComponentCount?: unknown; components?: unknown; removeComponents?: unknown };
  if (!Number.isSafeInteger(packetItem.itemCount) || (packetItem.itemCount as number) < 0) return null;
  const count = packetItem.itemCount as number;
  if (count === 0) return {
    slot, empty: true, rawNumericItemId: null, count: 0, componentCount: 0,
    removedComponentCount: 0, componentTypeIds: [], componentPayloads: 'omitted-bounded-summary-only',
  };
  if (!Number.isSafeInteger(packetItem.itemId) || (packetItem.itemId as number) < 0) return null;
  const components = Array.isArray(packetItem.components) ? packetItem.components : [];
  const componentTypeIds = components.slice(0, MAX_RAW_COMPONENT_TYPES).flatMap(component => {
    if (!component || typeof component !== 'object') return [];
    const type = (component as { type?: unknown }).type;
    return typeof type === 'string' || (typeof type === 'number' && Number.isSafeInteger(type)) ? [type] : [];
  });
  return {
    slot, empty: false, rawNumericItemId: packetItem.itemId as number, count,
    componentCount: Number.isSafeInteger(packetItem.addedComponentCount) ? packetItem.addedComponentCount as number : components.length,
    removedComponentCount: Number.isSafeInteger(packetItem.removedComponentCount) ? packetItem.removedComponentCount as number :
      Array.isArray(packetItem.removeComponents) ? packetItem.removeComponents.length : 0,
    componentTypeIds, componentPayloads: 'omitted-bounded-summary-only',
  };
}

interface RecoveryWatermark {
  fullSyncGeneration: number;
  stateId: number | undefined;
}

/**
 * Tracks server-originated inventory packets separately from Mineflayer's
 * optimistic Window mutations. Instances are scoped to one Bot object, so a
 * reconnect cannot inherit an earlier session's observations.
 */
export class InventoryActionConfirmationTracker {
  private readonly stateIds = new Map<number, number>();
  private readonly fullSyncGenerations = new Map<number, number>();
  private readonly completeSnapshotStateIds = new Map<number, number>();
  private readonly unresolved = new WeakMap<object, RecoveryWatermark>();
  private readonly pendingWindowOpens = new Map<number, WindowProtocolObservation>();
  private readonly earlyWindowSnapshots = new Map<number, { stateId: number | null; slotCount: number }>();
  private readonly windowObservations = new WeakMap<object, WindowProtocolObservation>();
  private readonly observationSessionId = randomUUID();
  private rawWindow: RawMenuObservation | null = null;
  private rawWindowClosed = false;
  private nextWindowGeneration = 0;
  private active: {
    window: Window;
    baselineStateId: number | undefined;
    baselineFullSyncGeneration: number;
    expected: WindowState;
    before: WindowState;
    changedSlots: number[];
    cursorChanged: boolean;
    seenSlots: Set<number>;
    cursorSeen: boolean;
    packets: Set<string>;
    stateIds: Set<number>;
    operationGeneration: number;
    finish: (status: InventoryActionStatus, recoveryRequired: boolean) => void;
  } | null = null;
  private disposed = false;
  private nextOperationGeneration = 0;

  private readonly onPacket = (packet: ServerPacket, metadata: { name?: string }): void => {
    if (this.disposed || !metadata?.name) return;
    const name = metadata.name;
    if (name === 'open_window' && Number.isInteger(packet.windowId)) {
      const windowId = packet.windowId!;
      // Window IDs may be reused after close/respawn. Reset the old protocol state
      // at the new open boundary, then bind subsequent observations to this generation.
      this.stateIds.delete(windowId);
      this.fullSyncGenerations.delete(windowId);
      this.completeSnapshotStateIds.delete(windowId);
      const early = this.earlyWindowSnapshots.get(windowId);
      const generation = ++this.nextWindowGeneration;
      this.pendingWindowOpens.set(windowId, {
        generation,
        kind: 'container',
        rawMenuTypeId: Number.isInteger(packet.inventoryType) ? packet.inventoryType! : null,
        rawEntityId: null,
        declaredContainerSlotCount: null,
        stateId: early?.stateId ?? null,
        completeContentObserved: early?.stateId !== null && early !== undefined,
        observedSlotCount: early?.slotCount ?? null,
        syncedProperties: {},
        runtimeBinding: this.getRuntimeBinding(),
      });
      const title = boundedValue(packet.windowTitle, 1024);
      this.rawWindow = {
        observationSessionId: this.observationSessionId,
        windowId,
        generation,
        kind: 'container',
        rawMenuTypeId: Number.isSafeInteger(packet.inventoryType) ? packet.inventoryType! : null,
        rawEntityId: null,
        declaredContainerSlotCount: null,
        titleData: title.value,
        titleDataStatus: packet.windowTitle === undefined ? 'unobserved' : title.oversized ? 'omitted-over-size-limit' : 'bounded-observed',
        stateId: null,
        contentStatus: 'not-observed',
        observedSlotCount: null,
        slots: null,
        cursor: null,
        syncedProperties: {},
        runtimeBinding: this.getRuntimeBinding(),
      };
      this.rawWindowClosed = false;
      this.earlyWindowSnapshots.delete(windowId);
      const currentWindow = this.bot.currentWindow;
      const pending = this.pendingWindowOpens.get(windowId)!;
      if (currentWindow?.id === windowId && pending.completeContentObserved && pending.observedSlotCount === currentWindow.slots.length) {
        // Some vanilla menus send window_items before open_window. Mineflayer
        // consumes that buffer and emits windowOpen before this packet listener runs.
        this.windowObservations.set(currentWindow, { ...pending });
        this.pendingWindowOpens.delete(windowId);
        this.stateIds.set(windowId, pending.stateId!);
        this.fullSyncGenerations.set(windowId, 1);
        this.completeSnapshotStateIds.set(windowId, pending.stateId!);
      }
      if (this.active && this.bot.currentWindow !== this.active.window) this.active.finish('uncertain', true);
      return;
    }
    if (name === 'open_horse_window' && Number.isInteger(packet.windowId)) {
      const windowId = packet.windowId!;
      this.stateIds.delete(windowId);
      this.fullSyncGenerations.delete(windowId);
      this.completeSnapshotStateIds.delete(windowId);
      const early = this.earlyWindowSnapshots.get(windowId);
      const generation = ++this.nextWindowGeneration;
      this.pendingWindowOpens.set(windowId, {
        generation,
        kind: 'horse',
        rawMenuTypeId: null,
        rawEntityId: Number.isInteger(packet.entityId) ? packet.entityId! : null,
        declaredContainerSlotCount: Number.isInteger(packet.nbSlots) ? packet.nbSlots! : null,
        stateId: early?.stateId ?? null,
        completeContentObserved: early?.stateId !== null && early !== undefined,
        observedSlotCount: early?.slotCount ?? null,
        syncedProperties: {},
        runtimeBinding: this.getRuntimeBinding(),
      });
      this.rawWindow = {
        observationSessionId: this.observationSessionId,
        windowId,
        generation,
        kind: 'horse',
        rawMenuTypeId: null,
        rawEntityId: Number.isSafeInteger(packet.entityId) ? packet.entityId! : null,
        declaredContainerSlotCount: Number.isSafeInteger(packet.nbSlots) && packet.nbSlots! >= 0 && packet.nbSlots! <= MAX_RAW_MENU_SLOTS ? packet.nbSlots! : null,
        titleData: 'Horse',
        titleDataStatus: 'bounded-observed',
        stateId: null,
        contentStatus: 'not-observed',
        observedSlotCount: null,
        slots: null,
        cursor: null,
        syncedProperties: {},
        runtimeBinding: this.getRuntimeBinding(),
      };
      this.rawWindowClosed = false;
      this.earlyWindowSnapshots.delete(windowId);
      const currentWindow = this.bot.currentWindow;
      const pending = this.pendingWindowOpens.get(windowId)!;
      if (currentWindow?.id === windowId && pending.completeContentObserved && pending.observedSlotCount === currentWindow.slots.length) {
        this.windowObservations.set(currentWindow, { ...pending });
        this.pendingWindowOpens.delete(windowId);
        this.stateIds.set(windowId, pending.stateId!);
        this.fullSyncGenerations.set(windowId, 1);
        this.completeSnapshotStateIds.set(windowId, pending.stateId!);
      }
      if (this.active && this.bot.currentWindow !== this.active.window) this.active.finish('uncertain', true);
      return;
    }
    if (name === 'close_window' && Number.isSafeInteger(packet.windowId) && this.rawWindow?.windowId === packet.windowId) {
      this.rawWindowClosed = true;
      return;
    }
    if (name === 'craft_progress_bar' && Number.isInteger(packet.windowId) && Number.isInteger(packet.property) && Number.isSafeInteger(packet.value)) {
      const window = packet.windowId === 0 ? this.bot.inventory : this.bot.currentWindow;
      const pending = this.pendingWindowOpens.get(packet.windowId!);
      if (pending) pending.syncedProperties[packet.property!] = packet.value!;
      else if (window && window.id === packet.windowId) {
        const observation = this.windowObservations.get(window);
        if (observation) observation.syncedProperties[packet.property!] = packet.value!;
      }
      if (this.rawWindow && !this.rawWindowClosed && packet.windowId === this.rawWindow.windowId) this.rawWindow.syncedProperties[packet.property!] = packet.value!;
      return;
    }
    if (name === 'window_items' && Number.isSafeInteger(packet.windowId) && this.rawWindow && !this.rawWindowClosed && packet.windowId === this.rawWindow.windowId) {
      if (Number.isSafeInteger(packet.stateId) && this.rawWindow.stateId !== null && packet.stateId! < this.rawWindow.stateId) return;
      const items = packet.items;
      const cursor = rawSlot(packet.carriedItem, -1);
      if (!Number.isSafeInteger(packet.stateId) || !Array.isArray(items) || items.length > MAX_RAW_MENU_SLOTS || cursor === null || items.some((item, index) => rawSlot(item, index) === null)) {
        this.rawWindow.contentStatus = 'oversized-or-malformed';
        this.rawWindow.slots = null;
        this.rawWindow.cursor = cursor;
        this.rawWindow.observedSlotCount = Array.isArray(items) ? items.length : null;
      } else {
        this.rawWindow.slots = items.map((item, index) => rawSlot(item, index)!);
        this.rawWindow.cursor = cursor;
        this.rawWindow.contentStatus = 'complete-packet-observed';
        this.rawWindow.observedSlotCount = items.length;
      }
      this.rawWindow.stateId = Number.isSafeInteger(packet.stateId) ? packet.stateId! : null;
    }
    if (name === 'set_slot' && Number.isSafeInteger(packet.windowId) && Number.isSafeInteger(packet.slot) && this.rawWindow && !this.rawWindowClosed) {
      if (Number.isSafeInteger(packet.stateId) && this.rawWindow.stateId !== null && packet.stateId! < this.rawWindow.stateId) return;
      const item = rawSlot(packet.item, packet.slot!);
      if (packet.windowId === this.rawWindow.windowId && packet.slot! >= 0 && this.rawWindow.slots) {
        if (!item || packet.slot! >= this.rawWindow.slots.length) {
          this.rawWindow.contentStatus = 'oversized-or-malformed';
          this.rawWindow.slots = null;
        } else {
          this.rawWindow.slots[packet.slot!] = item;
          if (Number.isSafeInteger(packet.stateId)) this.rawWindow.stateId = packet.stateId!;
        }
      } else if ((packet.windowId === -1 && packet.slot === -1) || (packet.windowId === this.rawWindow.windowId && packet.slot === -1)) {
        this.rawWindow.cursor = item;
        if (Number.isSafeInteger(packet.stateId)) this.rawWindow.stateId = packet.stateId!;
      }
    }
    if (name !== 'set_slot' && name !== 'window_items') return;
    if (typeof packet.stateId === 'number' && typeof packet.windowId === 'number' && packet.windowId >= 0) {
      const previousStateId = this.stateIds.get(packet.windowId);
      if (previousStateId !== undefined && packet.stateId < previousStateId) return;
      this.stateIds.set(packet.windowId, packet.stateId);
      const window = packet.windowId === 0 ? this.bot.inventory : this.bot.currentWindow;
      const observation = window?.id === packet.windowId ? this.windowObservations.get(window) : undefined;
      if (observation) observation.stateId = packet.stateId;
    }
    if (name === 'window_items' && typeof packet.windowId === 'number') {
      const items = packet.items;
      const window = packet.windowId === 0 ? this.bot.inventory : this.bot.currentWindow;
      const complete = Array.isArray(items) && window?.id === packet.windowId && items.length === window.slots.length && Number.isSafeInteger(packet.stateId);
      if (complete) {
        this.fullSyncGenerations.set(packet.windowId, (this.fullSyncGenerations.get(packet.windowId) ?? 0) + 1);
        this.completeSnapshotStateIds.set(packet.windowId, packet.stateId!);
      }
      if (packet.windowId !== 0) {
        const pending = this.pendingWindowOpens.get(packet.windowId);
        if (pending) {
          pending.stateId = Number.isSafeInteger(packet.stateId) ? packet.stateId! : null;
          pending.completeContentObserved = complete;
          pending.observedSlotCount = Array.isArray(items) ? items.length : null;
        } else if (!window || window.id !== packet.windowId) {
          this.earlyWindowSnapshots.set(packet.windowId, {
            stateId: Number.isSafeInteger(packet.stateId) ? packet.stateId! : null,
            slotCount: Array.isArray(items) ? items.length : 0,
          });
        } else {
          const observation = this.windowObservations.get(window);
          if (observation) {
            observation.stateId = Number.isSafeInteger(packet.stateId) ? packet.stateId! : null;
            observation.completeContentObserved = complete;
            observation.observedSlotCount = Array.isArray(items) ? items.length : null;
          }
        }
      }
    }

    const action = this.active;
    if (!action) return;
    const matchesWindow = name === 'window_items'
      ? packet.windowId === action.window.id
      : (packet.windowId === action.window.id || (packet.windowId === -1 && packet.slot === -1));
    if (!matchesWindow) return;
    if (action.baselineStateId !== undefined && (typeof packet.stateId !== 'number' || packet.stateId <= action.baselineStateId)) return;

    action.packets.add(name);
    if (typeof packet.stateId === 'number') action.stateIds.add(packet.stateId);
    // Mineflayer's packet listener updates Window synchronously after this
    // listener. A microtask observes the normalized state after that handler.
    queueMicrotask(() => this.observeAppliedPacket(action, name, packet));
  };

  private readonly onWindowClose: WindowListener = (window) => {
    if (this.active?.window === window) this.active.finish('uncertain', true);
  };
  private readonly onWindowOpen: WindowListener = (window) => {
    const pending = this.pendingWindowOpens.get(window.id);
    if (!pending) return;
    this.windowObservations.set(window, {
      ...pending,
      completeContentObserved: pending.completeContentObserved && pending.observedSlotCount === window.slots.length,
    });
    this.pendingWindowOpens.delete(window.id);
  };
  private readonly onEnd = (): void => {
    this.dispose();
  };
  private readonly onRespawn = (): void => {
    this.onSessionBoundary();
  };

  private readonly onSessionBoundary = (): void => {
    const active = this.active;
    active?.finish('uncertain', true);
    this.stateIds.clear();
    this.fullSyncGenerations.clear();
    this.completeSnapshotStateIds.clear();
    this.pendingWindowOpens.clear();
    this.earlyWindowSnapshots.clear();
    this.rawWindow = null;
    this.rawWindowClosed = false;
  };

  constructor(private readonly bot: Bot, private readonly getRuntimeBinding: () => MenuWindowRuntimeBinding | null = () => null) {
    bot._client.on('packet', this.onPacket);
    // BotConnection removes Bot listeners during teardown; the protocol
    // client's end event remains a reliable invalidation boundary.
    bot._client.on('end', this.onEnd);
    bot._client.on('login', this.onSessionBoundary);
    bot._client.on('respawn', this.onSessionBoundary);
    bot.on('windowClose', this.onWindowClose);
    bot.on('windowOpen', this.onWindowOpen);
    bot.on('end', this.onEnd);
    bot.on('respawn', this.onRespawn);
  }

  getStateId(windowId: number): number | undefined {
    return this.stateIds.get(windowId);
  }

  getWindowObservation(window: Window): WindowProtocolObservation | null {
    const observation = this.windowObservations.get(window);
    return observation ? {
      ...observation,
      syncedProperties: { ...observation.syncedProperties },
      runtimeBinding: observation.runtimeBinding ? { ...observation.runtimeBinding } : null,
    } : null;
  }

  getRawMenuObservation(): RawMenuObservation | null {
    if (!this.rawWindow || this.rawWindowClosed) return null;
    return structuredClone(this.rawWindow);
  }

  canStart(window: Window): boolean {
    const fullSync = this.fullSyncGenerations.get(window.id) ?? 0;
    const blockedAt = this.unresolved.get(window);
    if (blockedAt === undefined) return true;
    const currentStateId = this.completeSnapshotStateIds.get(window.id);
    // A repeated window_items packet at the same stateId is not fresh recovery
    // evidence. StateId is not action causality, so recovery only re-enables a
    // later explicit request after a complete, forward-moving snapshot.
    if (fullSync <= blockedAt.fullSyncGeneration || blockedAt.stateId === undefined || currentStateId === undefined || currentStateId <= blockedAt.stateId) return false;
    this.unresolved.delete(window);
    return true;
  }

  start(window: Window, before: WindowState, timeoutMs: number): {
    promise: Promise<InventoryActionResult>;
    markSent: (expected: WindowState) => void;
    finishUncertain: (actionSent: boolean) => void;
    cancel: () => void;
  } {
    if (!this.canStart(window)) throw new Error('previous-window-action-unresolved: wait for a fresh server window_items snapshot before another click');
    if (this.active) throw new Error('window-action-in-progress: wait for the active click to resolve');

    let resolveResult!: (value: InventoryActionResult) => void;
    let settled = false;
    let changedSlots: number[] = [];
    let cursorChanged = false;
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish!: (status: InventoryActionStatus, recoveryRequired: boolean) => void;
    const promise = new Promise<InventoryActionResult>((resolve) => { resolveResult = resolve; });
    const action = {
      window,
      baselineStateId: this.getStateId(window.id),
      baselineFullSyncGeneration: this.fullSyncGenerations.get(window.id) ?? 0,
      expected: before,
      before,
      changedSlots,
      cursorChanged,
      seenSlots: new Set<number>(),
      cursorSeen: false,
      packets: new Set<string>(),
      stateIds: new Set<number>(),
      operationGeneration: ++this.nextOperationGeneration,
      finish: (status: InventoryActionStatus, recoveryRequired: boolean) => finish(status, recoveryRequired),
    };
    this.active = action;

    finish = (status, recoveryRequired) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (this.active === action) this.active = null;
      if (recoveryRequired) this.unresolved.set(window, {
        fullSyncGeneration: this.fullSyncGenerations.get(window.id) ?? action.baselineFullSyncGeneration,
        stateId: this.stateIds.get(window.id),
      });
      resolveResult({
        operationGeneration: action.operationGeneration,
        status,
        actionCausality: 'not-provable-from-container-protocol',
        actionRequested: true,
        actionSent: sent,
        clientObserved: changedSlots.length > 0 || cursorChanged,
        serverConfirmed: status === 'server-confirmed',
        serverPacketsObserved: [...action.packets],
        windowId: window.id,
        baselineStateId: action.baselineStateId ?? null,
        serverStateIdsObserved: [...action.stateIds],
        changedSlots: [...changedSlots],
        cursorChanged,
        recoveryRequired,
        note: status === 'server-confirmed'
          ? 'A newer server-originated slot update or full window snapshot matched the locally observed result.'
          : status === 'server-state-conflict'
            ? 'A newer server-originated update contradicted the local result; the action outcome is not treated as rejected.'
            : 'No complete matching server update was observed. Do not retry this non-idempotent action; inspect after a fresh authoritative window snapshot.',
      });
    };

    timer = setTimeout(() => finish('uncertain', true), timeoutMs);
    return {
      promise,
      markSent: (nextExpected) => {
        sent = true;
        changedSlots = nextExpected.slots.flatMap((item, slot) => sameItem(before.slots[slot] ?? null, item) ? [] : [slot]);
        cursorChanged = !sameItem(before.cursor, nextExpected.cursor);
        action.expected = nextExpected;
        action.changedSlots = changedSlots;
        action.cursorChanged = cursorChanged;
        action.seenSlots.clear();
        action.cursorSeen = false;
      },
      finishUncertain: (actionSent) => {
        sent = actionSent;
        finish('uncertain', true);
      },
      cancel: () => {
        if (timer) clearTimeout(timer);
        if (this.active === action) this.active = null;
      },
    };
  }

  private observeAppliedPacket(action: NonNullable<InventoryActionConfirmationTracker['active']>, name: string, packet: ServerPacket): void {
    if (this.active !== action || this.disposed || this.bot.currentWindow !== action.window) {
      action.finish('uncertain', true);
      return;
    }
    if (name === 'window_items') {
      const matches = equalWindowState(snapshotWindow(action.window), action.expected);
      if (action.baselineStateId === undefined) {
        action.finish('uncertain', false);
      } else if (matches && action.changedSlots.length + Number(action.cursorChanged) > 0) action.finish('server-confirmed', false);
      else if (!matches) action.finish('server-state-conflict', true);
      else action.finish('uncertain', false);
      return;
    }
    if (packet.windowId === -1 && packet.slot === -1) {
      if (sameItem(snapshotItem(action.window.selectedItem), action.expected.cursor)) action.cursorSeen = true;
      else action.finish('server-state-conflict', true);
    } else if (packet.windowId === action.window.id && Number.isInteger(packet.slot) && packet.slot! >= 0) {
      const slot = packet.slot!;
      if (sameItem(snapshotItem(action.window.slots[slot]), action.expected.slots[slot] ?? null)) action.seenSlots.add(slot);
      else action.finish('server-state-conflict', true);
    }
    const slotsConfirmed = action.changedSlots.every((slot) => action.seenSlots.has(slot));
    const cursorConfirmed = !action.cursorChanged || action.cursorSeen;
    if (action.baselineStateId !== undefined && slotsConfirmed && cursorConfirmed && action.changedSlots.length + Number(action.cursorChanged) > 0) {
      action.finish('server-confirmed', false);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bot._client.removeListener('packet', this.onPacket);
    this.bot._client.removeListener('end', this.onEnd);
    this.bot._client.removeListener('login', this.onSessionBoundary);
    this.bot._client.removeListener('respawn', this.onSessionBoundary);
    this.bot.removeListener('windowClose', this.onWindowClose);
    this.bot.removeListener('windowOpen', this.onWindowOpen);
    this.bot.removeListener('end', this.onEnd);
    this.bot.removeListener('respawn', this.onRespawn);
    this.active?.finish('uncertain', true);
    this.stateIds.clear();
    this.fullSyncGenerations.clear();
    this.completeSnapshotStateIds.clear();
    this.pendingWindowOpens.clear();
    this.earlyWindowSnapshots.clear();
    this.rawWindow = null;
    this.rawWindowClosed = false;
  }

}

const trackers = new WeakMap<Bot, InventoryActionConfirmationTracker>();

export function getInventoryActionConfirmationTracker(bot: Bot, getRuntimeBinding?: () => MenuWindowRuntimeBinding | null): InventoryActionConfirmationTracker {
  let tracker = trackers.get(bot);
  if (!tracker) {
    tracker = new InventoryActionConfirmationTracker(bot, getRuntimeBinding);
    trackers.set(bot, tracker);
  }
  return tracker;
}

export function snapshotItem(item: { type: number; count: number; name: string; metadata?: number | null; nbt?: unknown; components?: unknown } | null | undefined): ItemState | null {
  if (!item) return null;
  return {
    type: item.type,
    count: item.count,
    name: item.name,
    metadata: item.metadata ?? null,
    nbt: safeStringify(item.nbt),
    components: safeStringify(item.components),
  };
}

export function snapshotWindow(window: Window): WindowState {
  return { slots: window.slots.map(snapshotItem), cursor: snapshotItem(window.selectedItem) };
}

function sameItem(a: ItemState | null, b: ItemState | null): boolean {
  return a === null || b === null
    ? a === b
    : a.type === b.type && a.count === b.count && a.name === b.name && a.metadata === b.metadata && a.nbt === b.nbt && a.components === b.components;
}

function equalWindowState(a: WindowState, b: WindowState): boolean {
  return a.slots.length === b.slots.length && a.slots.every((item, slot) => sameItem(item, b.slots[slot] ?? null)) && sameItem(a.cursor, b.cursor);
}

function safeStringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try { return JSON.stringify(value) ?? null; } catch { return '[unserializable]'; }
}
