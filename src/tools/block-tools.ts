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
      itemId: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/).optional().describe("Optional namespaced item to place; modded items require a runtime mapping for this session")
    },
    async ({ x, y, z, faceDirection = 'down', itemId }: { x: number, y: number, z: number, faceDirection?: FaceDirection, itemId?: string }) => {
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
          if (!bot.canSeeBlock(referenceBlock)) {
            const goal = new goals.GoalNear(referencePos.x, referencePos.y, referencePos.z, 2);
            await bot.pathfinder.goto(goal);
          }

          await bot.lookAt(placePos, true);

          try {
            if (itemToPlace && itemToPlace !== bot.heldItem) await bot.equip(itemToPlace, 'hand');
            await bot.placeBlock(referenceBlock, face.vector.scaled(-1));
          } catch (placeError) {
            if (itemToPlace && previousHeldItem && bot.heldItem !== previousHeldItem) {
              try { await bot.equip(previousHeldItem, 'hand'); } catch { /* Keep the original placement failure visible. */ }
            }
            log('warn', `Failed to place using ${face.direction} face: ${placeError}`);
            continue;
          }
          if (itemToPlace && previousHeldItem && previousHeldItem !== itemToPlace) {
            try { await bot.equip(previousHeldItem, 'hand'); }
            catch (restoreError) { log('warn', `Placed block but could not restore previous held item: ${restoreError}`); }
          }
          return factory.createResponse(`Placed block at (${x}, ${y}, ${z}) using ${face.direction} face`);
        }
      }

      return unresolvedReferenceCount > 0
        ? factory.createErrorResponse(`Cannot safely place block at (${x}, ${y}, ${z}): ${unresolvedReferenceCount} potential reference block(s) have unresolved Mineflayer definitions`)
        : factory.createResponse(`Failed to place block at (${x}, ${y}, ${z}): No suitable reference block found`);
    }
  );

  factory.registerTool(
    "dig-block",
    "Dig a block at the specified position",
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
        return factory.createResponse(`No block data loaded at position (${x}, ${y}, ${z}); chunk is not loaded`);
      }
      if (block.name === 'air') {
        return factory.createResponse(`No block found at position (${x}, ${y}, ${z})`);
      }
      if (block.name === 'unknown') {
        return factory.createErrorResponse(`Cannot safely dig unresolved Mineflayer block at (${x}, ${y}, ${z}); raw state ID: ${block.stateId}`);
      }

      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
        const goal = new goals.GoalNear(x, y, z, 2);
        await bot.pathfinder.goto(goal);
      }

      await bot.dig(block);
      return factory.createResponse(`Dug ${block.name} at (${x}, ${y}, ${z})`);
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
        return factory.createResponse(`${searchConclusive ? `No ${blockType} found` : `Search for ${blockType} inconclusive; no verified loaded match`} within ${boundedDistance} blocks\n${JSON.stringify({ status, reason: !areaComplete ? 'loaded-area-incomplete' : 'runtime-state-mapping-incomplete', mappingConfidence, requested: namespacedId, scanned, unloadedPositions, searchLimit: MAX_SCANNED_BLOCKS })}`);
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
