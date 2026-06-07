import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "./registry.js";
import { ChildManager } from "./child-manager.js";
import { MANAGEMENT_TOOLS, MANAGEMENT_TOOL_NAMES } from "./tools/management.js";
import { proxyToolCall } from "./tools/proxy.js";

/**
 * Build a gateway MCP Server wired to a shared registry + child manager.
 *
 * The same factory backs both transports:
 *  - stdio mode: one server for the single client
 *  - HTTP daemon mode: one server per connected session, all sharing the
 *    same global ChildManager (so child processes are warm and shared)
 */
export function createGatewayServer(
  registry: ToolRegistry,
  manager: ChildManager
): Server {
  const server = new Server(
    { name: "gateway", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [...MANAGEMENT_TOOLS, ...registry.getAllTools()] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (MANAGEMENT_TOOL_NAMES.has(name)) {
      return await manager.handleManagementCall(name, args);
    }

    return await proxyToolCall(name, args, registry, manager);
  });

  return server;
}
