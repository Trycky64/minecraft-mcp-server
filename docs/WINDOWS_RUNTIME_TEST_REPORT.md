# Windows Runtime Test Report — Mission 5

> **Historical Mission 5 report.** Keep this file as the original evidence for that run. Its audit totals, placement and profile statuses have since been superseded by [Mission 7](MISSION7_FINAL_REPORT.md); consult [Release Readiness](RELEASE_READINESS.md) for current support boundaries.

Date: 2026-10-14. Runtime was executed only in `C:\Users\qperr\minecraft-mcp-test`, on loopback ports `25665` (Minecraft) and `25677` (bridge). Minecraft EULA acceptance was confirmed by the user before server launch.

## Safety and environment

- Host: Windows 11, Temurin Java 21.0.12.1, Node.js 26.8.1, npm 11.19.0, Gradle wrapper 9.2.1.
- The start script checked the user-provided `eula=true` files and loopback-only server properties. Each server ran alone. All four test profiles were stopped; both reserved ports are free and ephemeral bridge credential files were removed on normal shutdown.
- No connection, port check, process query, file access, or world access was made against the personal server or port `25565`.
- The isolated test worlds were deliberately modified only for the documented fixtures below and saved on normal shutdown. They remain under the test root. No commit or push was made.
- Mekanism `10.7.15.81` was downloaded from the official Modrinth release, its SHA-512 matched the release API metadata, and the server log confirms Mekanism `10.7.15` loaded on NeoForge `21.1.259`.

## Runtime results

| Scenario | Result | Observed evidence |
|---|---|---|
| Vanilla MCP | PASS | Real MCP child connected to Minecraft `1.21.1` / protocol `767`; 54 tools listed; vanilla registry/block/inventory calls worked. Bridge status was disabled and bridge-only inspection failed explicitly. Empty inventory was complete and had no decode issues. `find-blocks minecraft:grass_block` returned loaded matches with runtime/static confidence reported explicitly. |
| Generic NeoForge | PASS | Dedicated server loaded only Minecraft, NeoForge `21.1.259` and `minecraft_mcp_bridge`; bridge listened on `127.0.0.1:25677`. MCP authenticated refresh returned complete registry snapshots (including 1,060 blocks, 26,684 states and 1,333 items). Runtime `minecraft:stone` block ID `1` and `minecraft:diamond` item ID `805` resolved with bridge provenance. |
| Authentication and loopback | PASS | Correct local MCP credentials completed the handshake. Requests with no bearer or a wrong bearer returned `401`; a valid session could read the bridge. The generic bridge listener bound only to `127.0.0.1`. Credential ACL was owner-only and the credential file was deleted on normal stop. No secret value was written to logs or this report. |
| Generic block/capability inspection | PASS | Through MCP, an isolated vanilla chest was read as a real BlockEntity with a 27-slot ItemHandler; slot 0 contained 3 diamonds, independently confirmed by the test server's `/data get block`. A far, unloaded position returned `bridge-chunk_not_loaded`; invalid coordinates were rejected. A chest correctly had no energy or fluid handler. |
| Processia registry discovery | PASS | Both the generic and Processia-specific bridge paths loaded with Processia `0.1.0`. The Processia namespace was discovered dynamically. The observed block registry contained 1,072 entries, item registry 1,360, BlockEntity types 50, and block states 26,795. Actual block IDs included generator `1066`, crusher `1067`, press `1068`, wiremill `1069`, battery `1070`, and cable `1071`; crusher item ID was `1341`. These IDs are scoped to the observed server generation. |
| Processia tools and machines | PASS | `bridge-refresh-registries`, `registry-resolve`, `registry-inspect`, namespace/search tools, `inspect-processia-machine`, `inspect-processia-capabilities`, `list-processia-machines`, and `inspect-processia-recipes` ran through MCP. A bounded list returned six loaded M2 blocks with complete chunk coverage and live BlockEntity types. Individual inspection of all six returned real block state IDs/properties and capability data. Recipe inspection returned all 11 recipes with `completeness: complete`. |
| Positive Processia ItemHandler | PASS | The real crusher ItemHandler returned two `minecraft:raw_iron` items in slot 0 (MCP and bridge response); another earlier generic chest fixture returned three diamonds. |
| Positive Processia EnergyStorage | PASS | The coal generator produced non-zero FE. Processia bridge inspection observed `7,960/10,000 FE`; after isolating consumers, the generic bridge observed `9,320/10,000 FE`. Later machine inspection observed non-zero stored FE on the crusher and wiremill. Values changed as the machines ticked, as expected. |
| Processia fluids | PASS (absence by design) | Processia blocks returned unavailable fluid capabilities; source inspection confirms Processia does not register a FluidHandler. This is an expected absence, not a failed capability read. |
| Mekanism load and generic bridge | PASS | Mekanism `10.7.15` loaded on a dedicated server. The authenticated bridge returned 1,260 block entries in 7 pages and 60 Mekanism basic/advanced/elite blocks. The generic MCP-compatible bridge reported `itemHandler`, `energyStorage`, and `fluidHandler` supported. |
| Positive third-party capabilities | PASS | Direct authenticated bridge inspection read a real `mekanism:basic_energy_cube` (state ID `28653`; EnergyStorage capacity `1,600,000 FE`), `mekanism:basic_fluid_tank` (state ID `28189`; one available tank with `32,000 mB` capacity), and `mekanism:basic_bin` (state ID `27576`; ItemHandler available). The tank was empty (`0 mB`), so non-empty FluidHandler contents were not validated. |
| MCP to Mekanism interop | BLOCKED | Mineflayer was refused during NeoForge configuration. Server log: “You are trying to connect to a server that is running NeoForge, but you are not. Please install NeoForge Version: 21.1.259 to connect to this server.” The authenticated bridge itself worked directly, but MCP cannot bind its bridge session to a disconnected Mineflayer epoch; it correctly failed closed. A NeoForge-capable Minecraft client/proxy is needed for end-to-end MCP integration with this modpack. |
| Auth errors, revocation and bounds | PASS | On the third-party bridge, missing/wrong authentication returned `401`; a closed session returned `401 authentication_required`; a wrong server identity returned `409 server_identity_mismatch`; unloaded chunk returned `404 chunk_not_loaded`; out-of-range coordinates returned `400 coordinates_out_of_range`. |
| Restart and epoch rotation | PASS | After a clean isolated Mekanism-server stop/restart, the bridge generated a new server identity and registry epoch. The new identity authenticated (`200`); the old expected identity was rejected (`409 server_identity_mismatch`). Per-MCP bot registry epochs remained separate from bridge source epochs in Processia results. |
| Processia placement and read-back | PASS with range limitation | MCP `place-block` placed two Processia machines in the isolated Processia world; a nearby `processia:basic_battery` placement also returned success. A subsequent MCP `inspect-processia-machine` confirmed `processia:basic_battery`, BlockEntity present, state ID `26729`, property `facing=up`. A multi-placement sequence's third, farther action timed out while searching/pathfinding; the target was still air at that point. The adjacent placement path and post-placement read-back passed. |
| Graceful MCP disconnect | PASS after fix | Live MCP teardown previously produced Netty `Connection reset` because the parent exited immediately after `bot.quit()`. Cleanup now waits for Mineflayer's `end` event (up to 1 second) before process exit. A retest logged `M5Graceful lost connection: Disconnected` without a Netty reset. |

## Corrections and regression tests

1. `find-blocks` previously paired `status: not-found-in-loaded-area` with the incorrect reason `runtime-state-mapping-incomplete`. It now returns `no-match-in-loaded-area` when coverage and session mapping are complete. A focused regression test covers this.
2. MCP shutdown now awaits Mineflayer disconnect completion with a bounded timeout. A regression test verifies cleanup waits for the `end` event.

An additional repeated Processia registry refresh during the same IP rate window received the bridge's intended `bridge-rate_limited` response (120 requests/minute per IP). After the window rolled over, individual machine/list/recipe tools succeeded in one MCP session. Avoid redundant full registry refreshes; this is a documented bridge throttle, not a hidden success.

## Validation

Reference checks before runtime passed: MCP build, lint and 210 tests; Processia build and 18 tests; generic bridge build and 5 tests (233 combined). After the two MCP fixes, focused tests passed: `npx ava tests/block-tools.test.ts tests/bot-connection.test.ts` — 39 passed. Final validations: `npm run build` PASS; `npm test` PASS (212 tests); `npm run lint` PASS; MCP `git diff --check` PASS. Processia `.\gradlew.bat build --no-daemon --max-workers=1 --console=plain` PASS and `.\gradlew.bat test --rerun-tasks --no-daemon --max-workers=1 --console=plain` PASS (18 tests, 0 failures). Generic bridge `.\gradlew.bat -p neoforge-bridge build --no-daemon --max-workers=1 --console=plain` PASS and `.\gradlew.bat -p neoforge-bridge test --rerun-tasks --no-daemon --max-workers=1 --console=plain` PASS (5 tests, 0 failures). Total: **235 passed, 0 failed** (212 MCP + 18 Processia + 5 bridge).

Runtime logs and JSON evidence are under `C:\Users\qperr\minecraft-mcp-test\logs`. Probe scripts, credentials, test requests and server profiles are outside both Git repositories. The bridge credentials were removed during normal server shutdown.

## Remaining limitations and verdict

- Fluid capability discovery is proven, but the positive non-empty Mekanism tank case is not: its `FluidHandler` was available, with `0/32,000 mB`. Filling it through a supported in-game modded interaction requires a NeoForge client; Mineflayer cannot connect to this Mekanism server.
- End-to-end MCP-to-Mekanism registry and block inspection remains blocked by the server's explicit NeoForge-client requirement. Direct bridge calls establish Java-side functionality only.
- Long-distance placement that invokes pathfinding can exceed the MCP client request deadline; immediate, adjacent placement was validated and read back.
- Processia itself has no fluid capability by design.

Mission 5 runtime verdict: **PARTIAL**. Vanilla, generic NeoForge, Processia, Processia machines/recipes, positive item/energy, bridge authentication, restart invalidation, generic third-party discovery/capabilities, and adjacent placement are demonstrated. The blocked MCP↔Mekanism path and non-empty fluid contents prevent a full PASS.

## Git and working tree

- MCP remains on `feature/processia-integration`; no commit or push was made. Mission 5 changed `src/bot-connection.ts`, `src/main.ts`, `src/tools/block-tools.ts`, `tests/bot-connection.test.ts`, `tests/block-tools.test.ts`, and this report plus `docs/UNIVERSALIZATION_REPORT.md`. `docs/WINDOWS_RUNTIME_TEST_SETUP.md` is an untracked test-preparation document created in the earlier Mission 4 work. `docs/universal-neoforge-bridge.md` was already modified before this Mission 5 runtime continuation and was preserved.
- Processia remains on `master`; Mission 5 made no source changes there. Its pre-existing uncommitted Windows credential ACL work remains in `neoforge-bridge/README.md`, `BridgeSettings.java`, and `BridgeSettingsTest.java`.
- No dependency manifest or lockfile, `.gitignore`, `.mcp.json`, personal MCP configuration, or Processia application source was changed in Mission 5. `git diff --check` passed in both repositories. No credentials remain in test profiles.

> Historical Mission 5 snapshot. Its PARTIAL verdict describes the evidence available then. Mission 6 later validated MCP bridge-only interop with Mekanism, non-empty fluid contents and authenticated auto fallback; see [`MISSION6_RUNTIME_REPORT.md`](MISSION6_RUNTIME_REPORT.md) for the current combined status. The long-distance placement timeout now has a bounded cancellation fix and unit regression, not a successful long-range placement proof.
