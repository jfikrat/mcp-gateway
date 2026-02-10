import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { ToolRegistry } from "./registry.js";
import { ChildManager } from "./child-manager.js";
import { MANAGEMENT_TOOLS, MANAGEMENT_TOOL_NAMES } from "./tools/management.js";
import { proxyToolCall } from "./tools/proxy.js";

// Load gateway .env into process.env (before any child spawns)
try {
  const envPath = join(import.meta.dir, "..", ".env");
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) {
      const i = t.indexOf("=");
      if (i > 0 && !process.env[t.slice(0, i)]) {
        process.env[t.slice(0, i)] = t.slice(i + 1).trim();
      }
    }
  }
} catch {}

const config = loadConfig();
const registry = new ToolRegistry();

const server = new Server(
  { name: "gateway", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const manager = new ChildManager(config.services, registry, () => {
  server.sendToolListChanged();
});

// --- ListTools handler ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [...MANAGEMENT_TOOLS, ...registry.getAllTools()] };
});

// --- CallTool handler ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (MANAGEMENT_TOOL_NAMES.has(name)) {
    return await manager.handleManagementCall(name, args);
  }

  return await proxyToolCall(name, args, registry, manager);
});

// --- Auto-activate services ---
async function autoActivate(): Promise<void> {
  const autoServices = config.services.filter((s) => s.autoActivate);
  if (autoServices.length === 0) return;

  process.stderr.write(
    `[gateway] Auto-activating: ${autoServices.map((s) => s.name).join(", ")}\n`
  );

  await Promise.allSettled(
    autoServices.map((s) => manager.activate(s.name))
  );
}

// --- Graceful shutdown ---
process.on("SIGINT", async () => {
  await manager.shutdown();
  await server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await manager.shutdown();
  await server.close();
  process.exit(0);
});

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(
  `[gateway] Started — ${config.services.length} services registered\n`
);

await autoActivate();
