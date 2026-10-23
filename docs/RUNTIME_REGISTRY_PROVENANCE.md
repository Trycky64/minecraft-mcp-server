# Runtime Registry Provenance

This document describes how the MCP process associates registry data with the active Minecraft and bridge sessions. A raw numeric ID is meaningful only within its source and generation.

## Sources and authority

| Source | Authority | Lifetime | What it proves |
| --- | --- | --- | --- |
| `minecraft-data` | `static-baseline` | Exact Minecraft data version | Version-static vanilla names, IDs, and state bounds. It does not prove a modded server's numeric mappings. |
| `protocol` | `protocol-observed` when explicitly supplied | Mineflayer connection/registry epoch | Only an association the protocol decoder actually observed and identified. Ordinals and opaque payload positions are not mappings. |
| `neoforge-bridge` | `authenticated-runtime` | Authenticated bridge session and Java `sourceRegistryEpoch`, linked to one MCP runtime | Authoritative entries and the stated complete/partial registry coverage from that bridge generation. |

An endpoint is not a server identity. Before a bridge handshake, Mineflayer context reports `serverIdentity: null`; after an authenticated handshake, the bridge identity is available separately from the endpoint.

## Epoch fields

- `registryEpoch` is the registry generation used by the active MCP resolver. In a Mineflayer session it is a generated per-connection registry token; in bridge-only mode it is independently generated for that authenticated context.
- `mineflayerSessionId` identifies the local Mineflayer connection context. `mineflayerRegistryEpoch` records its registry token when Mineflayer is active.
- `sourceRegistryEpoch` is reported by the Java bridge. It identifies the Java registry generation and is never substituted for the MCP epoch.
- `bridgeSessionId` identifies the authenticated bridge handshake.
- `runtimeEpoch` identifies the owning MCP runtime context. It is distinct from all registry epochs above.

`RegistryProvenance` and `RegistrySourceSnapshot` carry these values where known, plus the validated Minecraft endpoint, server identity, Minecraft and NeoForge versions, observation time, and per-registry coverage. Missing values remain absent or `null`; they are not synthesized from another field.

## Snapshot publication and invalidation

Bridge refresh builds a candidate snapshot in local memory. It checks every page's kind, offset, limit, size, total, completeness, endpoint, versions, server identity, session ID and Java registry epoch. Duplicate keys, duplicate numeric IDs within a registry, duplicate rows, missing rows, inconsistent totals and safety-limit violations fail closed. A candidate is injected only after every page has completed and the runtime/session linkage is rechecked.

Concurrent refreshes use latest-started-wins. An older read that finishes after a newer refresh is rejected and cannot replace the newer snapshot. Closing or revoking the bridge invalidates in-flight operations. Reconnection, version or endpoint change creates a new resolver context and revokes the previous resolver's runtime mappings.

The resolver retains static `minecraft-data` as static reference data after runtime revocation. Runtime snapshots from other epochs are removed or hidden. A lookup using an old runtime epoch returns `unavailable` with `reason: stale-context`; an unknown mapping in the current context remains `unresolved` with `reason: mapping-not-observed`.

Partial coverage can resolve entries present in the snapshot but cannot prove that an absent key or numeric ID does not exist. Complete coverage can establish absence only for that source generation and registry.

## Raw IDs and conflicts

An inventory stack's `type` is preserved as its raw numeric ID. It is resolved only against runtime data linked to the active registry epoch. An unknown raw ID, including historical ID `1373`, remains unresolved with no namespaced identity or provenance until an authoritative mapping is supplied. Static vanilla candidates are reported separately and are not substituted for runtime IDs.

The same raw ID may map to different namespaced entries in different registry generations. Such data cannot be combined: the active resolver only accepts its current epoch, and a resolver invalidated by reconnect refuses runtime lookups as stale. A collision inside one bridge registry snapshot fails closed.

## MCP visibility

`registry-status`, `registry-resolve`, and `registry-inspect` expose authority, coverage, source/runtime epochs and relevant session linkage. `registry-resolve` keeps the established discriminated status values; `unavailable: stale-context` distinguishes an expired context from a current registry that did not observe a mapping. The added provenance fields and reason are additive; existing tool names and required input fields are unchanged.

Opaque session IDs are diagnostic correlation values, not credentials. Secrets are never included in provenance.

## Offline test limits

Mission 23 tests use deterministic stubs and synthetic snapshots only. They prove local invalidation and publication rules but do not prove that a live NeoForge bridge emits accurate registry contents or that a particular server identity is correct. Runtime verification requires a separately authorized server and is outside this mission. No Minecraft server was contacted here.
