import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

type Entity = ReturnType<Bot['nearestEntity']>;

export function registerEntityTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "find-entity",
    "Find the nearest entity of a specific type",
    {
      type: z.string().optional().describe("Type of entity to find (empty for any entity)"),
      maxDistance: z.coerce.number().finite().positive().max(128).optional().describe("Maximum search distance (default: 16, max: 128)")
    },
    async ({ type = '', maxDistance = 16 }) => {
      const bot = getBot();
      const entityFilter = (entity: NonNullable<Entity>) => {
        if (!type) return true;
        if (type === 'player') return entity.type === 'player';
        if (type === 'mob') return entity.type === 'mob';
        return Boolean(entity.name && entity.name.includes(type.toLowerCase()));
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
