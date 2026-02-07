import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChildManager } from "../child-manager.js";
import type { ToolRegistry } from "../registry.js";

export async function proxyToolCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
  registry: ToolRegistry,
  manager: ChildManager
): Promise<CallToolResult> {
  const route = registry.resolve(toolName);
  if (!route) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  const connection = manager.getConnection(route.service);
  if (!connection) {
    return {
      content: [
        {
          type: "text",
          text: `Service "${route.service}" is not active. Use activate("${route.service}") first.`,
        },
      ],
      isError: true,
    };
  }

  return await connection.callTool(route.originalName, args);
}
