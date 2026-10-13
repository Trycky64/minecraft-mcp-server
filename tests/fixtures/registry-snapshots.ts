import type { RegistryEntry, RegistrySourceSnapshot } from '../../src/services/minecraft-registry-service.js';

/** Synthetic test data only; these mappings were not observed on a Processia runtime. */
const syntheticEntries: RegistryEntry[] = [
  {
    kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal', numericId: 7001, registryEpoch: 'synthetic-processia-test',
    provenance: { source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'synthetic-processia-test', observedAt: '2030-01-01T00:00:00.000Z' },
  },
  {
    kind: 'block', minecraftVersion: '1.21.1', namespacedId: 'processia:crusher', numericId: 810, registryEpoch: 'synthetic-processia-test',
    provenance: { source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'synthetic-processia-test', observedAt: '2030-01-01T00:00:00.000Z' },
  },
  {
    kind: 'blockState', minecraftVersion: '1.21.1', namespacedId: 'processia:crusher', registryEpoch: 'synthetic-processia-test',
    provenance: { source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'synthetic-processia-test', observedAt: '2030-01-01T00:00:00.000Z' },
  },
  {
    kind: 'menu', minecraftVersion: '1.21.1', namespacedId: 'processia:crusher', numericId: 91, registryEpoch: 'synthetic-processia-test',
    provenance: { source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'synthetic-processia-test', observedAt: '2030-01-01T00:00:00.000Z' },
  },
];

export const syntheticProcessiaSnapshot: RegistrySourceSnapshot = {
  source: 'neoforge-bridge',
  minecraftVersion: '1.21.1',
  availableRegistries: ['item', 'block', 'blockState', 'menu', 'fluid'],
  entries: syntheticEntries,
};

export const syntheticConflictingProtocolSnapshot: RegistrySourceSnapshot = {
  source: 'protocol',
  minecraftVersion: '1.21.1',
  availableRegistries: ['item'],
  entries: [{
    kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal', numericId: 7002, registryEpoch: 'synthetic-processia-test',
    provenance: { source: 'protocol', minecraftVersion: '1.21.1', registryEpoch: 'synthetic-processia-test' },
  }],
};

export const syntheticAmbiguousSnapshot: RegistrySourceSnapshot = {
  source: 'protocol',
  minecraftVersion: '1.21.1',
  registryEpoch: 'ambiguous-test-epoch',
  availableRegistries: ['item'],
  entries: [
    { kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:crystal_a', numericId: 77, registryEpoch: 'ambiguous-test-epoch', provenance: { source: 'protocol', minecraftVersion: '1.21.1', registryEpoch: 'ambiguous-test-epoch' } },
    { kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:crystal_b', numericId: 77, registryEpoch: 'ambiguous-test-epoch', provenance: { source: 'protocol', minecraftVersion: '1.21.1', registryEpoch: 'ambiguous-test-epoch' } },
  ],
};
