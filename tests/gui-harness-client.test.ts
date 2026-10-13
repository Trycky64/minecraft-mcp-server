import test from 'ava';
import sinon from 'sinon';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeRegistryService } from '../src/services/runtime-registry-service.js';
import { GuiHarnessClient, readGuiClientConfig } from '../src/gui/gui-harness-client.js';

const secret = 'p3-test-secret-with-at-least-32-characters';
const serverEpoch = 'f26cb41b-76cb-4a90-93eb-99d0e81b2d78';
const bridgeSession = {
  authenticated: true as const, serverIdentity: 'processia-p3-test', minecraftEndpoint: '127.0.0.1:25566',
  minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', sourceRegistryEpoch: serverEpoch,
  sessionId: randomUUID(), connectedAt: new Date().toISOString(),
};
function env(overrides: Record<string, string | undefined> = {}) {
  return readGuiClientConfig({ PROCESSIA_GUI_ENABLED: 'true', PROCESSIA_GUI_SECRET: secret,
    PROCESSIA_GUI_SERVER_IDENTITY: bridgeSession.serverIdentity,
    PROCESSIA_GUI_MINECRAFT_ENDPOINT: bridgeSession.minecraftEndpoint,
    PROCESSIA_GUI_NEOFORGE_VERSION: bridgeSession.neoForgeVersion,
    PROCESSIA_GUI_URL: 'http://127.0.0.1:25578', ...overrides });
}
function runtime(bridge = bridgeSession) {
  return { getContext: () => ({ bridgeSession: bridge }) } as unknown as RuntimeRegistryService;
}
function handshake(extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, sessionId: randomUUID(), graphEpoch: randomUUID(), serverEpoch,
    serverIdentity: bridgeSession.serverIdentity, minecraftEndpoint: bridgeSession.minecraftEndpoint,
    minecraftVersion: bridgeSession.minecraftVersion, neoForgeVersion: bridgeSession.neoForgeVersion,
    observedAt: new Date().toISOString(), player: 'ProcessiaGuiProbe', ...extra };
}

test('GUI harness is disabled by default; config rejects public URLs and the existing 25565 server', (t) => {
  t.false(readGuiClientConfig({}).enabled);
  t.is(env({ PROCESSIA_GUI_URL: 'http://192.0.2.5:25578' }).error, 'gui-url-must-be-loopback-http');
  t.is(env({ PROCESSIA_GUI_MINECRAFT_ENDPOINT: '127.0.0.1:25565' }).error, 'gui-test-endpoint-must-be-local-and-not-25565');
  t.is(env({ PROCESSIA_GUI_SECRET: 'weak' }).error, 'gui-secret-must-have-at-least-32-characters');
  t.is(env({ PROCESSIA_GUI_ALLOWED_BLOCKS: 'minecraft:chest,minecraft:air' }).error, null);
  t.is(env({ PROCESSIA_GUI_ALLOWED_BLOCKS: 'othermod:chest' }).error, 'gui-block-allowlist-invalid');
});

test('TEST_MUTATION requires explicit acknowledgement of an isolated test world', (t) => {
  t.is(env({ PROCESSIA_GUI_MODE: 'TEST_MUTATION' }).error, 'gui-test-world-acknowledgement-required');
  t.is(env({ PROCESSIA_GUI_MODE: 'TEST_MUTATION', PROCESSIA_GUI_TEST_WORLD_ACK: 'true' }).error, null);
  t.deepEqual(env({ PROCESSIA_GUI_ALLOWED_MACHINES: 'minecraft:chest' }).error, 'gui-machine-allowlist-invalid');
});

test.serial('handshake binds GUI session to the authenticated bridge endpoint and server epoch', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(handshake({ clientId: request.clientId })), { status: 200 });
  });
  t.teardown(() => fetch.restore());
  const client = new GuiHarnessClient(env(), runtime());
  const result = await client.handshake();
  t.is(result.authenticated, true);
  t.is(result.serverEpoch, serverEpoch);
  t.is((fetch.firstCall.args[1]?.headers as Record<string, string>).Authorization, `Bearer ${secret}`);
  t.false(JSON.stringify(await client.status()).includes(secret));
  const request = JSON.parse(String(fetch.firstCall.args[1]?.body));
  t.is(request.expectedServerEpoch, serverEpoch);
});

test.serial('handshake refuses a stale server epoch and does not retain the session', async (t) => {
  const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(handshake({ clientId: request.clientId, serverEpoch: randomUUID() })), { status: 200 });
  });
  t.teardown(() => fetch.restore());
  const client = new GuiHarnessClient(env(), runtime());
  await t.throwsAsync(client.handshake(), { message: 'gui-session-does-not-match-neoforge-bridge-epoch' });
  t.is((await client.status()).authenticated, false);
});

test.serial('another MCP owner cannot take over a GUI lease and no session is issued without bridge identity', async (t) => {
  const unavailable = new GuiHarnessClient(env(), runtime(null as never));
  await t.throwsAsync(unavailable.handshake(), { message: 'gui-requires-authenticated-neoforge-bridge-session' });

  const fetch = sinon.stub(globalThis, 'fetch').resolves(new Response(JSON.stringify({ schemaVersion: 1, status: 'error',
    error: 'gui_session_owned_by_another_client', serverIdentity: bridgeSession.serverIdentity,
    minecraftEndpoint: bridgeSession.minecraftEndpoint, serverEpoch, graphEpoch: randomUUID(), observedAt: new Date().toISOString() }), { status: 423 }));
  t.teardown(() => fetch.restore());
  const client = new GuiHarnessClient(env(), runtime());
  await t.throwsAsync(client.handshake(), { message: 'gui-gui_session_owned_by_another_client' });
  t.is((await client.status()).authenticated, false);
});

test.serial('bridge timeout and malformed JSON stay explicit errors', async (t) => {
  const session = handshake();
  const fetch = sinon.stub(globalThis, 'fetch');
  fetch.onFirstCall().callsFake(async (_input, init) => new Response(JSON.stringify({ ...session, clientId: JSON.parse(String(init?.body)).clientId }), { status: 200 }));
  fetch.onSecondCall().rejects(new DOMException('timed out', 'TimeoutError'));
  fetch.onThirdCall().callsFake(async (_input, init) => new Response(JSON.stringify({ ...session, clientId: JSON.parse(String(init?.body)).clientId }), { status: 200 }));
  fetch.onCall(3).resolves(new Response('not-json', { status: 200 }));
  t.teardown(() => fetch.restore());
  const client = new GuiHarnessClient(env(), runtime());
  await t.throwsAsync(client.call('/v1/screen'), { message: 'gui-request-timeout' });
  client.clearSession();
  await client.handshake();
  await t.throwsAsync(client.call('/v1/screen'), { message: 'gui-invalid-json' });
});

test.serial('authenticated screen inspection validates response identity, version and graph epoch', async (t) => {
  const session = handshake();
  const fetch = sinon.stub(globalThis, 'fetch');
  fetch.onFirstCall().callsFake(async (_input, init) => new Response(JSON.stringify({ ...session, clientId: JSON.parse(String(init?.body)).clientId }), { status: 200 }));
  fetch.onSecondCall().resolves(new Response(JSON.stringify({ schemaVersion: 1, serverIdentity: session.serverIdentity,
    minecraftEndpoint: session.minecraftEndpoint, serverEpoch, graphEpoch: session.graphEpoch, observedAt: new Date().toISOString(),
    minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', screenActive: false, slots: [], widgets: [] }), { status: 200 }));
  t.teardown(() => fetch.restore());
  const client = new GuiHarnessClient(env(), runtime());
  const screen = await client.call('/v1/screen');
  t.is(screen.screenActive, false);
  t.is((fetch.secondCall.args[1]?.headers as Record<string, string>)['X-Processia-Gui-Session'], session.sessionId);
  fetch.onThirdCall().resolves(new Response(JSON.stringify({ schemaVersion: 1, serverIdentity: session.serverIdentity,
    minecraftEndpoint: session.minecraftEndpoint, serverEpoch: randomUUID(), graphEpoch: session.graphEpoch,
    observedAt: new Date().toISOString(), minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259' }), { status: 200 }));
  await t.throwsAsync(client.call('/v1/screen'), { message: 'gui-response-server-epoch-mismatch' });
  t.is((await client.status()).authenticated, false);
});

test.serial('real framebuffer PNG is signature- and hash-checked before retention', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'processia-p3-test-'));
  t.teardown(async () => { await rm(directory, { recursive: true, force: true }); });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const session = handshake();
  const fetch = sinon.stub(globalThis, 'fetch');
  fetch.onFirstCall().callsFake(async (_input, init) => new Response(JSON.stringify({ ...session, clientId: JSON.parse(String(init?.body)).clientId }), { status: 200 }));
  fetch.onSecondCall().resolves(new Response(JSON.stringify({ schemaVersion: 1, serverIdentity: session.serverIdentity,
    minecraftEndpoint: session.minecraftEndpoint, serverEpoch, graphEpoch: session.graphEpoch, observedAt: new Date().toISOString(),
    minecraftVersion: '1.21.1', neoForgeVersion: '21.1.259', mediaType: 'image/png', width: 1920, height: 1080,
    sha256: createHash('sha256').update(png).digest('hex'), base64: png.toString('base64'), screen: { screenActive: true } }), { status: 200 }));
  t.teardown(() => fetch.restore());
  const client = new GuiHarnessClient(env({ PROCESSIA_GUI_ARTIFACT_DIR: directory }), runtime());
  const capture = await client.screenshot();
  t.is(capture.mediaType, 'image/png');
  t.is(capture.bytes, png.length);
  t.true(String(capture.path).startsWith(directory));
  t.deepEqual(await readFile(String(capture.path)), png);
  t.false('base64' in capture);
});
