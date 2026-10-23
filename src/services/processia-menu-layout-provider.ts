import type { MenuIdentityEvidence, MenuLayoutContract, MenuLayoutProvider } from './menu-layout-registry.js';

interface MachineSlotContract { inputs: number[]; outputs: number[]; size: number; hasRedstoneButton: boolean }

// Optional Processia extension, transcribed from ModMenus, MachineLayout and WorkshopMenu.
const CONTRACTS: Record<string, MachineSlotContract> = {
  'processia:coal_generator': { inputs: [0], outputs: [], size: 1, hasRedstoneButton: true },
  'processia:crusher': { inputs: [0], outputs: [1], size: 2, hasRedstoneButton: true },
  'processia:press': { inputs: [0, 2], outputs: [1], size: 3, hasRedstoneButton: true },
  'processia:wiremill': { inputs: [0], outputs: [1], size: 2, hasRedstoneButton: true },
  'processia:furnace_industrial': { inputs: [0], outputs: [1], size: 2, hasRedstoneButton: true },
  'processia:extruder': { inputs: [0], outputs: [1], size: 2, hasRedstoneButton: true },
  'processia:alloy_smelter': { inputs: [0, 1, 2], outputs: [3], size: 4, hasRedstoneButton: true },
  'processia:kiln': { inputs: [0, 1], outputs: [2], size: 3, hasRedstoneButton: true },
  'processia:washer': { inputs: [0], outputs: [1, 2], size: 3, hasRedstoneButton: true },
  'processia:basic_battery': { inputs: [], outputs: [], size: 0, hasRedstoneButton: false },
  'processia:centrifuge': { inputs: [0], outputs: [1, 2, 3], size: 4, hasRedstoneButton: true },
  'processia:slicer': { inputs: [0], outputs: [1, 2, 3, 4], size: 5, hasRedstoneButton: true },
  'processia:water_pump': { inputs: [], outputs: [], size: 0, hasRedstoneButton: true },
  'processia:saline_basin': { inputs: [], outputs: [], size: 0, hasRedstoneButton: true },
  'processia:electrolyzer': { inputs: [0], outputs: [1], size: 2, hasRedstoneButton: true },
  'processia:chemical_reactor': { inputs: [0], outputs: [1], size: 2, hasRedstoneButton: true },
  'processia:mixer': { inputs: [0, 1], outputs: [2], size: 3, hasRedstoneButton: true },
  'processia:biofermenter': { inputs: [0, 1], outputs: [2], size: 3, hasRedstoneButton: true },
  'processia:canner': { inputs: [0, 1], outputs: [2], size: 3, hasRedstoneButton: true },
  'processia:gas_separator': { inputs: [], outputs: [], size: 0, hasRedstoneButton: true },
  'processia:air_intake': { inputs: [], outputs: [], size: 0, hasRedstoneButton: true },
  'processia:regenerator': { inputs: [0, 1], outputs: [2], size: 3, hasRedstoneButton: true },
};

export const PROCESSIA_MENU_PROPERTY_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'energyLow16', 1: 'energyHigh16', 2: 'capacityLow16', 3: 'capacityHigh16',
  4: 'progress', 5: 'duration', 6: 'burnTime', 7: 'redstoneMode', 8: 'inputRate',
  9: 'outputRate', 10: 'status', 11: 'energyPerTick', 12: 'fluidAmount',
  13: 'gasAmount0', 14: 'gasAmount1', 15: 'gasAmount2', 16: 'gasAmount3',
});

export function processiaMenuIds(): string[] { return Object.keys(CONTRACTS); }

export function createProcessiaMenuLayoutProvider(): MenuLayoutProvider {
  return {
    id: 'processia-workshop-menu-contracts',
    getSynchronizedPropertyName(identity, propertyId) {
      if (identity.authority !== 'authenticated-runtime' || !CONTRACTS[identity.namespacedId]) return null;
      return PROCESSIA_MENU_PROPERTY_NAMES[propertyId] ?? null;
    },
    getContracts(identity: MenuIdentityEvidence): readonly MenuLayoutContract[] {
      if (!identity.namespacedId.startsWith('processia:') || identity.authority !== 'authenticated-runtime') return [];
      const machine = CONTRACTS[identity.namespacedId];
      if (!machine) return [];
      const totalSlotCount = machine.size + 36;
      const inventoryStart = machine.size;
      const inventoryEnd = inventoryStart + 36;
      return [{
        namespacedId: identity.namespacedId,
        minecraftVersions: ['1.21.1'],
        source: 'processia-workshop-menu-contract-from-java-source',
        totalSlotCount,
        machineSlots: { start: 0, endExclusive: machine.size },
        playerInventory: { start: inventoryStart, endExclusive: inventoryEnd - 9 },
        playerHotbar: { start: inventoryEnd - 9, endExclusive: inventoryEnd },
        roles: [
          ...machine.inputs.map(slot => ({ slots: [slot], role: 'machine-input' })),
          ...machine.outputs.map(slot => ({ slots: [slot], role: 'machine-output' })),
        ],
        capabilities: { indexedSlotClick: true, shiftClick: true, drag: false },
        controls: machine.hasRedstoneButton
          ? [{ kind: 'menu-button', id: 0, semantic: 'cycle-redstone-mode', executableByMineflayerTools: false }]
          : [],
      }];
    },
  };
}
