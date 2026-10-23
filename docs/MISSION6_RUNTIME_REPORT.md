# Mission 6 — Bridge-only interop and runtime report

> **Historical Mission 6 report.** The dependency tree and audit counts below describe that run. Mission 7 performed a compatible lockfile update and reran Windows runtime profiles; see [MISSION7_FINAL_REPORT.md](MISSION7_FINAL_REPORT.md) and [RELEASE_READINESS.md](RELEASE_READINESS.md) for current status.

Date: 2026-10-14 (Windows 11, Node.js 26.8.1, npm 11.19.0)

## Scope and preservation

Work was limited to the MCP fork and disposable test assets under `C:\Users\qperr\minecraft-mcp-test`. Runtime checks used only loopback ports `25665` (Minecraft) and `25677` (bridge), one isolated profile at a time. The personal port `25565` was not queried, contacted, or used. All temporary servers were stopped using the server console; both test ports were listener-free afterward. No Processia production source, user world, MCP personal configuration, `.gitignore`, remote, branch, commit or push was changed. Existing in-progress Mission 5 worktree edits were retained.

## Implementation and corrections

- Added explicit `bot`, `bridge-only`, and `auto` connection modes. Bridge-only startup never calls Mineflayer; runtime registry epochs bind to authenticated bridge server identity and registry generation. Player-required tools return `bot-required`.
- Added authenticated bridge-only liveness checks before serving cached registry data, and invalidate bridge snapshots after revocation/restart. Bridge-only credential reload permits a deliberate refresh after the Java server restarts.
- Made generic bridge diagnostics callable without a Mineflayer connection while retaining stable errors for Processia-adapter-only operations.
- Capped `place-block` pathfinding with a bounded `timeoutMs`; timeout cancels/stops pathfinding before the placement packet path can run. Regression test proves no placement after timeout.
- Runtime `auto` testing exposed NeoForge 1.21.1 rejecting `serverbound/minecraft:hello` without its translated client-install message. Added only that precise signature to the recognized rejection set. It still requires a valid bridge config and a new authenticated handshake; arbitrary failures/authentication errors do not trigger fallback.
- Updated only `@modelcontextprotocol/sdk` to `^1.32.1`, the compatible release suggested by audit for its vulnerability. Mineflayer, minecraft-protocol, minecraft-data and the lockfile's other packages were not bulk-upgraded.

## Runtime evidence

All MCP results below came through a real MCP stdio client calling the registered tools, not direct service-only stubs. Sanitized result records are under `C:\Users\qperr\minecraft-mcp-test\logs\mission6-*.json`; server logs and the temporary fixture source remain outside both repositories.

| Isolated profile | Observed result |
|---|---|
| Vanilla | Existing 54-tool MCP catalogue connected through Mineflayer; server info, capabilities, registry status, player position, block inspection, inventory and bounded block search returned successfully. Bridge remained disabled. |
| Generic NeoForge | Bridge-only authenticated on Minecraft 1.21.1 / NeoForge 21.1.259; 118 registry kinds and 33,719 entries refreshed complete; dynamic namespaces `brigadier`, `minecraft`, `neoforge`; `minecraft:stone` resolved. A loaded block inspection succeeded and unloaded chunks returned `bridge-chunk_not_loaded`. Player position correctly returned `bot-required`. |
| Processia | Generic bridge-only discovered `processia`; runtime M2 block IDs in that server epoch: coal generator 1066, crusher 1067, press 1068, wiremill 1069, basic battery 1070, energy cable 1071. Existing battery inspection returned a real BlockEntity, state 26729, ItemHandler and seven energy faces; no fluid capability. Processia-specific recipes/search returned explicit adapter-required errors in generic mode. |
| Mekanism | Generic bridge-only discovered `mekanism`; real IDs observed in that epoch: basic energy cube 1206, basic fluid tank 1177, basic bin 1120. Cube reported energy capability capacity 1,600,000 FE; bin reported ItemHandler; tank reported FluidHandler capacity 32,000 mB. An isolated, test-only fixture filled exactly 1,000 mB water after simulating acceptance; MCP then read the non-empty contents. No fixture source or jar was added to either repository. |
| Authentication/security | Real handshake succeeded; unauthenticated access returned HTTP 401; a closed/revoked session could not be reused (401); invalid coordinate and unloaded chunk cases returned structured 400/404 errors. Java unit tests also cover idle-session expiry, replay, rate limits and revocation; no real-time 15-minute expiry wait was performed. Secret values were not printed or included in reports. |
| Java server restart | A persistent MCP process initially resolved Mekanism ID 1177 under one identity/epoch. After graceful test-server restart, a cached lookup failed session validation and status became disconnected with no active epoch. Explicit refresh reloaded the new protected credential, authenticated a new identity/epoch, then resolved the new snapshot. |
| Auto fallback | With a valid 11-character player name, the Mekanism status ping reported `isModded: true`; Mineflayer then received the NeoForge negotiation rejection (the client surfaced a socket close). MCP attempted the configured bridge, authenticated and reported mode `bridge-only`, `playerAvailable:false`, `bridgeAvailable:true`; `get-position` returned `bot-required`. This succeeded on locked Mineflayer 4.35.0, minecraft-protocol 1.64.0 and minecraft-data 3.105.0. |

Epoch examples from the sanitized tool outputs: the Processia run used server identity `e5f48e2c-0d71-43db-833b-1a82580a6afa` and source registry epoch `201f221e-289e-494e-acbc-389ccd1cd716`; the MCP bridge-only epoch included both values. Mekanism's first observed run used identity `49369c49-f69c-4228-b90e-eec2050b32bf` / source epoch `010efc2e-b6a7-408a-840e-ce4571bf9544`; after restart the server reported a new identity `454bec66-b5d1-4707-b9c6-769666916639` / epoch `3acbc945-efe7-400a-869d-12a2c73f2616`. The rejected old session produced 401 and no active snapshot before refresh. Auto-mode's final validation had yet another identity/epoch, confirming it did not rely on cached values. These UUIDs are diagnostic identifiers, not secrets; numeric mappings remain scoped to their own run.

An initial exploratory auto probe used a 17-character offline player name. That is invalid for Minecraft and caused the vanilla test server to produce the same generic `serverbound/minecraft:hello` decode error. That probe is marked invalid in its saved evidence and was not used to implement or claim NeoForge detection. A corrected vanilla probe used the valid name `M6VanillaProbe`; a corrected NeoForge probe used `M6AutoProbe`.

IDs above are observations from their named isolated server generation only; do not reuse them across restarts. The third-party non-empty fluid mutation occurred only in the disposable Mekanism test world through a one-purpose fixture that required exact block identity, loaded chunk and successful `SIMULATE`; the fixture was disabled on the later restart.

## Placement and remaining runtime limits

Earlier Mission 5 evidence proved adjacent Processia placement and bridge read-back. A farther Mineflayer pathfinding attempt timed out and did not produce a false success. Mission 6 adds a bounded cancellable path timeout and a regression proving `placeBlock` is never invoked after timeout; it does not claim a new long-range placement success. The deadline behavior is unit-tested, but no second new world mutation was needed to test the cancellation path.

Generic bridge-only intentionally cannot expose player actions. GUI/framebuffer testing, GUI clicks, adapter-specific Processia recipes/machine search in generic mode, and broad arbitrary third-party capability semantics remain outside this Mission 6 scope. The generic bridge reads capabilities via their getter APIs; a defective third-party getter could theoretically have side effects.

## npm audit

Before the targeted updates, the locked tree reported 37 findings (2 low, 10 moderate, 23 high, 2 critical). The SDK update plus targeted semver-compatible updates to audited transitive packages reduced the final audit to 17 (0 low, 8 moderate, 9 high, 0 critical); `npm audit --omit=dev` reports 8 production findings (0 low, 4 moderate, 4 high, 0 critical). A broad npm fix also selected minecraft-protocol 1.68.0 and minecraft-data 3.117.0; those runtime components were restored to the tested versions 1.64.0 and 3.105.0. The remaining findings are confined to the Mineflayer/protocol authentication chain and test-tooling paths for which npm proposes incompatible major replacements (minecraft-protocol 0.15.0, Mineflayer 1.4.0, or AVA 1.4.1). Those were not applied. Full audit JSON outputs are kept outside the repository in the test log directory.

| Audit path group | Packages remaining after compatible updates | Exposure / disposition |
|---|---|---|
| Direct production | `minecraft-protocol` 1.64.0 (high); `mineflayer` 4.35.0 (moderate) | Kept at the tested versions. SDK MCP 1.27.1 → 1.32.1 is fixed. `npm audit` only proposes breaking protocol/Mineflayer major replacements for these findings. |
| Production transitives | `@azure/msal-node` (moderate), `@xboxreplay/xboxlive-auth` (high), `axios` (high), `prismarine-auth` (high), `uuid` (moderate), `yggdrasil` (moderate) | Authentication chain required by Mineflayer. npm ties fixes to minecraft-protocol 0.15.0 / Mineflayer 1.4.0, which are incompatible with the tested MC 1.21.1 setup. |
| Development-only paths | `argparse` (moderate), `ava` (high), `braces` (high), `fast-glob` (high), `globby` (high), `micromatch` (high), `js-yaml` (moderate), `sprintf-js` (moderate), `supertap` (moderate) | Tool/test paths, not production code. Remaining tree fix proposals require AVA 1.4.1 instead of 6.4.1; no major downgrade was applied. |

## Validations

- `npm ci`: PASS from the updated lockfile; audit summary remained 17 findings.
- `npm run build`: PASS.
- `npm test`: PASS, 223 tests, 0 failed.
- `npm run lint`: PASS.
- `git diff --check`: PASS.
- Standalone bridge `build`: PASS; forced JUnit run: 5 tests PASS.
- Processia root `build`: PASS; forced `test --rerun-tasks`: 18 tests, 0 failures/errors.
- Bridge `build`: PASS; forced `test --rerun-tasks`: 5 tests, 0 failures/errors.
- No server remains running; the two approved test ports are checked free at closeout.
- No commits or pushes were made.
- Runtime platform validated: Windows 11 only. Linux x64 and Linux ARM64/Raspberry Pi were not available in this session and are not claimed as tested.
- Test-only fluid fixture cleanup was attempted only inside the isolated test root, but the execution policy rejected the `Remove-Item` cleanup command. Its source/build directory and the fixture JAR therefore remain under `C:\Users\qperr\minecraft-mcp-test`, outside both repositories; no server process, listener or credential remains. They are not part of the repository diff.

## Worktree state

MCP branch: `feature/processia-integration`. Processia branch: `master`. Mission 5 pre-existing modifications were preserved. Mission 6 changes are uncommitted for review. The MCP has the bridge-only/runtime implementation, focused tests, targeted SDK dependency update and documentation changes. Processia retains only the three pre-existing Windows ACL edits; no Mission 6 source changes were made there. No claim is made that either repository is clean.

Suggested future MCP commit title: `feat(mcp): add authenticated bridge-only mode for modded servers`. No Processia Mission 6 commit is proposed because no Processia repository source was modified in this mission; its pre-existing ACL edits should be reviewed separately.

## Files and repository boundaries

MCP source/test edits: `src/bot-connection.ts`, `src/bridge/neoforge-bridge-client.ts`, `src/config.ts`, `src/main.ts`, `src/services/runtime-registry-service.ts`, new `src/services/minecraft-server-ping.ts`, `src/tools/block-tools.ts`, `src/tools/bridge-tools.ts`, `src/tools/registry-tools.ts`, `tests/block-tools.test.ts`, `tests/bot-connection.test.ts`, `tests/bridge-tools.test.ts`, `tests/config.test.ts`, `tests/neoforge-bridge-client.test.ts`, `tests/runtime-registry-service.test.ts`, and new `tests/minecraft-server-ping.test.ts`.

MCP dependency edits: `package.json` declares `@modelcontextprotocol/sdk` 1.32.1 and direct `minecraft-protocol` `^1.64.0`; `package-lock.json` pins those versions and contains targeted compatible security updates to eligible transitive packages. `mineflayer` 4.35.0, `minecraft-protocol` 1.64.0 and `minecraft-data` 3.105.0 remain the tested runtime versions. MCP documentation edits: `README.md`, `docs/UNIVERSALIZATION_REPORT.md`, `docs/universal-neoforge-bridge.md`, new `docs/BRIDGE_ONLY_MODE.md`, new `docs/MISSION6_RUNTIME_REPORT.md`. The pre-existing untracked `docs/WINDOWS_RUNTIME_TEST_REPORT.md` and `docs/WINDOWS_RUNTIME_TEST_SETUP.md` were preserved and appended with a clear historical/current status note.

Processia remained on `master`. Its pre-existing Windows ACL changes in `neoforge-bridge/README.md`, `BridgeSettings.java`, and `BridgeSettingsTest.java` were neither edited nor discarded by Mission 6. No Processia app source, build script, dependency, wrapper permission or generated artifact was added to Git.

No staged files, commit or push were created. Suggested MCP message only: `feat(mcp): add authenticated bridge-only mode for modded servers`.
