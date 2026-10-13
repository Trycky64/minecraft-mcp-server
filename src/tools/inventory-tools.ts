import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import type { RuntimeRegistryContext } from '../services/runtime-registry-service.js';
import { annotateItem, resolveItemType } from '../services/registry-reporting.js';

interface InventoryItem {
  name: string;
  count: number;
  slot: number;
}

export function registerInventoryTools(
  factory: ToolFactory,
  getBot: () => mineflayer.Bot,
  getRegistryContext: () => RuntimeRegistryContext | null = () => null,
): void {
  factory.registerTool(
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async () => {
      const bot = getBot();
      const items = bot.inventory.items();
      const registryContext = getRegistryContext();
      const itemList: InventoryItem[] = items.map((item) => ({
        name: item.name,
        count: item.count,
        slot: item.slot
      }));

      const snapshotStatus = registryContext?.protocolDecode.inventory ?? 'unverified';
      let inventoryText = !registryContext
        ? (items.length === 0 ? 'Inventory is empty' : `Found ${items.length} items in inventory:\n\n`)
        : snapshotStatus === 'incomplete'
        ? `Inventory snapshot INCOMPLETE; listed stacks may be stale. ${items.length} stack(s) currently exposed.\n`
        : snapshotStatus === 'unverified'
          ? `Inventory snapshot not verified by a complete server packet. ${items.length} stack(s) currently exposed.\n`
          : items.length === 0 ? 'Inventory is empty' : `Found ${items.length} items in inventory:\n\n`;
      itemList.forEach(item => {
        inventoryText += `- ${item.name} (x${item.count}) in slot ${item.slot}\n`;
      });
      inventoryText += `\nRegistry details (JSON):\n${JSON.stringify({
        minecraftVersion: registryContext?.minecraftVersion ?? bot.version,
        registryEpoch: registryContext?.registryEpoch ?? null,
        items: items.map((item) => annotateItem(item, registryContext)),
        snapshotStatus,
        decodeIssues: registryContext?.protocolDecode.issues.filter((issue) => issue.packetName === 'window_items' || issue.packetName === 'set_slot') ?? [],
      })}`;

      return factory.createResponse(inventoryText);
    }
  );

  factory.registerTool(
    "find-item",
    "Find a specific item in the bot's inventory",
    {
      nameOrType: z.string().describe("Name or type of item to find")
    },
    async ({ nameOrType }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const registryContext = getRegistryContext();
      const item = items.find((candidate) => {
        if (nameOrType.includes(':')) {
          const resolution = resolveItemType(candidate.type, registryContext);
          if (resolution?.status === 'resolved' && resolution.entry.namespacedId === nameOrType) return true;
          const legacyKey = candidate.name.includes(':') ? candidate.name : `minecraft:${candidate.name}`;
          return nameOrType.startsWith('minecraft:') && candidate.name !== 'unknown' && legacyKey === nameOrType;
        }
        return candidate.name !== 'unknown' && candidate.name.includes(nameOrType.toLowerCase());
      });

      if (item) {
        return factory.createResponse(`Found ${item.count} ${item.name} in inventory (slot ${item.slot})`);
      } else {
        return factory.createResponse(`Couldn't find any item matching '${nameOrType}' in inventory`);
      }
    }
  );

  factory.registerTool(
    "equip-item",
    "Equip a specific item",
    {
      itemName: z.string().describe("Name of the item to equip"),
      destination: z.string().optional().describe("Where to equip the item (default: 'hand')")
    },
    async ({ itemName, destination = 'hand' }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const registryContext = getRegistryContext();
      const item = items.find((candidate) => {
        if (itemName.includes(':')) {
          const resolution = resolveItemType(candidate.type, registryContext);
          if (resolution?.status === 'resolved' && resolution.entry.namespacedId === itemName) return true;
          const legacyKey = candidate.name.includes(':') ? candidate.name : `minecraft:${candidate.name}`;
          return itemName.startsWith('minecraft:') && candidate.name !== 'unknown' && legacyKey === itemName;
        }
        return candidate.name !== 'unknown' && candidate.name.includes(itemName.toLowerCase());
      });

      if (!item) {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      await bot.equip(item, destination as mineflayer.EquipmentDestination);
      return factory.createResponse(`Equipped ${item.name} to ${destination}`);
    }
  );
}
