import { z } from 'zod';
import { NeoForgeBridgeIntegration } from '../bridge/neoforge-bridge-client.js';
import { ToolFactory } from '../tool-factory.js';

function json(factory: ToolFactory, value: unknown) { return factory.createResponse(JSON.stringify(value, null, 2)); }
function failure(factory: ToolFactory, error: unknown) {
  const code = error instanceof Error ? error.message : 'bridge-request-failed';
  return json(factory, { status: 'error', error: code, readOnly: true });
}

export function registerBridgeTools(factory: ToolFactory, bridge: NeoForgeBridgeIntegration): void {
  factory.registerTool('bridge-status', 'Show local NeoForge bridge configuration and authenticated session status', {}, async () => json(factory, bridge.status()), { requiresConnection: false });

  factory.registerTool('bridge-refresh-registries', 'Refresh authoritative NeoForge registry snapshots for the active Minecraft session', {}, async () => {
    try { return json(factory, await bridge.refreshRegistries()); } catch (error) { return failure(factory, error); }
  });

  factory.registerTool('inspect-processia-machine', 'Read a Processia block and machine at a position in an already-loaded chunk; never loads chunks or changes the world', {
    dimension: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9/._-]+$/),
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int(),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  }, async (request) => {
    try { return json(factory, await bridge.inspectMachine(request)); } catch (error) { return failure(factory, error); }
  });

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
  });

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
  });

  factory.registerTool('inspect-processia-recipes', 'Read loaded Processia machine recipes without modifying the world', {
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(200).default(100),
    kind: z.enum(['processia:crushing', 'processia:pressing', 'processia:wiremilling']).optional(),
  }, async ({ offset, limit, kind }) => {
    try { return json(factory, await bridge.inspectRecipes(offset, limit, kind)); } catch (error) { return failure(factory, error); }
  });
}
