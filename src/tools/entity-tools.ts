import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import type { RuntimeRegistryContext } from '../services/runtime-registry-service.js';
import { isUnsafeItemNameStatus, mineflayerRegistryNameStatus, resolveRuntimeNumericId } from '../services/registry-reporting.js';

type Entity = ReturnType<Bot['nearestEntity']>;

/** Mineflayer 1.21 categories of living mobs; 'mob' alone covers only a few bosses and golems. */
const MOB_CATEGORIES = new Set(['mob', 'hostile', 'animal', 'passive', 'ambient', 'water_creature']);

export function registerEntityTools(factory: ToolFactory, getBot: () => Bot,
  getRegistryContext: () => RuntimeRegistryContext | null = () => null): void {
  factory.registerTool(
    "find-entity",
    "Find the nearest entity of a specific type",
    {
      type: z.string().optional().describe("Type of entity to find (empty for any entity)"),
      maxDistance: z.coerce.number().finite().positive().max(128).optional().describe("Maximum search distance (default: 16, max: 128)")
    },
    async ({ type = '', maxDistance = 16 }) => {
      const bot = getBot();
      const context = getRegistryContext();
      // Mineflayer names entities from its static table via the raw entity type ID;
      // only the runtime registry of this session can confirm or contradict that name.
      const identityOf = (entity: NonNullable<Entity>) => {
        const rawEntityTypeId = Number.isSafeInteger(entity.entityType) ? entity.entityType : null;
        const resolution = rawEntityTypeId === null ? null : resolveRuntimeNumericId('entity', rawEntityTypeId, context);
        return {
          rawEntityTypeId,
          namespacedId: resolution?.status === 'resolved' && resolution.provenance.source !== 'minecraft-data' ? resolution.entry.namespacedId : null,
          mineflayerNameStatus: mineflayerRegistryNameStatus({ name: entity.name ?? 'unknown' }, resolution),
        };
      };
      const entityFilter = (entity: NonNullable<Entity>) => {
        if (!type) return true;
        if (type === 'player') return entity.type === 'player';
        const identity = identityOf(entity);
        // The category also comes from Mineflayer's static table, so it is unusable once the name is contradicted.
        if (type === 'mob') return MOB_CATEGORIES.has(entity.type) && !isUnsafeItemNameStatus(identity.mineflayerNameStatus);
        if (type.includes(':')) {
          if (identity.namespacedId === type) return true;
          return !isUnsafeItemNameStatus(identity.mineflayerNameStatus) && type.startsWith('minecraft:') && entity.name !== 'unknown' && `minecraft:${entity.name}` === type;
        }
        return !isUnsafeItemNameStatus(identity.mineflayerNameStatus) && Boolean(entity.name && entity.name !== 'unknown' && entity.name.includes(type.toLowerCase()));
      };

      const entity = bot.nearestEntity(entityFilter);

      if (!entity || bot.entity.position.distanceTo(entity.position) > maxDistance) {
        return factory.createResponse(`No ${type || 'entity'} found within ${maxDistance} blocks`);
      }

      const entityName = entity.name || (entity as { username?: string }).username || entity.type;
      const droppedItem = entity.getDroppedItem?.() ?? null;
      const details = {
        entityId: entity.id,
        name: entityName,
        type: entity.type,
        mineflayerName: entity.name ?? null,
        ...identityOf(entity),
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        droppedItem: droppedItem ? {
          rawNumericId: droppedItem.type,
          count: droppedItem.count,
          mineflayerName: droppedItem.name,
          identity: droppedItem.name === 'unknown' ? 'unresolved' : 'mineflayer-name-only',
        } : null,
      };
      return factory.createResponse(`Found ${entityName} at position (${Math.floor(entity.position.x)}, ${Math.floor(entity.position.y)}, ${Math.floor(entity.position.z)})\nEntity details (JSON):\n${JSON.stringify(details)}`);
    }
  );
}
