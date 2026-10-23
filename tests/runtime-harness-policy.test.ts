import test from 'ava';
import {
  initialScenarioResult, RUNTIME_PROFILES, RuntimeHarnessSupervisor, sameManagedProcess, validateRuntimeTarget,
  type ProcessAdapter, type ProcessIdentity, type RuntimeTarget, type SupervisedProcess,
} from '../src/runtime-harness/runtime-harness-policy.js';

const base: RuntimeTarget = {
  profile: 'vanilla', host: '127.0.0.1', minecraftPort: 26001, bridgePort: undefined, guiPort: undefined,
  authorized: true, harnessRoot: 'C:\\Users\\tester\\minecraft-mcp-test\\mission29',
  runDirectory: 'C:\\Users\\tester\\minecraft-mcp-test\\mission29\\runs\\vanilla\\run-a', runDirectoryExists: false,
};
const identity: ProcessIdentity = {
  pid: 7421, startedAt: '2026-10-21T10:00:00.000Z', executablePath: 'C:\\Java\\bin\\java.exe',
  workingDirectory: base.runDirectory, runId: 'run-a',
};

test('defines vanilla, independent third-party NeoForge, and optional Processia profiles', (t) => {
  t.deepEqual(RUNTIME_PROFILES.map((profile) => profile.id), ['vanilla', 'neoforge-third-party', 'processia-optional']);
  t.false(RUNTIME_PROFILES.find((profile) => profile.id === 'neoforge-third-party')!.optional);
  t.true(RUNTIME_PROFILES.find((profile) => profile.id === 'processia-optional')!.optional);
  t.true(RUNTIME_PROFILES.find((profile) => profile.id === 'neoforge-third-party')!.requiredMods.includes('APPROVED_THIRD_PARTY_MENU_MOD'));
  t.true(RUNTIME_PROFILES.find((profile) => profile.id === 'vanilla')!.requiredMods.length === 0);
});

test('refuses missing authorization and implicit, public, invalid, or forbidden targets', (t) => {
  t.true(validateRuntimeTarget({ ...base, authorized: false }).errors.includes('explicit-start-authorization-required'));
  t.true(validateRuntimeTarget({ ...base, host: '0.0.0.0' }).errors.includes('loopback-host-required'));
  t.true(validateRuntimeTarget({ ...base, minecraftPort: 25565 }).errors.includes('personal-server-port-forbidden'));
  t.true(validateRuntimeTarget({ ...base, minecraftPort: 0 }).errors.includes('explicit-minecraft-port-required'));
  t.true(validateRuntimeTarget({ ...base, minecraftPort: undefined as unknown as number }).errors.includes('explicit-minecraft-port-required'));
  t.true(validateRuntimeTarget({ ...base, bridgePort: 26001 }).errors.includes('bridge-port-collides-with-minecraft'));
  t.true(validateRuntimeTarget({ ...base, bridgePort: 26002, guiPort: 26002 }).errors.includes('gui-port-collides-with-bridge'));
  t.true(validateRuntimeTarget({ ...base, bridgePort: 25565 }).errors.includes('personal-server-port-forbidden'));
});

test('requires new run directories under a dedicated root outside the repository', (t) => {
  t.true(validateRuntimeTarget({ ...base, runDirectoryExists: true }).errors.includes('run-directory-must-be-new'));
  t.true(validateRuntimeTarget({ ...base, runDirectory: 'C:\\Users\\tester\\processia-mcp-server\\runs\\x' }).errors.includes('run-directory-must-be-child-of-harness-root'));
  t.true(validateRuntimeTarget({ ...base, harnessRoot: 'relative', runDirectory: 'relative\\run' }).errors.includes('absolute-harness-paths-required'));
  t.true(validateRuntimeTarget(base).valid);
});

test('process ownership requires the same PID, start time, executable, working directory, and run ID', (t) => {
  t.true(sameManagedProcess(identity, identity));
  t.false(sameManagedProcess(identity, { ...identity, pid: identity.pid + 1 }));
  t.false(sameManagedProcess(identity, { ...identity, startedAt: '2026-10-21T10:01:00.000Z' }));
  t.false(sameManagedProcess(identity, { ...identity, workingDirectory: 'C:\\unrelated' }));
  t.false(sameManagedProcess(identity, null));
});

test('supervisor refuses unauthorized starts and never targets an unmanaged process on stop', async (t) => {
  const fake = new FakeProcess();
  const supervisor = new RuntimeHarnessSupervisor(fake);
  await t.throwsAsync(supervisor.start({ ...base, authorized: false }), { message: /explicit-start-authorization-required/ });
  t.is(fake.startCount, 0);
  await t.throwsAsync(supervisor.stop(identity, 1000), { message: 'harness-process-identity-mismatch' });
});

test('supervisor permits only one active profile at a time', async (t) => {
  const fake = new FakeProcess();
  const supervisor = new RuntimeHarnessSupervisor(fake);
  await supervisor.start(base);
  await t.throwsAsync(supervisor.start({ ...base, profile: 'neoforge-third-party', runDirectory: `${base.harnessRoot}\\runs\\neoforge-third-party\\run-b` }), {
    message: 'harness-process-already-active',
  });
  t.is(fake.startCount, 1);
});

test('supervisor sends only graceful stop and leaves timed-out process managed', async (t) => {
  const fake = new FakeProcess();
  const supervisor = new RuntimeHarnessSupervisor(fake);
  const started = await supervisor.start(base);
  t.deepEqual(started, identity);
  const timeout = await supervisor.stop(started, 1000);
  t.is(timeout, 'stop-timeout');
  t.deepEqual(fake.consoleLines, ['stop']);
  t.is(fake.forceStopCount, 0);
  fake.exited = true;
  fake.waitResult = true;
  t.is(await supervisor.stop(started, 1000), 'stopped');
  t.is(fake.consoleLines.length, 1);
});

test('rejects unreasonable stop timeouts and marks runtime scenarios NOT_RUN by default', async (t) => {
  const fake = new FakeProcess();
  const supervisor = new RuntimeHarnessSupervisor(fake);
  const started = await supervisor.start(base);
  await t.throwsAsync(supervisor.stop(started, 1), { message: 'harness-stop-timeout-out-of-range' });
  t.deepEqual(initialScenarioResult('vanilla-container-open'), { scenario: 'vanilla-container-open', status: 'NOT_RUN' });
});

class FakeProcess implements ProcessAdapter, SupervisedProcess {
  identity = { ...identity };
  exited = false;
  waitResult = false;
  startCount = 0;
  forceStopCount = 0;
  consoleLines: string[] = [];
  async start(): Promise<SupervisedProcess> { this.startCount += 1; return this; }
  async writeConsoleLine(line: string): Promise<void> { this.consoleLines.push(line); }
  async waitForExit(): Promise<boolean> { return this.waitResult; }
}
