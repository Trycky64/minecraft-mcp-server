import test from 'ava';
import {
  MenuLayoutRegistry,
  createVanillaMenuLayoutProvider,
  type MenuIdentityEvidence,
  type MenuLayoutProvider,
} from '../src/services/menu-layout-registry.js';
import { createProcessiaMenuLayoutProvider, PROCESSIA_MENU_PROPERTY_NAMES, processiaMenuIds } from '../src/services/processia-menu-layout-provider.js';

const modIdentity: MenuIdentityEvidence = {
  namespacedId: 'examplemod:machine_menu', numericTypeId: 900, minecraftVersion: '1.21.1',
  authority: 'authenticated-runtime', source: 'neoforge-bridge', serverIdentity: 'srv-a',
  registryEpoch: 'r1', runtimeEpoch: 'e1', mineflayerSessionId: 'bot-a', bridgeSessionId: 'bridge-a',
};

function provider(id: string, contract: ReturnType<MenuLayoutProvider['getContracts']>[number] | null): MenuLayoutProvider {
  return { id, getContracts: () => contract ? [contract] : [] };
}

test('generic menu resolver returns unknown when no optional provider knows a mod menu', (t) => {
  const registry = new MenuLayoutRegistry();
  t.deepEqual(registry.resolve(modIdentity, { observedSlotCount: 45 }), { status: 'unknown', reason: 'no-provider' });
});

test('generic mod provider describes only its namespaced identity and exact observed layout', (t) => {
  const registry = new MenuLayoutRegistry([provider('examplemod-contract', {
    namespacedId: 'examplemod:machine_menu', minecraftVersions: ['1.21.1'], source: 'fixture-contract', totalSlotCount: 45,
    machineSlots: { start: 0, endExclusive: 9 }, playerInventory: { start: 9, endExclusive: 36 },
    playerHotbar: { start: 36, endExclusive: 45 }, roles: [{ slots: [0], role: 'machine-input' }],
  })]);
  const result = registry.resolve(modIdentity, { observedSlotCount: 45, modelSlotCount: 45 });
  t.is(result.status, 'known');
  if (result.status === 'known') {
    t.deepEqual(result.contract.roles, [{ slots: [0], role: 'machine-input' }]);
    t.deepEqual(result.providerIds, ['examplemod-contract']);
  }
});

test('generic layout resolver accepts a second mod namespace without Processia contracts', (t) => {
  const identity: MenuIdentityEvidence = { ...modIdentity, namespacedId: 'anothermod:custom_container', numericTypeId: 902 };
  const registry = new MenuLayoutRegistry([provider('anothermod-contract', {
    namespacedId: 'anothermod:custom_container', minecraftVersions: ['1.21.1'], source: 'fixture-contract', totalSlotCount: 2,
    roles: [{ slots: [0], role: 'documented-input' }],
  })]);
  const result = registry.resolve(identity, { observedSlotCount: 2 });
  t.is(result.status, 'known');
});

test('static provider cannot establish a mod identity or provide a mod layout', (t) => {
  const staticMod: MenuIdentityEvidence = { ...modIdentity, authority: 'version-static', source: 'untrusted-static-mod-hint' };
  const registry = new MenuLayoutRegistry([provider('fixture', {
    namespacedId: 'examplemod:machine_menu', minecraftVersions: ['1.21.1'], source: 'fixture', totalSlotCount: 1,
  })]);
  t.deepEqual(registry.resolve(staticMod, { observedSlotCount: 1 }), { status: 'unknown', reason: 'identity-not-authoritative' });
});

test('provider conflicts are reported rather than silently resolved by registration order', (t) => {
  const left = provider('provider-a', { namespacedId: modIdentity.namespacedId, minecraftVersions: ['1.21.1'], source: 'a', totalSlotCount: 45 });
  const right = provider('provider-b', { namespacedId: modIdentity.namespacedId, minecraftVersions: ['1.21.1'], source: 'b', totalSlotCount: 46 });
  const registry = new MenuLayoutRegistry([left, right]);
  t.deepEqual(registry.resolve(modIdentity, { observedSlotCount: 45 }), {
    status: 'conflict', providerIds: ['provider-a', 'provider-b'], reason: 'providers-disagree',
  });
});

test('provider contracts are rejected when ranges exceed the declared slot count', (t) => {
  const registry = new MenuLayoutRegistry([provider('invalid', {
    namespacedId: modIdentity.namespacedId, minecraftVersions: ['1.21.1'], source: 'fixture', totalSlotCount: 4,
    playerInventory: { start: 2, endExclusive: 8 },
  })]);
  t.deepEqual(registry.resolve(modIdentity, { observedSlotCount: 4 }), { status: 'incompatible', reason: 'invalid-contract' });
});

test('contract must match the observed slot count and model range', (t) => {
  const registry = new MenuLayoutRegistry([provider('fixture', {
    namespacedId: modIdentity.namespacedId, minecraftVersions: ['1.21.1'], source: 'fixture', totalSlotCount: 45,
    playerInventory: { start: 9, endExclusive: 36 },
  })]);
  t.deepEqual(registry.resolve(modIdentity, { observedSlotCount: 44 }), { status: 'incompatible', reason: 'observed-slot-count-mismatch' });
  t.deepEqual(registry.resolve(modIdentity, { observedSlotCount: 45, modelSlotCount: 45, modelInventoryRange: { start: 4, endExclusive: 40 } }),
    { status: 'incompatible', reason: 'model-range-mismatch' });
});

test('vanilla provider is versioned and checks the raw numeric menu ID', (t) => {
  const registry = new MenuLayoutRegistry([createVanillaMenuLayoutProvider(() => ({
    'minecraft:generic_9x1': { type: 0, inventory: { start: 9, end: 44 }, slots: 45, craft: -1 },
  }))]);
  const identity: MenuIdentityEvidence = {
    namespacedId: 'minecraft:generic_9x1', numericTypeId: 0, minecraftVersion: '1.21.1',
    authority: 'version-static', source: 'version-type-table',
  };
  t.is(registry.resolve(identity, { observedSlotCount: 45, modelSlotCount: 45, modelInventoryRange: { start: 9, endExclusive: 45 } }).status, 'known');
  t.is(registry.resolve({ ...identity, numericTypeId: 7 }, { observedSlotCount: 45 }).status, 'unknown');
});

test('Processia remains an optional specialized provider with its existing 22 explicit contracts', (t) => {
  const genericOnly = new MenuLayoutRegistry();
  t.is(genericOnly.resolve({ ...modIdentity, namespacedId: 'processia:crusher' }, { observedSlotCount: 38 }).status, 'unknown');
  const processia = new MenuLayoutRegistry([createProcessiaMenuLayoutProvider()]);
  const identity: MenuIdentityEvidence = { ...modIdentity, namespacedId: 'processia:press', numericTypeId: 7 };
  const resolved = processia.resolve(identity, { observedSlotCount: 39, modelSlotCount: 39, modelInventoryRange: { start: 3, endExclusive: 39 } });
  t.is(resolved.status, 'known');
  if (resolved.status === 'known') t.deepEqual(resolved.contract.roles, [
    { slots: [0], role: 'machine-input' }, { slots: [2], role: 'machine-input' }, { slots: [1], role: 'machine-output' },
  ]);
  t.is(processiaMenuIds().length, 22);
  t.is(PROCESSIA_MENU_PROPERTY_NAMES[4], 'progress');
});

test('Processia property names are available only through its optional authenticated provider', (t) => {
  const processia = new MenuLayoutRegistry([createProcessiaMenuLayoutProvider()]);
  t.is(processia.getSynchronizedPropertyName({ ...modIdentity, namespacedId: 'processia:crusher' }, 4), 'progress');
  t.is(processia.getSynchronizedPropertyName({ ...modIdentity, namespacedId: 'processia:crusher', authority: 'version-static' }, 4), null);
  t.is(new MenuLayoutRegistry().getSynchronizedPropertyName({ ...modIdentity, namespacedId: 'processia:crusher' }, 4), null);
});

test('conflicting synchronized-property semantics are surfaced instead of selecting one provider', (t) => {
  const contract = { namespacedId: modIdentity.namespacedId, minecraftVersions: ['1.21.1'], source: 'same-layout', totalSlotCount: 1 } as const;
  const left: MenuLayoutProvider = { id: 'property-a', getContracts: () => [contract], getSynchronizedPropertyName: () => 'progress' };
  const right: MenuLayoutProvider = { id: 'property-b', getContracts: () => [contract], getSynchronizedPropertyName: () => 'temperature' };
  const registry = new MenuLayoutRegistry([left, right]);
  t.deepEqual(registry.resolveSynchronizedProperty(modIdentity, 4), { status: 'conflict', providerIds: ['property-a', 'property-b'] });
});

test('provider registry remains deliberately bounded', (t) => {
  const registry = new MenuLayoutRegistry();
  for (let index = 0; index < 16; index++) registry.register(provider(`p${index}`, null));
  t.throws(() => registry.register(provider('overflow', null)), { message: 'menu-layout-provider-limit-exceeded:16' });
});

test('a provider returning an excessive number of contracts fails closed', (t) => {
  const overflow: MenuLayoutProvider = { id: 'overflow-contracts', getContracts: () => Array.from({ length: 129 }, () => ({
    namespacedId: modIdentity.namespacedId, minecraftVersions: ['1.21.1'], source: 'test', totalSlotCount: 1,
  })) };
  const registry = new MenuLayoutRegistry([overflow]);
  t.deepEqual(registry.resolve(modIdentity, { observedSlotCount: 1 }), { status: 'incompatible', reason: 'invalid-contract' });
});
