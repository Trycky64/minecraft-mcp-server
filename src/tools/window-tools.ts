import { z } from 'zod';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import type { Window } from 'prismarine-windows';
import { Vec3 } from 'vec3';
import type { ToolFactory } from '../tool-factory.js';
import type { RuntimeRegistryContext } from '../services/runtime-registry-service.js';
import { getInventoryActionConfirmationTracker, snapshotWindow, type MenuWindowRuntimeBinding, type RawMenuObservation, type WindowProtocolObservation } from '../services/inventory-action-confirmation.js';
import { toBoundedJsonValue } from '../services/registry-reporting.js';
import { MenuLayoutRegistry, createVanillaMenuLayoutProvider, type MenuIdentityEvidence, type MenuLayoutProvider } from '../services/menu-layout-registry.js';
import { resolveAuthenticatedRuntimeRegistryId, resolveMenuIdentity, type VersionedMenuTypeDefinition } from '../services/menu-identity-resolver.js';
import { coerceCoordinates } from './coordinate-utils.js';

const MAX_INTERACTION_REACH = 4.5;
const MAX_WINDOW_WAIT_MS = 10_000;
const MAX_SLOT_CLICK_WAIT_MS = 10_000;
const resolvePackage = createRequire(import.meta.url);
const loadPrismarineWindows = createRequire(resolvePackage.resolve('mineflayer'))('prismarine-windows') as (version: string) => {
  windows: Record<string, { type: number | string; inventory: { start: number; end: number }; slots: number; craft: number } | null>;
};

function bindRuntimeContext(context: RuntimeRegistryContext | null): MenuWindowRuntimeBinding | null {
  if (!context) return null;
  return {
    minecraftVersion: context.minecraftVersion,
    minecraftEndpoint: context.minecraftEndpoint,
    serverIdentity: context.serverIdentity,
    registryEpoch: context.registryEpoch,
    runtimeEpoch: context.runtimeEpoch,
    mineflayerSessionId: context.mineflayerSessionId,
    mineflayerRegistryEpoch: context.mineflayerRegistryEpoch,
    bridgeSessionId: context.bridgeSessionId,
    sourceRegistryEpoch: context.sourceRegistryEpoch,
    bridgeAvailable: context.bridgeAvailable,
    bridgeAuthenticated: context.bridgeSession?.authenticated === true,
  };
}

function contextMatchesBinding(context: RuntimeRegistryContext | null, binding: MenuWindowRuntimeBinding | null): context is RuntimeRegistryContext {
  if (!context || !binding) return false;
  const current = bindRuntimeContext(context)!;
  return Object.keys(current).every(key => current[key as keyof MenuWindowRuntimeBinding] === binding[key as keyof MenuWindowRuntimeBinding]);
}

/**
 * A menu observed under a runtime binding is only named in that same context.
 * Once the server, bridge or registry generation changes, neither the runtime
 * registry nor the static vanilla table may reinterpret its numeric type ID.
 */
function resolveObservedMenuIdentity(
  rawMenuTypeId: number | null,
  version: string | null,
  mineflayerTypeHint: string | number,
  binding: MenuWindowRuntimeBinding | null,
  boundContext: RuntimeRegistryContext | null,
): ReturnType<typeof resolveMenuIdentity> {
  if (binding && !boundContext) {
    return {
      identity: { status: 'unresolved', reason: 'runtime-context-changed-since-menu-was-observed', rawNumericTypeId: rawMenuTypeId, mineflayerTypeHint },
      evidence: null,
    };
  }
  return resolveMenuIdentity(rawMenuTypeId, version, mineflayerTypeHint, boundContext, menuVersion =>
    loadPrismarineWindows(menuVersion).windows as Record<string, VersionedMenuTypeDefinition | null>);
}

/** Names a Mineflayer slot item only through the authenticated runtime registry bound to this window. */
function mineflayerSlotIdentity(item: { name: string; type: number }, version: string | null, boundContext: RuntimeRegistryContext | null) {
  const runtimeItem = boundContext && version ? resolveAuthenticatedRuntimeRegistryId('item', item.type, version, boundContext) : null;
  return {
    namespacedId: runtimeItem?.namespacedId ?? null,
    identity: runtimeItem ? 'authenticated-runtime-registry' : item.name === 'unknown' ? 'unresolved' : 'mineflayer-name-only',
    identityProvenance: runtimeItem?.provenance ?? null,
    mineflayerNameStatus: !runtimeItem ? 'not-checked-against-runtime-registry'
      : runtimeItem.namespacedId === `minecraft:${item.name}` ? 'matches-runtime-registry' : 'contradicts-runtime-registry',
  };
}

interface MenuDescription {
  identity: Record<string, unknown>;
  identityEvidence: MenuIdentityEvidence | null;
  layout: Record<string, unknown>;
}

function describeMenu(
  bot: Bot,
  window: Window,
  observation: WindowProtocolObservation | null,
  registryContext: RuntimeRegistryContext | null,
  layoutRegistry: MenuLayoutRegistry,
): MenuDescription {
  if (observation?.kind === 'horse') {
    return {
      identity: { status: 'known-protocol-window-kind', kind: 'horse-entity-inventory', entityId: observation.rawEntityId, rawMenuTypeId: null },
      identityEvidence: null,
      layout: { status: 'unknown', reason: 'horse-entity-slot-layout-varies-and-is-not-described-by-the-open-packet' },
    };
  }
  const rawMenuTypeId = observation?.kind === 'container' ? observation.rawMenuTypeId : null;
  const boundContext = contextMatchesBinding(registryContext, observation?.runtimeBinding ?? null) ? registryContext : null;
  const version = observation?.runtimeBinding?.minecraftVersion ?? boundContext?.minecraftVersion ?? bot.version;
  const resolved = resolveObservedMenuIdentity(rawMenuTypeId, version, window.type, observation?.runtimeBinding ?? null, boundContext);
  const observedSlotCount = observation?.completeContentObserved && observation.observedSlotCount === window.slots.length
    ? observation.observedSlotCount : -1;
  const resolvedLayout = layoutRegistry.resolve(resolved.evidence, {
    observedSlotCount,
    modelSlotCount: window.slots.length,
    modelInventoryRange: { start: window.inventoryStart, endExclusive: window.inventoryEnd },
  });
  const layout = resolvedLayout.status === 'known' ? {
    status: 'known', source: resolvedLayout.source, providerIds: resolvedLayout.providerIds,
    namespacedId: resolvedLayout.contract.namespacedId, totalSlotCount: resolvedLayout.contract.totalSlotCount,
    menuSlots: resolvedLayout.contract.menuSlots ?? null, machineSlots: resolvedLayout.contract.machineSlots ?? null,
    machineInputSlots: resolvedLayout.contract.roles?.filter(role => role.role === 'machine-input').flatMap(role => role.slots) ?? [],
    machineOutputSlots: resolvedLayout.contract.roles?.filter(role => role.role === 'machine-output').flatMap(role => role.slots) ?? [],
    playerInventory: resolvedLayout.contract.playerInventory ?? null, hotbar: resolvedLayout.contract.playerHotbar ?? null,
    controls: resolvedLayout.contract.controls ?? [],
    capabilities: resolvedLayout.contract.capabilities ?? { indexedSlotClick: false, shiftClick: false, drag: false },
  } : resolvedLayout;
  return { identity: resolved.identity, identityEvidence: resolved.evidence, layout };
}

function slotRole(layoutValue: Record<string, unknown>, slot: number): string {
  if (layoutValue.status !== 'known') return 'unknown';
  const layout = layoutValue as Record<string, unknown> & {
    machineInputSlots?: number[]; machineOutputSlots?: number[];
    playerInventory?: { start: number; endExclusive: number }; hotbar?: { start: number; endExclusive: number };
    menuSlots?: { start: number; endExclusive: number } | null;
  };
  if (layout.machineInputSlots?.includes(slot)) return 'machine-input';
  if (layout.machineOutputSlots?.includes(slot)) return 'machine-output';
  if (layout.hotbar && slot >= layout.hotbar.start && slot < layout.hotbar.endExclusive) return 'player-hotbar';
  if (layout.playerInventory && slot >= layout.playerInventory.start && slot < layout.playerInventory.endExclusive) return 'player-inventory';
  if (layout.menuSlots && slot >= layout.menuSlots.start && slot < layout.menuSlots.endExclusive) return 'menu-area-role-unspecified';
  return 'unknown';
}

function windowSnapshot(window: Window | null, bot: Bot, registryContext: RuntimeRegistryContext | null, layoutRegistry: MenuLayoutRegistry): Record<string, unknown> | null {
  if (!window) return null;
  const tracker = getInventoryActionConfirmationTracker(bot);
  const observation = tracker.getWindowObservation(window);
  const menu = describeMenu(bot, window, observation, registryContext, layoutRegistry);
  const layoutKnown = menu.layout.status === 'known';
  const resolvedCapabilities = menu.layout as Record<string, unknown> & { capabilities?: { shiftClick?: boolean; drag?: boolean } };
  const synchronized = observation?.completeContentObserved === true && observation.observedSlotCount === window.slots.length;
  const contextCurrent = contextMatchesBinding(registryContext, observation?.runtimeBinding ?? null);
  const boundContext = contextCurrent ? registryContext : null;
  const version = observation?.runtimeBinding?.minecraftVersion ?? boundContext?.minecraftVersion ?? bot.version;
  return {
    id: window.id,
    generation: observation?.generation ?? null,
    protocolWindowKind: observation?.kind ?? 'unobserved',
    type: window.type,
    mineflayerTypeHint: window.type,
    menuTypeId: observation?.kind === 'container' ? observation.rawMenuTypeId : null,
    mineflayerNumericTypeHint: typeof window.type === 'number' ? window.type : null,
    entityId: observation?.rawEntityId ?? null,
    declaredContainerSlotCount: observation?.declaredContainerSlotCount ?? null,
    menuIdentity: menu.identity,
    runtimeContextBinding: observation?.runtimeBinding ?? null,
    runtimeContextStatus: observation?.runtimeBinding ? (contextMatchesBinding(registryContext, observation.runtimeBinding) ? 'current' : 'changed-or-unavailable') : 'unbound',
    modelStatus: 'mineflayer-window-constructed',
    contentStatus: synchronized ? 'complete-packet-observed' : 'incomplete-or-unobserved',
    layoutStatus: String(menu.layout.status),
    capabilities: {
      inspectSlots: true,
      indexedLeftRightClick: synchronized && contextCurrent,
      shiftClick: synchronized && contextCurrent && layoutKnown && resolvedCapabilities.capabilities?.shiftClick === true,
      drag: false,
      menuButtons: false,
    },
    title: String(window.title),
    stateId: observation?.stateId ?? tracker.getStateId(window.id) ?? null,
    synchronization: observation?.completeContentObserved ? 'complete-window-items-observed' : 'incomplete-or-unobserved',
    observedSlotCount: observation?.observedSlotCount ?? null,
    slotCount: window.slots.length,
    slotCountSemantics: observation?.completeContentObserved && observation.observedSlotCount === window.slots.length
      ? 'observed-in-complete-window-items'
      : 'client-window-model',
    layout: menu.layout,
    syncedProperties: Object.entries(observation?.syncedProperties ?? {}).map(([propertyId, value]) => {
      const semantic = layoutRegistry.resolveSynchronizedProperty(menu.identityEvidence, Number(propertyId));
      return {
        propertyId: Number(propertyId), value,
        semanticField: semantic.status === 'known' ? semantic.name : null,
        semanticsStatus: semantic.status === 'known' ? 'mapped-by-verified-layout-provider' : semantic.status === 'conflict' ? 'provider-conflict-raw-property-only' : 'raw-property-only',
      };
    }).sort((a, b) => a.propertyId - b.propertyId),
    inventoryStart: layoutKnown ? window.inventoryStart : null,
    inventoryEnd: layoutKnown ? window.inventoryEnd : null,
    mineflayerInventoryRangeHint: layoutKnown ? undefined : { start: window.inventoryStart, endExclusive: window.inventoryEnd, trusted: false },
    selectedItem: window.selectedItem ? {
      name: window.selectedItem.name,
      rawNumericId: window.selectedItem.type,
      count: window.selectedItem.count,
      components: toBoundedJsonValue((window.selectedItem as unknown as { components?: unknown }).components),
      ...mineflayerSlotIdentity(window.selectedItem, version, boundContext),
    } : null,
    slots: window.slots.map((item, slot) => item ? {
      slot,
      name: item.name,
      rawNumericId: item.type,
      count: item.count,
      metadata: item.metadata,
      components: toBoundedJsonValue((item as unknown as { components?: unknown }).components),
      ...mineflayerSlotIdentity(item, version, boundContext),
      role: slotRole(menu.layout, slot),
    } : { slot, empty: true, role: slotRole(menu.layout, slot) }),
  };
}

function rawWindowSnapshot(
  raw: RawMenuObservation,
  bot: Bot,
  context: RuntimeRegistryContext | null,
  layoutRegistry: MenuLayoutRegistry,
): Record<string, unknown> {
  const boundContext = contextMatchesBinding(context, raw.runtimeBinding) ? context : null;
  const version = raw.runtimeBinding?.minecraftVersion ?? boundContext?.minecraftVersion ?? bot.version;
  const identity = raw.kind === 'container'
    ? resolveObservedMenuIdentity(raw.rawMenuTypeId, version, raw.rawMenuTypeId ?? 'unknown', raw.runtimeBinding, boundContext)
    : { identity: { status: 'known-protocol-window-kind', kind: 'horse-entity-inventory' }, evidence: null };
  const layoutResolution = layoutRegistry.resolve(identity.evidence, {
    observedSlotCount: raw.contentStatus === 'complete-packet-observed' ? raw.observedSlotCount ?? -1 : -1,
  });
  const layout = layoutResolution.status === 'known' ? {
    status: 'known', source: layoutResolution.source, providerIds: layoutResolution.providerIds,
    totalSlotCount: layoutResolution.contract.totalSlotCount,
    menuSlots: layoutResolution.contract.menuSlots ?? null,
    machineSlots: layoutResolution.contract.machineSlots ?? null,
    playerInventory: layoutResolution.contract.playerInventory ?? null,
    hotbar: layoutResolution.contract.playerHotbar ?? null,
    roles: layoutResolution.contract.roles ?? [],
    controls: layoutResolution.contract.controls ?? [],
    capabilities: layoutResolution.contract.capabilities ?? { indexedSlotClick: false, shiftClick: false, drag: false },
  } : layoutResolution;
  const rawSlotForOutput = (slot: NonNullable<typeof raw.slots>[number]) => {
    const runtimeItem = slot.rawNumericItemId === null || !boundContext || !version
      ? null
      : resolveAuthenticatedRuntimeRegistryId('item', slot.rawNumericItemId, version, boundContext);
    return {
      ...slot,
      namespacedId: runtimeItem?.namespacedId ?? null,
      identity: slot.rawNumericItemId === null ? 'empty' : runtimeItem ? 'authenticated-runtime-registry' : 'unresolved-raw-protocol-item-id',
      identityProvenance: runtimeItem?.provenance ?? null,
      layoutRole: layout.status === 'known'
        ? (layoutResolution.status === 'known' ? layoutResolution.contract.roles?.find(role => role.slots.includes(slot.slot))?.role ?? 'role-unspecified' : 'unknown')
        : 'unknown',
    };
  };
  const slots = raw.slots?.map(rawSlotForOutput) ?? null;
  return {
    mode: 'raw-only-read-only',
    interactionsAllowed: false,
    windowId: raw.windowId,
    generation: raw.generation,
    observationSessionId: raw.observationSessionId,
    menuTypeId: raw.rawMenuTypeId,
    entityId: raw.rawEntityId,
    declaredContainerSlotCount: raw.declaredContainerSlotCount,
    menuIdentity: identity.identity,
    runtimeContextBinding: raw.runtimeBinding,
    runtimeContextStatus: raw.runtimeBinding ? (boundContext ? 'current' : 'changed-or-unavailable') : 'unbound',
    titleData: raw.titleData,
    titleDataTrust: 'untrusted-display-data',
    stateId: raw.stateId,
    contentStatus: raw.contentStatus,
    observedSlotCount: raw.observedSlotCount,
    layout,
    cursor: raw.cursor ? rawSlotForOutput(raw.cursor) : null,
    slots,
    syncedProperties: Object.entries(raw.syncedProperties).map(([propertyId, value]) => {
      const semantic = layoutRegistry.resolveSynchronizedProperty(identity.evidence, Number(propertyId));
      return {
        propertyId: Number(propertyId), value,
        semanticField: semantic.status === 'known' ? semantic.name : null,
        semanticsStatus: semantic.status === 'known' ? 'mapped-by-optional-provider' : semantic.status === 'conflict' ? 'provider-conflict-raw-property-only' : 'raw-property-only',
      };
    }),
    runtimeContext: boundContext ? {
      minecraftVersion: boundContext.minecraftVersion,
      minecraftEndpoint: boundContext.minecraftEndpoint,
      serverIdentity: boundContext.serverIdentity,
      registryEpoch: boundContext.registryEpoch,
      runtimeEpoch: boundContext.runtimeEpoch,
      mineflayerSessionId: boundContext.mineflayerSessionId,
      bridgeSessionId: boundContext.bridgeSessionId,
      bridgeAuthenticated: boundContext.bridgeSession?.authenticated === true,
    } : null,
    itemComponentPayloads: 'omitted; only bounded component type identifiers and counts are exposed',
    interactionCapability: 'unsupported-for-raw-only-window',
  };
}

function waitForWindowOpen(bot: Bot, timeoutMs: number): { promise: Promise<Window | null>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  let settled = false;
  let resolvePromise: (window: Window | null) => void;
  const promise = new Promise<Window | null>((resolve) => { resolvePromise = resolve; });
  const cleanup = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    bot.removeListener('windowOpen', onOpen);
  };
  const onOpen = (window: Window) => {
    cleanup();
    resolvePromise(window);
  };
  bot.on('windowOpen', onOpen);
  timer = setTimeout(() => {
    cleanup();
    resolvePromise(null);
  }, timeoutMs);
  return { promise, cancel: cleanup };
}

async function withEmptyHand<T>(bot: Bot, action: () => Promise<T>): Promise<T> {
  const previousSlot = bot.quickBarSlot;
  const start = bot.inventory.hotbarStart;
  const emptySlot = bot.inventory.slots.findIndex((item, slot) => slot >= start && slot < start + 9 && item === null);
  if (bot.heldItem && emptySlot < 0) throw new Error('interact-block-requires-an-empty-hotbar-slot');
  let changedSlot = false;
  try {
    if (bot.heldItem && emptySlot >= 0) {
      bot.setQuickBarSlot(emptySlot - start);
      changedSlot = true;
      await bot.waitForTicks(1);
    }
    return await action();
  } finally {
    if (changedSlot && bot.quickBarSlot !== previousSlot) {
      bot.setQuickBarSlot(previousSlot);
      await bot.waitForTicks(1);
    }
  }
}

function itemSnapshot(item: { name: string; type: number; count: number } | null | undefined) {
  return item ? { name: item.name, rawNumericId: item.type, count: item.count } : null;
}

export function registerWindowTools(
  factory: ToolFactory,
  getBot: () => Bot,
  getRegistryContext: () => RuntimeRegistryContext | null = () => null,
  optionalLayoutProviders: readonly MenuLayoutProvider[] = [],
): void {
  const layoutRegistry = new MenuLayoutRegistry([
    createVanillaMenuLayoutProvider(version => loadPrismarineWindows(version).windows as Record<string, VersionedMenuTypeDefinition | null>),
    ...optionalLayoutProviders,
  ]);
  // Attach while the Mineflayer session is created so initial window stateId
  // packets are observed before the first non-idempotent click.
  const initialBot = getBot();
  if (initialBot) getInventoryActionConfirmationTracker(initialBot, () => bindRuntimeContext(getRegistryContext()));
  factory.registerTool('interact-block', 'Interact with a loaded block through the normal Minecraft use-on-block protocol; provide the raw state ID and registry epoch just observed to prevent stale-target actions', {
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2048).max(2048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
    expectedStateId: z.number().int().min(0).max(2_147_483_647),
    registryEpoch: z.string().min(1).max(200),
    timeoutMs: z.number().int().min(50).max(MAX_WINDOW_WAIT_MS).default(3000),
  }, async ({ x, y, z: zCoord, expectedStateId, registryEpoch, timeoutMs }: { x: number; y: number; z: number; expectedStateId: number; registryEpoch: string; timeoutMs: number }) => {
    const coordinates = coerceCoordinates(x, y, zCoord);
    const bot = getBot();
    getInventoryActionConfirmationTracker(bot);
    if (getRegistryContext()?.registryEpoch !== registryEpoch) return factory.createErrorResponse('stale-registry-epoch: re-observe the block in the current session');
    if (bot.currentWindow) return factory.createErrorResponse('close-or-inspect-the-current-window-before-interacting-with-another-block');
    const position = new Vec3(coordinates.x, coordinates.y, coordinates.z);
    const block = bot.blockAt(position);
    if (!block) return factory.createErrorResponse('interact-block-target-chunk-not-loaded');
    if (block.stateId !== expectedStateId) return factory.createErrorResponse(`interact-block-state-changed: expected ${expectedStateId}, observed ${block.stateId}`);
    if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > MAX_INTERACTION_REACH) {
      return factory.createErrorResponse(`interact-block-out-of-reach: maximum distance is ${MAX_INTERACTION_REACH} blocks`);
    }

    const waiter = waitForWindowOpen(bot, timeoutMs);
    try {
      await withEmptyHand(bot, () => bot.activateBlock(block));
      const opened = await waiter.promise;
      const current = bot.blockAt(position);
      const rawObservation = getInventoryActionConfirmationTracker(bot).getRawMenuObservation();
      const runtimeContext = getRegistryContext();
      return factory.createResponse(JSON.stringify({
        status: opened ? 'menu-opened' : rawObservation ? 'raw-only-window-observed' : 'interaction-sent-no-menu-observed',
        actionRequested: true,
        actionSent: true,
        clientObserved: opened !== null || rawObservation !== null,
        serverConfirmed: false,
        serverObservation: opened
          ? 'Mineflayer emitted windowOpen after receiving and initializing a server-created window.'
          : rawObservation ? 'A server-originated open/content packet was captured; no Mineflayer Window was constructed.' : null,
        windowConstructionStatus: opened ? 'mineflayer-window-constructed' : rawObservation ? 'mineflayer-window-not-constructed-raw-view-available' : 'no-window-packet-observed',
        interaction: 'normal-server-validated-use-on-block',
        target: {
          coordinates: { x: coordinates.x, y: coordinates.y, z: coordinates.z },
          expectedStateId,
          registryEpoch,
          stateIdAfterInteraction: current?.stateId ?? null,
          mineflayerName: block.name,
          identity: block.name === 'unknown' ? 'unresolved-raw-state-only' : 'mineflayer-name-not-runtime-authority',
        },
        window: windowSnapshot(opened, bot, runtimeContext, layoutRegistry),
        rawWindow: rawObservation ? rawWindowSnapshot(rawObservation, bot, runtimeContext, layoutRegistry) : null,
      }, null, 2));
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  });

  factory.registerTool('inspect-open-window', 'Read the active Mineflayer window or, when Mineflayer cannot construct it, a bounded raw packet observation', {}, async () => {
    const bot = getBot();
    const window = bot.currentWindow;
    const registryEpoch = getRegistryContext()?.registryEpoch ?? null;
    const tracker = getInventoryActionConfirmationTracker(bot);
    const rawObservation = tracker.getRawMenuObservation();
    return factory.createResponse(JSON.stringify({
      status: window ? 'open' : rawObservation ? 'raw-only-window-observed' : 'no-window',
      registryEpoch,
      window: windowSnapshot(window, bot, getRegistryContext(), layoutRegistry),
      rawWindow: rawObservation ? rawWindowSnapshot(rawObservation, bot, getRegistryContext(), layoutRegistry) : null,
    }, null, 2));
  });

  factory.registerTool('click-window-slot', 'Click a slot in the active window using a normal server-validated Minecraft menu click', {
    windowId: z.number().int().min(1).max(255),
    windowGeneration: z.number().int().min(1).optional(),
    slot: z.number().int().min(0).max(255),
    action: z.enum(['left', 'right', 'shift']),
    registryEpoch: z.string().min(1).max(200),
    timeoutMs: z.number().int().min(50).max(MAX_SLOT_CLICK_WAIT_MS).default(3000),
  }, async ({ windowId, windowGeneration, slot, action, registryEpoch, timeoutMs = 3000 }: { windowId: number; windowGeneration?: number; slot: number; action: 'left' | 'right' | 'shift'; registryEpoch: string; timeoutMs?: number }) => {
    const bot = getBot();
    if (getRegistryContext()?.registryEpoch !== registryEpoch) return factory.createErrorResponse('stale-registry-epoch: inspect the active window in the current session');
    const window = bot.currentWindow;
    if (!window) return factory.createErrorResponse('no-window-open');
    if (window.id !== windowId) return factory.createErrorResponse(`stale-window-id: active window is ${window.id}`);
    if (slot >= window.slots.length) return factory.createErrorResponse(`slot-out-of-range: window has ${window.slots.length} slots`);
    const tracker = getInventoryActionConfirmationTracker(bot);
    const observation = tracker.getWindowObservation(window);
    if (!observation?.completeContentObserved || tracker.getStateId(window.id) === undefined) {
      return factory.createErrorResponse('window-content-not-authoritatively-synchronized: inspect or reopen this window after a complete server window_items packet');
    }
    if ((observation.generation > 1 && windowGeneration === undefined) || (windowGeneration !== undefined && windowGeneration !== observation.generation)) {
      return factory.createErrorResponse(`stale-or-missing-window-generation: active generation is ${observation.generation}`);
    }
    if (!contextMatchesBinding(getRegistryContext(), observation.runtimeBinding)) {
      return factory.createErrorResponse('stale-window-runtime-context: reopen the menu in the current server and bridge epoch before clicking');
    }
    const menu = describeMenu(bot, window, observation, getRegistryContext(), layoutRegistry);
    const capabilities = menu.layout as Record<string, unknown> & { capabilities?: { shiftClick?: boolean } };
    if (action === 'shift' && (menu.layout.status !== 'known' || capabilities.capabilities?.shiftClick !== true)) {
      return factory.createErrorResponse(menu.layout.status === 'known'
        ? 'shift-click-refused: no applicable provider explicitly declares shift-click behavior'
        : 'shift-click-refused: slot disposition is unknown for this menu; use an explicitly observed slot with left/right action only if its exact index is intended');
    }
    if (!tracker.canStart(window)) return factory.createErrorResponse('previous-window-action-unresolved: wait for a fresh server window_items snapshot before another click');
    const beforeState = snapshotWindow(window);
    const before = itemSnapshot(window.slots[slot]);
    const mouseButton = action === 'right' ? 1 : 0;
    const mode = action === 'shift' ? 1 : 0;
    const confirmation = tracker.start(window, beforeState, timeoutMs);
    try {
      const click = bot.clickWindow(slot, mouseButton, mode);
      confirmation.markSent(snapshotWindow(window));
      // Mineflayer's promise can resolve from an optimistic local update. Its
      // completion is intentionally not used as a server acknowledgement.
      void click.catch(() => confirmation.finishUncertain(true));
    } catch {
      confirmation.finishUncertain(false);
    }
    const result = await confirmation.promise;
    const afterWindow = bot.currentWindow === window ? window : null;
    const after = afterWindow ? itemSnapshot(afterWindow.slots[slot]) : null;
    const changedSlots = result.changedSlots.map((changedSlot) => ({
      slot: changedSlot,
      before: beforeState.slots[changedSlot] ?? null,
      after: result.status === 'server-state-conflict' || afterWindow ? snapshotWindow(window).slots[changedSlot] ?? null : null,
    }));
    return factory.createResponse(JSON.stringify({
      status: result.status,
      operationGeneration: result.operationGeneration,
      actionRequested: result.actionRequested,
      actionSent: result.actionSent,
      clientObserved: result.clientObserved,
      serverConfirmed: result.serverConfirmed,
      serverConfirmationSemantics: result.serverConfirmed
        ? 'matching server state observed; protocol does not prove this click caused it'
        : 'no matching server state confirmation',
      actionCausality: result.actionCausality,
      clickConfirmation: 'Mineflayer clickWindow invocation is reported separately from the server-originated slot evidence below.',
      serverPacketsObserved: result.serverPacketsObserved,
      serverStateIdsObserved: result.serverStateIdsObserved,
      baselineStateId: result.baselineStateId,
      recoveryRequired: result.recoveryRequired,
      registryEpoch,
      windowGeneration: observation.generation,
      menuTypeId: observation.rawMenuTypeId,
      menuIdentity: menu.identity,
      layout: menu.layout,
      slotInterpretation: menu.layout.status === 'known' ? 'version-specific-known-layout' : 'explicit-protocol-slot-index-only',
      transferStatus: result.status === 'server-confirmed' ? 'server-state-update-matched' : result.status === 'server-state-conflict' ? 'server-state-conflicted-with-local-model' : result.clientObserved ? 'client-slot-or-cursor-delta-only' : 'no-transfer-confirmed-outcome-uncertain',
      windowId,
      slot,
      action,
      before,
      after,
      cursorBefore: beforeState.cursor,
      cursorAfter: afterWindow ? snapshotWindow(window).cursor : null,
      changedSlots,
      windowStillOpen: afterWindow?.id === windowId,
      note: result.note,
    }, null, 2));
  });

  factory.registerTool('close-open-window', 'Close the active Minecraft window through the normal protocol lifecycle', {
    windowId: z.number().int().min(1).max(255),
    windowGeneration: z.number().int().min(1).optional(),
    registryEpoch: z.string().min(1).max(200),
  }, async ({ windowId, windowGeneration, registryEpoch }: { windowId: number; windowGeneration?: number; registryEpoch: string }) => {
    const bot = getBot();
    if (getRegistryContext()?.registryEpoch !== registryEpoch) return factory.createErrorResponse('stale-registry-epoch: inspect the active window in the current session');
    const window = bot.currentWindow;
    if (!window) return factory.createResponse(JSON.stringify({ status: 'no-window-open' }));
    if (window.id !== windowId) return factory.createErrorResponse(`stale-window-id: active window is ${window.id}`);
    const observation = getInventoryActionConfirmationTracker(bot).getWindowObservation(window);
    if (!observation) return factory.createErrorResponse('window-generation-unavailable: close is refused until this open window has been observed by the current tracker');
    if ((observation.generation > 1 && windowGeneration === undefined) || (windowGeneration !== undefined && windowGeneration !== observation.generation)) {
      return factory.createErrorResponse(`stale-or-missing-window-generation: active generation is ${observation.generation}`);
    }
    if (!contextMatchesBinding(getRegistryContext(), observation.runtimeBinding)) {
      return factory.createErrorResponse('stale-window-runtime-context: menu close refused after server or bridge epoch changed');
    }
    await bot.closeWindow(window);
    return factory.createResponse(JSON.stringify({
      status: 'close-request-sent',
      actionRequested: true,
      actionSent: true,
      clientObservedClosed: bot.currentWindow !== window,
      serverConfirmed: false,
      windowId,
      note: 'Mineflayer cleared its local window after sending close_window; this is not an independent server acknowledgement.',
    }));
  });
}
