import test from 'ava';
import sinon from 'sinon';
import { GenericNeoForgeBridgeAdapter, ProcessiaBridgeAdapter } from '../src/bridge/bridge-adapters.js';
import { BridgeAdapterError, normalizeBridgeError } from '../src/bridge/bridge-adapter-contract.js';
import { NeoForgeBridgeClient, readBridgeClientConfig } from '../src/bridge/neoforge-bridge-client.js';

const secretA = 'generic-local-test-secret-with-more-than-32-characters';
const secretB = 'processia-local-test-secret-with-more-than-32-characters';

function genericConfig() {
  return readBridgeClientConfig({ MINECRAFT_MCP_BRIDGE_ENABLED: 'true', MINECRAFT_MCP_BRIDGE_SECRET: secretA,
    MINECRAFT_MCP_BRIDGE_SERVER_IDENTITY: 'generic-server', MINECRAFT_MCP_SERVER_ENDPOINT: '127.0.0.1:25665',
    MINECRAFT_MCP_BRIDGE_NEOFORGE_VERSION: '21.1.259' });
}

function processiaConfig() {
  return readBridgeClientConfig({ PROCESSIA_BRIDGE_ENABLED: 'true', PROCESSIA_BRIDGE_SECRET: secretB,
    PROCESSIA_BRIDGE_SERVER_IDENTITY: 'processia-server', PROCESSIA_MINECRAFT_ENDPOINT: '127.0.0.1:25665',
    PROCESSIA_BRIDGE_NEOFORGE_VERSION: '21.1.259' });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function protocolReply(init: RequestInit | undefined, value: Record<string, unknown>, prefix: 'X-Processia' | 'X-Minecraft-MCP'): Response {
  const requestId = new Headers(init?.headers).get(`${prefix}-Request-Id`) ?? '';
  return new Response(JSON.stringify({ ...value, requestId }), { status: 200, headers: { [`${prefix}-Request-Id`]: requestId } });
}

function genericHandshake(sessionId = '267318c8-a93c-48e9-8d92-6d30d78528b8') {
  return { schemaVersion: 1, minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', serverIdentity: 'generic-server',
    minecraftEndpoint: '127.0.0.1:25665', registryEpoch: 'b4490c33-6321-4e6c-8a5d-3d57244c885d',
    observedAt: '2026-10-21T10:00:00.000Z', sessionId };
}

test('adapter selection and capabilities remain protocol-specific with isolated credentials', (t) => {
  const genericClient = new NeoForgeBridgeClient(genericConfig());
  const processiaClient = new NeoForgeBridgeClient(processiaConfig());
  const generic = new GenericNeoForgeBridgeAdapter(genericClient);
  const processia = new ProcessiaBridgeAdapter(processiaClient);
  t.is(generic.kind, 'generic-neoforge');
  t.is(processia.kind, 'processia');
  t.true(generic.supports('registry.dynamic-index'));
  t.true(generic.supports('capability.fluid-handler'));
  t.false(generic.supports('machine.search'));
  t.true(processia.supports('machine.search'));
  t.true(processia.supports('recipes.inspect'));
  t.false(processia.supports('registry.dynamic-index'));
  t.false(processia.supports('capability.processia-gas'));
  t.not(genericClient.config.secret, processiaClient.config.secret);
  t.false('client' in generic);
  t.false(JSON.stringify({ generic: generic.capabilities, processia: processia.capabilities }).includes(secretA));
  t.false(JSON.stringify({ generic: generic.capabilities, processia: processia.capabilities }).includes(secretB));
});

test('adapter refuses a client configured for the other bridge protocol', (t) => {
  const genericClient = new NeoForgeBridgeClient(genericConfig());
  const processiaClient = new NeoForgeBridgeClient(processiaConfig());
  t.throws(() => new ProcessiaBridgeAdapter(genericClient), { code: 'bridge-configuration-invalid' });
  t.throws(() => new GenericNeoForgeBridgeAdapter(processiaClient), { code: 'bridge-configuration-invalid' });
});

test('adapter normalizes timeout and identity errors without preserving sensitive details', async (t) => {
  const client = new NeoForgeBridgeClient(genericConfig());
  const adapter = new GenericNeoForgeBridgeAdapter(client);
  const handshake = sinon.stub(client, 'handshake').rejects(new Error(`bridge-request-timeout ${secretA}`));
  const error = await t.throwsAsync(adapter.handshake('1.21.1', '127.0.0.1:25665'));
  t.true(error instanceof BridgeAdapterError);
  t.is((error as BridgeAdapterError).code, 'bridge-timeout');
  t.false(error!.message.includes(secretA));
  handshake.restore();
  const identityError = normalizeBridgeError(new Error('bridge-server-identity-mismatch'));
  t.is(identityError.code, 'server-identity-mismatch');
  t.is(identityError.message, 'bridge-server-identity-mismatch');
  t.is(normalizeBridgeError(new Error('bridge-handshake-required')).code, 'session-expired');
  t.is(normalizeBridgeError(new Error('bridge-operation-invalidated-by-runtime-session-change')).code, 'stale-registry-epoch');
  t.is(normalizeBridgeError(new Error('processia-machine-search-requires-processia-adapter')).code, 'capability-unsupported');
  const nonRevoking = Object.assign(new Error('bridge-chunk_not_loaded'), { invalidatesSession: false });
  t.is(normalizeBridgeError(nonRevoking).code, 'chunk-not-loaded');
  t.false(normalizeBridgeError(nonRevoking).invalidatesSession);
  const malformedRevocationSignal = Object.assign(new Error('bridge-chunk_not_loaded'), { invalidatesSession: 'false' });
  t.false(normalizeBridgeError(malformedRevocationSignal).invalidatesSession);
  t.true(new BridgeAdapterError('bridge-request-failed', undefined, 'false').invalidatesSession);
  t.false(normalizeBridgeError(new Error('bridge-invalid-pagination-request')).invalidatesSession);
  t.false(normalizeBridgeError(new Error('processia-machine-search-requires-processia-adapter')).invalidatesSession);
  t.false(normalizeBridgeError(new Error('bridge-disabled')).invalidatesSession);
  t.true(normalizeBridgeError(new Error('unexpected-internal-failure')).invalidatesSession);
  t.is(normalizeBridgeError(Object.assign(new Error('bridge-permission_denied'), { status: 403, invalidatesSession: true })).code, 'authentication-refused');
  t.is(normalizeBridgeError(Object.assign(new Error('bridge-internal_error'), { status: 503 })).code, 'bridge-unavailable');
  t.is(normalizeBridgeError(new BridgeAdapterError('bridge-request-failed', secretA)).message, 'bridge-request-failed');
  const forgedNonRevokingAuth = Object.assign(new Error('anything'), { status: 403, invalidatesSession: false });
  t.is(normalizeBridgeError(forgedNonRevokingAuth).code, 'authentication-refused');
  t.true(normalizeBridgeError(forgedNonRevokingAuth).invalidatesSession);
  const malformedSignalOnInternalError = Object.assign(new Error('unexpected-internal-failure'), { invalidatesSession: 'false' });
  t.true(normalizeBridgeError(malformedSignalOnInternalError).invalidatesSession);
  const http408 = normalizeBridgeError(Object.assign(new Error('request timeout'), { status: 408 }));
  t.is(http408.code, 'bridge-http-timeout');
  t.false(http408.invalidatesSession);
  const contradictoryRevocation = normalizeBridgeError(Object.assign(new Error('request timeout'), {
    status: 408, bridgeErrorCode: 'authentication-refused',
  }));
  t.is(contradictoryRevocation.code, 'invalid-bridge-response');
  t.is(contradictoryRevocation.message, 'bridge-http-status-code-mismatch');
  t.true(contradictoryRevocation.invalidatesSession);
  const contradictoryBenignCode = normalizeBridgeError(Object.assign(new Error('access denied'), {
    status: 403, bridgeErrorCode: 'chunk-not-loaded', invalidatesSession: false,
  }));
  t.is(contradictoryBenignCode.code, 'authentication-refused');
  t.true(contradictoryBenignCode.invalidatesSession);
  const http429 = normalizeBridgeError(Object.assign(new Error('rate limited'), { status: 429 }));
  t.is(http429.code, 'bridge-rate-limited');
  t.false(http429.invalidatesSession);
  const untrustedHttpDiagnostic = normalizeBridgeError(Object.assign(new Error('bridge-privatepayload'), { status: 404 }));
  t.is(untrustedHttpDiagnostic.message, 'resource-not-found');
  t.false(untrustedHttpDiagnostic.message.includes('privatepayload'));
  for (const status of [500, 502, 503, 504]) {
    const serverFailure = normalizeBridgeError(Object.assign(new Error('gateway failure'), { status }));
    t.is(serverFailure.code, 'bridge-unavailable');
    t.true(serverFailure.invalidatesSession);
  }
  t.is(normalizeBridgeError(Object.assign(new Error('bad request'), { status: 400 })).code, 'invalid-request');
  t.false(normalizeBridgeError(Object.assign(new Error('bad request'), { status: 400 })).invalidatesSession);
  t.is(normalizeBridgeError(Object.assign(new Error('missing'), { status: 404 })).code, 'resource-not-found');
  t.is(normalizeBridgeError(Object.assign(new Error('unsupported'), { status: 405 })).code, 'capability-unsupported');
});

test.serial('adapter maps rejected credentials to authentication-refused without leaking the secret', async (t) => {
  const client = new NeoForgeBridgeClient(processiaConfig());
  const adapter = new ProcessiaBridgeAdapter(client);
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (_input, init) => {
    const headers = new Headers(init?.headers);
    const requestId = headers.get('X-Processia-Request-Id') ?? '';
    return new Response(JSON.stringify({ requestId, error: 'unauthorized' }), {
      status: 401, headers: { 'X-Processia-Request-Id': requestId },
    });
  });
  t.teardown(() => fetch.restore());
  const error = await t.throwsAsync(adapter.handshake('1.21.1', '127.0.0.1:25665'));
  t.is((error as BridgeAdapterError).code, 'authentication-refused');
  t.is((error as BridgeAdapterError).message, 'bridge-unauthorized');
  t.false(error!.message.includes(secretB));
  t.is(adapter.session, null);
  t.is(adapter.sessionContext, null);
});

test.serial('authenticated adapter exposes bridge identity and source registry epoch as a distinct context', async (t) => {
  const client = new NeoForgeBridgeClient(genericConfig());
  const adapter = new GenericNeoForgeBridgeAdapter(client);
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (_input, init) => {
    const headers = new Headers(init?.headers);
    const requestId = headers.get('X-Minecraft-MCP-Request-Id') ?? '';
    const sourceRegistryEpoch = 'b4490c33-6321-4e6c-8a5d-3d57244c885d';
    return new Response(JSON.stringify({ schemaVersion: 1, minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259',
      serverIdentity: 'generic-server', minecraftEndpoint: '127.0.0.1:25665', registryEpoch: sourceRegistryEpoch,
      observedAt: '2026-10-21T10:00:00.000Z', sessionId: '267318c8-a93c-48e9-8d92-6d30d78528b8', requestId }),
    { status: 200, headers: { 'X-Minecraft-MCP-Request-Id': requestId } });
  });
  t.teardown(() => fetch.restore());
  await adapter.handshake('1.21.1', '127.0.0.1:25665');
  t.is(adapter.state, 'authenticated');
  t.deepEqual(adapter.sessionContext, {
    sessionId: '267318c8-a93c-48e9-8d92-6d30d78528b8', serverIdentity: 'generic-server',
    minecraftEndpoint: '127.0.0.1:25665', minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259',
    sourceRegistryEpoch: 'b4490c33-6321-4e6c-8a5d-3d57244c885d',
  });
  adapter.clearSession();
  t.is(adapter.state, 'disconnected');
});

test.serial('concurrent handshakes use latest-started wins and reject the stale response', async (t) => {
  const client = new NeoForgeBridgeClient(genericConfig());
  const adapter = new GenericNeoForgeBridgeAdapter(client);
  const firstResponse = deferred<Response>();
  const secondResponse = deferred<Response>();
  let calls = 0;
  const fetch = sinon.stub(globalThis, 'fetch').callsFake((_input, _init) => {
    calls += 1;
    return calls === 1 ? firstResponse.promise : secondResponse.promise;
  });
  t.teardown(() => fetch.restore());

  const first = adapter.handshake('1.21.1', '127.0.0.1:25665');
  const second = adapter.handshake('1.21.1', '127.0.0.1:25665');
  t.is(adapter.state, 'connecting');
  secondResponse.resolve(protocolReply(fetch.secondCall.args[1], genericHandshake('f3ac08b0-5227-4d5b-ab42-f562e13207d6'), 'X-Minecraft-MCP'));
  const activeSession = await second;
  firstResponse.resolve(protocolReply(fetch.firstCall.args[1], genericHandshake(), 'X-Minecraft-MCP'));
  const staleError = await t.throwsAsync(first);
  t.is((staleError as BridgeAdapterError).code, 'session-expired');
  t.is(adapter.session?.sessionId, activeSession.sessionId);
});

test.serial('close during handshake invalidates the late handshake without restoring a session', async (t) => {
  const client = new NeoForgeBridgeClient(genericConfig());
  const adapter = new GenericNeoForgeBridgeAdapter(client);
  const pending = deferred<Response>();
  const fetch = sinon.stub(globalThis, 'fetch').returns(pending.promise);
  t.teardown(() => fetch.restore());
  const handshake = adapter.handshake('1.21.1', '127.0.0.1:25665');
  await adapter.close();
  t.is(adapter.state, 'closed');
  pending.resolve(protocolReply(fetch.firstCall.args[1], genericHandshake(), 'X-Minecraft-MCP'));
  const error = await t.throwsAsync(handshake);
  t.is((error as BridgeAdapterError).code, 'session-expired');
  t.is(adapter.session, null);
});

test.serial('bridge close failure is bounded by the request deadline and still revokes local session state', async (t) => {
  const client = new NeoForgeBridgeClient({ ...genericConfig(), timeoutMs: 25 });
  const adapter = new GenericNeoForgeBridgeAdapter(client);
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/handshake')) return protocolReply(init, genericHandshake(), 'X-Minecraft-MCP');
    return new Promise<Response>(() => { /* Deliberately never settles; the local deadline must release close. */ });
  });
  t.teardown(() => fetch.restore());
  await adapter.handshake('1.21.1', '127.0.0.1:25665');
  const error = await t.throwsAsync(adapter.close());
  t.is((error as BridgeAdapterError).code, 'bridge-timeout');
  t.is(adapter.state, 'closed');
  t.is(adapter.session, null);
});

test.serial('late data response after clearSession cannot be returned by the adapter', async (t) => {
  const client = new NeoForgeBridgeClient(genericConfig());
  const adapter = new GenericNeoForgeBridgeAdapter(client);
  const pendingPage = deferred<Response>();
  const fetch = sinon.stub(globalThis, 'fetch').callsFake((input, init) => {
    if (new URL(String(input)).pathname.endsWith('/v1/handshake')) {
      return Promise.resolve(protocolReply(init, genericHandshake(), 'X-Minecraft-MCP'));
    }
    return pendingPage.promise;
  });
  t.teardown(() => fetch.restore());
  await adapter.handshake('1.21.1', '127.0.0.1:25665');
  const page = adapter.getRegistryPage('item', 0, 10);
  adapter.clearSession();
  pendingPage.resolve(protocolReply(fetch.secondCall.args[1], { schemaVersion: 1, minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259',
    serverIdentity: 'generic-server', minecraftEndpoint: '127.0.0.1:25665', registryEpoch: 'b4490c33-6321-4e6c-8a5d-3d57244c885d',
    observedAt: '2026-10-21T10:00:00.000Z', kind: 'item', completeness: 'complete', offset: 0, limit: 10, total: 0, entries: [] }, 'X-Minecraft-MCP'));
  const error = await t.throwsAsync(page);
  t.is((error as BridgeAdapterError).code, 'session-expired');
  t.is(adapter.session, null);
});

test.serial('close during registry read makes the late read unusable and leaves the adapter closed', async (t) => {
  const client = new NeoForgeBridgeClient(genericConfig());
  const adapter = new GenericNeoForgeBridgeAdapter(client);
  const pendingPage = deferred<Response>();
  const fetch = sinon.stub(globalThis, 'fetch').callsFake((input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/v1/handshake')) return Promise.resolve(protocolReply(init, genericHandshake(), 'X-Minecraft-MCP'));
    if (path.endsWith('/v1/close')) return Promise.resolve(protocolReply(init, { closed: true }, 'X-Minecraft-MCP'));
    return pendingPage.promise;
  });
  t.teardown(() => fetch.restore());
  await adapter.handshake('1.21.1', '127.0.0.1:25665');
  const page = adapter.getRegistryPage('item', 0, 10);
  const closing = adapter.close();
  await closing;
  pendingPage.resolve(protocolReply(fetch.secondCall.args[1], { schemaVersion: 1, minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259',
    serverIdentity: 'generic-server', minecraftEndpoint: '127.0.0.1:25665', registryEpoch: 'b4490c33-6321-4e6c-8a5d-3d57244c885d',
    observedAt: '2026-10-21T10:00:00.000Z', kind: 'item', completeness: 'complete', offset: 0, limit: 10, total: 0, entries: [] }, 'X-Minecraft-MCP'));
  const error = await t.throwsAsync(page);
  t.is((error as BridgeAdapterError).code, 'session-expired');
  t.is(adapter.state, 'closed');
});

test.serial('HTTP 408/429 are distinct non-revoking responses while 503 fails closed', async (t) => {
  const client = new NeoForgeBridgeClient(genericConfig());
  const adapter = new GenericNeoForgeBridgeAdapter(client);
  let status = 408;
  let remoteErrorField = 'request_error';
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/v1/handshake')) return protocolReply(init, genericHandshake(), 'X-Minecraft-MCP');
    const requestId = new Headers(init?.headers).get('X-Minecraft-MCP-Request-Id') ?? '';
    return new Response(JSON.stringify({ requestId, error: remoteErrorField }), {
      status, headers: { 'X-Minecraft-MCP-Request-Id': requestId },
    });
  });
  t.teardown(() => fetch.restore());
  await adapter.handshake('1.21.1', '127.0.0.1:25665');

  let error = await t.throwsAsync(adapter.getRegistryPage('item', 0, 1));
  t.is((error as BridgeAdapterError).code, 'bridge-http-timeout');
  t.false((error as BridgeAdapterError).invalidatesSession);
  t.is(adapter.state, 'authenticated');

  status = 429;
  error = await t.throwsAsync(adapter.getRegistryPage('item', 0, 1));
  t.is((error as BridgeAdapterError).code, 'bridge-rate-limited');
  t.false((error as BridgeAdapterError).invalidatesSession);
  t.is(adapter.state, 'authenticated');

  status = 503;
  remoteErrorField = 'privatecredentialtoken';
  error = await t.throwsAsync(adapter.getRegistryPage('item', 0, 1));
  t.is((error as BridgeAdapterError).code, 'bridge-unavailable');
  t.true((error as BridgeAdapterError).invalidatesSession);
  t.false(error!.message.includes(remoteErrorField));
  t.is(adapter.state, 'disconnected');
});

test.serial('HTTP authentication refusal revokes the session despite a contradictory non-revoking body code', async (t) => {
  const client = new NeoForgeBridgeClient(genericConfig());
  const adapter = new GenericNeoForgeBridgeAdapter(client);
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/v1/handshake')) return protocolReply(init, genericHandshake(), 'X-Minecraft-MCP');
    const requestId = new Headers(init?.headers).get('X-Minecraft-MCP-Request-Id') ?? '';
    return new Response(JSON.stringify({ requestId, error: 'chunk_not_loaded' }), {
      status: 403, headers: { 'X-Minecraft-MCP-Request-Id': requestId },
    });
  });
  t.teardown(() => fetch.restore());
  await adapter.handshake('1.21.1', '127.0.0.1:25665');

  const error = await t.throwsAsync(adapter.getRegistryPage('item', 0, 1));
  t.is((error as BridgeAdapterError).code, 'authentication-refused');
  t.true((error as BridgeAdapterError).invalidatesSession);
  t.is(adapter.state, 'disconnected');
});

test('adapter errors preserve safe diagnostic identifiers and redact configured credentials', async (t) => {
  const client = new NeoForgeBridgeClient(genericConfig());
  const adapter = new GenericNeoForgeBridgeAdapter(client);
  const handshake = sinon.stub(client, 'handshake').rejects(new Error(`bridge-session-metadata-changed ${secretA}`));
  const error = await t.throwsAsync(adapter.handshake('1.21.1', '127.0.0.1:25665'));
  t.is((error as BridgeAdapterError).code, 'invalid-bridge-response');
  t.is(error!.message, 'bridge-session-metadata-changed');
  t.false(error!.message.includes(secretA));
  handshake.restore();
  const responseError = normalizeBridgeError(new Error('bridge-invalid-machine-search-request'));
  t.is(responseError.message, 'bridge-invalid-machine-search-request');
  t.is(responseError.code, 'invalid-request');
});

test.serial('unsupported capabilities are explicit and do not fall through to another protocol endpoint', async (t) => {
  const adapter = new ProcessiaBridgeAdapter(new NeoForgeBridgeClient(processiaConfig()));
  const genericAdapter = new GenericNeoForgeBridgeAdapter(new NeoForgeBridgeClient(genericConfig()));
  const fetch = sinon.stub(globalThis, 'fetch');
  t.teardown(() => fetch.restore());
  const error = await t.throwsAsync(adapter.getServerCapabilities());
  t.is((error as BridgeAdapterError).code, 'capability-unsupported');
  t.false((error as BridgeAdapterError).invalidatesSession);
  t.is((await t.throwsAsync(genericAdapter.listMachines({ dimension: 'minecraft:overworld', x: 0, y: 64, z: 0, radius: 1, offset: 0, limit: 10 })) as BridgeAdapterError).code, 'capability-unsupported');
  t.is((await t.throwsAsync(genericAdapter.inspectRecipes()) as BridgeAdapterError).code, 'capability-unsupported');
  t.false(fetch.called);
  t.is(adapter.state, 'disconnected');
});

test('closed adapter cannot silently reuse its previous authenticated client', async (t) => {
  const adapter = new GenericNeoForgeBridgeAdapter(new NeoForgeBridgeClient(genericConfig()));
  await adapter.close();
  t.is(adapter.state, 'closed');
  const error = await t.throwsAsync(adapter.handshake('1.21.1', '127.0.0.1:25665'));
  t.is((error as BridgeAdapterError).code, 'bridge-unavailable');
});
