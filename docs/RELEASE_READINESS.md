# Mission 13 current status (2026-10-16)

> **Current state (2026-10-28):** see [the final cloud development report](FINAL_CLOUD_DEVELOPMENT_REPORT.md) for offline validation and remaining risks, and [the Codex runtime validation guide](CODEX_RUNTIME_VALIDATION.md) for the runtime checks still `NOT_RUN`. The sections below are historical.

**PARTIAL — private beta candidate prepared locally, pending owner decisions.** Candidate `2.1.0-beta.1` and bridge `0.1.0` are under `C:/Users/qperr/minecraft-mcp-test/release-candidate/mission13/`. Windows x64 and Linux x64 each passed `npm ci`, build, 232 tests and lint; MCP stdio listed 56 tools on both. Current audit: 15 advisories overall, 6 moderate in production; uuid risk remains pending explicit owner approval. A real Processia Crusher screen and energy synchronization were captured at 1600×900, but M2-V01 across every machine/face and human visual approval remain open. Processia V0.2 nickel slice is implemented; 49/49 required GameTests passed. Nothing was committed, tagged, pushed, published or transmitted. See [Mission 13 MCP report](MISSION13_MCP_FINAL_REPORT.md) and Processia report in the sibling project.

The Mission 12 and earlier sections below are historical snapshots unless specifically updated.
# Release readiness

**Mission 12 snapshot (superseded by Mission 13).** The source and local candidate are `2.1.0-beta.1`, with Windows/Linux x64 build, lint and 231 tests passing. The standalone bridge is `0.1.0`. Six moderate production npm findings remain open pending user risk acceptance. GUI is experimental; ARM64 and modded Mineflayer placement are excluded. See [Mission 12 report](MISSION12_MCP_RELEASE_REPORT.md). The assessments below describe earlier source states.

**Mission 11 update (2026-10-16): PARTIAL — BETA POSSIBLE WITH EXCLUSIONS.** The core has fresh Windows vanilla placement, standalone NeoForge and Mekanism runtime evidence; the Processia GUI runner completed a real Crusher recipe with independent server output delta, but its overall result is PARTIAL because the generic bridge cannot expose private progress, combustion and redstone values. Windows and Linux x64 each pass 231 MCP tests. Six moderate production advisories remain; native ARM64 is untested. The candidate is local and still version `2.0.4`. Review [MISSION11_FINAL_REPORT.md](MISSION11_FINAL_REPORT.md) before any release decision. The Mission 10 assessment below is historical.

**Snapshot date:** 2026-10-14. This is a readiness assessment, not a release or a promise of support beyond the tested matrix. Current evidence is in [MISSION10_FINAL_REPORT.md](MISSION10_FINAL_REPORT.md); earlier mission reports are historical.

## Mission 10 current decision

**PARTIAL — BETA POSSIBLE WITH EXCLUSIONS.** Four isolated runtime profiles were replayed through MCP stdio, and GUI capture, Crusher menu, tooltip and music-zero readback passed with one graphical client. The GUI E2E runner exposed an old inventory response-shape assumption; its correction has unit coverage but has not been rerun with a graphical client. Recipe execution, placement with a legitimate nonempty stack, and native ARM64 remain unproven. Windows and Linux x64 builds and 230 MCP tests pass; Processia and generic bridge Java builds pass with 24 and 5 tests. The source package version remains 2.0.4. Do not market the experimental GUI or full placement as supported in a beta.

## Historical Mission 8/9 decision (2026-10-14)

**Publication: NOT READY.** On the final run, MCP build/lint passed with 225/225 tests; Processia build passed with 23/23 tests; the generic bridge build passed with 5/5 tests. The one GUI client authenticated and reached `clientReady`, but the harness script then failed with `options-screen-not-open:none` and stopped that client. Per the user's instruction, no second graphical client was launched. Music controls, stabilized screenshots, and the final machine-menu workflow therefore remain unvalidated; see [MISSION8_FINAL_REPORT.md](MISSION8_FINAL_REPORT.md). Current npm audit is 15 advisories (10 moderate/5 high overall; 6 moderate production). The local candidate snapshot and its checksums are at `C:/Users/qperr/minecraft-mcp-test/release-candidate`; it is unpublished and is not a release-ready candidate. Full reports: [Mission 8](MISSION8_FINAL_REPORT.md) and [Mission 9](MISSION9_FINAL_REPORT.md).

## Supported and tested matrix

| Area | Verified | Boundary |
|---|---|---|
| Host | Windows 11 x64 | Linux x64 Node checks passed under WSL before the final lockfile update; final-lock WSL rerun is recorded in the Mission 7 report. |
| Node | 26.8.1 / npm 11.19.0 | Node >=20.10 is declared; other versions are not validated here. |
| Java | Temurin 21.0.12.1 | Processia Gradle build/tests and generic bridge build/tests passed. |
| Minecraft | Java 1.21.1, protocol 767 | The current release baseline is 1.21.1. The upstream README's older 1.21.8 note is not the tested compatibility claim for this fork. |
| NeoForge | 21.1.259 | Generic bridge tested without Processia; Processia 0.1.0 and Mekanism 10.7.15 tested in isolated profiles. |
| MCP connection | `bot`, `bridge-only`, `auto` | Vanilla tools require a Mineflayer player; bridge-only does not fabricate player state. |

## Available features

- Vanilla Mineflayer player, world, inventory, crafting, navigation and interaction tools remain registered.
- The generic NeoForge bridge is optional, disabled by default, loopback-bound and authenticated using generated credentials. It exposes dynamic registry discovery and bounded read-only block, BlockEntity, item-handler, energy and fluid inspection.
- The Processia adapter is optional. Its machine and recipe-specific functions remain available when the Processia adapter is configured. The generic bridge does not impersonate the adapter for recipe lists or machine searches it cannot provide.
- GUI features use a separate instrumented Processia client and a second authenticated session tied to the active server identity and registry epoch. Mission 10 opened a real Crusher menu, read slots and synchronized values, captured a framebuffer and read tooltips. The corrected E2E comparison runner has unit tests but awaits a graphical rerun. The harness fails closed when the target is not visible and never teleports the local client player to frame it.

## MCP tool compatibility matrix

The MCP currently registers 56 tools. These are the complete names observed at runtime.

### Vanilla player tools (22)

`get-position`, `move-to-position`, `look-at`, `jump`, `move-in-direction`, `list-inventory`, `find-item`, `equip-item`, `place-block`, `dig-block`, `get-block-info`, `find-blocks`, `find-entity`, `send-chat`, `read-chat`, `fly-to`, `detect-gamemode`, `list-recipes`, `craft-item`, `get-recipe`, `can-craft`, `smelt-item`.

Require a live Mineflayer player (`bot` mode or a successful Mineflayer connection in `auto`). In `bridge-only`, they return an explicit `bot-required` error.

### Generic bridge and registry tools (11)

`minecraft-get-server-info`, `minecraft-get-capabilities`, `minecraft-list-namespaces`, `minecraft-search-registry`, `registry-status`, `registry-resolve`, `registry-inspect`, `bridge-status`, `bridge-refresh-registries`, `minecraft-inspect-block-entity`, `minecraft-inspect-capabilities`.

Require an authenticated generic bridge for authoritative modded server data. Static Minecraft data remains marked static; it is not runtime ID evidence. Refresh only updates MCP snapshots and does not change the Minecraft world.

### Processia inspection tools (4)

`inspect-processia-machine`, `inspect-processia-capabilities`, `list-processia-machines`, `inspect-processia-recipes`.

The first two can delegate to the generic read-only block/BlockEntity inspection when that bridge is active. Machine enumeration and recipes require the Processia-specific adapter and return an explicit unavailable/adapter-required result without it.

### GUI harness tools (19)

`gui-status`, `gui-start-client`, `gui-stop-client`, `gui-inspect-screen`, `gui-open-pause`, `gui-set-music-zero`, `gui-open-machine`, `gui-open-block`, `gui-click-slot`, `gui-move-items`, `gui-click-widget`, `gui-hover-slot`, `gui-hover-widget`, `gui-close-screen`, `gui-screenshot`, `gui-capture-block`, `gui-set-display`, `gui-wait-for`, `gui-run-e2e`.

These require GUI harness configuration, an authenticated Processia client and a matching authenticated bridge identity/epoch. Mutating menu operations additionally require `TEST_MUTATION` and explicit acknowledgement of the isolated test world. Tool registration alone does not indicate a running GUI client. Mission 10 validated Pause/Options navigation and the Crusher menu; item transfer, a full E2E recipe run and the corrected runner's runtime result remain open.

| Mode | Vanilla player tools | Generic bridge tools | Processia adapter tools | GUI tools |
|---|---|---|---|---|
| `bot` | Available after Mineflayer connects | Available if an authenticated bridge is configured | Adapter-dependent | Independent GUI client required |
| `bridge-only` | `bot-required` | Available after bridge handshake | Generic inspection only; adapter-only operations fail explicitly | Independent GUI client and authenticated bridge link required |
| `auto` | Available if Mineflayer succeeds | Available after the narrow, authenticated NeoForge fallback | Adapter-dependent | Independent GUI client and authenticated bridge link required |

## Configuration and security

- Keep the bridge disabled unless the local development/test server is explicitly enabled. Do not bind it beyond loopback.
- Let the bridge generate an ephemeral credential file with owner-only access. Configure the MCP process with the file path; do not paste the secret into command history, a repository file or logs.
- The MCP credential reader rejects non-files and symlinks, enforces a 16 KiB limit and checks file identity around opening. POSIX credentials must be mode `0600`; Windows file ACLs are expected to be restricted to the current user.
- Handshakes and subsequent responses validate protocol, server identity, endpoint, Minecraft/NeoForge versions and registry epoch. An epoch change requires refresh; stale IDs are not reusable across restarts.
- The HTTP interface has no arbitrary command, filesystem or outbound-network operation. World inspection is read-only and refuses unloaded chunks rather than loading/generating them.

## Dependency security

`npm audit fix` (without `--force`) was run against the existing lockfile. The lock now resolves Mineflayer 4.39.0, minecraft-protocol 1.68.0, minecraft-data 3.117.0 and compatible Prismarine/auth-chain updates; the vulnerable transitive Axios 0.21.4 was removed. On the Mission 8/9 final run the stack passed the build, all 225 tests and lint. This final run did not repeat all isolated Minecraft profile scenarios.

Residual audit on this snapshot:

- `npm audit`: 15 findings (10 moderate, 5 high, 0 critical).
- `npm audit --omit=dev`: 6 findings (6 moderate, 0 high, 0 critical), all in the Mineflayer authentication/protocol dependency chain: `@azure/msal-node`, `minecraft-protocol`, `mineflayer`, `prismarine-auth`, `uuid`, `yggdrasil`.
- Remaining high findings are development/test tooling dependencies (AVA/glob/matcher/YAML/formatting paths). npm offers their remediation only by replacing AVA with incompatible major version 1.4.1. Production chain remediation still requests incompatible legacy protocol/Mineflayer versions or an unverified UUID override. No `--force` or unvalidated override was applied.

Run both audit commands on every release candidate. Reassess upstream patches before release; do not treat the current residual findings as waived.

## Runtime evidence and limitations

- Mission 10 replayed the four Windows isolated profiles sequentially: vanilla, standalone generic NeoForge, NeoForge+Processia, and NeoForge+Mekanism. All test servers and the single GUI client were stopped at the end; ports 25665/25677/25678 are free. The earlier PID 13208 and Mission 8/9 server state are historical only.
- Processia registry observations include six M2 blocks with runtime IDs 1066–1071 for the exact observed server epoch. Those values are observations, not portable constants.
- Mekanism `basic_energy_cube`, `basic_fluid_tank` and `basic_bin` exposed live capabilities through the generic bridge. The persisted isolated tank contained `1,000/32,000 mB` water; the optional fixture mod was disabled for the Mission 7 rerun.
- Vanilla inventory reads were complete and empty. This proves an empty inventory read only. No positive placement was repeated on the upgraded Mineflayer stack because no item stack was available. Mission 5 contains the earlier isolated adjacent-placement proof; a fresh placement release gate remains recommended.
- Mission 10 screenshots were real PNG framebuffer captures at 1280×720 and 1600×900, with signature/hash checks and `interactionReady=true`. The Crusher menu, synced FE values and item/redstone tooltips were observed. Slot transfer, recipe execution and the corrected E2E runner's graphical result remain unvalidated; older Mission 8 loading frames are historical and are not used as evidence here.
- Linux x64 unit/toolchain validation is documented separately from Minecraft server runtime. Native Linux ARM64 and Raspberry Pi were unavailable; no ARM64 claim is made.

## Linux use

Use Node.js >=20.10 and npm, then run `npm ci`, `npm run build`, `npm test`, and `npm run lint`. Store bridge credentials in a user-only path (for example, `$XDG_RUNTIME_DIR`) and set the loopback URL/version variables described in [bridge-only mode](BRIDGE_ONLY_MODE.md). Linux paths and permission behavior were checked under x64 WSL; native ARM64 and a Linux Minecraft server were not demonstrated.

## Rollback and publication checklist

1. Keep the candidate branch and current worktree intact; do not use destructive reset/clean commands.
2. To restore dependencies, review the candidate lock diff and restore only the intended lockfile snapshot from version control or a separately saved copy, then run `npm ci`; do not replace local source edits wholesale.
3. Disable the server-side bridge and remove the MCP bridge variables from the test process to return to ordinary vanilla mode. Never delete user worlds or credentials outside the isolated test root.
4. Before release, require: current build/tests/lint, audit review, Windows vanilla+NeoForge smoke, successful placement after obtaining a legitimate test stack, and either GUI menu/framebuffer validation or an explicit decision to exclude GUI claims. Add native ARM64 validation if Raspberry Pi is a release target.
5. Review both repositories' dirty states, secrets and generated artifacts. This Mission 7 did not create commits, tags, releases or pushes.
