import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "./registry.js";
import { ChildManager } from "./child-manager.js";
import type { SessionCtx } from "./types.js";
import { MANAGEMENT_TOOLS, MANAGEMENT_TOOL_NAMES } from "./tools/management.js";
import { proxyToolCall } from "./tools/proxy.js";

/**
 * Build one MCP session: a Server plus its private view (SessionCtx).
 *
 * Every session shares the one global ChildManager (warm, shared child
 * processes) but gets its OWN registry, so full-mode schema injection and the
 * ListTools a session sees are isolated — one agent's `activate(lazy=false)`
 * never leaks into another agent's context.
 *
 * stdio mode builds exactly one of these; the HTTP daemon builds one per
 * connected client.
 */
export function createGatewaySession(
  manager: ChildManager,
  sessionId: string
): { server: Server; ctx: SessionCtx } {
  const server = new Server(
    { name: "gateway", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  const ctx: SessionCtx = {
    id: sessionId,
    registry: new ToolRegistry(),
    fullMode: new Map(),
    notify: () => {
      try {
        server.sendToolListChanged();
      } catch {
        // session may be tearing down
      }
    },
  };
  manager.addSession(ctx);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [...MANAGEMENT_TOOLS, ...ctx.registry.getAllTools()] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (MANAGEMENT_TOOL_NAMES.has(name)) {
      return await manager.handleManagementCall(name, args, ctx);
    }
    return await proxyToolCall(name, args, ctx.registry, manager);
  });

  return { server, ctx };
}
