import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ChildManager } from "./child-manager.js";
import { createGatewaySession } from "./server-factory.js";
import type { ServiceConfig, SessionCtx } from "./types.js";

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  ctx: SessionCtx;
  lastActivity: number;
}

function isInitialize(body: unknown): boolean {
  const isInit = (m: unknown): boolean =>
    !!m && typeof m === "object" && (m as { method?: string }).method === "initialize";
  return Array.isArray(body) ? body.some(isInit) : isInit(body);
}

/**
 * Run the gateway as an always-on HTTP daemon.
 *
 * One global ChildManager is shared across every connected session, so the
 * child MCP services (whatsapp, helm, …) stay warm and shared between agents —
 * connect once, the toolkit is already live. Each session gets its own MCP
 * Server + private view (SessionCtx) keyed by Mcp-Session-Id, so full-mode
 * schema injection is isolated per agent.
 */
export async function startHttpServer(opts: {
  services: ServiceConfig[];
  port: number;
  host?: string;
}): Promise<{ manager: ChildManager; port: number; stop: () => void }> {
  const { services, port, host = "127.0.0.1" } = opts;

  const sessions = new Map<string, Session>();
  const manager = new ChildManager(services);

  async function handleMcp(req: Request): Promise<Response> {
    const sid = req.headers.get("mcp-session-id") ?? undefined;

    if (sid) {
      const session = sessions.get(sid);
      if (!session) return new Response("Session not found", { status: 404 });
      session.lastActivity = Date.now();
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
        const { server, ctx } = createGatewaySession(manager, crypto.randomUUID());
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server, ctx, lastActivity: Date.now() });
            process.stderr.write(`[gateway] session opened: ${id} (${sessions.size} active)\n`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId && sessions.delete(transport.sessionId)) {
            process.stderr.write(
              `[gateway] session closed: ${transport.sessionId} (${sessions.size} active)\n`
            );
          }
          manager.removeSession(ctx);
        };
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

  const httpServer = Bun.serve({
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

  process.stderr.write(
    `[gateway] HTTP daemon listening on http://${host}:${httpServer.port}/mcp\n`
  );

  // Idle session GC: clients (Claude Code, Codex) often exit without sending
  // DELETE, so sessions — and the service refs they hold — would otherwise
  // accumulate forever. Sweep sessions idle longer than the TTL.
  const sessionTtl = Number(process.env.GATEWAY_SESSION_TTL_MS) || 60 * 60_000;
  const sweepEvery = Number(process.env.GATEWAY_SESSION_SWEEP_MS) || 5 * 60_000;
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity <= sessionTtl) continue;
      sessions.delete(id);
      manager.removeSession(session.ctx);
      session.transport.close().catch(() => {});
      process.stderr.write(
        `[gateway] session expired after ${Math.round((now - session.lastActivity) / 60_000)}m idle: ${id} (${sessions.size} active)\n`
      );
    }
  }, sweepEvery);

  const stop = () => {
    clearInterval(sweeper);
    httpServer.stop(true);
  };

  const shutdown = async () => {
    stop();
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
    await Promise.allSettled(auto.map((s) => manager.warmup(s.name)));
  } else if (process.env.GATEWAY_NO_AUTOACTIVATE) {
    process.stderr.write(`[gateway] autoActivate skipped (GATEWAY_NO_AUTOACTIVATE)\n`);
  }

  return { manager, port: httpServer.port ?? port, stop };
}
