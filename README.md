# MCP Gateway

A service orchestration layer for the [Model Context Protocol](https://modelcontextprotocol.io). Manages multiple MCP services through a single unified interface — spawn, supervise, and route tool calls across all your services.

## Features

- **Service orchestration** — spawn, stop, reload, restart child MCP services
- **Tool aggregation** — collects tools from all services, exposes them as `service_toolName`
- **Auto-reactivation** — inactive services restart automatically when their tools are called
- **Environment variable expansion** — use `$VAR` or `${VAR}` in config for secrets
- **Dynamic management** — add/remove services at runtime without restarting
- **Health monitoring** — built-in ping/health checks
- **Any command** — supports `bun`, `node`, `npx`, `ssh`, or any executable

## Quick Start

```bash
# Install
bun install

# Create your config from the example
cp gateway.config.example.json gateway.config.json

# Edit gateway.config.json with your services
# Then start the gateway
bun run start
```

## Configuration

`gateway.config.json` defines your services:

```json
{
  "services": [
    {
      "name": "my-service",
      "command": "bun",
      "args": ["run", "/path/to/service/index.ts"],
      "env": { "API_KEY": "$MY_API_KEY" },
      "autoActivate": false,
      "timeout": 30000
    }
  ]
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | yes | — | Unique service identifier |
| `command` | yes | — | Executable to run (`bun`, `node`, `npx`, `ssh`, ...) |
| `args` | no | `[]` | Command arguments |
| `env` | no | `{}` | Environment variables (supports `$VAR` expansion) |
| `autoActivate` | no | `false` | Start automatically on gateway launch |
| `timeout` | no | `30000` | Connection timeout in ms |

### Environment Variables

Config values support `$VAR` and `${VAR}` syntax, resolved from `process.env` at load time:

```json
{
  "env": { "API_KEY": "$MY_SECRET_KEY" },
  "args": ["--config", "${HOME}/.config/my-service.json"]
}
```

This keeps secrets out of your config file. Set them in your shell or `.env`:

```bash
export MY_SECRET_KEY="sk-..."
bun run start
```

## Built-in Tools

Once running, the gateway exposes these management tools:

| Tool | Description |
|---|---|
| `services` | List all services with status, tool count, uptime |
| `activate` | Start a service by name |
| `deactivate` | Stop a service |
| `reload` | Reconnect to a service (picks up code changes) |
| `restart` | Kill and respawn a service |
| `health` | Ping all active services |
| `add` | Register a new service dynamically |
| `remove` | Remove a service from config |
| `call` | Call any tool on any active service |

All child service tools are exposed with the prefix `service_toolName` (e.g., `exa_search`).

## Using with Claude Code

Add to your Claude Code MCP config (`~/.claude/config.json` or project settings):

```json
{
  "mcpServers": {
    "gateway": {
      "command": "bun",
      "args": ["run", "/path/to/mcp-gateway/src/index.ts"]
    }
  }
}
```

## License

MIT
