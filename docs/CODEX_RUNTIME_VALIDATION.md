# Codex runtime validation handover

This guide lists every check that Claude Cloud could not run (Linux container, no Windows, no Minecraft server, no bridge) and how to run it on authorized infrastructure. Offline AVA tests cover the logic with synthetic fixtures; they are **not** runtime evidence. Record each result as `PASS`, `FAIL`, `BLOCKED` or `NOT_RUN`; never promote a synthetic result to `PASS`.

Source branch: `cloud/final-development`. Baseline: `npm ci && npm run build && npm test && npm run lint` (460 tests, 60 tools).

## 1. Safety rules (apply to every step)

- Use only a dedicated, disposable server created for this validation, bound to `127.0.0.1`. Never contact a personal or production server.
- Ports `25565` (personal) and `25665` (retired historical test server) are forbidden. Choose explicit free ports, for example Minecraft `26001`, bridge `26002`, GUI `26003`, and record them.
- Never reuse or modify an existing world. Each run starts from a world-free template copied into a new run directory.
- Accept the Minecraft EULA explicitly and only in the new template.
- Never log or commit the bridge credential file or any secret. Collect only bounded, sanitized evidence.
- Do not retry an action whose result was reported as uncertain; re-inspect state instead.
- Stop servers gracefully (`stop` / `Stop-TestProfile.ps1`). Never force-kill a process you did not start, and never stop historical processes.
- The MCP `processia-test` profile requires `--host 127.0.0.1`, an explicit port, and refuses 25565/25665.

## 2. Evidence format

For each test ID, store: date, OS, Node/npm versions, `git rev-parse HEAD`, Minecraft/NeoForge/mod versions and SHA-256 of jars, ports, MCP tool call names with sanitized arguments, the relevant JSON response fields, and the final status. Do not store chat content, raw packets, hex dumps or credentials.

## 3. Windows supervisor (no Minecraft)

| ID | Procedure | Expected |
|---|---|---|
| W1 | `powershell -NoProfile -ExecutionPolicy Bypass -File tools/runtime-harness/Test-SupervisorOffline.ps1` (Windows PowerShell 5.1) | 61/61 assertions PASS, including `historical test port refused without socket access`. |
| W2 | Parse check: `[Management.Automation.Language.Parser]::ParseFile` on the four harness files | 0 parse errors (already PASS on Linux pwsh 7.4.6; repeat on 5.1). |
| W3 | Create a junction inside a temporary harness root pointing outside it; call `Resolve-HarnessPath` on a path through it | Throws `reparse-point-path-refused`. |
| W4 | Start two `Stop-TestProfile.ps1` against one fake lease simultaneously (reuse the fake-process fixture of W1) | One `accepted`, the other times out or is refused; final lease `stopped-confirmed` only once; no kill. |
| W5 | From a second Windows account, open the run's named pipe | Access denied (DACL limited to the owner SID). |
| W6 | Repository-disjointness: run `Start-TestProfile.ps1 -AuthorizeStart` with `-HarnessRoot` set to a parent of the repository | Refused with `harness-root-must-be-disjoint-from-repository` (Mission 29.0 fix). |

## 4. Vanilla profile (Minecraft 1.21.1, no mods)

Prepare a world-free vanilla template and approved manifest per `docs/RUNTIME_TEST_HARNESS.md`, then:
`Start-TestProfile.ps1 -Profile vanilla -HarnessRoot <root> -TemplateDirectory <root>\templates\vanilla -ApprovedManifestSha256 <sha> -MinecraftPort 26001 -AuthorizeStart`

Connect the MCP over stdio with an MCP client (Claude Desktop, or `npx @modelcontextprotocol/inspector node dist/main.js --host 127.0.0.1 --port 26001 --username CodexBot`). Grant the bot operator rights only if a step requires a game-mode change, using the server console.

| ID | Steps | Expected |
|---|---|---|
| V1 | List tools | 60 tools. |
| V2 | `get-position`, `detect-gamemode`, `list-inventory` | Position read; game mode `"survival"`; `snapshotStatus` becomes `complete` after the first window 0 snapshot. |
| V3 | `get-block-info` on stone and air; `find-blocks minecraft:stone` | Without bridge: `identityConfidence: version-static-candidate`, `mineflayerNameStatus: not-checked-against-runtime-registry`; search status `found-static-candidate-unverified`. |
| V4 | `equip-item chest`, then `place-block` without `itemId` (an `itemId` needs an authoritative runtime mapping, unavailable in vanilla) with `registryEpoch` from V3, `interact-block`, `inspect-open-window`, `click-window-slot` left on an item, `close-open-window` | Placement observed; menu identity `minecraft:generic_9x3` (version-static); click status `server-confirmed` or explicit `uncertain` (never retried). |
| V5 | Surround a target with blocks, `move-to-position` across it | Path found without breaking or placing any block (movement-only pathfinder), or a timeout/no-path error; the world around the bot is unchanged. |
| V6 | `dig-block` on dirt; `dig-block` passing a previous session's `registryEpoch` | First mined (`block-mined-observed-client-cache`); second refused `stale-registry-epoch` with no dig. |
| V7 | `craft-item stick` with planks; `can-craft`, `get-recipe` | Crafted; read tools show `Recipe source: static minecraft-data`. |
| V8 | `smelt-item` raw_iron + coal in a placed furnace | `output-observed-client-side` with `clientObservedOutput.rawNumericId`. |
| V9 | `fly-to` in survival; then switch to creative from the server console; `fly-to` again | Survival refused, no flight packets (no kick); creative flies. |
| V10 | During a long `move-to-position`, restart the MCP connection (kick the bot from the console) | Result `minecraft-session-changed-during-action` or a connection error; never a success on the old bot; no automatic retry of the move. |
| V11 | Start the MCP with `--host localhost` instead of `127.0.0.1` | `registry-status` shows endpoint `127.0.0.1:26001`. |

## 5. NeoForge with the generic bridge

The harness refuses NeoForge profiles (`run.bat` supervision unproven). Until a direct-Java or job-object supervisor is implemented and W1-style tested, launch NeoForge manually under human supervision in a new disposable directory with `server.properties` bound to `127.0.0.1:26001`, the bridge on `26002`, and the environment from `docs/BRIDGE_ONLY_MODE.md`. Stop it with `stop` in its console.

| ID | Steps | Expected |
|---|---|---|
| N1 | `--connection-mode bridge-only`; `bridge-status`, `bridge-refresh-registries`, `registry-status` | Authenticated session; record each registry kind with its `completeness` (`complete`/`partial`). Coverage determines whether "absent from complete registry" refusals can occur. |
| N2 | `minecraft-get-capabilities` | `neoforge.capability.*` available with `serverAdvertised` values from `/v1/capabilities`. |
| N3 | `minecraft-inspect-capabilities` on a vanilla furnace, a chest and an empty block | `capabilityReports` per system; empty vs absent recorded exactly as returned; no fabricated values. |
| N4 | Revoke: stop the bridge (or delete/rotate its credential) while the MCP runs; repeat N3 and `registry-resolve` | Error with session invalidation; runtime mappings withdrawn; no stale values. |
| N5 | Restart the bridge; `bridge-refresh-registries` | New `bridgeSessionId`/`sourceRegistryEpoch`; earlier menu observations report `runtime-context-changed-since-menu-was-observed`. |
| N6 | Mode `auto` with a vanilla bot name rejected by NeoForge | One authenticated bridge-only fallback, no retry loop. |

## 6. Third-party mods (profile B)

Select and approve one mod for Minecraft 1.21.1 / NeoForge 21.1.259 with a non-vanilla menu (record source, license, SHA-256, approval). Mekanism 10.7.15 was used historically for capabilities.

| ID | Steps | Expected |
|---|---|---|
| M1 | Refresh registries; `registry-resolve` a modded item, block state and entity type | Authenticated `namespacedId` with provenance; numeric IDs scoped to the session. |
| M2 | Open the mod's menu with `interact-block` | Raw-only window if Mineflayer cannot build it: identity from the bridge menu registry, slots raw or authenticated, `interactionsAllowed: false`; any click refused. |
| M3 | `get-block-info`, `find-blocks`, `dig-block` on a modded block | Runtime identity reported; if Mineflayer's static name contradicts it, `dig-block` refuses (`runtime-identity-contradicts-mineflayer`). |
| M4 | FE and fluid blocks: `minecraft-inspect-capabilities` | Values exactly as the bridge reports them; `capabilityReports` correct. |
| M5 | `find-entity examplemod`-style namespaced lookup of a modded entity | Found by runtime `namespacedId`; static names contradicted by the registry are not matched. |

## 7. Processia (optional, profile C)

Only after A and B. Processia must never be required by any A/B step. Repeat M2–M4 for a Processia machine with the Processia adapter; the layout provider may name properties only for an authenticated `processia:*` menu.

## 8. `declare_recipes` decode issue (`RUNTIME_BLOCKED`)

The historical `PartialReadError` cannot be root-caused without the original packet. On a reproducing authorized server, capture only: Mineflayer and minecraft-protocol versions, `client.version`, `client.state`, protocol number, `metadata.name`, `error.name`, `error.field`, buffer length and cursor offset (see `docs/DECLARE_RECIPES_INVESTIGATION.md`). A byte capture needs separate approval and redaction. Do not patch protodef or the schema before isolating the first divergent field with a minimized regression test.

## 9. Known limits to watch during runtime

- The pathfinder plans with static block shapes; on reordered modded registries paths can be wrong (it no longer digs or places).
- Recipes are static `minecraft-data`; server-declared recipes are not used.
- `zod` < 4.6.6 (memory exhaustion on oversized constrained collections) remains: inputs come from the local stdio client and a size-capped authenticated loopback bridge. `uuid` < 11.1.1 remains through minecraft-protocol.
