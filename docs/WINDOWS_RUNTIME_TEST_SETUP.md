# Windows Minecraft MCP runtime test setup

> **Historical setup record.** Its package versions and per-mission results are snapshots. Mission 7 reran the four profiles after compatible dependency updates; see [MISSION7_FINAL_REPORT.md](MISSION7_FINAL_REPORT.md) for the current evidence and exceptions.

Status: isolated setup prepared and runtime tested on Windows 11 for Minecraft 1.21.1 / NeoForge 21.1.259 (2026-10-14). This document retains the preparation procedure; final evidence and limitations are in [WINDOWS_RUNTIME_TEST_REPORT.md](WINDOWS_RUNTIME_TEST_REPORT.md).

The user subsequently confirmed reading and accepting Minecraft's EULA and confirmed `eula=true` in all four isolated profiles. Vanilla, generic NeoForge, Processia and Mekanism runtime tests were run. Every test server was stopped normally, both test ports were released, and ephemeral bridge credentials were removed.

## Detected environment

- Windows 11, PowerShell.
- Eclipse Temurin JDK `21.0.12.1`; `JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot`.
- Node.js `v26.8.1`, npm `11.19.0`, Git `2.55.0.windows.5`.
- MCP branch `feature/processia-integration`, commit `8c50ee5`.
- Processia branch `master`, commit `d4c217c`.
- Both repositories were clean before this mission. Source changes made for Windows ACL support are currently uncommitted in Processia.
- MCP uses its existing `package-lock.json`; `npm ci` was used. No dependency manifest or lockfile was edited.
- The Processia wrapper uses Gradle 9.2.1. Builds were constrained to one worker.

## Isolated test root

The prepared root is `C:\Users\qperr\minecraft-mcp-test`, outside both repositories. Its ACL disables inheritance and grants full control only to the current Windows account. It contains:

```text
minecraft-mcp-test\
  artifacts\       # official 1.21.1 server jar, NeoForge installer, Processia jar, bridge jar
  logs\
  vanilla\
  neoforge-generic\
  neoforge-processia\
  neoforge-third-party\
```

Each profile has a separate fresh `world` name, `server.properties`, `user_jvm_args.txt`, and logs. The server property binds to `127.0.0.1`, uses port `25665`, has RCON/query/command blocks disabled, and uses small view/simulation distances. NeoForge profiles have independent installations and `mods` directories. Generic contains only `minecraft_mcp_bridge`; Processia contains that bridge plus `processia`; third-party contains the bridge only. The vanilla profile contains Mojang's server jar.

The chosen test ports are Minecraft `25665` and bridge `25677`. Both were checked free before preparation and again afterward. Port `25565` was never probed. Only one test server may run at a time.

The user-provided EULA files remain in the isolated profiles. The standard start script verifies but never edits them. Test worlds now exist only inside the four isolated profile directories; no personal world/configuration was copied or accessed. The runtime report records which worlds received explicit test fixtures.

## Artifacts

Built artifacts copied to the isolated root:

- `artifacts\minecraft_server.1.21.1.jar` — downloaded from Mojang's official version manifest; SHA-1 verified by the official manifest.
- `artifacts\neoforge-21.1.259-installer.jar` — official NeoForge Maven artifact; each of the three isolated profile installations completed successfully.
- `artifacts\minecraft_mcp_bridge-0.1.0.jar` — built from `Processia\neoforge-bridge`.
- `artifacts\processia-0.1.0.jar` — built from the Processia project.

Every NeoForge `run.bat` was created by the official installer. No launch command was run. Bridge and Processia jar IDs are distinct (`minecraft_mcp_bridge`, `processia`).

## Start procedure for a later authorized runtime mission

Use a dedicated PowerShell window and the external script `C:\Users\qperr\minecraft-mcp-test\Start-IsolatedTestServer.ps1`:

```powershell
& "$env:USERPROFILE\minecraft-mcp-test\Start-IsolatedTestServer.ps1" -Profile neoforge-generic
```

Other profile names are `vanilla`, `neoforge-processia`, and `neoforge-third-party`. The script checks only ports `25665` and `25677`, requires `eula=true` to have been set manually, and runs in the profile directory. For modded profiles it sets bridge activation, development mode, local endpoint, port, and a credential-file path only in the launched process environment. It deliberately does not set a bridge secret: the Java bridge generates a fresh 256-bit secret and writes the credential file. The bridge listener binds to loopback. Processia's legacy adapter remains disabled by this generic launcher; a separate temporary launcher enabled it for Mission 5 using an ephemeral secret removed on shutdown.

In a separate PowerShell window, build output already exists at `C:\Users\qperr\processia-mcp-server\dist\main.js`. The MCP process is started with the test-only endpoint and an independent probe name:

```powershell
$env:MINECRAFT_MCP_BRIDGE_ENABLED = 'true' # NeoForge profiles only
$env:MINECRAFT_MCP_BRIDGE_URL = 'http://127.0.0.1:25677'
$env:MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE = "$env:USERPROFILE\minecraft-mcp-test\neoforge-generic\config\minecraft-mcp-bridge.credentials.json"
node "$env:USERPROFILE\processia-mcp-server\dist\main.js" --host 127.0.0.1 --port 25665 --username WindowsMcpProbe
```

For vanilla, omit both bridge environment variables. Do not add these values to `.mcp.json` or any personal client configuration. Use actual tools already registered by this fork: `minecraft-get-server-info`, `minecraft-get-capabilities`, `minecraft-list-namespaces`, `minecraft-search-registry`, `registry-status`, `registry-resolve`, `registry-inspect`, `bridge-status`, `bridge-refresh-registries`, `minecraft-inspect-block-entity`, and `minecraft-inspect-capabilities`. Processia exposes `inspect-processia-machine`, `inspect-processia-capabilities`, `list-processia-machines`, and `inspect-processia-recipes`.

Read-only checks should cover handshake, dynamic namespace/registry paging, a loaded vanilla block, a deliberately unloaded chunk, and capability absence. Positive inventory/energy/fluid cases require suitable loaded providers. Machine inspection and placement tests must use only the isolated Processia world; any world mutation needs explicit test authorization and a reproducible setup.

## Third-party profile

Mekanism `10.7.15.81` was staged in `neoforge-third-party/mods` and loaded by the isolated server. The authenticated generic bridge discovered 60 Mekanism blocks and positively identified energy, fluid and item capabilities. Mineflayer could not join: this Mekanism server requires a NeoForge 21.1.259 client. The FluidHandler was available on a `basic_fluid_tank`, but was empty; non-empty fluid contents were not validated. Sources: [version detail](https://modrinth.com/mod/mekanism/version/zcaMNWl7), [project](https://modrinth.com/mod/mekanism).

## Validation run during preparation

- MCP: `npm ci` completed from the existing lockfile; `npm run build`, `npm test` (210/210), and `npm run lint` passed on Windows. npm reported 37 audit findings in the lockfile's dependency tree (2 low, 10 moderate, 23 high, 2 critical); no automatic audit fix was run.
- Processia: `.\gradlew.bat build --no-daemon --max-workers=1 --console=plain` passed; all available Processia test tasks were up to date. Existing Processia test reports show 18 tests, 0 failures.
- Generic bridge: `.\gradlew.bat -p neoforge-bridge build --no-daemon --max-workers=1 --console=plain` passed on Windows, including 5 JUnit tests (4 session tests and 1 credential test). The credential test verified the Windows owner-only ACL branch. Only a deprecation note in `GenericBlockInspector` was emitted.
- The 3 NeoForge installer executions completed successfully and their output run scripts were verified. No server JVM was started; no port listener existed on `25665` or `25677` at the final check.
- Git whitespace validation passed. No commit or push was made. Build outputs and test profiles remain outside version control; `todo.txt` remains ignored.

## Remaining work

- Complete MCP-through-Mineflayer interoperability with modpacks that require a NeoForge client (a modded client/proxy is needed).
- Validate a non-empty Mekanism FluidHandler through a supported in-game fluid transfer.
- Bound or improve long-distance Mineflayer block placement when it enters pathfinding; adjacent placement and read-back are proven.
- Review the 37 npm audit findings separately before changing dependencies.

The prior “Remaining work” items for EULA, basic runtime startup, registry discovery, Processia machine/recipe reads, selected third-party artifact, restart identity rotation, and adjacent placement/read-back were completed. See the runtime report for PASS/PARTIAL status and exact evidence.

## Current status after Mission 6

The prior Mission 5 “Remaining work” list is historical, not the current checklist: EULA, runtime startup, registry discovery, Processia machine/recipe reads, third-party capabilities, restart invalidation, adjacent placement/read-back, MCP-through-Mekanism and non-empty fluid were exercised as recorded in [`MISSION6_RUNTIME_REPORT.md`](MISSION6_RUNTIME_REPORT.md). Long-distance path placement has a bounded cancellation fix and unit regression, but no successful long-distance placement claim. Mission 5 status remains in [`WINDOWS_RUNTIME_TEST_REPORT.md`](WINDOWS_RUNTIME_TEST_REPORT.md) as history.
