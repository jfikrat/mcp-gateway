import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ToolRegistry } from "./registry.js";
import { ChildManager } from "./child-manager.js";
import { createGatewayServer } from "./server-factory.js";
import { startHttpServer } from "./http-server.js";
import type { GatewayConfig } from "./types.js";

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

// --- stdio mode (default, unchanged): one client per gateway process ---
async function startStdio(config: GatewayConfig, registry: ToolRegistry): Promise<void> {
  let notify = () => {};
  const manager = new ChildManager(config.services, registry, () => notify());
  const server = createGatewayServer(registry, manager);
  notify = () => server.sendToolListChanged();

  const shutdown = async () => {
    await manager.shutdown();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[gateway] Started (stdio) — ${config.services.length} services registered\n`
  );

  const auto = process.env.GATEWAY_NO_AUTOACTIVATE
    ? []
    : config.services.filter((s) => s.autoActivate);
  if (auto.length > 0) {
    process.stderr.write(`[gateway] Auto-activating: ${auto.map((s) => s.name).join(", ")}\n`);
    await Promise.allSettled(auto.map((s) => manager.activate(s.name)));
  }
}

// GATEWAY_HTTP_PORT set → always-on shared HTTP daemon; otherwise stdio.
const httpPort = process.env.GATEWAY_HTTP_PORT;
if (httpPort) {
  await startHttpServer({ services: config.services, registry, port: Number(httpPort) });
} else {
  await startStdio(config, registry);
}
