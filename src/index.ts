import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ChildManager } from "./child-manager.js";
import { createGatewaySession } from "./server-factory.js";
import { startHttpServer } from "./http-server.js";
import type { GatewayConfig } from "./types.js";

// Load gateway .env into process.env (before any child spawns).
// Supports `export KEY=...` and single/double-quoted values.
try {
  const envPath = join(import.meta.dir, "..", ".env");
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    let t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("export ")) t = t.slice(7).trim();
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let value = t.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
} catch {}

const config = loadConfig();

// --- stdio mode (default, unchanged): one client, one session ---
async function startStdio(config: GatewayConfig): Promise<void> {
  const manager = new ChildManager(config.services);
  const { server } = createGatewaySession(manager, "stdio");

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
    await Promise.allSettled(auto.map((s) => manager.warmup(s.name)));
  }
}

// GATEWAY_HTTP_PORT set → always-on shared HTTP daemon; otherwise stdio.
const httpPort = process.env.GATEWAY_HTTP_PORT;
if (httpPort) {
  await startHttpServer({ services: config.services, port: Number(httpPort) });
} else {
  await startStdio(config);
}
