# Processia registry diagnostics (P1)

This fork adds a version-scoped `MinecraftRegistryService` and connects it to the active Mineflayer bot. It does not patch `bot.registry`; the 22 existing vanilla MCP tools remain registered. Three registry diagnostics are added. The P2 NeoForge bridge is not implemented, so this release must not be described as having runtime Processia mappings.

## Runtime lifecycle, sources and epochs

After Mineflayer spawns, `RuntimeRegistryService` reads the actual `bot.version`, derives the protocol number from the matching installed `minecraft-data` dataset when available, and creates a fresh random session epoch. Its server identity is the configured host and port. A changed bot object, endpoint or version creates a fresh service and static baseline; disconnect invalidates the session. Runtime snapshots can be injected only for the active Minecraft version and epoch. A bridge is reported available only after a future authenticated bridge implementation; current status is always `false`.

Source priority is NeoForge bridge > protocol > minecraft-data. Coverage is declared per registry: `complete` snapshots can prove absence and block lower-priority associations; `partial` snapshots override associations they know (including numeric collisions) and allow lower-priority known vanilla entries to fill unrelated gaps. Unspecified runtime coverage defaults to partial. Static results retain `minecraft-data:<version>` provenance and should not be represented as runtime-observed mappings. The detailed status/coverage/epoch rules are in [registry-service.md](registry-service.md).

No runtime session data is reused after reconnect. Runtime lookups without an epoch are unresolved when runtime data is present. Static-only lookups preserve the static source epoch. A lookup for an epoch represented only by another runtime capture is unavailable.

## Mineflayer and registry identifiers

Mineflayer constructs its registry from `minecraft-data` and the negotiated version. It exposes decoded item names and block objects where its static data can interpret them. NeoForge item/block registries and opaque custom payloads are not exposed as authoritative item/block/state mappings by the existing bot API. This integration therefore preserves raw `item.type`, `block.type` and `block.stateId` values and asks the RegistryService for a namespaced key. It does not infer a key from the string `unknown`, `undefined`, or a packet list ordinal.

An item numeric ID is an item registry ID. A block type ID identifies a block entry. A block state ID identifies a particular state; several state IDs can map to one namespaced block key, and state properties may further distinguish those states. Do not compare these ID domains interchangeably.

Inventory component data is included only when JSON serialization succeeds and remains under the 8 KiB per-item bound. The raw numeric ID observed in Mineflayer is separate from a `staticCandidate` ID from `minecraft-data`. An item name or block name derived from static data is marked `version-static-candidate`; it is not proof of a runtime numeric mapping. Runtime numeric lookups require an entry for the current session epoch. Mineflayer's displayed item/block name is preserved as a legacy field and explicitly marked unreliable when it equals `unknown`. Block state properties are included only from a session-resolved state entry or Mineflayer's state parser for a mapping whose source is identified.

## Block search

`find-blocks` accepts unqualified vanilla names for compatibility and namespaced IDs such as `minecraft:stone` or `processia:crusher`. The tool scans only positions in Mineflayer's already loaded world cache; it never requests or loads chunks. Search distance is capped at 32 blocks, results at 256 and scanned positions at 150,000. Results are distance-sorted. Matches based only on static `minecraft-data` state IDs are reported as `found-static-candidate-unverified`; absence based only on static IDs is `inconclusive`. A conclusive absence requires complete loaded-area coverage and complete runtime block-state registry coverage. A positive match using a mapping observed for the active epoch is reported as runtime-found.

If the block key is unknown, the tool returns a structured unresolved result. If the key is known but no numeric block-state mappings are available, it reports that state IDs are unavailable. A null `blockAt` result counts as an unloaded position: no matches with any unloaded position or a scan limit is inconclusive, not a false absence. Static-only IDs also make a negative result inconclusive. `get-block-info` similarly reports an unloaded chunk separately from an air block and retains raw observed block/state IDs; a static name mapping is shown separately as a candidate.

## Protocol decode diagnostics

The installed runtime versions are `minecraft-protocol` 1.64.0, `minecraft-data` 3.105.0, `prismarine-item` 1.17.0, `prismarine-nbt` 2.7.0 and `protodef` 1.19.0. The observed `PartialReadError` occurs during Protodef decoding, before `prismarine-item` creates Mineflayer item objects. The runtime probe identified clientbound play packet `declare_recipes` (`0x77`), protocol 767, frame length 110934; Protodef attempted to read 110967 bytes from the decoded packet. Its bytes contained a `processia:` namespace marker. `minecraft-data` 1.21.1 describes vanilla recipe types in this packet schema, while Processia registers custom recipe types and stream serializers. This strongly suggests an unsupported custom recipe payload or an interaction with NeoForge's recipe synchronization; the exact serializer/field causing the 33-byte overrun is not proven, and another mod contribution cannot be excluded.

Protodef's `FullPacketParser` catches and logs `PartialReadError`, then drops that packet without emitting it as a protocol/client error. The MCP now observes decoder exceptions at the parser boundary, records only state, packet ID/name, error metadata and time (never packet contents), then rethrows the same error for Protodef's normal handling. `registry-status` exposes these issues. The observed failure is `declare_recipes`, not `window_items` or `set_slot`, so the successfully parsed full inventory packet established a complete empty inventory snapshot in this probe. Inventory becomes `incomplete` if its full or delta slot packet fails; it becomes `complete` again only after a valid full `window_items` packet.

The MCP's crafting tools use Mineflayer's static recipe data and do not consume this server recipe declaration. Custom Processia machine recipes are not thereby supported by P1. Correct decoding of custom `declare_recipes` serializers requires protocol-level support for the live recipe-serializer registry and each serializer's wire codec; no schema override is guessed here, and no dependency was changed.

## MCP tools

### `registry-status`

No arguments. Returns connection status, detected Minecraft and protocol versions, server endpoint identity, active epoch, source list, registries with entry counts and coverage, bridge availability, and current limitations. It is callable while disconnected and does not trigger a reconnect.

### `registry-resolve`

Arguments: `kind` (required), and at least one of `namespacedId` or `numericId`; `registryEpoch` is optional and defaults to the current runtime epoch. The Minecraft version always comes from the active bot. Example request:

```json
{"kind":"item","namespacedId":"minecraft:diamond"}
```

Example outcome shape (a key lookup can identify a version-static candidate; the static numeric ID is not runtime-confirmed):

```json
{"status":"resolved","identityConfidence":"version-static","runtimeNumericIdVerified":false,"entry":{"kind":"item","namespacedId":"minecraft:diamond","numericId":805},"provenance":{"source":"minecraft-data","minecraftVersion":"1.21.1","registryEpoch":"minecraft-data:1.21.1"}}
```

An unavailable Processia mapping is returned as `unresolved` with a reason; synthetic test data is never loaded into runtime.

### `registry-inspect`

Optional filters: `kind`, `source`, `offset` (default 0), `limit` (default 50, maximum 200). Returns a bounded page with total count, per-snapshot coverage and entry provenance. Static entries and current-session runtime entries are shown separately by their source and epoch.

Existing `list-inventory` and `get-block-info` keep their human-readable leading text and append JSON details for raw IDs, resolution status, key and provenance. `find-blocks` retains the prior human summary for matches and appends bounded search details. Unknown modded mappings stay visibly unresolved.

## Other tools and safe behavior

The vanilla place/dig/equip/crafting/furnace/navigation behaviors are not rewritten around guessed mod IDs. `place-block` retains its existing behavior when `itemId` is omitted (use the currently held stack). The optional namespaced `itemId` selects a stack only when an authoritative item-to-numeric-ID mapping exists for the active registry epoch and a matching stack is in inventory. Static `minecraft-data` IDs cannot authorize this runtime selection. If the mapping or stack is unavailable, the tool fails before looking at or changing the world. Successful placement uses the normal Mineflayer placement path, so the server still validates the held item, target and interaction. Unknown reference-block geometry remains unsupported: placement will not guess a shape for a block Mineflayer cannot decode. Digging likewise refuses an unresolved Mineflayer block definition.

The runtime recipe audit is complete for P1: the observed `declare_recipes` decoder failure and its impact are recorded above. This verifies that custom Processia machine recipes are not supported by Mineflayer's static crafting tools; it does not validate or decode the custom recipe serializers. The exact field/codec causing the over-read remains unproven, so no compatibility workaround is claimed.

## P2 bridge contract

`src/bridge/bridge-types.ts` defines a type-only versioned envelope with Minecraft and NeoForge versions, server identity, registry epoch, observation time, per-registry completeness, namespaced entries, numeric IDs, optional state properties and structured errors. A future transport must be loopback-only, authenticated and validate that its server identity, version and epoch match the active bot before calling the runtime snapshot injection point. P1 exposes no bridge socket, endpoint or secret and does not mark an injected source as an authenticated active bridge.

## Runtime validation and troubleshooting

Before runtime validation, check `127.0.0.1:25565` is already listening; this server never starts Minecraft automatically. Use a unique temporary probe username, connect without movement/chat/inventory actions, wait for spawn, record only protocol/version and registry diagnostics, then disconnect. For read-only checks, inspect the bot's current position and search a bounded radius in loaded chunks. Never use placement, dig, chat commands, GUI clicks or inventory transfer as diagnostics.

- `unavailable / registry-not-loaded`: no matching version/registry/epoch snapshot is loaded.
- `unresolved / mapping-not-observed`: the source is partial or the required association was not captured.
- `unresolved / identifier-not-found`: authoritative complete coverage establishes absence.
- `ambiguous`: equally prioritized evidence conflicts; do not choose a candidate automatically.
- Search inconclusive with unloaded positions: increase neither chunk loading nor radius automatically; repeat only in a region already loaded by normal gameplay.
- Bridge unavailable: expected in P1; modded item/block IDs remain unresolved unless a separately verified source is injected.

Static validations are `npm run build`, `npm test` and `npm run lint`. Runtime validation is separate and must be reported as blocked if the development server is not already reachable.

### P1.11 runtime evidence

On the development server at `127.0.0.1:25565`, a temporary probe connected as `P1FinalProbe2` to Minecraft 1.21.1 / protocol 767 and invoked the registered tool handlers. `registry-status`, `registry-resolve` and `registry-inspect` returned structured results. Vanilla key queries returned `version-static` candidates with `runtimeNumericIdVerified: false`; `processia:crusher` and `processia:coal_generator` returned `unresolved/mapping-not-observed`; an unknown numeric ID remained unresolved; an absent registry and foreign epoch returned unavailable. A second connection received a different epoch, and the old epoch was unavailable.

At the current loaded bot position `(-8, -60, 7)`, Mineflayer exposed `air`, type 0, state ID 0. `find-blocks minecraft:air` returned that observed location as `found-static-candidate-unverified`; it did not claim a runtime-confirmed mapping. The full `window_items` packet parsed successfully and `list-inventory` reported an empty inventory with snapshot status `complete`. No non-empty stack was available, so runtime stack-field preservation remains unverified. A reproducible `declare_recipes` decoder error is reported above and is unrelated to the inventory packet.
