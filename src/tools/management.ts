import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const MANAGEMENT_TOOLS: Tool[] = [
  {
    name: "services",
    description: "List all registered services with their status, tool count, and uptime",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "activate",
    description: "Activate a service. Default is lazy: spawns process, fetches tool list, but does NOT inject schemas into context (0 tokens). Use tools() to see available tools, call() to use them. Set lazy=false to register all tool schemas in context.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name to activate" },
        lazy: {
          type: "boolean",
          description: "If true (default), don't register tool schemas in context. Tools are still callable via call().",
        },
        groups: {
          type: "array",
          items: { type: "string" },
          description: "Tool groups to load (e.g. ['gmail', 'calendar']). Only applies when lazy=false.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "tools",
    description: "List available tools for an active service. Returns tool names, parameters, and descriptions as text (not injected into context).",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name" },
        filter: { type: "string", description: "Optional keyword to filter tools by name or description" },
      },
      required: ["service"],
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
    name: "add",
    description:
      "Add a new MCP service to the gateway config. Supports npx, bunx, node, bun, ssh, etc.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique service name" },
        command: {
          type: "string",
          description: "Command to run (e.g. npx, bunx, bun, node, ssh)",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments",
        },
        env: {
          type: "object",
          description: "Environment variables",
        },
      },
      required: ["name", "command"],
    },
  },
  {
    name: "remove",
    description: "Remove an MCP service from the gateway config",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name to remove" },
      },
      required: ["name"],
    },
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
