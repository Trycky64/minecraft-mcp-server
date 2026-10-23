import { z } from 'zod';
import { NeoForgeBridgeIntegration } from '../bridge/neoforge-bridge-client.js';
import { ToolFactory } from '../tool-factory.js';
import type { RuntimeRegistryService } from '../services/runtime-registry-service.js';
import { bridgeErrorPolicy, normalizeBridgeError } from '../bridge/bridge-adapter-contract.js';

function json(factory: ToolFactory, value: unknown) { return factory.createResponse(JSON.stringify(value, null, 2)); }
function failure(factory: ToolFactory, error: unknown) {
  const normalized = normalizeBridgeError(error);
  const policy = bridgeErrorPolicy(normalized.code);
  return json(factory, { status: 'error', error: normalized.code, diagnostic: { category: policy.category,
    retryable: policy.retryable, temporary: policy.temporary, sessionInvalidated: policy.invalidatesSession }, readOnly: true });
}

export function registerBridgeTools(factory: ToolFactory, bridge: NeoForgeBridgeIntegration, runtime?: RuntimeRegistryService): void {
  factory.registerTool('bridge-status', 'Show local NeoForge bridge configuration and authenticated session status', {}, async () => {
    const context = runtime?.getContext();
    if (context?.connectionMode === 'bridge-only' && context.bridgeAvailable) {
      await bridge.validateBridgeOnlySession().catch(() => undefined);
    }
    return json(factory, bridge.status());
  }, { requiresConnection: false });

  factory.registerTool('minecraft-inspect-block-entity', 'Read a generic block state, block entity type, item, energy and fluid capabilities at a loaded position using the authenticated NeoForge bridge', {
    dimension: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/),
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int(),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  }, async (request) => {
    try {
      const result = await bridge.inspectBlock(request);
      return json(factory, { ...result, readOnly: true,
        limitation: 'Only generic public block state, BlockEntity identity, Inventory/ItemHandler, EnergyStorage and FluidHandler data are exposed. Arbitrary mod-private fields are not reflected or serialized.' });
    } catch (error) { return failure(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('minecraft-inspect-capabilities', 'Read-only generic NeoForge ItemHandler, EnergyStorage and FluidHandler presence and state for each face at a loaded block position', {
    dimension: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/),
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int(),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  }, async (request) => {
    try {
      const result = await bridge.inspectBlock(request);
      return json(factory, { status: 'available', readOnly: true, serverIdentity: result.serverIdentity,
        registryEpoch: result.registryEpoch, dimension: result.dimension, x: result.x, y: result.y, z: result.z,
        itemCapabilities: result.itemCapabilities ?? null, energyCapabilities: result.energyCapabilities ?? null,
        fluidCapabilities: result.fluidCapabilities ?? null,
        caveat: 'Capabilities are queried without insert, extract, fill, drain or simulation calls.' });
    } catch (error) { return failure(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('bridge-refresh-registries', 'Refresh authoritative NeoForge registry snapshots for the active Minecraft session', {}, async () => {
    try { return json(factory, await bridge.refreshRegistries()); } catch (error) { return failure(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('inspect-processia-machine', 'Read a Processia block and machine at a position in an already-loaded chunk; never loads chunks or changes the world', {
    dimension: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/),
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int(),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  }, async (request) => {
    try { return json(factory, await bridge.inspectMachine(request)); } catch (error) { return failure(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('inspect-processia-capabilities', 'Read ItemHandler and EnergyStorage exposure for every face of a loaded Processia block; simulation reads never change contents', {
    dimension: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/),
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int(),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  }, async (request) => {
    try {
      const result = await bridge.inspectMachine(request);
      return json(factory, { serverIdentity: result.serverIdentity, minecraftEndpoint: result.minecraftEndpoint,
        registryEpoch: result.registryEpoch, dimension: result.dimension, x: result.x, y: result.y, z: result.z,
        block: result.block, itemCapabilities: result.itemCapabilities ?? null, energyCapabilities: result.energyCapabilities ?? null,
        energyNetwork: result.energyNetwork ?? null,
        caveat: 'Insertion simulation is meaningful only for a representative item; empty slots are reported with null acceptance.' });
    } catch (error) { return failure(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('list-processia-machines', 'Search Processia blocks in a bounded sphere without loading chunks; partial chunk coverage is reported explicitly', {
    dimension: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/).default('minecraft:overworld'),
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int(),
    z: z.number().int().min(-30_000_000).max(30_000_000),
    radius: z.number().int().min(1).max(16).default(8),
    offset: z.number().int().nonnegative().max(50_000).default(0),
    limit: z.number().int().positive().max(100).default(50),
  }, async (request) => {
    try { return json(factory, await bridge.listMachines(request)); } catch (error) { return failure(factory, error); }
  }, { requiresConnection: false });

  factory.registerTool('inspect-processia-recipes', 'Read loaded Processia machine recipes without modifying the world', {
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(200).default(100),
    kind: z.enum(['processia:crushing', 'processia:pressing', 'processia:wiremilling']).optional(),
  }, async ({ offset, limit, kind }) => {
    try { return json(factory, await bridge.inspectRecipes(offset, limit, kind)); } catch (error) { return failure(factory, error); }
  }, { requiresConnection: false });
}
