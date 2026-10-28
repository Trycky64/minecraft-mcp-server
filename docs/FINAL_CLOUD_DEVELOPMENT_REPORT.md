# Final Claude Cloud development report

Period: 2026-10-23 → 2026-10-28. Environment: Claude Cloud Linux container (Node 22, no Windows, no Minecraft server, no bridge). Branch: `cloud/final-development` (from `cloud/mission-35`; baseline `cloud/processia-m29-baseline` = `4eef615`).

## Verdict

**CLOUD_COMPLETE for offline work; runtime validation NOT_RUN.** Every defect reproducible offline in the audited scope was fixed and covered by a test that fails on the previous code. Nothing in this report is runtime evidence; the project is not declared production-ready.

## Validation (final)

| Check | Result |
|---|---|
| `npm ci` | PASS |
| `npm run build` | PASS |
| `npm test` | PASS, 460 AVA tests (baseline 369 at resume) |
| `npm run lint` | PASS |
| `git diff --check` | PASS |
| MCP tools registered | 60 (41 core + 19 experimental GUI) |
| PowerShell parse (pwsh 7.4.6 Linux) | PASS for the 4 harness files |
| Windows harness suite, Minecraft, bridge, mods | NOT_RUN (see `docs/CODEX_RUNTIME_VALIDATION.md`) |
| `npm audit` | 1 high (`zod`), 6 moderate (`uuid` chain) remaining — see below |

## Defects fixed (each reproduced on the previous code)

| Area | Defect | Fix |
|---|---|---|
| Test profile | `processia-test` pinned the historical `127.0.0.1:25665` | Explicit loopback target; 25565/25665 refused (config, connection, harness TS/PS) |
| Harness | `Start-TestProfile.ps1` parsed `-or` as arguments: a root containing the repository was accepted | Parenthesized checks (AST-verified) |
| Menus | Stale binding renamed a modded menu with the vanilla table; complete runtime registry absence ignored; Mineflayer window slots ignored runtime item IDs | Unresolved on context change; static fallback blocked; slots named by runtime registry with conflict status |
| Capabilities | `null` vs `[]` vs unsupported indistinguishable | `capabilityReports` per item/FE/fluid; "unknown, not zero" |
| Blocks | Static `block.type` resolved against the server block registry; Mineflayer properties attached to a contradicting block; `find-blocks` offered contradicted static states | State-only resolution, conflict reporting, contradicted IDs excluded |
| Dig/place | Acted on contradicted identities ("air" mapped to a modded block included); no context re-check across awaits | Identity checks on target/references; full context re-check before dig/equip/placeBlock; optional `registryEpoch` |
| Items | `equip-item`/`find-item` matched contradicted or ambiguous static names; `craft-item` crafted with contradicted ingredients/outputs and continued after revocation | Guarded matching; recipe conflict refusal; per-operation context re-check |
| Smelting/recipes | `smelt-item` used contradicted input/fuel/furnace/output, acted after revocation/reconnect, treated two `unknown` modded items as equal; `can-craft` said "Yes" on contradicted data | Refusals before opening; per-step re-check with partial reporting; type comparison; static recipe provenance labels |
| Entities/actions | `find-entity` matched contradicted static names; `mob` filter missed 1.21 categories; `fly-to` flew in survival/unknown mode; `detect-gamemode` printed `"undefined"`; move/fly reported success after reconnect | Runtime entity registry checks; 1.21 mob categories; creative required; `unknown`; session-change errors without retry |
| Pathfinder | Default movements dug blocks and placed dirt/cobblestone scaffolding (unrequested world changes, bypassing guards) | Movement-only pathfinder |
| Interact | Hand-switch tick not re-checked before `activateBlock` | Re-validation of bot, epoch and state |
| Registry | `--host localhost` silently lost all authenticated mappings (strict endpoint comparison) | Loopback aliases canonicalized to `127.0.0.1` |
| Dependencies | body-parser (high), qs, fast-uri advisories | Semver-compatible lockfile updates; `package.json` unchanged |

Tests added: `multimod-menus`, `generic-capabilities`, `multimod-blocks`, `multimod-dig-place`, `multimod-inventory`, `multimod-recipes-smelting`, `multimod-actions-entities` (fixtures in `tests/fixtures/modded-menus.ts`: two fictitious namespaces `examplemod`/`anothermod`, real `RuntimeRegistryService` and authenticated snapshot validation), plus targeted regressions in existing suites.

## Protocol

- Minecraft 1.21.1 / protocol 767. Vanilla Mineflayer play; NeoForge servers through bridge-only mode.
- Unknown modded menus: raw-only observation with stateId ordering, bounded content, never clickable.
- Numeric IDs (items, block states, menus, entities) are named only by the authenticated runtime registry of the current session; static data is labelled as a candidate.
- `declare_recipes` historical `PartialReadError`: **RUNTIME_BLOCKED** (needs packet metadata/bytes; procedure in the Codex guide §8). Decode failures are monitored without retaining payloads.
- Recipes remain static `minecraft-data`; server-declared recipes are not used.

## Bridge

- Generic NeoForge adapter: authenticated handshake, server identity, session/epoch linkage, paginated registries with coverage, read-only item/FE/fluid capabilities, revocation and fail-closed error normalization, no automatic replay. Implemented in this repository's TypeScript client; the Java bridge is not in this workspace and was **not** exercised.
- Processia adapter: optional, separate credentials, capability-gated tools; never required.
- Not supported: gas/heat or other non-standard capability systems, entity capabilities, write operations.

## Runtime checks not executed

All items of `docs/CODEX_RUNTIME_VALIDATION.md`: Windows supervisor (W1–W6), vanilla profile (V1–V11), NeoForge generic bridge (N1–N6), third-party mod profile (M1–M5), Processia profile, `declare_recipes` capture.

## Remaining risks and limits

- Pathfinder plans with static block shapes (no digging/placing any more).
- `zod` < 4.6.6 high advisory: fix requires a zod 4 migration incompatible with the current v3 API used by the project and the MCP SDK; exposure limited to the local stdio client and a size-capped authenticated loopback bridge.
- `uuid` < 11.1.1 through `minecraft-protocol` (no compatible fix).
- NeoForge launch is refused by the harness until JVM supervision is proven.
- `interact-block` relies on the Mineflayer epoch and state ID; a bridge renewal within the same player session does not change identity semantics on the same server.

## Budget

`BUDGET_UNKNOWN`: consumption is not visible from the session. No external paid service was used.
