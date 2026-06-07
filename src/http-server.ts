import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ToolRegistry } from "./registry.js";
import { ChildManager } from "./child-manager.js";
import { createGatewayServer } from "./server-factory.js";
import type { ServiceConfig } from "./types.js";

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
}

function isInitialize(body: unknown): boolean {
  const isInit = (m: unknown): boolean =>
    !!m && typeof m === "object" && (m as { method?: string }).method === "initialize";
  return Array.isArray(body) ? body.some(isInit) : isInit(body);
}

/**
 * Run the gateway as an always-on HTTP daemon.
 *
 * A single global ChildManager is shared across every connected session, so the
 * child MCP services (whatsapp, helm, …) stay warm and are shared between agents
 * — connect once, the toolkit is already live. Each session gets its own MCP
 * Server + Streamable HTTP transport keyed by Mcp-Session-Id.
 *
 * NOTE (Stage 1): the ToolRegistry (full-mode schema injection) is still global,
 * so a `lazy=false` activate would surface schemas to every session. That's fine
 * while always-on services run lazy (0 schemas). Per-session view isolation is
 * Stage 2.
 */
export async function startHttpServer(opts: {
  services: ServiceConfig[];
  registry: ToolRegistry;
  port: number;
  host?: string;
}): Promise<ChildManager> {
  const { services, registry, port, host = "127.0.0.1" } = opts;

  const sessions = new Map<string, Session>();
  const sessionServers = new Set<Server>();

  // One shared manager; tool-list changes fan out to every connected session.
  const manager = new ChildManager(services, registry, () => {
    for (const s of sessionServers) {
      try {
        s.sendToolListChanged();
      } catch {
        // a session may be tearing down; ignore
      }
    }
  });

  async function handleMcp(req: Request): Promise<Response> {
    const sid = req.headers.get("mcp-session-id") ?? undefined;

    if (sid) {
      const session = sessions.get(sid);
      if (!session) {
        return new Response("Session not found", { status: 404 });
      }
      return await session.transport.handleRequest(req);
    }

    // No session id: only an initialize POST may open a new session.
    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }

      if (isInitialize(body)) {
        const server = createGatewayServer(registry, manager);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server });
            process.stderr.write(`[gateway] session opened: ${id} (${sessions.size} active)\n`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          sessionServers.delete(server);
        };
        sessionServers.add(server);
        await server.connect(transport);
        return await transport.handleRequest(req, { parsedBody: body });
      }

      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session ID (initialize first)" },
          id: null,
        },
        { status: 400 }
      );
    }

    return new Response("Invalid or missing session ID", { status: 400 });
  }

  Bun.serve({
    port,
    hostname: host,
    idleTimeout: 0, // keep long-lived SSE streams open
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        const states = manager.getAllStates();
        return Response.json({
          ok: true,
          sessions: sessions.size,
          services: states.map((s) => ({
            name: s.config.name,
            status: s.status,
            tools: s.allTools.length,
            pid: manager.getConnection(s.config.name)?.pid ?? null,
          })),
        });
      }
      if (url.pathname === "/mcp") {
        return await handleMcp(req);
      }
      return new Response("Not found", { status: 404 });
    },
  });

  process.stderr.write(`[gateway] HTTP daemon listening on http://${host}:${port}/mcp\n`);

  const shutdown = async () => {
    await manager.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Warm the always-on services once, at daemon start (shared by all sessions).
  // GATEWAY_NO_AUTOACTIVATE skips this — e.g. a safe boot-test that must not
  // spawn stateful singletons that are already running elsewhere.
  const auto = process.env.GATEWAY_NO_AUTOACTIVATE
    ? []
    : services.filter((s) => s.autoActivate);
  if (auto.length > 0) {
    process.stderr.write(`[gateway] Auto-activating: ${auto.map((s) => s.name).join(", ")}\n`);
    await Promise.allSettled(auto.map((s) => manager.activate(s.name)));
  } else if (process.env.GATEWAY_NO_AUTOACTIVATE) {
    process.stderr.write(`[gateway] autoActivate skipped (GATEWAY_NO_AUTOACTIVATE)\n`);
  }

  return manager;
}
