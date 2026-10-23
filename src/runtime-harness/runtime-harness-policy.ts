import path from 'node:path';

export type RuntimeProfileId = 'vanilla' | 'neoforge-third-party' | 'processia-optional';
export type ValidationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN' | 'UNSUPPORTED';

export interface RuntimeProfile {
  id: RuntimeProfileId;
  serverKind: 'vanilla' | 'neoforge';
  requiredMods: readonly string[];
  optional: boolean;
  scenarios: readonly string[];
}

export const RUNTIME_PROFILES: readonly RuntimeProfile[] = [
  {
    id: 'vanilla', serverKind: 'vanilla', requiredMods: [], optional: false,
    scenarios: ['connect', 'inventory-observation', 'vanilla-container-open', 'slot-inspection', 'container-close', 'server-update-confirmation'],
  },
  {
    id: 'neoforge-third-party', serverKind: 'neoforge', requiredMods: ['minecraft_mcp_bridge', 'APPROVED_THIRD_PARTY_MENU_MOD'], optional: false,
    scenarios: ['dynamic-registries', 'namespace-discovery', 'modded-menu-identity', 'numeric-menu-type', 'slot-observation', 'unknown-menu-raw-only', 'provenance', 'mineflayer-limits'],
  },
  {
    id: 'processia-optional', serverKind: 'neoforge', requiredMods: ['minecraft_mcp_bridge', 'processia'], optional: true,
    scenarios: ['processia-menu-identity', 'known-layout-match', 'synchronized-properties', 'slot-consistency'],
  },
] as const;

export interface RuntimeTarget {
  profile: RuntimeProfileId;
  host: string;
  minecraftPort: number;
  bridgePort?: number;
  guiPort?: number;
  authorized: boolean;
  harnessRoot: string;
  runDirectory: string;
  runDirectoryExists: boolean;
}

export interface TargetValidation { valid: boolean; errors: string[] }

/** Pure policy shared by the offline tests and the future launcher review. It never performs I/O. */
export function validateRuntimeTarget(input: RuntimeTarget): TargetValidation {
  const errors: string[] = [];
  if (!input.authorized) errors.push('explicit-start-authorization-required');
  if (input.host !== '127.0.0.1') errors.push('loopback-host-required');
  if (!validPort(input.minecraftPort)) errors.push('explicit-minecraft-port-required');
  if (input.minecraftPort === 25565) errors.push('personal-server-port-forbidden');
  for (const [name, port] of [['bridge', input.bridgePort], ['gui', input.guiPort]] as const) {
    if (port === undefined) continue;
    if (!validPort(port)) errors.push(`explicit-${name}-port-invalid`);
    if (port === 25565) errors.push('personal-server-port-forbidden');
    if (port === input.minecraftPort) errors.push(`${name}-port-collides-with-minecraft`);
  }
  if (input.bridgePort !== undefined && input.guiPort !== undefined && input.bridgePort === input.guiPort) errors.push('gui-port-collides-with-bridge');
  if (!isAbsolute(input.harnessRoot) || !isAbsolute(input.runDirectory)) errors.push('absolute-harness-paths-required');
  else {
    const root = normalize(input.harnessRoot);
    const run = normalize(input.runDirectory);
    if (!isWithin(root, run) || root === run) errors.push('run-directory-must-be-child-of-harness-root');
    if (input.runDirectoryExists) errors.push('run-directory-must-be-new');
    if (isWithin(normalize(process.cwd()), run)) errors.push('run-directory-must-be-outside-repository');
  }
  return { valid: errors.length === 0, errors };
}

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
  executablePath: string;
  workingDirectory: string;
  runId: string;
}

/** Exact identity comparison; port ownership alone is deliberately insufficient. */
export function sameManagedProcess(expected: ProcessIdentity, observed: ProcessIdentity | null): boolean {
  return observed !== null && expected.pid === observed.pid && expected.startedAt === observed.startedAt &&
    path.resolve(expected.executablePath).toLowerCase() === path.resolve(observed.executablePath).toLowerCase() &&
    path.resolve(expected.workingDirectory).toLowerCase() === path.resolve(observed.workingDirectory).toLowerCase() &&
    expected.runId === observed.runId;
}

export interface SupervisedProcess {
  readonly identity: ProcessIdentity;
  readonly exited: boolean;
  writeConsoleLine(line: string): Promise<void>;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface ProcessAdapter { start(target: RuntimeTarget): Promise<SupervisedProcess> }

/** In-process orchestration contract. Production OS launchers are intentionally separate. */
export class RuntimeHarnessSupervisor {
  private active: SupervisedProcess | null = null;
  constructor(private readonly adapter: ProcessAdapter) {}

  async start(target: RuntimeTarget): Promise<ProcessIdentity> {
    if (this.active && !this.active.exited) throw new Error('harness-process-already-active');
    const result = validateRuntimeTarget(target);
    if (!result.valid) throw new Error(`harness-target-refused:${result.errors.join(',')}`);
    this.active = await this.adapter.start(target);
    return { ...this.active.identity };
  }

  async stop(expected: ProcessIdentity, timeoutMs: number): Promise<'stopped' | 'stop-timeout'> {
    const current = this.active;
    if (!current || !sameManagedProcess(expected, current.identity)) throw new Error('harness-process-identity-mismatch');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('harness-stop-timeout-out-of-range');
    if (!current.exited) await current.writeConsoleLine('stop');
    const stopped = await current.waitForExit(timeoutMs);
    if (stopped) this.active = null;
    return stopped ? 'stopped' : 'stop-timeout';
  }
}

export function initialScenarioResult(scenario: string): { scenario: string; status: ValidationStatus } {
  return { scenario, status: 'NOT_RUN' };
}

function validPort(port: number | undefined): port is number {
  return port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535;
}
function isAbsolute(value: string): boolean { return path.isAbsolute(value) || path.win32.isAbsolute(value); }
function normalize(value: string): string { return (path.win32.isAbsolute(value) ? path.win32 : path).resolve(value).replace(/[\\/]+$/, '').toLowerCase(); }
function isWithin(parent: string, child: string): boolean { return child.startsWith(`${parent}${path.sep}`) || child.startsWith(`${parent}\\`) || child.startsWith(`${parent}/`); }
