import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceConfig, ServiceState } from "./types.js";
import { ChildConnection } from "./child-connection.js";
import { ToolRegistry } from "./registry.js";

export class ChildManager {
  private states = new Map<string, ServiceState>();
  private connections = new Map<string, ChildConnection>();
  private onToolsChanged: () => void;

  constructor(
    configs: ServiceConfig[],
    private registry: ToolRegistry,
    onToolsChanged: () => void
  ) {
    this.onToolsChanged = onToolsChanged;

    for (const config of configs) {
      this.states.set(config.name, {
        config,
        status: "inactive",
        tools: [],
      });
    }
  }

  getConnection(name: string): ChildConnection | undefined {
    return this.connections.get(name);
  }

  getState(name: string): ServiceState | undefined {
    return this.states.get(name);
  }

  getAllStates(): ServiceState[] {
    return Array.from(this.states.values());
  }

  async activate(name: string): Promise<CallToolResult> {
    const state = this.states.get(name);
    if (!state) {
      return {
        content: [{ type: "text", text: `Unknown service: ${name}` }],
        isError: true,
      };
    }

    if (state.status === "active") {
      return {
        content: [
          {
            type: "text",
            text: `${name} is already active (${state.tools.length} tools)`,
          },
        ],
      };
    }

    state.status = "activating";
    state.error = undefined;

    try {
      const conn = new ChildConnection(state.config);

      conn.onclose = () => {
        const s = this.states.get(name);
        if (s && s.status === "active") {
          s.status = "error";
          s.error = "Process exited unexpectedly";
          this.registry.unregisterService(name);
          this.connections.delete(name);
          this.onToolsChanged();
          process.stderr.write(`[gateway] ${name} crashed, tools removed\n`);
        }
      };

      const tools = await conn.connect();

      this.connections.set(name, conn);
      this.registry.registerService(name, tools);

      state.status = "active";
      state.tools = tools;
      state.activatedAt = Date.now();

      this.onToolsChanged();

      const toolLines = tools.map((t) => {
        const schema = t.inputSchema as {
          properties?: Record<string, { type?: string; description?: string }>;
          required?: string[];
        };
        const props = schema?.properties ?? {};
        const required = new Set(schema?.required ?? []);
        const params = Object.entries(props)
          .map(([k, v]) => {
            const opt = required.has(k) ? "" : "?";
            return `${k}${opt}: ${v.type ?? "any"}`;
          })
          .join(", ");
        const desc = t.description ? ` — ${t.description}` : "";
        return `• ${t.name}(${params})${desc}`;
      });

      const text = [
        `✓ ${name} activated — ${tools.length} tools:`,
        "",
        ...toolLines,
        "",
        `Use call({service: "${name}", tool: "<name>", args: {...}}) to call these tools.`,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
      };
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `Failed to activate ${name}: ${state.error}` },
        ],
        isError: true,
      };
    }
  }

  async deactivate(name: string): Promise<CallToolResult> {
    const state = this.states.get(name);
    if (!state) {
      return {
        content: [{ type: "text", text: `Unknown service: ${name}` }],
        isError: true,
      };
    }

    if (state.status === "inactive") {
      return {
        content: [{ type: "text", text: `${name} is already inactive` }],
      };
    }

    const conn = this.connections.get(name);
    if (conn) {
      conn.onclose = undefined; // prevent crash handler during intentional close
      await conn.disconnect();
      this.connections.delete(name);
    }

    this.registry.unregisterService(name);
    state.status = "inactive";
    state.tools = [];
    state.activatedAt = undefined;
    state.error = undefined;

    this.onToolsChanged();

    return {
      content: [{ type: "text", text: `✓ ${name} deactivated` }],
    };
  }

  async reload(name: string): Promise<CallToolResult> {
    await this.deactivate(name);
    return await this.activate(name);
  }

  async restart(name: string): Promise<CallToolResult> {
    return await this.reload(name);
  }

  async health(): Promise<CallToolResult> {
    const results: string[] = [];

    for (const [name, state] of this.states) {
      if (state.status !== "active") {
        results.push(`${name}: ${state.status}${state.error ? ` (${state.error})` : ""}`);
        continue;
      }

      const conn = this.connections.get(name);
      if (!conn) {
        results.push(`${name}: error (no connection)`);
        continue;
      }

      const healthy = await conn.ping();
      results.push(
        `${name}: ${healthy ? "healthy" : "unhealthy"} (pid: ${conn.pid ?? "?"})`
      );
    }

    return {
      content: [{ type: "text", text: results.join("\n") }],
    };
  }

  async handleManagementCall(
    toolName: string,
    args: Record<string, unknown> | undefined
  ): Promise<CallToolResult> {
    switch (toolName) {
      case "services": {
        const lines = this.getAllStates().map((s) => {
          const uptime =
            s.activatedAt
              ? `${Math.round((Date.now() - s.activatedAt) / 1000)}s`
              : "-";
          return `${s.config.name}: ${s.status} | tools: ${s.tools.length} | uptime: ${uptime}${s.error ? ` | error: ${s.error}` : ""}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "activate":
        return await this.activate(args?.name as string);

      case "deactivate":
        return await this.deactivate(args?.name as string);

      case "reload":
        return await this.reload(args?.name as string);

      case "restart":
        return await this.restart(args?.name as string);

      case "health":
        return await this.health();

      case "call": {
        const service = args?.service as string;
        const tool = args?.tool as string;
        const toolArgs = (args?.args as Record<string, unknown>) ?? {};

        if (!service || !tool) {
          return {
            content: [
              { type: "text", text: "Both 'service' and 'tool' are required" },
            ],
            isError: true,
          };
        }

        const state = this.states.get(service);
        if (!state) {
          return {
            content: [
              { type: "text", text: `Unknown service: "${service}"` },
            ],
            isError: true,
          };
        }

        // Auto-reactivate if not active
        if (state.status !== "active") {
          const activateResult = await this.activate(service);
          if (activateResult.isError) return activateResult;
        }

        const conn = this.connections.get(service);
        if (!conn) {
          return {
            content: [
              { type: "text", text: `No connection for service "${service}"` },
            ],
            isError: true,
          };
        }

        return await conn.callTool(tool, toolArgs);
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown management tool: ${toolName}` }],
          isError: true,
        };
    }
  }

  async shutdown(): Promise<void> {
    for (const [name] of this.connections) {
      await this.deactivate(name);
    }
  }
}
