import { z } from "zod";
import mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { ToolFactory } from '../tool-factory.js';
import type { RuntimeRegistryContext } from '../services/runtime-registry-service.js';
import { annotateItem, isUnsafeItemNameStatus, itemMatchesRequest, mineflayerItemNameStatus, resolveItemType } from '../services/registry-reporting.js';
import { getProtocolDecodeStatus } from '../services/protocol-decode-monitor.js';

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

      const protocolStatus = getProtocolDecodeStatus(bot._client as never);
      const snapshotStatus = registryContext?.protocolDecode.inventory ?? protocolStatus.inventory;
      let inventoryText = snapshotStatus === 'incomplete'
        ? `Inventory snapshot INCOMPLETE; listed stacks may be stale. ${items.length} stack(s) currently exposed.\n`
        : snapshotStatus === 'unverified'
          ? `Inventory snapshot not verified by a complete server packet. ${items.length} stack(s) currently exposed.\n`
          : items.length === 0 ? 'Inventory is empty' : `Found ${items.length} items in inventory:\n\n`;
      itemList.forEach((item, index) => {
        const stack = items[index]!;
        const nameStatus = mineflayerItemNameStatus(stack, registryContext);
        const runtime = resolveItemType(stack.type, registryContext);
        const runtimeName = runtime?.status === 'resolved' && runtime.provenance.source !== 'minecraft-data' ? runtime.entry.namespacedId : null;
        const warning = isUnsafeItemNameStatus(nameStatus)
          ? ` [Mineflayer name not reliable: ${nameStatus}${runtimeName ? `; runtime registry: ${runtimeName}` : ''}; the runtime registry contradicts or cannot confirm it]`
          : '';
        inventoryText += `- ${item.name} (x${item.count}) in slot ${item.slot}${warning}\n`;
      });
      inventoryText += `\nRegistry details (JSON):\n${JSON.stringify({
        minecraftVersion: registryContext?.minecraftVersion ?? bot.version,
        registryEpoch: registryContext?.registryEpoch ?? null,
        items: items.map((item) => annotateItem(item, registryContext)),
        snapshotStatus,
        playerInventory: {
          selectedHotbarSlot: Number.isInteger(bot.quickBarSlot) ? bot.quickBarSlot : null,
          selectedInventorySlot: Number.isInteger(bot.quickBarSlot) && Number.isInteger(bot.inventory.hotbarStart)
            ? bot.inventory.hotbarStart + bot.quickBarSlot!
            : null,
          activeWindowId: bot.currentWindow?.id ?? 0,
          cursor: annotateCursorItem(bot.currentWindow?.selectedItem ?? bot.inventory.selectedItem, registryContext),
          slots: (bot.inventory.slots ?? []).map((item, slot) => item ? annotateItem({ ...item, slot }, registryContext) : null),
        },
        decodeIssues: (registryContext?.protocolDecode.issues ?? protocolStatus.issues).filter((issue) => issue.packetName === 'window_items' || issue.packetName === 'set_slot'),
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
      const item = items.find((candidate) => itemMatchesRequest(candidate, nameOrType, registryContext));

      if (item) {
        const runtime = resolveItemType(item.type, registryContext);
        const displayName = item.name === 'unknown' && runtime?.status === 'resolved' ? runtime.entry.namespacedId : item.name;
        return factory.createResponse(`Found ${item.count} ${displayName} in inventory (slot ${item.slot})`);
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
      destination: z.string().optional().describe("Where to equip the item (default: 'hand')"),
      registryEpoch: z.string().min(1).max(200).optional().describe('Optional registry epoch from the inventory observation; a different current epoch is refused'),
    },
    async ({ itemName, destination = 'hand', registryEpoch }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const registryContext = getRegistryContext();
      if (registryEpoch !== undefined && registryContext?.registryEpoch !== registryEpoch) {
        return factory.createErrorResponse('stale-registry-epoch: re-list the inventory in the current session before equipping');
      }
      const item = items.find((candidate) => itemMatchesRequest(candidate, itemName, registryContext));

      if (!item) {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      await bot.equip(item, destination as mineflayer.EquipmentDestination);
      const destinationSlot = destination === 'hand'
        ? (!Number.isInteger(bot.quickBarSlot) || !Number.isInteger(bot.inventory.hotbarStart) ? null : bot.inventory.hotbarStart + bot.quickBarSlot!)
        : (typeof bot.getEquipmentDestSlot === 'function' ? bot.getEquipmentDestSlot(destination as mineflayer.EquipmentDestination) : null);
      const observedItem = destinationSlot === null ? null : bot.inventory.slots[destinationSlot] ?? null;
      const observed = observedItem?.type === item.type && observedItem.count === item.count;
      return factory.createResponse(JSON.stringify({
        status: observed ? 'client-observed' : 'uncertain',
        actionRequested: true,
        actionSent: true,
        clientObserved: observed,
        serverConfirmed: false,
        item: (() => {
          const annotated = annotateItem(item, registryContext);
          return { mineflayerName: item.name, rawNumericId: item.type, count: item.count,
            namespacedId: annotated.namespacedId, mineflayerNameStatus: annotated.mineflayerNameStatus };
        })(),
        destination,
        destinationSlot,
        note: 'Mineflayer completed equip handling and the local slot model was inspected; no independent server acknowledgement was correlated with this equipment change.',
      }));
    }
  );
}

function annotateCursorItem(item: Item | null | undefined, context: RuntimeRegistryContext | null): ReturnType<typeof annotateItem> | null {
  return item ? annotateItem({ ...item, slot: -1 }, context) : null;
}
