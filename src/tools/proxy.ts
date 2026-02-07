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

  let connection = manager.getConnection(route.service);
  if (!connection) {
    // Auto-activate the service
    const activateResult = await manager.activate(route.service);
    if (activateResult.isError) return activateResult;

    connection = manager.getConnection(route.service);
    if (!connection) {
      return {
        content: [
          {
            type: "text",
            text: `Service "${route.service}" failed to activate.`,
          },
        ],
        isError: true,
      };
    }
  }

  return await connection.callTool(route.originalName, args);
}
