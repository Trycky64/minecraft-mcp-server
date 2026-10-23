# Universal Minecraft MCP Server — working report

> **Historical audit and implementation log.** Statements below describe the dates and worktree snapshots they name; they are not the current release verdict. The current tested dependency set, runtime matrix and limitations are in [RELEASE_READINESS.md](RELEASE_READINESS.md) and [MISSION7_FINAL_REPORT.md](MISSION7_FINAL_REPORT.md).

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
## Mission 4 — Windows runtime preparation (2026-10-14)

- Verified the MCP repository is on `feature/processia-integration` at `8c50ee5` and Processia is on `master` at `d4c217c`; both were clean at the start. No remotes or client MCP configurations were changed.
- Detected Windows 11/PowerShell, Temurin Java `21.0.12.1`, Node `v26.8.1`, npm `11.19.0`, and Git `2.55.0.windows.5`.
- Reinstalled MCP dependencies with `npm ci` from the existing lockfile. Build passed, 210/210 tests passed, and lint passed. npm reported 37 audit findings in the locked dependency tree; no fix was applied.
- Processia root build passed with the Windows wrapper and one worker. The generic bridge build passed on Windows with five JUnit tests.
- Found that credential file handling used POSIX-only attributes and failed on Windows. Added an owner-only Windows ACL implementation and platform-conditional regression assertion. Unsupported filesystems fail closed. The Windows bridge build/test verified this path.
- Created a user-ACL-protected test root at `C:\Users\qperr\minecraft-mcp-test`, prepared vanilla and three independent NeoForge 21.1.259 installations, and copied the Processia and generic bridge jars to their isolated profiles. The third-party profile is staged but has no third-party mod jar pending exact release review.
- Downloaded official Minecraft/NeoForge setup artifacts into that test root. Server properties are loopback-only on `25665`; the bridge uses `25677`. Both ports were free before and after setup. Port `25565` was not queried or contacted.
- No server was started, no EULA file was created/accepted, no world was generated, and no runtime capability claim was added. See `docs/WINDOWS_RUNTIME_TEST_SETUP.md` for paths, commands and the next-mission checklist.

## Mission 5 — Windows runtime validation preflight (2026-10-14)

- Re-audited both worktrees and retained all pre-existing modifications. MCP remains on `feature/processia-integration`; Processia remains on `master`. No source code, dependencies, remotes, or commits were changed in this mission segment.
- Re-ran reference checks: MCP build/lint PASS and 210/210 tests PASS; Processia build PASS and forced tests PASS (18 tests); standalone bridge build PASS and forced tests PASS (5 tests). Combined automated result: 233 passed, 0 failed. Full command logs are under `C:\Users\qperr\minecraft-mcp-test\logs\mission5-*.log`.
- Verified the four isolated Windows profiles remain configured for loopback and do not have `eula.txt` files or generated worlds. Ports `25665` and `25677` had no listeners. The Windows start script refuses to launch without a manually present `eula=true`; no server was started and port `25565` was not queried.
- Selected and staged Mekanism `10.7.15.81` from its official Modrinth distribution. The version metadata identifies Minecraft 1.21.1 and NeoForge, labels the release Release, lists only optional dependencies, and the downloaded file's SHA-512 matched the API metadata. The stated NeoForge minimum is 21.1.194, below the target 21.1.259. This is preparation only; the mod has not been loaded.
- Source inspection confirms Processia's generator/crusher/press/wiremill provide ItemHandler, M2 machines and the energy cable provide EnergyStorage, and Processia does not register FluidHandler. A positive fluid test needs a third-party or test fixture provider.
- Runtime matrix remains BLOCKED pending the user's explicit confirmation that they have read and accepted Minecraft's EULA. See [`WINDOWS_RUNTIME_TEST_REPORT.md`](WINDOWS_RUNTIME_TEST_REPORT.md) and [`WINDOWS_RUNTIME_TEST_SETUP.md`](WINDOWS_RUNTIME_TEST_SETUP.md). No `eula.txt`, credential, or world was created.

## Mission 5 — runtime results after EULA confirmation (2026-10-14)

The user explicitly confirmed EULA acceptance and confirmed `eula=true` in all four isolated profiles. This section supersedes the preflight-only runtime status above.

- Vanilla server/MCP PASS: protocol 767, vanilla tools remained available with the bridge disabled, and loaded block/inventory/search responses were structurally valid.
- Generic NeoForge PASS: `minecraft_mcp_bridge` loaded without Processia, bound only to `127.0.0.1:25677`, completed authenticated MCP handshake/registry refresh, exposed complete runtime registries, and inspected vanilla BlockEntities and capabilities. No-auth/wrong-secret requests returned 401; credentials were owner-only and removed at normal shutdown.
- Processia PASS: Processia `0.1.0` and both bridge implementations loaded on NeoForge `21.1.259`. Runtime registry IDs were discovered, not hard-coded: M2 block IDs ranged from `processia:coal_generator` 1066 through `processia:energy_cable` 1071; the observed crusher item ID was 1341. A complete bounded machine search found six M2 blocks, and individual MCP inspection returned their BlockEntities, states and properties. The Processia adapter returned all 11 recipes.
- Positive capability observations: Processia crusher ItemHandler exposed two raw iron; the generator exposed non-zero FE (`7,960/10,000` at one observation); Mekanism's real basic energy cube exposed `1,600,000 FE` capacity and its real basic fluid tank exposed an available `32,000 mB` FluidHandler. The tank was empty; no non-empty fluid amount was claimed.
- Mekanism loaded successfully and its generic bridge exposed 1,260 block entries including 60 Mekanism machine blocks. Mineflayer could not join this server: NeoForge required a NeoForge 21.1.259 client. Consequently the TypeScript MCP bridge integration failed closed for this modpack, although direct authenticated bridge inspection succeeded.
- Restart PASS: the isolated third-party server produced a new server identity and registry epoch; an old expected identity was rejected. Closed sessions and missing authentication were rejected, and unloaded chunks/out-of-range coordinates returned structured errors.
- Placement PASS for adjacent targets: MCP placed a Processia basic battery and the bridge read it back with a present BlockEntity, state ID 26729 and `facing=up`. A farther action in a multi-placement sequence timed out during pathfinding; it did not produce a false success. Long-distance pathfinding remains a limitation.
- Runtime logs and request/result evidence are retained outside the repositories under `C:\Users\qperr\minecraft-mcp-test\logs`. All test servers were stopped normally, their ephemeral credentials were removed, and test ports were released. Neither the personal server nor port 25565 was contacted or checked.
- Two runtime-driven MCP fixes were made: `find-blocks` now uses `no-match-in-loaded-area` for a complete, session-observed no-match, and MCP shutdown waits (bounded to one second) for Mineflayer's `end` event. Unit regressions cover both.
- Final mission verdict remains **PARTIAL**: a non-empty third-party fluid tank and MCP-through-Mineflayer operation against Mekanism remain unvalidated because the modpack requires a NeoForge client that Mineflayer does not provide. See [`WINDOWS_RUNTIME_TEST_REPORT.md`](WINDOWS_RUNTIME_TEST_REPORT.md) for exact evidence, logs and the scenario matrix.

## Mission 6 status override (2026-10-14)

The preceding Mission 5 verdict and “remaining work” bullets are historical snapshots. Mission 6 later validated an authenticated MCP bridge-only session against Mekanism and read a non-empty `minecraft:water` FluidHandler (1,000/32,000 mB) after a test-only fixture filled the isolated test-world tank. It also validated `auto` fallback using the status ping's modded marker and an authenticated bridge handshake. A first exploratory probe had an invalid overlong player name; that generic decode error was shown to be ambiguous and is not used by fallback logic. Mission 6 also added bounded placement path cancellation. Current evidence and limitations are summarized in [`MISSION6_RUNTIME_REPORT.md`](MISSION6_RUNTIME_REPORT.md). The placement timeout is regression-tested but was not staged as a new runtime placement mutation in Mission 6. Targeted SDK and compatible transitive fixes reduced the npm audit to 17 findings, including 8 production-chain findings that would require incompatible protocol/authentication major changes to remove.


## Mission gameplay survie via fork local - 2026-10-20

### Matrice des capacites constatees

| Capacite | Etat | Chemin effectif / limite |
|---|---|---|
| Deplacement et orientation | PASS | `move-to-position` (Pathfinder), `move-in-direction`, `look-at`, `jump`. Le test runtime en Survie a confirme le changement de position serveur. Chemins maintenant limites a 256 blocs, duree 15 s par defaut / 60 s max; mouvements directionnels 5 s max. |
| Observation blocs et entites | PARTIAL | `get-block-info`, `find-blocks` (chunks deja charges, recherche bornee) et `find-entity`. Les candidats vanilla sur NeoForge restent des noms statiques non autoritaires; pas de loading de chunk. |
| Minage | PARTIAL | `dig-block` emet le vrai protocole Mineflayer, refuse `unknown`, limite la distance a 32 blocs, timeouts, revalide le state ID apres pathfinding et confirme air en cache. Non execute en runtime durant cette mission. |
| Ramassage | PARTIAL | Minecraft ramasse normalement les drops quand le joueur les touche; `list-inventory` permet le controle. Aucun outil dedie d'approche/attente d'un drop n'est expose. |
| Inventaire/equipement | PARTIAL | `list-inventory`, `find-item`, `equip-item`. Le runtime conserve la pile preexistante raw ID 1373 comme `unknown`; aucune cle ne peut etre deduite. |
| Crafting | PARTIAL | `list-recipes`, `get-recipe`, `can-craft`, `craft-item` utilisent les recettes statiques Mineflayer et les clics de recettes normaux cote serveur; `smelt-item` couvre les fours vanilla. Les recettes de machines Processia ne sont pas des recettes de craft Mineflayer. |
| Placement | PARTIAL | `place-block` utilise le vrai paquet placement, mapping de pile moddee autoritatif lorsqu'un nom est fourni, timeout et verification de changement d'etat. Aucun placement n'a ete execute. |
| Interaction bloc/machine | PARTIAL | Nouvel outil `interact-block`: use-on-block normal, limite de portee 4.5, chunk charge, state ID observe et epoch courant requis, main vide temporaire. Une machine moddee reste impossible a identifier sans mapping/bridge, mais un GUI Mineflayer n'est pas une condition protocolaire. |
| GUI / conteneurs | PARTIAL | Nouveaux `inspect-open-window`, `click-window-slot`, `close-open-window` utilisent l'API fenetre Mineflayer et les paquets normaux; les clics sont attendus/validees par le serveur. Les tests unitaires couvrent aussi les IDs bruts `unknown`. Pas de capture framebuffer, rendu, tooltip ou preuve d'ouverture de conteneur runtime. |

### Actions runtime observees

Le serveur existant de `C:/Users/qperr/minecraft-mcp-test/neoforge-processia` est reste sur `127.0.0.1:25665`, monde `world`, PID Java 23780. Minecraft 1.21.1 / protocole 767 / NeoForge 21.1.259 / Processia 0.1.0. Aucune connexion au port 25565, commande administrative, reset ou redemarrage serveur.

Le fork local a ete lance par stdio avec `dist/main.js --host 127.0.0.1 --port 25665 --username CodexBot`. Mineflayer a rapporte Survie. Deplacement confirme: `(20,104,-15)` vers `(21,104,-15)` via `move-to-position` (range 0.25, timeout 10 000 ms); `get-position` relu apres l'action et confirme la nouvelle position. Le support et le volume cible avaient ete lus avant l'action; aucun bloc n'a ete modifie.

Le nouveau `interact-block` a ete exerce sur la case air du joueur avec le state ID brut observe 0 et main vide. Le serveur n'a ouvert aucun menu; le retour indiquait `interaction-sent-no-menu-observed`, l'etat est reste 0 et la pile inconnue est restee identique. Cela valide le chemin d'envoi d'interaction, pas un conteneur ou menu de machine.

### Diagnostic runtime

- `rawNumericId=1373`, `unknown`, aucun namespace, provenance ou mapping de session. `registry-status` n'a que minecraft-data statique; `runtimeNumericIdVerified=false`. Le bridge est desactive/non authentifie. L'identite de cet item n'est pas resolue et aucune modification de registre n'a ete faite.
- `declare_recipes`, paquet clientbound 119 (protocol 767), `PartialReadError`: `Missing characters in string, found size is 112028 expected size was 420784383`. L'inventaire de la meme connexion est `complete`, sans erreurs `window_items`/`set_slot`; le bot reste connecte. Le decoder enregistre/reemet l'erreur et ne la transforme pas en inventaire vide. Cause exacte non prouvee; aucune dependance/schema n'a ete change.
- Versions installees: Mineflayer 4.39.0, minecraft-protocol 1.68.0, minecraft-data 3.117.0. Ces versions correspondent au lock existant; cette mission n'a pas modifie package.json/lockfile.
- L'absence d'un client graphique instrumente ne bloque pas l'envoi de `use_on`, la reception de `open_window`/slots ni `clickWindow` au niveau protocole. Elle bloque toujours les captures, tooltips et verdicts de rendu. Le bridge NeoForge desactive empeche l'inspection FE/fluides, les mappings moddes autoritaires et la liste des recettes de machines.

### Implementations et validations de cette mission

Nouveaux outils: `interact-block`, `inspect-open-window`, `click-window-slot`, `close-open-window`. Les actions de fenetre exigent l epoch courant et refusent les appels obsoletes apres reconnexion. Durcissements: limites coordinates, distance/timeout pour mouvement; timeout directionnel; recherche d'entites plafonnee a 128 blocs; minage borne, annule au timeout, revalide et verifie l'etat final; placement refuse une pile held `unknown`.

Build PASS (`npm run build`), AVA **244/244 PASS** (`npm test`), lint PASS, `git diff --check` PASS. Aucun dependency/lockfile change par cette mission. Les GUI menus de machines, recipes M2, minage/ramassage/crafting/placement et progression V0.2 n'ont pas ete valides en runtime. Verdict survie: PARTIAL; prochaine gate: activer et authentifier le bridge dans le profil de test existant, resoudre les mappings dans l'epoch courant, puis obtenir/inspecter un bloc machine deja present ou une fixture de gameplay autorisee avant d'executer des recettes et transferts normaux.


Runtime final apres recompilation: nouvelle session `session:e628157d-5aac-44c2-be95-9e59fc18e8e7`; `interact-block` a accepte l epoch courant sur air state 0 a (21,104,-15), sans ouvrir de fenetre ni changer position. Les clics de slots et l ouverture de GUI de machine restent non testes en runtime car aucun menu cible accessible ni bridge authentifie n etait disponible.