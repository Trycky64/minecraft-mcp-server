# Contributing to Trycky64 Minecraft MCP Server

This repository is maintained at [Trycky64/minecraft-mcp-server](https://github.com/Trycky64/minecraft-mcp-server) and derives from [yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server). Contributions to this edition should target Trycky64's `main` branch.

## Prerequisites
- Git
- Node.js (>=20.10.0)
- A running Minecraft game (tested with Minecraft 1.21.11 Java Edition)
- Claude Desktop (or another MCP-compatible client)

### 1. Fork and Clone the Repository

1. Fork this repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/minecraft-mcp-server.git
   cd minecraft-mcp-server
   ```

### 2. Create a Feature Branch

Create a new branch for your feature or bug fix:
```bash
git checkout -b your-feature-name
```

### 3. Setup Minecraft Server

Create a singleplayer world and open it to LAN (ESC -> Open to LAN). The upstream bot defaults to port 25565 on localhost. For development, use a dedicated local test server on port 25665 instead; do not run automation against personal or production worlds.

For a more detailed setup guide and the Trycky64 installation reference, see the [README](README.md).

### 4. Configure Your MCP Client

#### For Claude Desktop Users

Make sure [Claude Desktop](https://claude.ai/download) is installed. Open your desktop config file via Claude Desktop: `File -> Settings -> Developer -> Edit Config`

Alternatively, you can edit the config file directly:

**MacOS/Linux**
```bash
code ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Windows**
```bash
code $env:AppData\Claude\claude_desktop_config.json
```

#### For Other MCP Clients

If you're using a different MCP client, configure it according to your client's documentation to point to the npx command and arguments shown below.

### 5. Point Your Client to Your Development Branch

Update your MCP configuration to use your fork and branch:

**For Claude Desktop (`claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": [
        "-y",
        "github:YOUR_USERNAME/minecraft-mcp-server#your-feature-branch-name",
        "--host",
        "localhost",
        "--port",
        "25665",
        "--username",
        "ClaudeBot"
      ]
    }
  }
}
```

### 6. Development Workflow

1. Make your changes and commit them to your feature branch
2. Push your branch to your fork:
   ```bash
   git push origin your-feature-name
   ```
3. Restart your MCP client completely (for Claude Desktop, close from system tray)
4. Open your MCP client - it will automatically pull and run your latest changes
5. Test your changes through your client's chat interface

### 7. Debugging with MCP Inspector

The [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) is an excellent tool for debugging and testing your MCP server during development. It provides a user-friendly interface to:

- Test individual tools without needing a full MCP client
- Inspect requests and responses
- Debug connection issues
- Validate tool schemas and responses

To use the MCP Inspector with your development branch, follow the guide at: https://modelcontextprotocol.io/docs/tools/inspector

## Submitting Changes

Once you're happy with your changes:
1. Push your feature branch to your fork
2. Create a Pull Request from your fork to [Trycky64/minecraft-mcp-server](https://github.com/Trycky64/minecraft-mcp-server) targeting `main`
3. Others can test your changes by pointing their config to your fork/branch
