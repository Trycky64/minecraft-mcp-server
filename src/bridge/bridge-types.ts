import type { RegistryKind, RegistryProvenance, RegistrySourceSnapshot } from '../services/minecraft-registry-service.js';

export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export interface BridgeHandshakeRequest {
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  expectedServerIdentity: string;
  expectedMinecraftEndpoint: string;
}

export interface BridgeHandshakeResponse {
  schemaVersion: typeof BRIDGE_PROTOCOL_VERSION;
  minecraftVersion: string;
  neoForgeVersion: string;
  serverIdentity: string;
  minecraftEndpoint: string;
  registryEpoch: string;
  observedAt: string;
  sessionId: string;
}

export interface BridgeRegistryRow {
  namespacedId: string;
  numericId?: number;
  numericIdScope?: 'server-registry-generation' | 'server-block-state-generation';
  kind: RegistryKind;
  blockStateProperties?: Record<string, string | number | boolean>;
}

export interface BridgeRegistryPage extends Omit<BridgeHandshakeResponse, 'sessionId'> {
  kind: RegistryKind;
  completeness: 'complete' | 'partial';
  offset: number;
  limit: number;
  total: number;
  entries: BridgeRegistryRow[];
}

export interface BridgeMachineInspectionRequest {
  dimension: string;
  x: number;
  y: number;
  z: number;
}

export interface BridgeMachineInspection extends Omit<BridgeHandshakeResponse, 'sessionId'> {
  dimension: string;
  x: number;
  y: number;
  z: number;
  block: string;
  blockStateId: number;
  blockStateProperties: Record<string, string>;
  blockEntityType: string | null;
  blockEntityPresent: boolean;
  inventory?: unknown;
  itemCapabilities?: unknown[];
  energyCapabilities?: unknown[];
  fluidCapabilities?: unknown[];
  blockEntityClass?: string | null;
  energyNetwork?: BridgeEnergyNetworkInspection;
  processiaMachine?: Record<string, unknown>;
}

export interface BridgeCapabilities extends Omit<BridgeHandshakeResponse, 'sessionId'> {
  status: 'available';
  registries: boolean;
  blockStateProperties: boolean;
  genericBlockEntityType: boolean;
  itemHandler: boolean;
  energyStorage: boolean;
  fluidHandler: boolean;
  loadedChunkOnly: boolean;
  readOnly: boolean;
  processiaAdapter: boolean;
}

export interface BridgeEnergyNetworkInspection {
  available: boolean;
  cables: Array<{ x: number; y: number; z: number }>;
  energyEndpoints: Array<{ x: number; y: number; z: number; face: string; block: string; stored: number; capacity: number; canReceive: boolean; canExtract: boolean }>;
  transferMeasurement: 'observed_this_tick' | 'not_measured_this_tick';
  transferredThisTick: number;
  transferLimitPerTick: number;
}

export interface BridgeMachineSearchRequest {
  dimension: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  offset: number;
  limit: number;
}

export interface BridgeMachineSearchPage extends Omit<BridgeHandshakeResponse, 'sessionId'> {
  dimension: string;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  coverage: 'complete' | 'partial';
  unloadedChunkCount: number;
  total: number;
  offset: number;
  limit: number;
  machines: Array<Record<string, unknown>>;
}

export interface BridgeRecipePage extends Omit<BridgeHandshakeResponse, 'sessionId'> {
  completeness: 'complete' | 'partial';
  offset: number;
  limit: number;
  total: number;
  recipes: Array<Record<string, unknown>>;
}

/** Authenticated runtime linkage; Java source epoch remains metadata, never replaces bot epoch. */
export interface AuthenticatedBridgeSession {
  authenticated: true;
  serverIdentity: string;
  minecraftEndpoint: string;
  minecraftVersion: string;
  neoForgeVersion: string;
  sourceRegistryEpoch: string;
  sessionId: string;
  connectedAt: string;
}

export interface BridgeSnapshotMapper {
  map(page: BridgeRegistryPage, botRegistryEpoch: string, provenance: RegistryProvenance): RegistrySourceSnapshot;
}
