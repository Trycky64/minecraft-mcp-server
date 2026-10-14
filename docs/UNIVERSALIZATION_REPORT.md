# Universal Minecraft MCP Server — working report

This report is maintained during the universalization work. It distinguishes inspected facts from implementation goals and unrun scenarios.

## Initial audit (2026-10-14)

### Repositories and local state

| Repository | Branch | Initial state |
|---|---|---|
| MCP | `feature/processia-integration` | Clean; HEAD `6f8d435` includes the P1–P3 MCP commit `d47eab1` and the later local-ignore commit. |
| Processia | `master` | Only local change is the executable bit of `gradlew` (`100644 -> 100755`); preserve it. HEAD `0a66e48`. |

The Processia history has two divergent lines. `master` contains the P1–P3 bridge/machine work and subsequent machine-frame/electric-motor/resource changes. `backup/processia-p1-p3` is an earlier backup line with the bridge and initial M2 content. The bridge package and `WorkshopBlockEntity` are identical between the lines inspected; the newer `master` adds machine and art changes and removes internal art/generation tooling. Do not merge or rewrite either history as part of this work.

### Toolchains and available commands

- Raspberry Pi OS, Linux ARM64 (`aarch64`), 4 CPUs, 7.6 GiB RAM, 125 GiB free at audit time.
- Node `v22.23.2`, npm `10.9.8`, Java Temurin `21.0.9`, Gradle wrapper `9.2.1`.
- MCP scripts: `dev`, `build`, `prepare`, `start`, `test` (AVA), `lint`, `lint:fix`.
- Installed MCP runtime dependencies include Mineflayer `4.35.0`, minecraft-data `3.105.0`, MCP SDK `1.27.1`, TypeScript `5.9.3`, Zod `3.25.76`.
- Processia targets Minecraft `1.21.1`, NeoForge version from its Gradle properties; dedicated-server separation check is part of `check`. Do not run a GameTest server until its isolated game directory and non-25565 port are explicitly configured.

### Existing implementation facts

- MCP Core is a single TypeScript process in `src/main.ts`, a `BotConnection`, `ToolFactory`, and tool registration modules. Existing tools use Mineflayer directly.
- RegistryService supports static `minecraft-data`, protocol snapshots, and NeoForge bridge snapshots, with provenance/epoch/coverage semantics.
- The current NeoForge HTTP client and the server bridge share protocol v1 and authenticated loopback assumptions. The Processia server implementation imports `Processia`, `WorkshopBlockEntity`, `CableBlock`, `CableNetworkManager`, and `ModRecipes`; `/v1/list-machines` filters `processia:` and `/v1/recipes` is hard-coded to Processia machine recipe types. It is therefore a Processia adapter, not an independent generic mod.
- The bridge already reads built-in item, block, entity, block-entity, menu, serializer/type registries and NeoForge `ItemHandler`/`EnergyStorage` capabilities. It does not yet offer generic fluid capability inspection or generic block-entity inspection tools. It intentionally serializes component type IDs instead of arbitrary component payloads.
- Existing `place-block` resolves an item name only through an authoritative current-epoch numeric mapping, then uses Mineflayer inventory and `bot.placeBlock`. Success is currently returned after the Mineflayer promise resolves without a post-placement block-state confirmation. This is a known correctness gap to fix.
- Current bridge authentication requires a configured shared secret; automatic ephemeral secret generation/distribution (P2.8) is absent.
- The README still describes Processia as the validation target; universal/vanilla/NeoForge behavior needs a neutral capability-oriented description.

### Initial MCP baseline

`npm ls --depth=0` reported the installed dependency tree above. Initial `build/test/lint` command was started; its precise result is recorded below only after all processes terminate and return statuses.

## Prioritized plan

1. **U1 — audit and contracts:** record capability/source boundaries; keep Processia integration optional and avoid claiming unsupported Mineflayer behavior.
2. **U2 — generic MCP discovery:** expose server/session info, honest capability status, namespaces and bounded dynamic registry search over loaded snapshots; retain old tool names and behavior.
3. **U3 — generic bridge protocol:** define versioned, authenticated, read-only protocol contracts for generic block entity/capability inspection; preserve the existing Processia v1 adapter for compatibility.
4. **U4 — independent NeoForge mod:** extract/implement a separately loadable generic NeoForge diagnostic mod with dynamic built-in registry listing, loaded-block inspection, ItemHandler/EnergyStorage/FluidHandler read paths and ephemeral local credential handoff.
5. **U5 — Processia adapter:** keep machine/network/recipe details as optional adapter endpoints and make capabilities/availability explicit.
6. **U6 — placement validation:** confirm world state after placement, return failure/inconclusive when confirmation is missing, and keep modded placements fail-closed without a verified current-session mapping.
7. **U7 — validation/docs:** add tests, update setup/security/limits, run available offline builds/tests. Minecraft runtime tests may only use an isolated disposable instance on an explicitly selected free port other than 25565.

## Progress and verification

Implementation and validation results are appended here as work proceeds. No server at `127.0.0.1:25565` is to be queried, probed, started, or modified.

## Implemented in this pass

### MCP Core and vanilla adapter

- Added generic `minecraft-get-server-info`, `minecraft-get-capabilities`, `minecraft-list-namespaces`, and bounded `minecraft-search-registry` tools while retaining the existing registry and Processia tools.
- Added generic read-only block-entity/capability inspection tools that query the configured authenticated bridge; no generic tool requires Processia.
- Added the generic bridge credential-file flow and protocol mode alongside the legacy Processia adapter. The generic client validates the local credential file, loopback URL, handshake identity/version/endpoint, per-response identity and epoch, paging shape and duplicate mappings. It never reports bridge availability without authenticated session state.
- Registry refresh uses dynamically enumerated registry kinds and retains per-entry numeric ID scope/provenance. A 100,000 entry cap prevents an unbounded in-memory snapshot.
- `place-block` now inspects Mineflayer's post-action block cache and reports a failed/inconclusive result if no changed state is observed. A modded stack still requires an authoritative mapping bound to the current runtime epoch.
- Added tests for dynamic registry kinds/namespaces, credential-file security, generic capability tools, stale/oversized/malformed bridge responses, and placement confirmation.

### Independent NeoForge bridge

- Added `Processia/neoforge-bridge`, a standalone NeoForge mod with no Processia imports/dependencies. It can be installed without Processia and is opt-in only.
- The generic bridge binds IPv4 loopback, requires the explicit development environment, creates a random 256-bit credential when needed, hands it off in an owner-only credential file, and deletes it on normal shutdown. It accepts only authenticated, versioned, replay-protected local requests.
- Generic discovery reads active `RegistryAccess` registries and the block-state registry. Generic block inspection is limited to already-loaded chunks and public block/capability reads (`Container`, `IItemHandler`, `IEnergyStorage`, `IFluidHandler`); arbitrary NBT, private fields, mutation methods, command execution and generic recipe introspection are not exposed.
- Reads that require world access are dispatched to the server thread with a deadline, concurrency/queue limits, strict coordinate/query parsing and bounded request/response sizes. Registry reload rotates the Java registry epoch and revokes sessions.
- Processia machine/network/recipe support remains in its existing Processia-specific bridge adapter and MCP tools; it is not required by the generic bridge.
- The initial Java build exposed incorrect `WorldVersion.name()` use and two test setup errors. These were corrected against the generated 1.21.1/21.1.259 compile classpath. Gson 2.10.1 was added as a Java test-only dependency because that library is provided by the Minecraft runtime but not the JUnit test runtime. Session tests now independently cover expiration, replay, rate limiting and session/cache limits.

## Validation results

| Validation | Result |
|---|---|
| MCP `npm run build` | PASS |
| MCP `npm test` | PASS — 210 tests |
| MCP `npm run lint` | PASS |
| MCP `git diff --check` | PASS |
| NeoForge generic bridge `./gradlew -p neoforge-bridge build --no-daemon --max-workers=1 --console=plain` | PASS — production code compiled against NeoForge 21.1.259; 5 JUnit tests passed |
| Processia `./gradlew.bat build` / GameTests | Not run: this is the Processia application build, not the independent bridge build; no existing full mod-server test environment was launched. |
| Dedicated-server runtime / vanilla / third-party-mod runtime matrix | Not run. Only an isolated local server may be used; no runtime process has been connected to or started against the personal server or port 25565. |

The isolated bridge build verifies compilation and unit behavior, not that a server loads the mod, emits actual live registry rows, or answers over HTTP. Therefore runtime interoperability remains unverified and the work is **PARTIAL**. To complete that proof, provision a disposable server directory, explicit non-25565 Minecraft/bridge ports, and an authorized EULA-accepted runtime; then verify the generic handshake, registry pages and loaded-position capability inspection using the credential handoff. No live Processia mappings are claimed here.

## Final repository state

- MCP branch remains `feature/processia-integration`; initial tracked files changed: `README.md`, `src/bridge/bridge-types.ts`, `src/bridge/neoforge-bridge-client.ts`, `src/main.ts`, `src/services/minecraft-registry-service.ts`, `src/tools/block-tools.ts`, `src/tools/bridge-tools.ts`, `src/tools/registry-tools.ts`, `tests/block-tools.test.ts`, `tests/bridge-tools.test.ts`, `tests/neoforge-bridge-client.test.ts`, `tests/registry-tools.test.ts`; new docs: `docs/UNIVERSALIZATION_REPORT.md`, `docs/universal-neoforge-bridge.md`.
- Processia branch remains `master`; new untracked independent project files live under `neoforge-bridge/`; `docs/NEOFORGE_DIAGNOSTIC_BRIDGE.md` points out the legacy adapter boundary. The pre-existing `gradlew` executable-bit change (`100644 -> 100755`) is preserved and not rewritten.
- No branch, remote, dependency lockfile, user MCP configuration or personal server world was modified. No commit or push was made. Build caches/artifacts are confined to ignored Gradle build/cache paths.
- The two Processia branches remain divergent; no merge, reset, or history rewrite was done.

## Remaining gaps

- No isolated HTTP runtime handshake or actual dynamic modded-registry/capability observation has yet been demonstrated.
- No third-party mod or GameTest matrix has been run.
- The generic bridge currently has no universal recipe endpoint, generic entity-capability endpoint, or GUI/framebuffer interface. Those remain explicit capability gaps, rather than inferred support.
- A `FluidHandler` getter is invoked as a read operation, but third-party capability implementations execute mod code; for this reason the bridge remains disabled by default and intended only for authorized test/development worlds.

## Mission 2 — runtime readiness and security audit (2026-10-14)

### Audited local changes

- MCP worktree remains on `feature/processia-integration` at `6f8d435`; its existing uncommitted genericization changes and this report are preserved. `todo.txt` exists, is ignored by `.gitignore`, and was read but left unchanged. It still lists P2.8 and P2.20 unchecked; the generic bridge implements ephemeral credentials, but that new path still lacks runtime proof.
- Processia worktree remains on `master` at `0a66e48`. The pre-existing `gradlew` mode change (`100644 -> 100755`) remains untouched. The standalone bridge source and its ignored build outputs are the only additional work in that repository.
- No commit/push, branch change, reset, MCP personal config change, or Processia application source/world change was made.

### Bridge security findings and corrections

- Confirmed server bind is exactly `127.0.0.1`; requests also require a loopback peer. No public bind, command execution, shell process, arbitrary file read, or arbitrary network endpoint exists.
- Confirmed generated credential contains a 256-bit random secret and per-process identity, writes with POSIX `0600`, refuses symlink/non-private credential targets, and is removed on normal shutdown. TypeScript rejects symlinks, invalid owner-only permissions, malformed credential fields, non-loopback bridge URLs, identity/version/endpoint mismatches and session metadata changes. MCP status returns only `secretConfigured`, never the secret.
- Confirmed bearer/session authentication uses constant-time secret comparison, 15-minute idle expiry, UUID request replay protection, a 32-session limit, a bounded per-session request budget, and explicit close/reload revocation. The Java and TypeScript sides use the same v1 headers and response request ID.
- Hardened concurrent bridge lifecycle fields with `volatile` visibility, exact integer coordinate parsing, malformed percent-encoding errors, and a 2 MiB serialized response cap. These changes compiled and passed Java tests.
- Capability methods invoked are getters only. The bridge does not invoke insertion/extraction/fill/drain methods. Third-party implementations remain arbitrary mod code and could violate getter expectations; the opt-in/development restriction remains necessary.

### Initial isolated-runtime setup (before EULA approval)

The following captures the state before the user authorized writing `eula=true`; it is historical and is superseded by the completed runtime section below.

- Verified the selected alternate ports `25665` (Minecraft) and `25677` (bridge) were free using a listener-only `ss` query. Port `25565` was not queried, probed, or used.
- Prepared `<isolated-temporary-directory>` with only the standalone generic bridge JAR and loopback-only server properties (`server-ip=127.0.0.1`, `server-port=25665`, offline auth, low view/simulation distance, RCON/query disabled). The directory is mode `0700`, its properties file `0600`. No world exists and no server process was started.
- Added configurable `mcpTestServerDirectory` / `mcpTestServerPort` ModDev run settings; default runtime-test port is `25665`, game directory defaults under ignored bridge build output, and the test server heap is capped at 2 GiB. The `runServer` task configuration was inspected with `help --task`; no server launch occurred.
- Minecraft server startup requires `eula=true`. User approval was requested before creating that file; until approval, no EULA file is written and runtime-dependent steps remain paused. No EULA terms were accepted on the user's behalf.

### Mission 2 validation checkpoint before EULA approval (historical)

| Validation | Result |
|---|---|
| MCP build/tests/lint | PASS — latest implementation run: build PASS, 210 tests PASS, lint PASS; `todo.txt` and report-only changes followed. |
| Generic NeoForge bridge build | PASS — offline rebuild after runtime-run configuration change; compile and test tasks were up-to-date from the successful source build. |
| JUnit reports | PASS — `BridgeSessionsTest`: 4/4; `BridgeSettingsTest`: 1/1; failures/errors/skips all zero. |
| Gradle isolated `runServer` configuration | PASS — task configuration inspected with chosen temp directory and port; no server launched. |
| Alternate port availability | PASS at preparation time — no listener shown on 25665 or 25677. |
| Runtime handshake, live registries, loaded block, MCP-to-bridge call | BLOCKED pending EULA approval; nothing is claimed as runtime-tested. |
| Processia and third-party-mod runtime matrix | Not run; no isolated runtime has been started. |

### Current exact worktree additions

- MCP: `docs/UNIVERSALIZATION_REPORT.md`, `docs/universal-neoforge-bridge.md` and the previously listed genericization files. The ignored local `todo.txt` was restored to its original text and is not part of this worktree diff.
- Processia: `neoforge-bridge/build.gradle` run isolation/heap settings, `neoforge-bridge/src/main/java/dev/minecraftmcp/bridge/BridgeProtocol.java` response cap, and `GenericDiagnosticBridge.java` input/thread/response hardening; pre-existing documentation and independent bridge files remain uncommitted.

### Runtime validation completed (isolated generic bridge)

- User confirmed acceptance of Minecraft's EULA for `<isolated-temporary-directory>`; `eula=true` was written only in that isolated test directory. `server.properties` bound Minecraft to `127.0.0.1:25665`, with the bridge bound to `127.0.0.1:25677`. Both ports were rechecked free before launches. Port `25565` was never queried or contacted.
- Launched with the standalone `minecraft_mcp_bridge` JAR only; the actual mod list was Minecraft 1.21.1, Minecraft MCP Diagnostic Bridge, and NeoForge 21.1.259. No Processia or third-party mod was loaded. The first runtime attempt exposed that `runServer` used a stale JAR already staged in the temporary server's `mods/` directory. The current JAR was rebuilt (`./gradlew -p neoforge-bridge jar --no-daemon --max-workers=1 --console=plain`), copied into that isolated `mods/` directory, and its SHA-256 was verified equal to the built artifact. The stale artifact had retained the former 120-request/minute limit.
- Increased the authenticated per-session budget to 240 requests/minute to accommodate the complete generic registry set and block-state pages; the Java rate-limit test was updated to prove the bound and its reset. A direct authenticated runtime check then completed 130 capability requests in one session. The MCP refresh subsequently completed without throttling. Registry page size remains 500: an attempted 1000-entry page was explicitly rejected by the running endpoint, so the client and server retain their documented 500-entry contract.
- Connected a temporary MCP JSON-RPC client and Mineflayer bot named `UniversalP2Probe` to `127.0.0.1:25665`. The actual MCP tool list contained 54 tools and included `bridge-status`, `bridge-refresh-registries`, `registry-status`, `registry-resolve`, `registry-inspect`, `minecraft-list-namespaces`, and `minecraft-inspect-block-entity`.
- Authenticated handshake/runtime metadata: Minecraft `1.21.1`, protocol `767`, NeoForge `21.1.259`, bridge protocol `1`; `bridge-status` reported `authenticated: true`, `bridgeAvailable: true`, and `lastError: null`. Java source registry epoch and MCP bot registry epoch were distinct and both were returned in status/refresh metadata. The unauthenticated `/v1/registry-kinds` request returned HTTP `401` with `authentication_required`.
- `bridge-refresh-registries` returned `status: refreshed`, 118 registries, all marked complete, and 33,719 total entries. Core counts were: blocks 1,060; BlockEntity types 44; block states 26,684; entities 130; items 1,333; menus 25; recipe serializers 23. Dynamic namespace discovery returned `brigadier`, `minecraft`, and `neoforge`. `registry-inspect` successfully read `registry:neoforge:fluid_type` (3 rows: `minecraft:empty`, `minecraft:lava`, `minecraft:water`).
- Through the real MCP tool path, `registry-resolve` returned runtime-observed mappings: `minecraft:stone` block ID 1; `minecraft:diamond` item ID 805; `minecraft:stone` block-state ID 1. Each response identified `neoforge-bridge` provenance, a server-generation numeric-ID scope, `identityConfidence: session-observed`, and `runtimeNumericIdVerified: true`. `processia:coal_generator` returned `unresolved / identifier-not-found`, as expected because Processia was not installed; no modded IDs were invented.
- `minecraft-inspect-block-entity` inspected the already-loaded overworld position `(0, 112, 4)` and returned `minecraft:birch_leaves`, server block-state ID 304, and properties `distance=3`, `persistent=false`, `waterlogged=false`; no BlockEntity was present. Its item, energy and fluid capabilities were explicitly absent on that vanilla block. An inspection in `minecraft:the_nether` at `(0,64,0)` returned `bridge-chunk_not_loaded`, without loading the chunk.
- Bridge shutdown removed the ephemeral credential file. The temporary MCP probe script was removed. The server process stopped and ports 25665/25677 were confirmed free. The isolated test directory and generated world were preserved; no destructive cleanup was run.

### Remaining runtime coverage after Mission 2

- PASS: generic mod loads on dedicated NeoForge server; secret handoff and authenticated handshake; unauthenticated rejection; dynamic full registry refresh; dynamic namespaces; vanilla item/block/state runtime mappings; generic registry page inspection; loaded-block and unloaded-chunk inspection; MCP-to-bridge tool path; session epochs remain distinct and visible.
- Not demonstrated: Processia registry IDs/machines, positive ItemHandler/FE/FluidHandler providers, inventories with contents, recipe data, a third-party mod, a second authenticated MCP client at once, or a stale mapping lookup after a Java server restart. Processia and a suitable capability-providing test mod were absent, and the inspected vanilla block had no capabilities. The initial server restart produced new server identity/registry epochs, but no post-restart stale-mapping request was run.
- Final verdict for Mission 2 runtime: **PARTIAL**. The generic bridge and MCP interoperability were validated on a real isolated NeoForge server; mod-specific and positive-capability integration cases remain to be exercised in an isolated environment containing those providers.

### Final post-runtime validations

- MCP `npm run build`: PASS; `npm test`: PASS, 210/210; `npm run lint`: PASS; `git diff --check`: PASS in both repositories.
- Processia generic bridge `./gradlew -p neoforge-bridge test --rerun-tasks --no-daemon --max-workers=1 --console=plain`: PASS, 5 JUnit tests executed freshly (4 `BridgeSessionsTest`, 1 `BridgeSettingsTest`), no failures/errors/skips. Java compilation reports only a deprecation note in `GenericBlockInspector`.
- No dependency or lockfile was changed. Neither repository received a commit or push. Existing MCP genericization work, ignored `todo.txt`, and Processia `gradlew` executable-bit change were preserved.
