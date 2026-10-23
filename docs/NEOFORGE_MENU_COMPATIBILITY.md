# Menu and container compatibility (Minecraft 1.21.1)

This note describes what the MCP fork can establish from the installed protocol definitions and source code. It does not claim a live NeoForge or Processia menu was opened during Mission 27.

## Audited versions and evidence

The installed dependencies are Mineflayer 4.39.0, `minecraft-protocol` 1.68.0, `minecraft-data` 3.117.0, `prismarine-windows` 2.9.0, and `protodef` 1.19.0. The audited Minecraft data is 1.21.1 / protocol 767.

The local `minecraft-data/data/pc/1.21.1/protocol.json` defines the packet shapes below. Mineflayer's installed `lib/plugins/inventory.js` creates its windows through `prismarine-windows`, emits `windowOpen` after receiving initial slot content, applies local click predictions, and updates its inventory model from server packets. Its window type and slot ranges are a client model; they are not a separate GUI rendering observation.

## Protocol 767 window packets

| Direction / packet | Fields observed in the installed schema | Meaning and limits |
| --- | --- | --- |
| Clientbound `open_window` | `windowId: varint`, `inventoryType: varint`, `windowTitle: anonymousNbt` | `windowId` identifies this open container. `inventoryType` is a numeric menu-registry ID; it is not itself a namespaced ID. The title is display data, not a registry key. The packet has no slot count or slot-role table. |
| Clientbound `open_horse_window` | `windowId: ContainerID`, `nbSlots: varint`, `entityId: i32` | Identifies a horse-entity window and its declared container-slot count. It does not describe the semantic role of each slot. |
| Clientbound `window_items` | `windowId`, `stateId: varint`, `items: array<Slot>`, `carriedItem: Slot` | Full content snapshot, including cursor. It is complete for a modeled window only when its item count matches that window's slots. |
| Clientbound `set_slot` | `windowId`, `stateId: varint`, `slot: i16`, `item: Slot` | One slot update. Special IDs `windowId=-1, slot=-1` address the carried item in applicable cases. |
| Clientbound `craft_progress_bar` | `windowId`, `property: i16`, `value: i16` | Raw synchronized menu property. The packet does not define the meaning of a property number for every menu. |
| Clientbound `close_window` | `windowId` | Server-side close notification. Mineflayer's own `windowClose` event is still a client-library lifecycle event. |
| Serverbound `window_click` | `windowId`, `stateId`, `slot`, `mouseButton`, `mode`, `changedSlots`, `cursorItem` | Normal server-validated slot operation. It has no click-correlation ID that proves a later matching state change was caused by that click. |
| Serverbound `close_window` | `windowId` | Close request. A local Mineflayer window disappearing is not a distinct server acknowledgement. |
| Serverbound `enchant_item` | `windowId`, `enchantment: varint` | The installed schema and Mineflayer enchantment plugin use this for the enchantment-table choice. This fork does not expose a generic menu-button tool. |

There is no clientbound packet named `window_property` in the installed protocol 767 packet map; the schema calls the raw menu property update `craft_progress_bar`. Do not infer semantics from the packet name.

`stateId` is a container synchronization counter. It is not a window generation, registry epoch, click ID, or proof of action causality. The MCP separately tracks a local per-bot window generation whenever an open packet is observed.

## Vanilla menu definitions

`prismarine-windows` contains version-specific protocol definitions for `minecraft:generic_9x1` through `generic_9x6`, `generic_3x3`, `crafter_3x3`, anvil, beacon, blast furnace, brewing stand, crafting, enchantment, furnace, grindstone, hopper, lectern, loom, merchant, shulker box, smithing, smoker, cartography, and stonecutter. The player inventory model is separate.

The MCP accepts a vanilla layout only if the captured numeric `inventoryType` matches the installed 1.21.1 definition for Mineflayer's canonical vanilla type and the modeled slot count and player-inventory range match that definition. In that case it labels the identity source as the version-specific `prismarine-windows` definition, not as a runtime bridge observation. Slot roles such as machine input/output are not inferred from a generic menu area; only the player inventory/hotbar ranges and the definition's result slot are labeled.

## Processia menu identities and layouts from source

Read-only inspection of Processia's `registry/ModMenus.java`, `machine/MachineLayout.java`, and `machine/WorkshopMenu.java` finds 22 `processia:*` menu registrations. The menu registrations all create `WorkshopMenu`; the menu class first adds the machine's physical slots, then 27 player-inventory slots and 9 hotbar slots. The table below transcribes the current source contracts. The MCP uses this schema only after the numeric protocol menu ID resolves to the same namespaced ID through an authenticated bridge snapshot for the active server/session, and only when a complete content packet and matching modeled slot range are present.

| Menu ID | Machine slots | Inputs | Outputs |
| --- | ---: | --- | --- |
| `processia:coal_generator` | 1 | 0 | — |
| `processia:crusher` | 2 | 0 | 1 |
| `processia:press` | 3 | 0, 2 | 1 |
| `processia:wiremill` | 2 | 0 | 1 |
| `processia:furnace_industrial` | 2 | 0 | 1 |
| `processia:extruder` | 2 | 0 | 1 |
| `processia:alloy_smelter` | 4 | 0, 1, 2 | 3 |
| `processia:kiln` | 3 | 0, 1 | 2 |
| `processia:washer` | 3 | 0 | 1, 2 |
| `processia:basic_battery` | 0 | — | — |
| `processia:centrifuge` | 4 | 0 | 1, 2, 3 |
| `processia:slicer` | 5 | 0 | 1, 2, 3, 4 |
| `processia:water_pump` | 0 | — | — |
| `processia:saline_basin` | 0 | — | — |
| `processia:electrolyzer` | 2 | 0 | 1 |
| `processia:chemical_reactor` | 2 | 0 | 1 |
| `processia:mixer` | 3 | 0, 1 | 2 |
| `processia:biofermenter` | 3 | 0, 1 | 2 |
| `processia:canner` | 3 | 0, 1 | 2 |
| `processia:gas_separator` | 0 | — | — |
| `processia:air_intake` | 0 | — | — |
| `processia:regenerator` | 3 | 0, 1 | 2 |

For a menu with `N` machine slots, the current source places player inventory at `[N, N+27)` and hotbar at `[N+27, N+36)`. This contract is explicit source-derived data, not a conclusion drawn from the machine name. It is maintained in `src/services/menu-layout-registry.ts`; a mismatched slot count or model range leaves layout unknown.

`WorkshopMenu.DATA_COUNT` is 17. The source accessors map properties 0–16 to energy low/high, capacity low/high, progress, duration, burn time, redstone mode, input/output rates, status, energy per tick, fluid amount, and four gas amounts. The MCP retains the signed raw `i16` value and adds these labels only for an authenticated Processia menu identity. It does not silently combine or reinterpret the halves.

`craft_progress_bar` has no `stateId`; these fields are exposed as the latest values observed for the tracked window generation, with no click/action causal claim. A new observed open starts an empty property map.

The source implements button ID 0 as a redstone-mode cycle for every `WorkshopMenu` kind except `basic_battery`. This fork's `click-window-slot` is a slot operation and does not send that menu-button packet. The observation reports this control as not executable through the Mineflayer window tools. The separate GUI harness has a real-client widget path, but it is not a Mineflayer window and its availability is governed by its own authenticated GUI configuration.

## Mineflayer limitations and fail-closed behavior

Mineflayer calls `prismarine-windows.createWindow(packet.windowId, packet.inventoryType, packet.windowTitle, packet.slotCount)`. For protocol 767, `open_window` supplies no `slotCount`. `prismarine-windows` has no fallback window for an unknown numeric type when slot count is absent, so the installed code can return `null`; Mineflayer's `prepareWindow` then expects a window object. This is an upstream structural limitation for an unrecognized modded menu. No local handler can recover an actual slot layout or inspect a window object that Mineflayer failed to construct. Mission 27 does not modify `node_modules` or replace Mineflayer's inventory plugin; an unknown modded-menu construction path therefore remains unvalidated and may fail before MCP inspection tools run.

If a window object is available, `inspect-open-window` reports the raw numeric type, Mineflayer's type hint, local generation, state ID, content completeness, slot count semantics, synced properties, mapping provenance, and whether the layout is known. Unresolved IDs remain numeric. A bridge mapping is accepted only when its authenticated session, server identity, endpoint, registry source epoch, and runtime epoch match the current context. A resolved menu identity alone does not establish a slot layout.

`click-window-slot` requires an active, completely synchronized window and current registry epoch. The optional `windowGeneration` is checked when provided and required after the first observed window generation, so a reused numeric window ID cannot silently target a replacement menu. Left/right clicks address only the supplied protocol slot index when layout is unknown. Shift-click is refused without a known layout because Mineflayer predicts quick-move ranges from its local slot model. Invalid or out-of-range slots are refused. The MCP never retries an uncertain click.

After an uncertain action, a duplicate full snapshot with the same `stateId`, a regressing snapshot, or a partial snapshot cannot release the recovery lock. A later complete full snapshot with a strictly greater `stateId` allows a fresh explicit operation. That snapshot is synchronization evidence only; it does not prove the prior click caused the observed state. Responses carry `actionCausality: not-provable-from-container-protocol` for this reason.

`interact-block` waits for Mineflayer's `windowOpen` lifecycle after the server sends and initializes a window; it does not prove a rendered GUI. `close-open-window` reports its close request and local client observation separately from server confirmation. The GUI harness is a separate instrumented graphical client that can inspect widgets and capture the framebuffer; its screenshot must not be replaced by a Mineflayer JSON snapshot.

## MCP output example

An unknown numeric menu remains inspectable without invented identity or ranges:

```json
{
  "id": 3,
  "generation": 2,
  "protocolWindowKind": "container",
  "menuTypeId": 143,
  "menuIdentity": { "status": "unresolved", "reason": "menu-type-not-observed-or-not-mapped", "rawNumericTypeId": 143 },
  "stateId": 12,
  "synchronization": "complete-window-items-observed",
  "slotCount": 7,
  "layout": { "status": "unknown", "reason": "no-matching-version-specific-menu-and-slot-definition" }
}
```

No live Minecraft or bridge connection was made for this documentation or its tests. A real Processia-menu open, slot synchronization, menu-button behavior, and Mineflayer handling of an unknown custom menu still require validation in an authorized isolated runtime.

## Mission 28: generic layout providers and raw-only observation

Menu identity and slot layout are now separate services. `MenuLayoutRegistry` is independent of Processia. Versioned vanilla contracts and explicitly injected mod contracts can be composed; conflicting contracts fail closed. The Processia contracts live in `processia-menu-layout-provider.ts` and are passed as an optional provider from the application composition root. See [GENERIC_MODDED_MENU_ARCHITECTURE.md](GENERIC_MODDED_MENU_ARCHITECTURE.md) for the provider API and validation rules.

When Mineflayer does not construct a `Window`, the raw observer may expose decoded `open_window` and `window_items` metadata in `inspect-open-window`. It preserves the numeric type/item IDs and bounded slot counts, binds the observation to its open-time session/epoch context, and explicitly reports `interactionsAllowed: false`. It does not synthesize a Mineflayer model. Undecodable packets remain outside this recovery path. This is a new offline-tested code path, not a live runtime result.
