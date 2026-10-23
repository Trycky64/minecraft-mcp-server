# GUI client integration (P3)

> This is the P3 design/configuration note. Its sample ports are historical test values. Current GUI runtime evidence and the no-teleport framing rule are in [MISSION7_FINAL_REPORT.md](MISSION7_FINAL_REPORT.md); select only the isolated ports allocated for a test run.

The MCP GUI layer controls a real NeoForge client over a separate, authenticated loopback protocol. It is distinct from Mineflayer: Mineflayer remains the vanilla networking bot, while the GUI harness observes the client screen/menu and captures the actual client framebuffer. No HTML/JSON drawing is used as a screenshot substitute.

## Configuration

Set environment variables in the MCP process (do not edit personal Claude/Codex MCP configuration as part of this implementation):

```text
PROCESSIA_GUI_ENABLED=true
PROCESSIA_GUI_URL=http://127.0.0.1:25578
PROCESSIA_GUI_SECRET=<same local random secret as the GUI client; at least 32 characters>
PROCESSIA_GUI_SERVER_IDENTITY=processia-p3-isolated
PROCESSIA_GUI_MINECRAFT_ENDPOINT=127.0.0.1:25566
PROCESSIA_GUI_NEOFORGE_VERSION=21.1.259
PROCESSIA_GUI_MINECRAFT_VERSION=1.21.1
PROCESSIA_GUI_PROJECT_DIR=C:\Users\qperr\Processia
PROCESSIA_GUI_MODE=READ_ONLY
PROCESSIA_GUI_ALLOWED_DIMENSIONS=minecraft:overworld
PROCESSIA_GUI_ALLOWED_MACHINES=processia:coal_generator,processia:crusher,processia:press,processia:wiremill,processia:basic_battery
PROCESSIA_GUI_ALLOWED_BLOCKS=minecraft:chest,minecraft:barrel,minecraft:furnace,minecraft:blast_furnace,minecraft:smoker,minecraft:crafting_table,...
PROCESSIA_GUI_TIMEOUT_MS=5000
PROCESSIA_GUI_ARTIFACT_DIR=C:\Users\qperr\processia-mcp-server\artifacts\p3
```

`PROCESSIA_GUI_MODE=TEST_MUTATION` additionally requires `PROCESSIA_GUI_TEST_WORLD_ACK=true`. The client launch target must be loopback and must not use port 25565. `gui-start-client` additionally requires an authenticated P2 bridge session for the exact same server identity/endpoint; it copies the Java registry epoch into the client process. If the GUI response reports a different Java epoch, identity, endpoint or game version, the tool fails closed and discards the GUI session. The GUI epoch is kept separate from both the Mineflayer epoch and Java registry epoch.

The server harness refuses weak secrets and public bind addresses. Do not put the secret in source, command-line arguments, screenshots, `.mcp.json`, or this document. Gradle stdout/stderr are retained only in the per-launch temporary game directory, and the TypeScript client rejects non-loopback URLs and validates bounded responses. GUI tool errors are structured and secrets are never returned from `gui-status`.

## Tools

| Tool | Purpose |
| --- | --- |
| `gui-status` | Check configuration, process, authenticated GUI session and current P2 bridge linkage. |
| `gui-start-client` / `gui-stop-client` | Launch/stop `runClient` in a per-launch temporary game directory, targeting only the configured test server. Start returns stdout/stderr log paths for troubleshooting. |
| `gui-inspect-screen` | Read live screen/menu IDs, menu slots/stacks, widgets, coordinates, cursor and resolution. |
| `gui-open-machine` | Open an allowlisted Processia machine through actual client block interaction. Requires `TEST_MUTATION`. |
| `gui-open-block` | Open an explicitly allowlisted vanilla container or Processia menu through actual client interaction. Requires `TEST_MUTATION`. |
| `gui-click-slot` | Left/right/shift click a real menu slot, preserving server validation. Requires `TEST_MUTATION`. |
| `gui-move-items` | Move an exact stack count using ordinary pickup clicks and normal server slot validation. Requires `TEST_MUTATION`. |
| `gui-click-widget` / `gui-close-screen` | Interact with a live logical widget or close the screen. Requires `TEST_MUTATION`. |
| `gui-hover-slot` / `gui-hover-widget` | Move the real cursor over a slot/widget to show its actual client tooltip. |
| `gui-screenshot` | Capture/verify/retain a framebuffer PNG and return its path, SHA-256 and display metadata. |
| `gui-capture-block` | Aim at an allowlisted Processia block, verify the client raycast against P2, and retain a world screenshot. |
| `gui-set-display` | Change resolution and GUI scale in the isolated client game directory. |
| `gui-wait-for` | Bounded wait for `client_ready` (authenticated player, world, player chunk, loading screen ended, usable framebuffer), `interaction_ready` (client ready and no screen), an active/closed screen, menu key or slot item/count. |
| `gui-run-e2e` | Compare a live P2 machine read with a real GUI/menu; optional item transfer and expected-output wait. |

All bridge calls require an authenticated P2 session matching identity and endpoint. Every GUI session has a lease, a separate graph epoch and a server epoch. Re-login rotates the graph epoch; a server restart invalidates the P2 epoch; both conditions invalidate the MCP binding. A single GUI lease and one in-flight harness request serialize Codex/Claude actions so two MCP clients cannot interleave clicks on one shared GUI. The lease is owned by one MCP process ID: that owner may renew it, but another owner is refused with 423 until the first lease is explicitly released or expires.

## Running a test

1. Start a disposable NeoForge server on a port other than 25565 with a new temporary world and the P2 bridge enabled. Do not use the user's existing world.
2. Connect the MCP bridge and call `bridge-refresh-registries` to establish the authenticated server epoch.
3. Set the GUI variables in the MCP process, including the same temporary server identity/endpoint and secret. For client launch, set `PROCESSIA_GUI_PROJECT_DIR` to the Processia checkout.
4. Call `gui-start-client`; poll `gui-status` until its authenticated session is linked to the P2 epoch.
5. Use `gui-inspect-screen`, `gui-open-machine`, `gui-click-slot`, `gui-click-widget`, `gui-wait-for` and `gui-screenshot`. Mutating calls are refused unless the test-world acknowledgement and allowlists are set.
6. To transfer an existing player stack, supply its real player menu slot, machine input slot and exact count to `gui-run-e2e`; no item is synthesized or transferred through a direct server-side inventory write. To prove recipe completion, also provide the expected output ID/slot and ensure the isolated world already has the required energy/fuel setup. The report returns `PARTIAL` if only a GUI smoke check was run.
7. Retain JSON/PNG artifacts under the configured artifact directory. Review screenshots manually for pixel-level rendering; menu metadata and PNG/hash validation do not prove visual correctness by themselves.
8. Call `gui-stop-client`. It requests normal game shutdown, waits, then terminates only the process tree it launched if needed and removes only that generated temporary game directory.

The harness does not expose arbitrary Minecraft commands, server fixtures, chunk loading, or P2 world mutation. A test world must be prepared independently using a bounded and reproducible test-only setup. Vanilla Mineflayer tools remain available and do not require the GUI harness. The development client connects via the normal `ConnectScreen` API after startup; it does not rely on `runClient --server/--port` flags. `gui-wait-for` polls snapshots from the HTTP worker and dispatches brief reads to the client thread, so waiting does not freeze the screen/network event loop.

## Known limits

- The shared Processia screen exposes its energy/progress/burn/redstone tooltip values to diagnostics; generic vanilla tooltip extraction is not available yet. Screenshots capture actual rendered tooltips when visible.
- `gui-run-e2e` supports menu smoke assertions and optional real player-stack shift-click/output checks. It does not create fixtures or guarantee a powered network; missing prerequisites are a real timeout/failure.
- Deterministic pixel-diff baselines and automatic texture/font error classification are not implemented. Human visual review is required.
- This code does not claim runtime GUI success until a client and isolated server are actually launched and evidence is retained.
