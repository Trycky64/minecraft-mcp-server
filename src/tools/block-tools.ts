import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';
import { coerceCoordinates } from './coordinate-utils.js';
import type { RuntimeRegistryContext } from '../services/runtime-registry-service.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
const MAX_FIND_BLOCKS_COUNT = 256;
const MAX_FIND_BLOCKS_DISTANCE = 32;
const MAX_SCANNED_BLOCKS = 150_000;
const MAX_DIG_DISTANCE = 32;
const DEFAULT_DIG_TIMEOUT_MS = 15_000;
const MAX_DIG_TIMEOUT_MS = 30_000;
const DIG_SETTLE_TICKS = 10;

function inventoryCounts(bot: mineflayer.Bot): Map<number, number> {
  const counts = new Map<number, number>();
  for (const item of bot.inventory?.items?.() ?? []) counts.set(item.type, (counts.get(item.type) ?? 0) + item.count);
  return counts;
}

function droppedItemsNear(bot: mineflayer.Bot, center: Vec3, excludedIds: Set<number>) {
  return Object.values(bot.entities ?? {}).flatMap((entity) => {
    if (excludedIds.has(entity.id) || entity.position.distanceTo(center) > 6) return [];
    const item = entity.getDroppedItem?.();
    return item ? [{ entityId: entity.id, rawNumericId: item.type, name: item.name, count: item.count }] : [];
  });
}

async function withEmptyHand<T>(bot: mineflayer.Bot, action: () => Promise<T>): Promise<T> {
  if (!bot.heldItem) return action();
  const previousSlot = bot.quickBarSlot;
  const start = bot.inventory.hotbarStart;
  const emptySlot = bot.inventory.slots.findIndex((item, slot) => slot >= start && slot < start + 9 && item === null);
  if (emptySlot < 0) throw new Error('dig-block-requires-an-empty-hotbar-slot-to-preserve-the-held-item');
  let changedSlot = false;
  try {
    bot.setQuickBarSlot(emptySlot - start);
    changedSlot = true;
    await bot.waitForTicks(1);
    return await action();
  } finally {
    if (changedSlot && bot.quickBarSlot !== previousSlot) {
      bot.setQuickBarSlot(previousSlot);
      await bot.waitForTicks(1);
    }
  }
}

interface FaceOption {
  direction: string;
  vector: Vec3;
}

export function registerBlockTools(
  factory: ToolFactory,
  getBot: () => mineflayer.Bot,
  getRegistryContext: () => RuntimeRegistryContext | null = () => null,
): void {
  factory.registerTool(
    "place-block",
    "Place a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      faceDirection: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Direction to place against (default: 'down')"),
      itemId: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/).optional().describe("Optional namespaced item to place; modded items require a runtime mapping for this session"),
      timeoutMs: z.number().int().min(100).max(30_000).optional().describe('Maximum time for placement pathfinding (default 15 seconds, max 30 seconds)')
    },
    async ({ x, y, z, faceDirection = 'down', itemId, timeoutMs = 15_000 }: { x: number, y: number, z: number, faceDirection?: FaceDirection, itemId?: string, timeoutMs?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      let itemToPlace: ReturnType<typeof bot.inventory.items>[number] | null = null;
      const previousHeldItem = bot.heldItem;
      if (itemId !== undefined) {
        const context = getRegistryContext();
        if (!context?.registryService || !context.minecraftVersion || !context.registryEpoch) {
          return factory.createErrorResponse(`Cannot place ${itemId}: no active runtime registry session is available`);
        }
        const resolution = context.registryService.resolve({
          kind: 'item', minecraftVersion: context.minecraftVersion,
          registryEpoch: context.registryEpoch, namespacedId: itemId,
        });
        if (resolution.status !== 'resolved' || resolution.provenance.source === 'minecraft-data' || resolution.provenance.registryEpoch !== context.registryEpoch || resolution.entry.numericId === undefined) {
          return factory.createErrorResponse(`Cannot safely place ${itemId}: an authoritative item-to-ID mapping has not been observed for this session`);
        }
        itemToPlace = bot.inventory.items().find((item) => item.type === resolution.entry.numericId) ?? null;
        if (!itemToPlace) {
          return factory.createErrorResponse(`Cannot place ${itemId}: no matching stack is present in the bot inventory`);
        }
      } else if (bot.heldItem?.name === 'unknown') {
        return factory.createErrorResponse(`Cannot safely place with unresolved held item ID ${bot.heldItem.type}; specify a namespaced item with an authoritative current-session mapping`);
      }
      const placePos = new Vec3(x, y, z).floored();
      ({ x, y, z } = placePos);

      const botPos = bot.entity.position.floored();
      if (placePos.equals(botPos) || placePos.equals(botPos.offset(0, 1, 0))) {
        return factory.createResponse(`You can't place a block where you're standing or one block above`);
      }

      const blockAtPos = bot.blockAt(placePos);

      if (!blockAtPos) {
        return factory.createResponse(`Cannot safely place at (${x}, ${y}, ${z}): target chunk is not loaded`);
      }

      if (blockAtPos && blockAtPos.name !== 'air') {
        return factory.createResponse(`There's already a block (${blockAtPos.name}) at (${x}, ${y}, ${z})`);
      }
      const stateBeforePlacement = blockAtPos.stateId;

      const possibleFaces: FaceOption[] = [
        { direction: 'down', vector: new Vec3(0, -1, 0) },
        { direction: 'north', vector: new Vec3(0, 0, -1) },
        { direction: 'south', vector: new Vec3(0, 0, 1) },
        { direction: 'east', vector: new Vec3(1, 0, 0) },
        { direction: 'west', vector: new Vec3(-1, 0, 0) },
        { direction: 'up', vector: new Vec3(0, 1, 0) }
      ];

      if (faceDirection !== 'down') {
        const specificFace = possibleFaces.find(face => face.direction === faceDirection);
        if (specificFace) {
          possibleFaces.unshift(possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]);
        }
      }

      let unresolvedReferenceCount = 0;
      for (const face of possibleFaces) {
        const referencePos = placePos.plus(face.vector);
        const referenceBlock = bot.blockAt(referencePos);

        if (referenceBlock?.name === 'unknown') {
          unresolvedReferenceCount += 1;
          continue;
        }
        if (referenceBlock && referenceBlock.name !== 'air') {
          const referenceStateId = referenceBlock.stateId;
          if (!bot.canSeeBlock(referenceBlock)) {
            const goal = new goals.GoalNear(referencePos.x, referencePos.y, referencePos.z, 2);
            await pathfindForPlacement(bot, goal, timeoutMs);
          }

          const currentTarget = bot.blockAt(placePos);
          if (!currentTarget || currentTarget.name !== 'air' || currentTarget.stateId !== stateBeforePlacement) {
            return factory.createErrorResponse(`Placement target changed while approaching (${x}, ${y}, ${z}); no placement packet was sent`);
          }
          const currentReference = bot.blockAt(referencePos);
          if (!currentReference || currentReference.name === 'air' || currentReference.name === 'unknown' || currentReference.stateId !== referenceStateId) {
            continue;
          }

          await bot.lookAt(placePos, true);

          try {
            if (itemToPlace && itemToPlace !== bot.heldItem) await bot.equip(itemToPlace, 'hand');
            await bot.placeBlock(currentReference, face.vector.scaled(-1));
          } catch (placeError) {
            if (itemToPlace && previousHeldItem && bot.heldItem !== previousHeldItem) {
              try { await bot.equip(previousHeldItem, 'hand'); } catch { /* Keep the original placement failure visible. */ }
            }
            log('warn', `Block placement attempt failed for face ${face.direction}.`);
            return factory.createErrorResponse(`Placement attempt through ${face.direction} did not complete cleanly; no retry was sent because the server-side result may be uncertain: ${placeError instanceof Error ? placeError.message : String(placeError)}`);
          }
          const observed = bot.blockAt(placePos);
          const stateChanged = stateBeforePlacement !== undefined && observed?.stateId !== undefined && observed.stateId !== stateBeforePlacement;
          const namedBlockObserved = observed !== null && observed !== undefined && observed.name !== 'air' && observed.name !== 'unknown';
          const confirmed = observed !== null && observed !== undefined && (stateChanged || namedBlockObserved);
          if (itemToPlace && previousHeldItem && previousHeldItem !== itemToPlace) {
            try { await bot.equip(previousHeldItem, 'hand'); }
            catch { log('warn', 'Block placement completed but hotbar restoration failed.'); }
          }
          if (!confirmed) {
            return factory.createErrorResponse(`Mineflayer accepted the placement request at (${x}, ${y}, ${z}), but the resulting block state was not confirmed in the loaded-world cache`);
          }
          if (observed.name === 'unknown') {
            return factory.createResponse(JSON.stringify({ status: 'placement-observed-client-cache', actionRequested: true, actionSent: true,
              clientObserved: { x, y, z, rawStateId: observed.stateId }, serverConfirmed: false,
              note: 'The resulting raw state changed in Mineflayer cache; the modded block name remains unresolved.' }));
          }
          return factory.createResponse(JSON.stringify({ status: 'placement-observed-client-cache', actionRequested: true, actionSent: true,
            clientObserved: { x, y, z, name: observed.name, rawStateId: observed.stateId, face: face.direction }, serverConfirmed: false,
            note: 'The non-air block was observed in Mineflayer cache; no independent server-side confirmation was performed.' }));
        }
      }

      return unresolvedReferenceCount > 0
        ? factory.createErrorResponse(`Cannot safely place block at (${x}, ${y}, ${z}): ${unresolvedReferenceCount} potential reference block(s) have unresolved Mineflayer definitions`)
        : factory.createResponse(`Failed to place block at (${x}, ${y}, ${z}): No suitable reference block found`);
    }
  );

  factory.registerTool(
    "dig-block",
    "Dig a loaded block within 32 blocks with a bounded timeout and state confirmation",
    {
      x: z.coerce.number().finite().min(-30_000_000).max(30_000_000).describe("X coordinate"),
      y: z.coerce.number().finite().min(-2048).max(2048).describe("Y coordinate"),
      z: z.coerce.number().finite().min(-30_000_000).max(30_000_000).describe("Z coordinate"),
      timeoutMs: z.number().int().min(100).max(MAX_DIG_TIMEOUT_MS).optional().describe("Maximum time for pathfinding or digging (default 15000ms, max 30000ms)"),
    },
    async ({ x, y, z, timeoutMs = DEFAULT_DIG_TIMEOUT_MS }: { x: number; y: number; z: number; timeoutMs?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      let block = bot.blockAt(blockPos);

      if (!block) {
        return factory.createResponse(`No block data loaded at position (${x}, ${y}, ${z}); chunk is not loaded`);
      }
      if (block.name === 'air') {
        return factory.createResponse(`No block found at position (${x}, ${y}, ${z})`);
      }
      if (block.name === 'unknown') {
        return factory.createErrorResponse(`Cannot safely dig unresolved Mineflayer block at (${x}, ${y}, ${z}); raw state ID: ${block.stateId}`);
      }
      if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > MAX_DIG_DISTANCE) {
        return factory.createErrorResponse(`Dig target is too far; maximum distance is ${MAX_DIG_DISTANCE} blocks`);
      }
      const initialStateId = block.stateId;
      const inventoryBefore = inventoryCounts(bot);
      const droppedBefore = new Set(droppedItemsNear(bot, blockPos, new Set()).map((item) => item.entityId));

      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
        const goal = new goals.GoalNear(x, y, z, 1);
        const path = bot.pathfinder.goto(goal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Dig pathfinding timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        try {
          await Promise.race([path, timeout]);
        } catch (error) {
          if (timedOut) bot.pathfinder.stop();
          path.catch(() => {});
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
        block = bot.blockAt(blockPos);
        if (!block || block.stateId !== initialStateId || block.name === 'air' || block.name === 'unknown') {
          return factory.createErrorResponse('Dig target changed or became unresolved while pathfinding; no dig action was sent');
        }
      }

      const canDigAfterApproach = bot.canDigBlock(block);
      const canSeeAfterApproach = bot.canSeeBlock(block);
      if (!canDigAfterApproach || !canSeeAfterApproach) {
        const distance = bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5));
        return factory.createErrorResponse(JSON.stringify({
          status: 'dig-not-sent',
          reason: !canDigAfterApproach ? 'out-of-reach-or-not-diggable' : 'line-of-sight-obstructed',
          canDigBlock: canDigAfterApproach,
          canSeeBlock: canSeeAfterApproach,
          distanceToBlockCenter: distance,
          maxDigDistance: MAX_DIG_DISTANCE,
          targetStateId: block.stateId,
          position: { x: block.position.x, y: block.position.y, z: block.position.z },
        }));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        await withEmptyHand(bot, async () => {
          const dig = bot.dig(block);
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
          reject(new Error(`dig-timeout-result-uncertain-no-retry: stop-digging was sent after ${timeoutMs}ms; re-observe the target before any new dig request`));
            }, timeoutMs);
          });
          try {
            await Promise.race([dig, timeout]);
          } catch (error) {
            if (timedOut) bot.stopDigging();
            dig.catch(() => {});
            throw error;
          }
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      const observed = bot.blockAt(blockPos);
      if (!observed || observed.name !== 'air') {
        return factory.createErrorResponse(`Dig request completed but the final block state was not confirmed as air at (${x}, ${y}, ${z})`);
      }
      await bot.waitForTicks(DIG_SETTLE_TICKS);
      const inventoryAfter = inventoryCounts(bot);
      const inventoryGains = [...inventoryAfter.entries()].flatMap(([rawNumericId, count]) => {
        const gained = count - (inventoryBefore.get(rawNumericId) ?? 0);
        if (gained <= 0) return [];
        const item = bot.inventory?.items?.().find((candidate) => candidate.type === rawNumericId);
        return [{ rawNumericId, count: gained, mineflayerName: item?.name ?? 'unknown', identity: item?.name === 'unknown' || !item ? 'unresolved' : 'mineflayer-name-only' }];
      });
      const nearbyDrops = droppedItemsNear(bot, blockPos, droppedBefore);
      const dropObservation = nearbyDrops.length > 0
        ? 'new-dropped-item-entity-observed'
        : inventoryGains.length > 0
          ? 'inventory-increase-observed-during-dig-window-source-not-independently-proven'
          : 'no-drop-observed';
      return factory.createResponse(JSON.stringify({
        status: 'block-mined-observed-client-cache',
        actionRequested: true,
        actionSent: true,
        clientObservedAir: true,
        serverConfirmed: false,
        block: { coordinates: { x, y, z }, mineflayerName: block.name, rawStateIdBefore: initialStateId, rawStateIdAfter: observed.stateId },
        dropObservation,
        dropEntities: nearbyDrops,
        collectionStatus: inventoryGains.length > 0 ? 'inventory-increase-observed-client-side' : 'not-confirmed',
        inventoryGains,
        note: 'A mined block does not prove a drop was generated; only a new item entity or an inventory count increase is reported as observed.',
      }, null, 2));
    }
  );

  factory.registerTool(
    "get-block-info",
    "Get information about a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block) {
        return factory.createResponse(`No block information found at position (${x}, ${y}, ${z}); chunk is not loaded`);
      }

      const context = getRegistryContext();
      const stateId = Number.isSafeInteger(block.stateId) ? block.stateId : null;
      const rawBlockId = Number.isSafeInteger(block.type) ? block.type : null;
      const stateResolution = stateId === null || !context?.registryService || !context.minecraftVersion
        ? null
        : context.registryService.resolve({ kind: 'blockState', minecraftVersion: context.minecraftVersion, registryEpoch: context.registryEpoch ?? undefined, numericId: stateId });
      const blockResolution = rawBlockId === null || !context?.registryService || !context.minecraftVersion
        ? null
        : context.registryService.resolve({ kind: 'block', minecraftVersion: context.minecraftVersion, registryEpoch: context.registryEpoch ?? undefined, numericId: rawBlockId });
      const resolution = stateResolution?.status === 'resolved'
        ? stateResolution
        : blockResolution?.status === 'resolved'
          ? blockResolution
          : stateResolution ?? blockResolution;
      let properties: unknown = undefined;
      if (stateResolution?.status === 'resolved' && stateResolution.entry.blockStateProperties) {
        properties = stateResolution.entry.blockStateProperties;
      }
      const propertiesAreGrounded = stateId === null ? resolution?.status === 'resolved' : stateResolution?.status === 'resolved';
      if (properties === undefined && propertiesAreGrounded && typeof block.getProperties === 'function') {
        try { properties ??= block.getProperties(); } catch { /* Preserve bridge properties when Mineflayer parsing fails. */ }
      }
      const details = {
        coordinates: { x: block.position.x, y: block.position.y, z: block.position.z },
        rawStateId: stateId,
        rawBlockId,
        namespacedId: resolution?.status === 'resolved' ? resolution.entry.namespacedId : null,
        resolutionStatus: resolution?.status ?? 'unavailable',
        provenance: resolution?.status === 'resolved' ? resolution.provenance : null,
        identityConfidence: resolution?.status === 'resolved' && resolution.provenance.source !== 'minecraft-data'
          ? 'session-observed'
          : (block.name !== 'unknown' ? 'version-static-candidate' : 'unresolved'),
        staticCandidate: block.name !== 'unknown' && context?.registryService && context.minecraftVersion
          ? (() => {
            const key = block.name.includes(':') ? block.name : `minecraft:${block.name}`;
            const candidate = context.registryService.resolve({ kind: 'block', minecraftVersion: context.minecraftVersion, namespacedId: key, registryEpoch: `minecraft-data:${context.minecraftVersion}` });
            return candidate.status === 'resolved' && candidate.provenance.source === 'minecraft-data'
              ? { namespacedId: candidate.entry.namespacedId, numericId: candidate.entry.numericId ?? null, provenance: candidate.provenance }
              : null;
          })()
          : null,
        runtimeNumericIdVerified: resolution?.status === 'resolved' && resolution.provenance.source !== 'minecraft-data' && resolution.provenance.registryEpoch === context?.registryEpoch,
        properties: resolution?.status === 'resolved' ? properties ?? null : null,
        minecraftVersion: context?.minecraftVersion ?? bot.version,
        registryEpoch: context?.registryEpoch ?? null,
        mineflayerName: block.name,
        mineflayerNameReliable: block.name !== 'unknown',
        mineflayerNameConfidence: block.name !== 'unknown' ? 'version-static' : 'unresolved',
        mineflayerType: block.type ?? null,
        diggable: block.diggable,
        canDigBlock: (() => { try { return bot.canDigBlock(block); } catch { return null; } })(),
        canSeeBlock: (() => { try { return bot.canSeeBlock(block); } catch { return null; } })(),
        distanceToBlockCenter: (() => { try { return bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)); } catch { return null; } })(),
      };
      return factory.createResponse(`Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z})\nRegistry details (JSON):\n${JSON.stringify(details)}`);
    }
  );

  factory.registerTool(
    "find-blocks",
    "Find one or more nearby blocks of a specific type",
    {
      blockType: z.string().describe("Type of block to find"),
      maxDistance: z.coerce.number().finite().positive().optional().describe("Maximum search distance (default: 16; capped at 32)"),
      count: z.coerce.number().int().positive().optional().describe("Maximum number of blocks to return (default: 1; values above 256 are clamped)")
    },
    async ({ blockType, maxDistance = 16, count = 1 }) => {
      const bot = getBot();
      const context = getRegistryContext();
      const normalizedCount = Math.min(count, MAX_FIND_BLOCKS_COUNT);
      const boundedDistance = Math.min(maxDistance, MAX_FIND_BLOCKS_DISTANCE);
      const namespacedId = blockType.includes(':') ? blockType : `minecraft:${blockType}`;
      const version = context?.minecraftVersion ?? bot.version;
      const service = context?.registryService;
      const blockResolution = service?.resolve({ kind: 'block', minecraftVersion: version, registryEpoch: context?.registryEpoch ?? undefined, namespacedId });
      const stateEntries = service?.getEntries({ kind: 'blockState', minecraftVersion: version, namespacedId, registryEpoch: context?.registryEpoch ?? undefined, limit: null }) ?? [];
      const runtimeStateEntries = stateEntries.filter((entry) => entry.provenance.source !== 'minecraft-data' && entry.registryEpoch === context?.registryEpoch);
      const candidateStateEntries = runtimeStateEntries.length > 0 ? runtimeStateEntries : stateEntries;
      const stateIds = [...new Set(candidateStateEntries.flatMap((entry) => Number.isSafeInteger(entry.numericId) ? [entry.numericId!] : []))];
      const mappingConfidence = runtimeStateEntries.length > 0 ? 'session-observed' : 'version-static-unverified';
      const completeRuntimeStateCoverage = service?.getSnapshots().some((snapshot) =>
        snapshot.source !== 'minecraft-data' && snapshot.registryEpoch === context?.registryEpoch &&
        snapshot.availableRegistries.includes('blockState') && snapshot.registryCoverage?.blockState === 'complete',
      ) ?? false;

      if (blockResolution?.status !== 'resolved' && stateEntries.length === 0) {
        const status = blockResolution?.status ?? 'unavailable';
        return factory.createResponse(JSON.stringify({ status, reason: 'block-identifier-not-resolved', requested: namespacedId, resolution: blockResolution ?? null }));
      }
      if (stateIds.length === 0) {
        return factory.createResponse(JSON.stringify({ status: 'unresolved', reason: 'block-state-ids-unavailable', requested: namespacedId, blockResolution }));
      }

      const center = bot.entity.position.floored();
      const dimension = bot.game as typeof bot.game & { minY?: number; height?: number };
      const minY = Number.isFinite(dimension?.minY) ? dimension.minY! : center.y - boundedDistance;
      const maxY = Number.isFinite(dimension?.height) ? minY + dimension.height! - 1 : center.y + boundedDistance;
      const minX = Math.floor(center.x - boundedDistance);
      const maxX = Math.floor(center.x + boundedDistance);
      const minZ = Math.floor(center.z - boundedDistance);
      const maxZ = Math.floor(center.z + boundedDistance);
      const matchesFound: Array<{ x: number; y: number; z: number; stateId: number }> = [];
      let scanned = 0;
      let unloadedPositions = 0;
      const stateIdSet = new Set(stateIds);
      outer: for (let xPos = minX; xPos <= maxX; xPos += 1) {
        for (let yPos = Math.max(minY, center.y - boundedDistance); yPos <= Math.min(maxY, center.y + boundedDistance); yPos += 1) {
          for (let zPos = minZ; zPos <= maxZ; zPos += 1) {
            const dx = xPos - center.x;
            const dy = yPos - center.y;
            const dz = zPos - center.z;
            if ((dx * dx) + (dy * dy) + (dz * dz) > boundedDistance * boundedDistance) continue;
            if (scanned >= MAX_SCANNED_BLOCKS) break outer;
            scanned += 1;
            const pos = new Vec3(xPos, yPos, zPos);
            const block = bot.blockAt(pos);
            if (!block) {
              unloadedPositions += 1;
              continue;
            }
            if (stateIdSet.has(block.stateId)) matchesFound.push({ x: xPos, y: yPos, z: zPos, stateId: block.stateId });
          }
        }
      }
      const sorted = matchesFound
        .sort((a, b) => center.distanceTo(new Vec3(a.x, a.y, a.z)) - center.distanceTo(new Vec3(b.x, b.y, b.z)))
        .slice(0, normalizedCount);
      const areaComplete = unloadedPositions === 0 && scanned < MAX_SCANNED_BLOCKS;
      const searchConclusive = areaComplete && mappingConfidence === 'session-observed' && completeRuntimeStateCoverage;
      if (sorted.length === 0) {
        const status = searchConclusive ? 'not-found-in-loaded-area' : 'inconclusive';
        const reason = !areaComplete
          ? 'loaded-area-incomplete'
          : searchConclusive
            ? 'no-match-in-loaded-area'
            : 'runtime-state-mapping-incomplete';
        return factory.createResponse(`${searchConclusive ? `No ${blockType} found` : `Search for ${blockType} inconclusive; no verified loaded match`} within ${boundedDistance} blocks\n${JSON.stringify({ status, reason, mappingConfidence, requested: namespacedId, scanned, unloadedPositions, searchLimit: MAX_SCANNED_BLOCKS })}`);
      }
      const foundStatus = mappingConfidence === 'session-observed'
        ? (areaComplete ? 'found' : 'found-in-loaded-area-search-incomplete')
        : 'found-static-candidate-unverified';
      return factory.createResponse(`${mappingConfidence === 'session-observed' ? 'Found' : 'Static candidate'} ${sorted.length} ${blockType} block(s) within ${boundedDistance} blocks:\n${sorted.map((block, index) => `${index + 1}. (${block.x}, ${block.y}, ${block.z})`).join('\n')}\nRegistry search details (JSON):\n${JSON.stringify({
        status: foundStatus,
        mappingConfidence,
        requested: namespacedId,
        maxDistance: boundedDistance,
        scanned,
        unloadedPositions,
        results: sorted,
      })}`);
    }
  );
}

async function pathfindForPlacement(bot: mineflayer.Bot, goal: InstanceType<typeof goals.GoalNear>, timeoutMs: number): Promise<void> {
  const pathPromise = bot.pathfinder.goto(goal);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Placement pathfinding timed out after ${timeoutMs}ms; pathfinding was stopped and no placement packet was sent`));
    }, timeoutMs);
  });
  try {
    await Promise.race([pathPromise, timeoutPromise]);
    if (timedOut) throw new Error(`Placement pathfinding timed out after ${timeoutMs}ms; pathfinding was stopped and no placement packet was sent`);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      bot.pathfinder.stop();
      pathPromise.catch(() => undefined);
    }
  }
}
