# Minecraft RegistryService

`MinecraftRegistryService` is the runtime lookup layer used by inventory, block and registry diagnostic MCP tools. It does not patch Mineflayer's registry. Callers provide immutable-by-copy `RegistrySourceSnapshot` values and query a registry kind within one exact Minecraft version and, when known, one registry epoch.

## Snapshot coverage and source priority

`availableRegistries` means that a source has a snapshot for that registry. It does **not** claim the snapshot contains every entry. `registryCoverage` declares `complete` or `partial` separately for each registry. An omitted declaration is treated as `partial`. The bundled `minecraft-data` snapshot declares its supported static registries complete. Protocol and future bridge adapters must decide coverage from their actual capture semantics; the service assumes neither is complete.

Entries are ranked `neoforge-bridge` > `protocol` > `minecraft-data` > unknown source. A known association from the highest-priority source wins; therefore a known runtime numeric collision overrides a lower-priority vanilla association. Equal-priority conflicting mappings return `ambiguous`.

A complete snapshot describes the whole registry within its declared version and epoch. When it outranks a lower-priority matching association, its missing key/ID proves absence and blocks that fallback. A partial snapshot only overrides associations it actually knows: an unrelated missing vanilla key may fall back to a lower-priority source, while a known key or numeric-ID collision cannot. If the highest-priority loaded coverage is partial and no source can answer, the result is `unresolved/mapping-not-observed`, not `identifier-not-found`; a lower complete dataset cannot prove that a higher-priority partial runtime capture contains no additional mod entries. `minecraft-data` completeness covers its vanilla `minecraft:` namespace only and never proves an arbitrary mod namespace or unknown runtime numeric ID absent. A complete authoritative runtime snapshot that proves absence returns `identifier-not-found`. All resolved results retain the winning entry's provenance and epoch, so a static fallback remains visibly identified as static `minecraft-data` evidence.

## Registry epochs and sessions

An epoch identifies one runtime registry generation/session. Every runtime lookup requires an explicit `registryEpoch`; without it, runtime data is not borrowed across sessions. The MCP `registry-resolve` tool rejects an explicitly supplied foreign session epoch. Namespaced key lookups may return a version-static `minecraft-data` candidate, explicitly labeled `identityConfidence: version-static` and `runtimeNumericIdVerified: false`. A numeric ID queried in a runtime epoch is resolved only by a snapshot for that epoch; the static numeric ID is not treated as proof of the live server's numeric association. An explicit `minecraft-data:<version>` epoch requests the static dataset itself. Runtime snapshots from another epoch are never considered.

`minecraft-data` contributes static item, block, entity and block-state mappings for the requested version only. Block-state IDs are expanded from that dataset's declared `minStateId`/`maxStateId` bounds. It does not provide menu mappings. Registry kinds are open strings so bridge and protocol sources can add registries without changing the service.

## Evidence rules

Every entry carries its kind, exact Minecraft version, namespaced key, optional numeric ID, optional epoch and provenance. A numeric ID is usable only when the source explicitly supplies it and its provenance remains visible. Static IDs are version candidates, not runtime observations. `ProtocolRegistryEntry.entryOrdinal` is deliberately distinct from `numericId`: list position alone is not an ID association. The future bridge entry contract requires a registry epoch. Synthetic Processia fixtures in tests are test data, not runtime evidence.

Outcomes are discriminated: `resolved` includes entry/provenance; `unresolved` means an identifier is absent or a mapping was not observed; `unavailable` means a version or registry snapshot is unavailable; `ambiguous` returns competing winning-priority entries. Namespaced identifiers are required; no default `minecraft:` namespace is invented.

## Extension

Protocol decoders and the future NeoForge bridge should convert only verified data into `RegistryEntry` values and add a version- and epoch-scoped snapshot. They must set `registryCoverage` per registry: mark `complete` only when the capture proves the whole registry, otherwise mark or leave it `partial`. A snapshot epoch, when supplied, must match its entries; provenance source, version and epoch are validated and snapshots are deep-copied both by the constructor and `addSnapshot()`. Do not derive entries from Mineflayer's fallback display names or infer a Processia numeric mapping from a registry-list ordinal. A later integration layer can consume this service without altering the 22 existing vanilla tools.
