# Inventory and action confirmation

## Scope and runtime facts

This document describes the local Mineflayer 4.39.0 / minecraft-protocol 1.68.0 integration for Minecraft 1.21.1 (protocol 767). Mission 26 tests use offline emitters and fixtures. No real Minecraft server or bridge was contacted, so these tests do not prove a live item transfer.

For protocol 767, the client sends `window_click` with `windowId`, `stateId`, slot, button, mode, changed slots, and cursor item. The server sends `set_slot` and/or `window_items`; both carry a `stateId`. The full contents packet `window_items` carries the whole container slots and cursor. The older transaction confirmation packet is not present in this protocol schema.

Mineflayer's `bot.clickWindow()` may apply a local `Window.acceptClick()` prediction before sending the packet. Its promise does not provide an independent server acknowledgement for this protocol. Mineflayer updates its model from inbound `set_slot` and `window_items` packets. `windowOpen` is emitted only after Mineflayer has a server-created window and its initial contents. Locally calling `closeWindow()` clears `currentWindow` after sending `close_window`; that local change is not a server close acknowledgement.

`src/services/protocol-decode-monitor.ts` marks a player inventory complete only after `window_items` for window 0. A decode error in `window_items` or `set_slot` marks it incomplete. A container's full snapshot does not establish completeness of the player's inventory. `list-inventory` exposes occupied stacks, all raw slots, selected hotbar index, cursor item, active window ID, registry provenance, and decode status. An unverified or incomplete snapshot is not described as empty.

## Confirmation states

| State | Evidence |
| --- | --- |
| `requested` | MCP handler passed validation and began an operation. |
| `sent` | Mineflayer's packet-writing method returned its operation promise. This does not prove server acceptance. |
| `client-observed` | Mineflayer's local window/inventory model changed. The model may be optimistic. |
| `server-confirmed` | A newer inbound update with a known prior `stateId` matches all locally changed slots/cursor, or a newer full `window_items` snapshot matches the entire expected window. This confirms the reported state, not the server's internal reason for it or that this click caused it. |
| `server-state-conflict` | A newer inbound server update disagrees with Mineflayer's expected result. It is not labeled a rejection. |
| `uncertain` | No sufficient matching server state arrived before timeout, or context was invalidated. The caller must re-observe and must not retry automatically. |

There is no explicit accepted/rejected click acknowledgement or click-correlation ID in protocol 767. Therefore a no-op click, a click with no resulting state change, or a response without a known baseline state ID stays `uncertain`; elapsed time is never proof. Every response sets `actionCausality` to `not-provable-from-container-protocol`, including a matching state result. The current click response includes operation generation, window ID, window generation, raw menu type when observed, registry epoch, baseline/observed state IDs, observed packet names, local changed slots, server confirmation, and recovery requirement. It does not expose a session secret or authenticated session identifier.

## Window, session, and concurrency binding

The tracker is held in a `WeakMap` keyed by the exact Mineflayer `Bot` object. An action is bound to that bot object, the exact active `Window` object and its numeric ID, the registry epoch supplied to the MCP request, a monotonically increasing per-tracker operation generation, and the last observed window `stateId`. A separate local window generation is created from each observed `open_window` or `open_horse_window` packet. It is not a registry epoch.

Only one click operation may be active per bot. A timeout or contradictory state leaves that exact window object blocked until a complete, correctly sized `window_items` snapshot with a strictly greater `stateId` is observed. A duplicate snapshot at the same state, a regressing state, an incomplete snapshot, or a snapshot for another window does not release the lock. This permits a new explicit operation after a fresh synchronized view; it does not confirm the timed-out operation or establish packet causality. A closed window invalidates its in-flight operation. A replacement window object, even if it reuses the numeric window ID, cannot receive the older operation's confirmation. Protocol client end, bot end, and respawn invalidate active operations and the cached stateId baseline. A reconnect creates a new bot object and a new tracker; old observations are not reused.

No click is retried. After a full authoritative snapshot, a later explicit MCP request may proceed. The old result remains uncertain if it timed out; the later snapshot is reconciliation evidence, not retroactive proof that the original operation completed as intended.

## Tool behavior and limits

- `inspect-open-window` reads Mineflayer's current model and the tracked protocol lifecycle. It exposes numeric menu type, mapping provenance, window generation, `stateId`, content completeness, raw synchronized properties, and layout status. Slot IDs and counts remain raw; names are not authoritative unless separately resolved through the active registry provenance.
- `click-window-slot` requires an initial complete server content snapshot. Left/right actions can target only the explicitly supplied slot index when layout is unknown; shift-click is refused until a version-specific vanilla definition or authenticated Processia menu contract establishes the layout. A window generation is required after a numeric window ID has been reused.
- Menu identity and layout are separate. A current authenticated bridge mapping may identify a Processia menu, but the slot contract is accepted only when its explicit source-derived schema and observed/model slot bounds match. Unknown menu IDs stay numeric and unknown layouts do not inherit Mineflayer's synthetic inventory range.
- `interact-block` reports a menu only when Mineflayer observes a server-created window after normal use-on-block interaction. No menu after timeout means only that no window was observed in time.
- `close-open-window` reports `close-request-sent` and whether Mineflayer cleared its local window. It does not claim server confirmation because the clientbound close packet may not be sent for a client-initiated close.
- `list-inventory` does not resolve unknown item IDs to air or guess modded identities. In particular raw item ID 1373 remains unresolved absent an authoritative current-session mapping.
- `equip-item` reports local observation and never claims server confirmation. It is not correlated to a complete inbound slot transaction by this tracker.
- `craft-item` retains its existing bounded-operation lock and reports client-side completion only. A timeout/error after dispatch is uncertain and does not trigger an alternate recipe or retry.
- `smelt-item` reports an output observed through Mineflayer as client-side evidence. A timeout is uncertain; it does not authorize resubmitting input or fuel.
- `dig-block` and `place-block` report Mineflayer cache observations separately from server confirmation. A changed block cache is not independently verified by the bridge.

Direct GUI harness operations are separate from Mineflayer window clicks; they are not upgraded by this tracker. Capabilities such as shift-click routing are confirmed only if all expected changed slots/cursor are observed in newer inbound state packets.

## Offline validation

AVA tests use event emitters and controlled updates to cover matching and stale `stateId`s, optimistic local mutations, contradictory updates, timeouts, window close/replacement, a fresh full-snapshot recovery, independent bot sessions, concurrent clicks, and unknown numeric item IDs. These validate the local model and response semantics only. No test sends a packet to a live server.

## Future survival validation

On a specifically authorized isolated world, capture before/after inventory and container snapshots for a normal click, shift-click, cursor transfer, and a rejected/ineffective click. Compare the MCP result with server-originated `set_slot`/`window_items` packets and the bridge's server-side inventory inspection when available. Keep the world and operation non-destructive. Do not treat an item name alone as proof, and do not repeat a timed-out transfer until a fresh authoritative snapshot has been read.

## Remaining limitations

- No explicit protocol acknowledgement identifies which individual click caused a given slot update; `stateId` ordering plus full expected-state matching is the strongest evidence available here.
- Full click correlation is implemented for `click-window-slot`, not for every multi-click sequence hidden inside `equip-item`, crafting, furnace operations, placement, or the GUI harness.
- A full snapshot that arrives after timeout can reconcile current state but cannot prove whether a specific timed-out request caused it.
- Runtime behavior against a NeoForge server has not been tested in Mission 26 by design.

## Raw menu observation (Mission 28)

`InventoryActionConfirmationTracker` also keeps an independent, bounded view of decoded menu packets. It captures the raw numeric menu/item IDs, packet slot count, stack counts, component type IDs/counts, carried item, state ID, synchronized integer properties, and per-Bot window generation. Component payloads are omitted. The observation is bound to the server/version/registry/runtime/bridge-session context present at `open_window`; if the active context later differs, the menu resolver will not reuse that modded mapping.

This view exists to avoid losing decoded observations when Mineflayer cannot build a `Window`; it never creates a `Window`, cannot authorize clicks, and reports no action confirmation. Full `window_items` means all slot values in that packet were observed, not that an unknown menu's expected total size or slot roles are known. `inspect-open-window` exposes this as `raw-only-window-observed`. A malformed/oversized snapshot remains non-inspectable as slot content.
