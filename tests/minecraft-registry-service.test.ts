import test from 'ava';
import {
  createMinecraftDataSnapshot,
  MinecraftRegistryService,
  type RegistrySourceSnapshot,
} from '../src/services/minecraft-registry-service.js';
import { syntheticAmbiguousSnapshot, syntheticConflictingProtocolSnapshot, syntheticProcessiaSnapshot } from './fixtures/registry-snapshots.js';

test('resolves vanilla item, block and entity from exact minecraft-data version', (t) => {
  const service = MinecraftRegistryService.withMinecraftData(['1.21.1']);
  const item = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'minecraft:diamond' });
  t.is(item.status, 'resolved');
  if (item.status === 'resolved') t.is(item.entry.numericId, 805);
  const block = service.resolve({ kind: 'block', minecraftVersion: '1.21.1', numericId: 1 });
  t.is(block.status, 'resolved');
  if (block.status === 'resolved') t.is(block.entry.namespacedId, 'minecraft:stone');
  const entity = service.resolve({ kind: 'entity', minecraftVersion: '1.21.1', namespacedId: 'minecraft:allay' });
  t.is(entity.status, 'resolved');
});

test('resolves static block states only from explicit minecraft-data bounds', (t) => {
  const snapshot = createMinecraftDataSnapshot('1.21.1');
  t.truthy(snapshot);
  const service = new MinecraftRegistryService(snapshot ? [snapshot] : []);
  const result = service.resolve({ kind: 'blockState', minecraftVersion: '1.21.1', numericId: 1 });
  t.is(result.status, 'resolved');
  if (result.status === 'resolved') t.is(result.entry.namespacedId, 'minecraft:stone');
});

test('resolves synthetic namespaced mod entries without representing them as runtime observations', (t) => {
  const service = new MinecraftRegistryService([syntheticProcessiaSnapshot]);
  const result = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal', registryEpoch: 'synthetic-processia-test' });
  t.is(result.status, 'resolved');
  if (result.status === 'resolved') {
    t.is(result.entry.numericId, 7001);
    t.is(result.provenance.source, 'neoforge-bridge');
    t.is(result.provenance.registryEpoch, 'synthetic-processia-test');
  }
});

test('supports extensible registry kinds and leaves absent numeric mappings unresolved', (t) => {
  const service = new MinecraftRegistryService([syntheticProcessiaSnapshot]);
  t.is(service.resolve({ kind: 'menu', minecraftVersion: '1.21.1', numericId: 91, registryEpoch: 'synthetic-processia-test' }).status, 'resolved');
  const missingNumeric = service.resolve({ kind: 'blockState', minecraftVersion: '1.21.1', namespacedId: 'processia:crusher', numericId: 100 });
  t.is(missingNumeric.status, 'unresolved');
  if (missingNumeric.status === 'unresolved') t.is(missingNumeric.reason, 'mapping-not-observed');
  t.is(service.resolve({ kind: 'fluid', minecraftVersion: '1.21.1', namespacedId: 'processia:steam' }).status, 'unresolved');
});

test('separates unsupported versions from registries not loaded for a known version', (t) => {
  const service = MinecraftRegistryService.withMinecraftData(['1.21.1']);
  t.is(service.resolve({ kind: 'item', minecraftVersion: '1.20.1', namespacedId: 'minecraft:stone' }).status, 'unavailable');
  t.is(service.resolve({ kind: 'menu', minecraftVersion: '1.21.1', namespacedId: 'minecraft:generic_9x1' }).status, 'unavailable');
});

test('does not cross registry, version or epoch boundaries', (t) => {
  const service = new MinecraftRegistryService([syntheticProcessiaSnapshot]);
  t.is(service.resolve({ kind: 'block', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal' }).status, 'unresolved');
  t.is(service.resolve({ kind: 'item', minecraftVersion: '1.20.1', namespacedId: 'processia:raw_crystal' }).status, 'unavailable');
  t.is(service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal', registryEpoch: 'other' }).status, 'unavailable');
});

test('uses source priority and does not let lower-priority protocol data override bridge data', (t) => {
  const service = new MinecraftRegistryService([syntheticProcessiaSnapshot, syntheticConflictingProtocolSnapshot]);
  const result = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal', registryEpoch: 'synthetic-processia-test' });
  t.is(result.status, 'resolved');
  if (result.status === 'resolved') {
    t.is(result.entry.numericId, 7001);
    t.is(result.provenance.source, 'neoforge-bridge');
  }
});

test('reports same-priority conflicting IDs as ambiguous', (t) => {
  const first: RegistrySourceSnapshot = {
    source: 'protocol', minecraftVersion: '1.21.1', registryEpoch: 'synthetic-processia-test', availableRegistries: ['item'],
    entries: [{ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal', numericId: 51, registryEpoch: 'synthetic-processia-test', provenance: { source: 'protocol', minecraftVersion: '1.21.1', registryEpoch: 'synthetic-processia-test' } }],
  };
  const service = new MinecraftRegistryService([first, syntheticConflictingProtocolSnapshot]);
  const result = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal', registryEpoch: 'synthetic-processia-test' });
  t.is(result.status, 'ambiguous');
});

test('reports conflicting keys for a numeric ID as ambiguous', (t) => {
  const service = new MinecraftRegistryService([syntheticAmbiguousSnapshot]);
  t.is(service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 77, registryEpoch: 'ambiguous-test-epoch' }).status, 'ambiguous');
});

test('does not combine captures from different epochs when no epoch is supplied', (t) => {
  const otherEpoch: RegistrySourceSnapshot = {
    source: 'protocol', minecraftVersion: '1.21.1', availableRegistries: ['item'],
    entries: [{ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal', numericId: 51, registryEpoch: 'epoch-b', provenance: { source: 'protocol', minecraftVersion: '1.21.1', registryEpoch: 'epoch-b' } }],
  };
  const service = new MinecraftRegistryService([syntheticConflictingProtocolSnapshot, otherEpoch]);
  const noEpoch = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal' });
  t.is(noEpoch.status, 'unresolved');
  if (noEpoch.status === 'unresolved') t.is(noEpoch.reason, 'mapping-not-observed');
  t.is(service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal', registryEpoch: 'synthetic-processia-test' }).status, 'resolved');
});

test('requires the matching runtime epoch for numeric resolution and never borrows another session', (t) => {
  const service = new MinecraftRegistryService([syntheticProcessiaSnapshot]);
  const withoutContext = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 7001 });
  t.is(withoutContext.status, 'unresolved');
  if (withoutContext.status === 'unresolved') t.is(withoutContext.reason, 'mapping-not-observed');
  t.is(service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 7001, registryEpoch: 'another-session' }).status, 'unavailable');
  const sameSession = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 7001, registryEpoch: 'synthetic-processia-test' });
  t.is(sameSession.status, 'resolved');
});

test('does not treat a static numeric ID as a mapping observed for a runtime epoch', (t) => {
  const service = MinecraftRegistryService.withMinecraftData(['1.21.1']);
  const staticLookup = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 1, registryEpoch: 'minecraft-data:1.21.1' });
  const runtimeLookup = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 1, registryEpoch: 'session:current' });
  t.is(staticLookup.status, 'resolved');
  if (staticLookup.status === 'resolved') t.is(staticLookup.provenance.source, 'minecraft-data');
  t.is(runtimeLookup.status, 'unresolved');
  if (runtimeLookup.status === 'unresolved') t.is(runtimeLookup.reason, 'mapping-not-observed');
});

test('a partial runtime snapshot falls back to the static vanilla baseline for entries it does not know', (t) => {
  const runtime = new MinecraftRegistryService([syntheticProcessiaSnapshot, createMinecraftDataSnapshot('1.21.1')!]);
  const result = runtime.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'minecraft:diamond', registryEpoch: 'synthetic-processia-test' });
  t.is(result.status, 'resolved');
  if (result.status === 'resolved') {
    t.is(result.entry.namespacedId, 'minecraft:diamond');
    t.is(result.provenance.source, 'minecraft-data');
    t.is(result.provenance.registryEpoch, 'minecraft-data:1.21.1');
  }
});

test('a complete runtime snapshot can establish absence and block lower-priority fallback', (t) => {
  const completeSnapshot: RegistrySourceSnapshot = {
    ...syntheticProcessiaSnapshot,
    registryCoverage: { item: 'complete' },
  };
  const runtime = new MinecraftRegistryService([completeSnapshot, createMinecraftDataSnapshot('1.21.1')!]);
  const result = runtime.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'minecraft:diamond', registryEpoch: 'synthetic-processia-test' });
  t.is(result.status, 'unresolved');
  if (result.status === 'unresolved') t.is(result.reason, 'identifier-not-found');
});

test('partial runtime numeric collisions override the matching static association', (t) => {
  const partial: RegistrySourceSnapshot = {
    source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'partial-collision-epoch',
    availableRegistries: ['item'],
    registryCoverage: { item: 'partial' },
    entries: [{ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:runtime_item', numericId: 805, registryEpoch: 'partial-collision-epoch', provenance: { source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'partial-collision-epoch' } }],
  };
  const service = new MinecraftRegistryService([partial, createMinecraftDataSnapshot('1.21.1')!]);
  const byNumericId = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 805, registryEpoch: 'partial-collision-epoch' });
  t.is(byNumericId.status, 'resolved');
  if (byNumericId.status === 'resolved') t.is(byNumericId.entry.namespacedId, 'processia:runtime_item');
  const staticName = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'minecraft:diamond', registryEpoch: 'partial-collision-epoch' });
  t.is(staticName.status, 'unresolved');
  if (staticName.status === 'unresolved') t.is(staticName.reason, 'mapping-not-observed');
});

test('absence from a partial snapshot without a lower-priority source remains unobserved', (t) => {
  const partialOnly: RegistrySourceSnapshot = {
    source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'partial-only-epoch',
    availableRegistries: ['item'], registryCoverage: { item: 'partial' },
    entries: [{ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:known', numericId: 3, registryEpoch: 'partial-only-epoch', provenance: { source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'partial-only-epoch' } }],
  };
  const service = new MinecraftRegistryService([partialOnly]);
  const result = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:maybe', registryEpoch: 'partial-only-epoch' });
  t.is(result.status, 'unresolved');
  if (result.status === 'unresolved') t.is(result.reason, 'mapping-not-observed');
});

test('partial runtime coverage prevents static absence from proving an unknown runtime ID absent', (t) => {
  const partial: RegistrySourceSnapshot = {
    source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'partial-unknown-epoch',
    availableRegistries: ['item'], registryCoverage: { item: 'partial' },
    entries: [{ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:known', numericId: 3, registryEpoch: 'partial-unknown-epoch', provenance: { source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'partial-unknown-epoch' } }],
  };
  const service = new MinecraftRegistryService([partial, createMinecraftDataSnapshot('1.21.1')!]);
  const result = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 999999, registryEpoch: 'partial-unknown-epoch' });
  t.is(result.status, 'unresolved');
  if (result.status === 'unresolved') t.is(result.reason, 'mapping-not-observed');
});

test('an explicitly complete empty runtime registry can prove an ID absent', (t) => {
  const completeEmpty: RegistrySourceSnapshot = {
    source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'empty-complete-epoch',
    availableRegistries: ['item'], registryCoverage: { item: 'complete' }, entries: [],
  };
  const service = new MinecraftRegistryService([completeEmpty, createMinecraftDataSnapshot('1.21.1')!]);
  const result = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 999999, registryEpoch: 'empty-complete-epoch' });
  t.is(result.status, 'unresolved');
  if (result.status === 'unresolved') t.is(result.reason, 'identifier-not-found');
});

test('runtime numeric mapping wins a collision with static vanilla data only in its explicit epoch', (t) => {
  const runtimeCollision: RegistrySourceSnapshot = {
    source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'collision-epoch', availableRegistries: ['block'],
    entries: [{ kind: 'block', minecraftVersion: '1.21.1', namespacedId: 'processia:custom_stone', numericId: 1, registryEpoch: 'collision-epoch', provenance: { source: 'neoforge-bridge', minecraftVersion: '1.21.1', registryEpoch: 'collision-epoch' } }],
  };
  const service = new MinecraftRegistryService([runtimeCollision, createMinecraftDataSnapshot('1.21.1')!]);
  const result = service.resolve({ kind: 'block', minecraftVersion: '1.21.1', numericId: 1, registryEpoch: 'collision-epoch' });
  t.is(result.status, 'resolved');
  if (result.status === 'resolved') {
    t.is(result.entry.namespacedId, 'processia:custom_stone');
    t.is(result.provenance.source, 'neoforge-bridge');
  }
});

test('addSnapshot makes the same deep defensive copy as the constructor', (t) => {
  const source: RegistrySourceSnapshot = {
    source: 'protocol', minecraftVersion: '1.21.1', registryEpoch: 'copy-epoch', availableRegistries: ['item'],
    entries: [{ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:copy_test', numericId: 45, registryEpoch: 'copy-epoch', provenance: { source: 'protocol', minecraftVersion: '1.21.1', registryEpoch: 'copy-epoch' } }],
  };
  const service = new MinecraftRegistryService();
  service.addSnapshot(source);
  source.entries[0]!.namespacedId = 'processia:mutated';
  source.entries[0]!.provenance.source = 'minecraft-data';
  source.availableRegistries[0] = 'block';
  const result = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:copy_test', registryEpoch: 'copy-epoch' });
  t.is(result.status, 'resolved');
  if (result.status === 'resolved') t.is(result.provenance.source, 'protocol');
});

test('rejects snapshots whose source or version provenance conflicts with the snapshot', (t) => {
  const invalid: RegistrySourceSnapshot = {
    source: 'protocol', minecraftVersion: '1.21.1', availableRegistries: ['item'],
    entries: [{ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'processia:raw_crystal', provenance: { source: 'minecraft-data', minecraftVersion: '1.20.1' } }],
  };
  t.throws(() => new MinecraftRegistryService([invalid]));
});

test('rejects unqualified identifiers and empty lookups as unresolved', (t) => {
  const service = MinecraftRegistryService.withMinecraftData(['1.21.1']);
  t.is(service.resolve({ kind: 'item', minecraftVersion: '1.21.1', namespacedId: 'diamond' }).status, 'unresolved');
  t.is(service.resolve({ kind: 'item', minecraftVersion: '1.21.1' }).status, 'unresolved');
});

test('keeps unknown IDs explicitly unresolved rather than manufacturing names', (t) => {
  const service = MinecraftRegistryService.withMinecraftData(['1.21.1']);
  const result = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 999999 });
  t.is(result.status, 'unresolved');
  if (result.status === 'unresolved') t.is(result.reason, 'mapping-not-observed');
});

test('static vanilla completeness does not claim unknown mod namespaces or numeric IDs absent at runtime', (t) => {
  const service = MinecraftRegistryService.withMinecraftData(['1.21.1']);
  const modKey = service.resolve({ kind: 'block', minecraftVersion: '1.21.1', namespacedId: 'processia:unobserved' });
  const unknownId = service.resolve({ kind: 'item', minecraftVersion: '1.21.1', numericId: 999999 });
  t.is(modKey.status, 'unresolved');
  if (modKey.status === 'unresolved') t.is(modKey.reason, 'mapping-not-observed');
  t.is(unknownId.status, 'unresolved');
  if (unknownId.status === 'unresolved') t.is(unknownId.reason, 'mapping-not-observed');
});
