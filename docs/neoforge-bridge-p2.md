# NeoForge diagnostic bridge (P2)

The Processia bridge is an opt-in, read-only local diagnostics service. It is disabled by default. It does not execute commands, open menus, change blocks, move players, transfer items, or load chunks. World reads and registry reads are dispatched onto the NeoForge server thread.

## Components

- `src/main/java/com/trycky/processia/bridge/NeoForgeDiagnosticBridge.java` owns the loopback HTTP lifecycle and read-only endpoints.
- `BridgeConfig` reads environment variables; `BridgeAuthenticator` and `BridgeProtocol` implement secret/session and handshake validation.
- `src/bridge/neoforge-bridge-client.ts` implements the MCP-side client, schema checks, loopback policy, identity/version checks, pagination and integration with `RuntimeRegistryService`.
- `src/tools/bridge-tools.ts` exposes four MCP tools. Existing vanilla and registry tools remain registered.

The server identity is an operator-provisioned instance label. The Mineflayer endpoint is checked against the endpoint configured on both sides. The Java registry epoch is a UUID generated for that server process and remains separate from the random bot-session epoch. Bridge entries are mapped to the active bot epoch only after an authenticated handshake has matched the configured identity, endpoint, Minecraft version and NeoForge version. Their provenance retains both epochs and the server identity.

## Enabling for local development

Generate a unique random secret of at least 32 characters using a local secret manager or a cryptographically secure random generator. Do not commit or paste it into logs, MCP JSON files or source code. Set the following variables in the environment of the **dedicated server process** before starting it:

```text
PROCESSIA_ENVIRONMENT=development
PROCESSIA_BRIDGE_ENABLED=true
PROCESSIA_BRIDGE_SECRET=<local-generated-secret>
PROCESSIA_BRIDGE_SERVER_IDENTITY=processia-dev-01
PROCESSIA_MINECRAFT_ENDPOINT=127.0.0.1:25565
PROCESSIA_BRIDGE_PORT=25576
```

If any required value is missing or invalid, bridge startup is refused and Minecraft continues without the bridge. The bridge binds only `127.0.0.1`; the Minecraft endpoint must be `localhost:port` or `127.0.0.1:port`. Default behavior with `PROCESSIA_BRIDGE_ENABLED` unset is disabled.

Set these variables in the MCP process environment:

```text
PROCESSIA_BRIDGE_ENABLED=true
PROCESSIA_BRIDGE_URL=http://127.0.0.1:25576
PROCESSIA_BRIDGE_SECRET=<same-local-secret>
PROCESSIA_BRIDGE_SERVER_IDENTITY=processia-dev-01
PROCESSIA_MINECRAFT_ENDPOINT=127.0.0.1:25565
PROCESSIA_BRIDGE_NEOFORGE_VERSION=21.1.259
PROCESSIA_BRIDGE_TIMEOUT_MS=3000
```

The TypeScript client rejects non-loopback URLs and plain HTTP to any other host. It does not expose the secret in status or errors. Closing the MCP process revokes its bridge session; sessions also expire after 30 minutes of inactivity. Restart the Minecraft server after changing the server process environment. No current MCP configuration is edited by this implementation.

## Protocol v1

All successful data JSON responses include `schemaVersion`, `minecraftVersion`, `neoForgeVersion`, `serverIdentity`, `minecraftEndpoint`, `registryEpoch` (Java process generation) and `observedAt`; the MCP validates the complete tuple on every response. Requests are limited to 16 KiB; JSON responses to 2 MiB; registry pages to 1,000 rows (MCP fetches 500 at a time). The MCP caps the combined snapshot at 50,000 entries so a complete refresh remains bounded under the 120-requests-per-minute limit, and rejects duplicate keys, numeric collisions, inconsistent page metadata or incomplete snapshots declared complete. Responses are read with a streaming byte limit. The server allows four concurrent requests and caps each loopback peer at 120 requests per minute. Reads dispatched to the server thread time out after three seconds. A timed-out queued read is logically cancelled before it starts.

1. `POST /v1/handshake` requires `Authorization: Bearer <secret>` and JSON containing protocol version, expected server identity and expected Minecraft endpoint. It returns a random `sessionId` only if all three match.
2. Subsequent requests require the same bearer header and `X-Processia-Session: <sessionId>`.
3. `POST /v1/close` revokes the authenticated session.

Read endpoints:

- `GET /v1/registries?kind=item|block|blockState|blockEntityType|menu|entity|recipeSerializer|recipeType&offset=0&limit=500`
- `POST /v1/inspect-machine` with `{ "dimension":"minecraft:overworld", "x":0, "y":64, "z":0 }`
- `GET /v1/recipes?offset=0&limit=100&kind=processia:crushing` (kind is optional; supported filters are crushing, pressing and wiremilling)

Unknown endpoints and methods are rejected. Structured failures include stable codes such as `unauthorized`, `protocol_mismatch`, `server_identity_mismatch`, `dimension_not_found`, `chunk_not_loaded`, `invalid_request`, `server_thread_timeout`, `rate_limited` and `response_too_large`.

## Registry semantics

Item, block, entity, BlockEntityType, menu, recipe serializer and recipe type numeric IDs come from the registry's `getId(value)` API. Block-state IDs come from `Block.BLOCK_STATE_REGISTRY.getId(state)`, with state properties encoded by their registered property names and values. No packet ordinal is used. If a registry has no reliable numeric ID, only its namespaced key is included. Registry lists are declared complete for the enumerated registry; a page returns its total and pagination offsets.

The bridge epoch is not a bot epoch. The MCP stores it as `sourceRegistryEpoch` provenance and maps records to the current bot epoch only after the handshake link succeeds. A bot reconnect invalidates bridge snapshots; a server restart changes the Java generation UUID. Static `minecraft-data` candidates remain visibly static and never establish runtime numeric IDs.

## Machine and recipe reads

Machine inspection first resolves a loaded `ServerLevel`, validates dimension/coordinates/build height, and calls `hasChunkAt`. It never calls a chunk-loading API. It returns actual block/state IDs and properties, BlockEntity type, Container slots when implemented, item IDs/counts and at most 64 registered component type IDs (component values are intentionally not stringified or serialized), side-specific FE capability properties, and public Processia `WorkshopBlockEntity` values (energy, capacity, progress, burn time, redstone mode, active/locked state, transfer values and current recipe). Missing capabilities and BlockEntities are represented as absent/null rather than fabricated values. Cable FE reports its real zero stored/capacity values and receive-only side behavior; this does not claim a cable owns stored energy.

Recipe inspection enumerates the server's loaded machine recipes and exposes recipe key/type, result, ingredient candidates, input quantity, processing time and FE/tick when the Processia `MachineRecipe` API provides them. It is separate from the Mineflayer `declare_recipes` packet decoder.

## MCP tools

- `bridge-status`: configured/authenticated state, versions, identities, separate epochs and last safe error code. It is callable while disconnected.
- `bridge-refresh-registries`: fetches paginated snapshots into the active MCP session; does not call the game world.
- `inspect-processia-machine`: read-only dimension/coordinate inspection; unloaded chunks are rejected.
- `inspect-processia-recipes`: bounded read-only recipe listing.

Suggested validation after a server restart with the new mod:

1. Call `bridge-status`; require `authenticated=true` before treating the bridge as available.
2. Call `bridge-refresh-registries`; resolve known `processia:*` item/block keys and confirm bridge provenance, runtime IDs and both epoch fields.
3. Inspect only a coordinate already known to be inside a loaded chunk. A missing machine is a valid response; do not place one for this test.
4. Compare Java response metadata and values with `registry-status`, `registry-inspect` and `registry-resolve`.

## Limitations and recovery

The production development server on `127.0.0.1:25565` was not restarted or modified. Runtime verification is performed against a separate disposable development server, on separate ports and a separate world; its observations are recorded in the P2.1 completion report. The configured server identity is an operator-managed instance label, not an automatically queried remote server UUID. Recipe ingredients are reported as resolved item candidates; tag semantics are not expanded into a complete tag membership listing. Machine progress maximum is only included when a recipe is actively locked. The bridge intentionally does not expose generic `BlockEntity.saveAdditional`, arbitrary NBT, actions, menu clicks or commands.

To disable it, stop the server and unset `PROCESSIA_BRIDGE_ENABLED` (or set it to `false`), then restart normally. It binds no socket when disabled and closes the listener on `ServerStoppingEvent`.
