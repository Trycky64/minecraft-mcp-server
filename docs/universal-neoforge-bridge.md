# Universal NeoForge bridge contract

## Scope and optionality

The MCP server and all existing Mineflayer tools work without NeoForge, this bridge, or Processia. The standalone companion mod at the sibling repository path `../Processia/neoforge-bridge` has its own mod ID (`minecraft_mcp_bridge`) and Java package (`dev.minecraftmcp.bridge`); it has no Processia source dependency. The older `com.trycky.processia.bridge` is a legacy adapter for machine-specific Processia data.

The generic bridge is development/test only, read-only, disabled by default, and binds only `127.0.0.1`. It is not intended as a public administration API. There is no arbitrary command, file, or network request endpoint.

## Enable and connect

Build the companion project with Java 21 using the Processia repository wrapper:

```sh
../gradlew -p ../Processia/neoforge-bridge build --no-daemon --max-workers=1
```

Put the resulting `minecraft_mcp_bridge` mod jar in an isolated NeoForge server's `mods` directory. Its loader range targets NeoForge 21.1.259+ in the 21.1 line and Minecraft 1.21.1. Set these variables in the test server environment:

```text
MINECRAFT_MCP_BRIDGE_ENABLED=true
MINECRAFT_MCP_ENVIRONMENT=development
MINECRAFT_MCP_SERVER_ENDPOINT=127.0.0.1:<the-isolated-server-port>
# Optional; default is 25577 and must not equal the Minecraft port.
MINECRAFT_MCP_BRIDGE_PORT=25577
# Optional; default is config/minecraft-mcp-bridge.credentials.json.
MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE=<private-path>
```

On server start the mod creates a cryptographically random 256-bit bearer secret if no `MINECRAFT_MCP_BRIDGE_SECRET` is provided. It writes the secret, generated server identity, endpoint and NeoForge version into the credential file with POSIX mode `0600`. On platforms/filesystems that cannot provide owner-only POSIX permissions, startup fails closed. The file is replaced only if it is already a private bridge credential and is removed on normal server shutdown. A hard process crash can leave an expired file; delete that specific generated file before restarting. The secret is never logged.

In the MCP process:

```text
MINECRAFT_MCP_BRIDGE_ENABLED=true
MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE=<the-same-private-file-path>
# Optional when the generated credential's endpoint is the endpoint Mineflayer uses:
MINECRAFT_MCP_BRIDGE_URL=http://127.0.0.1:25577
```

The MCP client checks the credential file is a regular non-symlink file with owner-only permissions, checks the loopback URL, binds the bridge identity and version to the current bot endpoint, authenticates a session, and validates every response's protocol, identity, endpoint and registry epoch. Reconnection or datapack reload invalidates the session and runtime registry snapshot. Do not use the user's `25565` server for testing; tests must use a disposable world and explicitly selected ports.

## Protocol v1


Successful data responses include `schemaVersion: 1`, `requestId`, `minecraftVersion`, `neoForgeVersion`, `serverIdentity`, `minecraftEndpoint`, `registryEpoch`, and `observedAt`. Structured error responses include `requestId` and an error code. The server echoes canonical UUID request IDs in both JSON and `X-Minecraft-MCP-Request-Id`. Requests use `Authorization: Bearer …`; authenticated requests also use `X-Minecraft-MCP-Session`. Sessions expire after 15 idle minutes, are capped at 32, allow at most 240 authenticated requests per minute per session, reject replayed request IDs, and can be revoked with `/v1/close`. The request budget supports full paginated registry refreshes while remaining bounded; a global four-request semaphore and bounded executor also apply.

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/handshake` | POST | Authenticate and bind protocol, server identity and exact Minecraft endpoint. |
| `/v1/capabilities` | GET | Report implemented read operations and loaded-chunk/read-only guarantees. |
| `/v1/registry-kinds` | GET | Enumerate available active server registry kinds dynamically. |
| `/v1/registries?kind=…&offset=…&limit=…` | GET | Read a bounded registry page. Max page size is 500. |
| `/v1/inspect-block` | POST | Read a block, optional BlockEntity identity and standard capabilities at a loaded position. |
| `/v1/close` | POST | Revoke the authenticated session. |

`registry-kinds` derives IDs from `RegistryAccess.registries()` and maps common item/block/entity/menu types to familiar MCP kinds; other registries remain namespaced as `registry:<registry-id>`. Block states use the explicit `blockState` kind. Each row has a namespaced ID; a numeric ID is included only when the actual Java registry supplies one. `numericIdScope` is `server-registry-generation` or `server-block-state-generation`; IDs are session-local and must not be carried across restart/reload. Registry pages are complete snapshots for that response, not a promise that a key set is immutable forever.

Block inspection requires exact `dimension`, `x`, `y`, `z`. It rejects invalid dimensions/coordinates and chunks that are not already loaded; it never requests chunk loads. State ID properties and registered block/BlockEntity names are read from NeoForge/Minecraft. Inventory inspection prefers `IItemHandler`, with a vanilla `Container` fallback; energy and fluids use the standard `IEnergyStorage` and `IFluidHandler` read getters. It enumerates six faces plus unsided access. Item component payloads are not serialized, only component type identifiers. No arbitrary `BlockEntity` reflection or NBT dumping is performed.

The HTTP thread parses/authenticates bounded requests and dispatches every server/world read onto the server thread. Reads have a three-second wait deadline, four concurrent request slots, bounded executor queues, 32 KiB request bodies, 2 MiB response bodies and bounded result arrays. Coordinate fields must be JSON integers; malformed query encoding is rejected. If a read times out, the bridge returns an explicit error; logical cancellation prevents work that has not started, while already-running server-thread code cannot be preempted safely. Registry reload advances the bridge epoch and revokes all sessions.

## MCP tools

- `minecraft-get-server-info` and `minecraft-get-capabilities` report negotiated server state and only observed/implemented features.
- `minecraft-list-namespaces` derives namespaces from loaded current-version snapshots; it does not use a hard-coded mod allowlist.
- `minecraft-search-registry` queries a bounded current-session snapshot; use `bridge-refresh-registries` first for newly connected servers.
- `minecraft-inspect-block-entity` and `minecraft-inspect-capabilities` inspect a loaded position through the authenticated bridge.
- `registry-status`, `registry-resolve`, `registry-inspect` and `bridge-status` remain available for source/epoch/provenance diagnostics.
- Processia machine, network and recipe tools are optional adapter tools; generic operation does not assume Processia is installed.

If there is no authenticated bridge, modded registry mappings and generic BlockEntity capabilities are returned as unavailable. Vanilla Mineflayer reads continue to work. Search and placement do not treat static IDs as authoritative server IDs.

## Technical boundaries and safety caveats

NeoForge's capability system is dynamically provided per block/side. The bridge only calls the standard getter-style methods and never calls insert, extract, fill or drain. However, arbitrary third-party capability implementations are mod code; a defective provider could have side effects in a nominal getter. For higher-risk production worlds, keep this development bridge disabled. NeoForge documents that capability providers may be registered per block/entity/item, and that block capabilities are queried through the level with position and context ([NeoForge 1.21.1 capability docs](https://docs.neoforged.net/docs/1.21.1/inventories/capabilities/)). `RegistryAccess` exposes the active registries and dynamic registry access ([Minecraft 1.21.1 RegistryAccess Javadoc](https://aldak.netlify.app/javadoc/1.21.1-21.1.x/net/minecraft/core/registryaccess)).

Current limits:

- No entity capability inspection yet; the endpoint focuses on blocks and BlockEntities.
- No universal recipe inspection API; recipe schemas are mod-defined and Processia recipes remain a Processia adapter.
- No GUI screenshots, clicks or framebuffer integration are part of this generic bridge.
- The legacy Processia adapter still uses its own protocol headers and configured shared secret; the generated credential flow belongs to the standalone generic bridge.
- Complete refresh is capped at 100,000 entries in TypeScript to bound memory on ARM64. Oversized refreshes fail closed; they do not publish partial snapshots as complete.
- The generic bridge has been exercised against an isolated NeoForge 21.1.259 / Minecraft 1.21.1 server without Processia. It exposed 118 complete registries and served a real loaded-block inspection. The vanilla test world has no positive FE/fluid provider or Processia machines; details and remaining runtime coverage are tracked in `UNIVERSALIZATION_REPORT.md`.
