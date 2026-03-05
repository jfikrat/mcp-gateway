# MCP Gateway

A service orchestration layer for the [Model Context Protocol](https://modelcontextprotocol.io). Manages multiple MCP services through a single unified interface — spawn, supervise, and route tool calls across all your services.

## Key Feature: Lazy Activate

By default, services activate in **lazy mode** — the process spawns and tool list is fetched, but **zero tool schemas are injected into the LLM context**. This means you can have hundreds of tools across dozens of services with no token overhead.

```
activate({name: "google-workspace"})     → 281 tools ready, 0 context tokens
tools({service: "google-workspace"})     → browse available tools
call({service: "...", tool: "...", args}) → call any tool directly
```

## Features

- **Lazy activate** — spawn services with 0 context tokens, browse with `tools()`, call with `call()`
- **Service orchestration** — spawn, stop, restart child MCP services
- **On-demand tool browsing** — `tools({service, filter})` returns tool descriptions as conversation text (not system prompt)
- **Direct routing** — `call()` routes to child connections without needing schema registration
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
      "autoActivate": false
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

### Environment Variables

Config values support `$VAR` and `${VAR}` syntax, resolved from `process.env` at load time:

```json
{
  "env": { "API_KEY": "$MY_SECRET_KEY" },
  "args": ["--config", "${HOME}/.config/my-service.json"]
}
```

This keeps secrets out of your config file. Pass them through your MCP client config (see below).

## Built-in Tools

Once running, the gateway exposes these management tools:

| Tool | Description |
|---|---|
| `services` | List all services with status, mode (lazy/full), tool count, uptime |
| `activate` | Start a service. Default lazy (0 context tokens). Set `lazy=false` for full schema registration |
| `tools` | List available tools for an active service. Supports `filter` for keyword search |
| `deactivate` | Stop a service and clean up |
| `restart` | Kill and respawn a service (preserves lazy/full mode) |
| `health` | Ping all active services |
| `add` | Register a new service dynamically (persists to config) |
| `remove` | Remove a service from config |
| `call` | Call any tool on any active service |

### Workflow

```
1. activate({name: "my-service"})                        → spawn process, 0 tokens
2. tools({service: "my-service"})                        → see all tools
3. tools({service: "my-service", filter: "search"})      → filter by keyword
4. call({service: "my-service", tool: "...", args: {}})   → call a tool
5. deactivate({name: "my-service"})                      → stop when done
```

### Full Mode (optional)

If you want tool schemas injected into the LLM context (traditional MCP behavior):

```
activate({name: "my-service", lazy: false})              → register all schemas
activate({name: "my-service", lazy: false, groups: ["gmail", "drive"]})  → register specific groups
```

## Using with Claude Code

Add to your Claude Code MCP config (`~/.claude/config.json` or project settings).
API keys go in the `env` block — they're passed to the gateway process and expanded in `gateway.config.json` via `$VAR` syntax:

```json
{
  "mcpServers": {
    "gateway": {
      "command": "bun",
      "args": ["run", "/path/to/mcp-gateway/src/index.ts"],
      "env": {
        "GEMINI_API_KEY": "your-gemini-key",
        "EXA_API_KEY": "your-exa-key"
      }
    }
  }
}
```

## License

MIT
