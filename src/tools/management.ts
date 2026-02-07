import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const MANAGEMENT_TOOLS: Tool[] = [
  {
    name: "services",
    description: "List all registered services with their status, tool count, and uptime",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "activate",
    description: "Activate a service: spawn its process, load its tools",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name to activate" },
      },
      required: ["name"],
    },
  },
  {
    name: "deactivate",
    description: "Deactivate a service: stop its process, remove its tools",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name to deactivate" },
      },
      required: ["name"],
    },
  },
  {
    name: "reload",
    description: "Reload a service: disconnect and reconnect (picks up code changes)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name to reload" },
      },
      required: ["name"],
    },
  },
  {
    name: "restart",
    description: "Restart a service: kill process and respawn",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name to restart" },
      },
      required: ["name"],
    },
  },
  {
    name: "health",
    description: "Check health of all active services via ping",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "call",
    description:
      "Call any tool on any active service. Use activate first to see available tools and their schemas.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service name (e.g. x, helm, squad)",
        },
        tool: {
          type: "string",
          description: "Tool name within the service",
        },
        args: {
          type: "object",
          description: "Tool arguments",
        },
      },
      required: ["service", "tool"],
    },
  },
];

export const MANAGEMENT_TOOL_NAMES = new Set(
  MANAGEMENT_TOOLS.map((t) => t.name)
);
