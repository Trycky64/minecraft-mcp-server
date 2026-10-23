# Minecraft MCP Server

> **Mission 12 candidate (2026-10-16):** The local, unpublished MCP package is now `2.1.0-beta.1`; the standalone bridge remains `0.1.0`. Windows and Linux x64 builds, lint and 231 tests pass. The GUI remains experimental and the six moderate production npm audit findings await an explicit risk decision. See [Mission 12 release report](docs/MISSION12_MCP_RELEASE_REPORT.md). Earlier mission summaries below are historical snapshots.

> **Mission 11 (2026-10-16):** The isolated Windows rerun validated the corrected Crusher GUI E2E path, a real Raw Iron → Iron Dust recipe (output increased from 2 to 3), vanilla adjacent and two distant placements, and timeout without late placement. Windows and Linux x64 each pass 231 MCP tests. The source version is still **2.0.4**; the GUI remains experimental, six moderate production advisories remain, and native ARM64 is untested. See [Mission 11 report](docs/MISSION11_FINAL_REPORT.md) for evidence and the beta decision.

> **Mission 10 update (2026-10-14):** Four isolated server profiles were replayed through MCP stdio; Windows and Linux x64 builds and 230 TypeScript tests pass. The Processia GUI client opened a real Crusher menu and captured screenshots with music at 0%, while the corrected E2E runner still awaits a graphical rerun. See [Mission 10 report](docs/MISSION10_FINAL_REPORT.md). Earlier Mission 8/9 reports below are historical snapshots.

> **Current validation snapshot (2026-10-14):** Minecraft Java 1.21.1 / NeoForge 21.1.259, Windows 11, Node.js 26.8.1. Release status and security findings are in [Release Readiness](docs/RELEASE_READINESS.md), [Mission 8](docs/MISSION8_FINAL_REPORT.md) and [Mission 9](docs/MISSION9_FINAL_REPORT.md). See the [installation guide](docs/INSTALLATION.md) before configuring a bridge.

For NeoForge servers that reject vanilla Mineflayer clients, see [bridge-only mode](docs/BRIDGE_ONLY_MODE.md). The authenticated generic NeoForge bridge contract is documented in [the bridge guide](docs/universal-neoforge-bridge.md).

The GUI harness remains experimental and is not required for vanilla or bridge-only use. Current release limitations and locally prepared, unpublished artifacts are recorded in [Release Readiness](docs/RELEASE_READINESS.md).

<a href="https://github.com/yuniko-software/minecraft-mcp-server/actions">
  <img alt="CI" src="https://github.com/yuniko-software/minecraft-mcp-server/actions/workflows/build.yml/badge.svg">
</a>
<a href="https://github.com/yuniko-software">
  <img alt="Contribution Welcome" src="https://img.shields.io/badge/Contribution-Welcome-blue">
</a>
<a href="https://github.com/yuniko-software/minecraft-mcp-server/releases/latest">
  <img alt="Latest Release" src="https://img.shields.io/github/v/release/yuniko-software/minecraft-mcp-server?label=Latest%20Release">
</a>

<img width="2063" height="757" alt="image" src="https://github.com/user-attachments/assets/3f0f0438-f079-4226-90bd-87b9e1311d19" />

___

> [!IMPORTANT]
> This fork supports the vanilla Mineflayer path without mods and adds an optional, standalone NeoForge diagnostic bridge. The active Minecraft version is negotiated at runtime. Modded registries and capabilities are only reported when an authenticated bridge supplies them; Processia-specific machine details remain optional. See [the universalization report](docs/UNIVERSALIZATION_REPORT.md) and [the generic bridge guide](docs/universal-neoforge-bridge.md).

https://github.com/user-attachments/assets/6f17f329-3991-4bc7-badd-7cde9aacb92f

A Minecraft bot powered by large language models and [Mineflayer API](https://github.com/PrismarineJS/mineflayer). This bot uses the [Model Context Protocol](https://github.com/modelcontextprotocol) (MCP) to enable Claude and other supported models to control a Minecraft character.

<a href="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server/badge" alt="mcp-minecraft MCP server" />
</a>

## Prerequisites

- Git
- Node.js (>= 20.10.0)
- A running Minecraft Java Edition server. The current fork runtime was validated with Minecraft 1.21.1; see [the compatibility matrix](docs/RELEASE_READINESS.md).
- An MCP-compatible client. Claude Desktop will be used as an example, but other MCP clients are also supported

## Vanilla and NeoForge support

The existing Mineflayer tools work without NeoForge or Processia. An optional companion mod in the sibling repository path `../Processia/neoforge-bridge` exposes bounded registry and block/capability reads on loopback for NeoForge servers. It is a separate mod and does not reference Processia classes. The current Processia mod bridge remains a legacy optional adapter.

The generic bridge is disabled by default. Enabling it requires `MINECRAFT_MCP_BRIDGE_ENABLED=true` and `MINECRAFT_MCP_ENVIRONMENT=development` in the game server environment. It writes an ephemeral owner-only credential file in the server `config` directory. Configure the MCP process with `MINECRAFT_MCP_BRIDGE_ENABLED=true` and `MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE` pointing to that file. The default bridge listener is `127.0.0.1:25577`; it must differ from the Minecraft port. Never copy the credential into logs or source control.

The bridge reports registry-local numeric IDs scoped to a server registry generation. They are not stable between server restarts or registry reloads. Arbitrary mod-private BlockEntity fields and custom capability APIs are not reflected. Capability inspection only reads standard NeoForge ItemHandler, EnergyStorage and FluidHandler interfaces and refuses unloaded chunks. See the [security and endpoint contract](docs/universal-neoforge-bridge.md).

## Getting started

This bot is designed to be used with Claude Desktop through the Model Context Protocol (MCP).

### Run Minecraft

Create a singleplayer world and open it to LAN (`ESC -> Open to LAN`). Bot will try to connect using port `25565` and hostname `localhost`. These parameters could be configured in `claude_desktop_config.json` on a next step. 

### MCP Configuration

Make sure that [Claude Desktop](https://claude.ai/download) is installed. Open `File -> Settings -> Developer -> Edit Config`. It should open installation directory. Find file with a name `claude_desktop_config.json` and insert the following code:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": [
        "-y",
        "github:yuniko-software/minecraft-mcp-server",
        "--host",
        "localhost",
        "--port",
        "25565",
        "--username",
        "ClaudeBot"
      ]
    }
  }
}
```

Double-check that right `--port` and `--host` parameters were used. Make sure to completely reboot the Claude Desktop application (should be closed in OS tray). 

## Running

Make sure Minecraft game is running and the world is opened to LAN. Then start Claude Desktop application and the bot should join the game. 

**It could take some time for Claude Desktop to boot the MCP server**. The marker that the server has booted successfully:

<img width="885" height="670" alt="image" src="https://github.com/user-attachments/assets/ccbb42f8-6544-462c-8ac1-8af13ddfcddd" />

You can give bot any commands through any active Claude Desktop chat. You can also upload images of buildings and ask bot to build them 😁

Don't forget to mention that bot should do something in Minecraft in your prompt. Because saying this is a trigger to run MCP server. It will ask for your permissions.

Using Claude Sonnet could give you some interesting results. The bot-agent would be really smart 🫡

Example usage: [shared Claude chat](https://claude.ai/share/535d5f69-f102-4cdb-9801-f74ea5709c0b)

## Available Commands

Once connected to a Minecraft server, Claude can use these commands:

### Movement
- `get-position` - Get the current position of the bot
- `move-to-position` - Move to specific coordinates
- `look-at` - Make the bot look at specific coordinates
- `jump` - Make the bot jump
- `move-in-direction` - Move in a specific direction for a duration

### Flight
- `fly-to` - Make the bot fly directly to specific coordinates

### Inventory
- `list-inventory` - List all items in the bot's inventory
- `find-item` - Find a specific item in inventory
- `equip-item` - Equip a specific item

### Block Interaction
- `place-block` - Place a block at specified coordinates
- `dig-block` - Dig a block at specified coordinates
- `get-block-info` - Get information about a block
- `find-blocks` - Find one or more nearby blocks of a specific type

### Furnace
- `smelt-item` - Smelt items using a furnace-like block

### Entity Interaction
- `find-entity` - Find the nearest entity of a specific type

### Communication
- `send-chat` - Send a chat message in-game
- `read-chat` - Get recent chat messages from players

### Game State
- `detect-gamemode` - Detect the gamemode on game

## Contributing

Feel free to submit pull requests or open issues for improvements. All refactoring commits, functional and test contributions, issues and discussion are greatly appreciated!

To get started with contributing, please see [CONTRIBUTING.md](CONTRIBUTING.md).

---

⭐ If you find this project useful, please consider giving it a star on GitHub! ⭐

Your support helps make this project more visible to other people who might benefit from it.

For NeoForge servers that reject vanilla Mineflayer clients, see [bridge-only mode](docs/BRIDGE_ONLY_MODE.md). The current isolated validation and known limitations are in [Release Readiness](docs/RELEASE_READINESS.md) and [Mission 7](docs/MISSION7_FINAL_REPORT.md).
