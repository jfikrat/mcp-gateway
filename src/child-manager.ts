import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceConfig, ServiceState, GatewayConfig } from "./types.js";
import { ChildConnection } from "./child-connection.js";
import { ToolRegistry } from "./registry.js";
import { CONFIG_PATH, saveConfig } from "./config.js";
import { readFileSync } from "fs";

export class ChildManager {
  private states = new Map<string, ServiceState>();
  private connections = new Map<string, ChildConnection>();
  private restartAttempts = new Map<string, number>();
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
        allTools: [],
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

  private filterToolsByGroups(allTools: Tool[], config: ServiceConfig, groups: string[]): Tool[] {
    if (!config.groups) return allTools;

    const allowedNames = new Set<string>();
    for (const group of groups) {
      const toolNames = config.groups[group];
      if (toolNames) {
        for (const name of toolNames) allowedNames.add(name);
      }
    }

    return allTools.filter((t) => allowedNames.has(t.name));
  }

  private formatToolLines(tools: Tool[]): string[] {
    return tools.map((t) => {
      const schema = t.inputSchema as {
        properties?: Record<string, { type?: string; enum?: string[]; description?: string }>;
        required?: string[];
      };
      const props = schema?.properties ?? {};
      const required = new Set(schema?.required ?? []);
      const params = Object.entries(props)
        .map(([k, v]) => {
          const opt = required.has(k) ? "" : "?";
          const type = v.enum ? v.enum.map((e) => `'${e}'`).join("|") : (v.type ?? "any");
          return `${k}${opt}: ${type}`;
        })
        .join(", ");
      const desc = t.description ? ` — ${t.description}` : "";
      return `• ${t.name}(${params})${desc}`;
    });
  }

  async activate(name: string, lazy = true, groups?: string[]): Promise<CallToolResult> {
    const state = this.states.get(name);
    if (!state) {
      return {
        content: [{ type: "text", text: `Unknown service: ${name}` }],
        isError: true,
      };
    }

    // Already active
    if (state.status === "active") {
      // Switch between lazy and non-lazy mode
      if (!lazy && state.lazy) {
        // Promote from lazy to full: register tools
        let tools = state.allTools;
        if (groups && groups.length > 0 && state.config.groups) {
          tools = this.filterToolsByGroups(state.allTools, state.config, groups);
          state.activeGroups = groups;
        }
        this.registry.registerService(name, tools);
        state.tools = tools;
        state.lazy = false;
        this.onToolsChanged();

        const toolLines = this.formatToolLines(tools);
        const text = [
          `✓ ${name} promoted to full mode — ${tools.length} tools registered in context:`,
          "",
          ...toolLines,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }

      if (!lazy && groups && groups.length > 0 && state.config.groups) {
        // Re-filter tools without respawning
        const filtered = this.filterToolsByGroups(state.allTools, state.config, groups);
        this.registry.unregisterService(name);
        this.registry.registerService(name, filtered);
        state.tools = filtered;
        state.activeGroups = groups;
        this.onToolsChanged();

        const groupLabel = groups.join(", ");
        const toolLines = this.formatToolLines(filtered);
        const text = [
          `✓ ${name} groups updated [${groupLabel}] — ${filtered.length}/${state.allTools.length} tools:`,
          "",
          ...toolLines,
          "",
          `Use call({service: "${name}", tool: "<name>", args: {...}}) to call these tools.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      }

      const mode = state.lazy ? "lazy" : "full";
      return {
        content: [
          {
            type: "text",
            text: `${name} is already active [${mode}] (${state.allTools.length} tools). Use tools({service: "${name}"}) to list them.`,
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
          if (!s.lazy) this.registry.unregisterService(name);
          this.connections.delete(name);
          if (!s.lazy) this.onToolsChanged();
          process.stderr.write(`[gateway] ${name} crashed\n`);
          // Always-on services respawn themselves with backoff.
          if (s.config.keepAlive) this.scheduleKeepAliveRestart(name);
        }
      };

      const allTools = await conn.connect();
      this.connections.set(name, conn);

      state.status = "active";
      state.allTools = allTools;
      state.activatedAt = Date.now();
      state.lazy = lazy;

      if (lazy) {
        // Lazy mode: store tools but don't register in registry (0 context tokens)
        state.tools = [];
        state.activeGroups = undefined;

        const text = [
          `✓ ${name} activated [lazy] — ${allTools.length} tools available (0 registered in context)`,
          "",
          `⚠️ IMPORTANT: You MUST call tools({service: "${name}"}) first to see available tools and their parameters before calling any tool. Do NOT guess tool names or parameters.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      }

      // Full mode: register tools in registry (schemas go into context)
      let tools: Tool[];
      if (groups && groups.length > 0 && state.config.groups) {
        tools = this.filterToolsByGroups(allTools, state.config, groups);
        state.activeGroups = groups;
      } else {
        tools = allTools;
        state.activeGroups = undefined;
      }

      this.registry.registerService(name, tools);
      state.tools = tools;
      this.onToolsChanged();

      const toolLines = this.formatToolLines(tools);
      const groupInfo = state.activeGroups
        ? ` [${state.activeGroups.join(", ")}]`
        : "";
      const countInfo = state.activeGroups
        ? `${tools.length}/${allTools.length}`
        : `${tools.length}`;

      const text = [
        `✓ ${name} activated [full]${groupInfo} — ${countInfo} tools registered in context:`,
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

    if (!state.lazy) this.registry.unregisterService(name);
    this.restartAttempts.delete(name); // cancel any pending keepAlive restart
    state.status = "inactive";
    state.tools = [];
    state.allTools = [];
    state.lazy = undefined;
    state.activeGroups = undefined;
    state.activatedAt = undefined;
    state.error = undefined;

    this.onToolsChanged();

    return {
      content: [{ type: "text", text: `✓ ${name} deactivated` }],
    };
  }

  async restart(name: string): Promise<CallToolResult> {
    const state = this.states.get(name);
    const lazy = state?.lazy ?? true;
    const groups = state?.activeGroups;
    await this.deactivate(name);
    return await this.activate(name, lazy, groups);
  }

  /**
   * Respawn a crashed keepAlive service with exponential backoff (1s→2s→…→30s cap),
   * giving up after 5 consecutive failures. Only restarts from "error" state, so an
   * intentional deactivate (which sets "inactive") cancels the loop.
   */
  private scheduleKeepAliveRestart(name: string): void {
    const attempts = (this.restartAttempts.get(name) ?? 0) + 1;
    this.restartAttempts.set(name, attempts);
    if (attempts > 5) {
      process.stderr.write(`[gateway] ${name} keepAlive: gave up after ${attempts - 1} attempts\n`);
      return;
    }
    const delay = Math.min(1000 * 2 ** (attempts - 1), 30000);
    process.stderr.write(`[gateway] ${name} keepAlive: restart #${attempts} in ${delay}ms\n`);
    setTimeout(async () => {
      const st = this.states.get(name);
      if (!st || st.status !== "error") return; // deactivated meanwhile → stop
      const res = await this.activate(name, st.lazy ?? true, st.activeGroups);
      if (res.isError) {
        this.scheduleKeepAliveRestart(name);
      } else {
        this.restartAttempts.delete(name);
        process.stderr.write(`[gateway] ${name} keepAlive: restarted ✓\n`);
      }
    }, delay);
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
      const groupInfo = state.activeGroups ? ` [${state.activeGroups.join(",")}]` : "";
      results.push(
        `${name}: ${healthy ? "healthy" : "unhealthy"} (pid: ${conn.pid ?? "?"})${groupInfo}`
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
          const mode = s.status === "active" ? (s.lazy ? " [lazy]" : " [full]") : "";
          const groupInfo = s.activeGroups ? ` [${s.activeGroups.join(",")}]` : "";
          const toolCount = s.lazy
            ? `${s.allTools.length} (0 in context)`
            : s.activeGroups
              ? `${s.tools.length}/${s.allTools.length}`
              : `${s.tools.length}`;
          return `${s.config.name}: ${s.status}${mode} | tools: ${toolCount}${groupInfo} | uptime: ${uptime}${s.error ? ` | error: ${s.error}` : ""}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "activate": {
        const lazy = args?.lazy !== false; // default true
        const rawGroups = args?.groups;
        let groups: string[] | undefined;
        if (Array.isArray(rawGroups)) {
          groups = rawGroups as string[];
        } else if (typeof rawGroups === "string") {
          try { groups = JSON.parse(rawGroups); } catch { groups = [rawGroups]; }
        }
        return await this.activate(args?.name as string, lazy, groups);
      }

      case "tools": {
        const service = args?.service as string;
        if (!service) {
          return {
            content: [{ type: "text", text: "'service' is required" }],
            isError: true,
          };
        }

        const state = this.states.get(service);
        if (!state) {
          return {
            content: [{ type: "text", text: `Unknown service: "${service}"` }],
            isError: true,
          };
        }

        if (state.status !== "active") {
          return {
            content: [
              { type: "text", text: `Service "${service}" is ${state.status}. Activate it first.` },
            ],
            isError: true,
          };
        }

        let tools = state.allTools;
        const filter = args?.filter as string | undefined;
        if (filter) {
          const normalize = (s: string) => s.toLowerCase().replace(/[-_\s.]+/g, " ");
          const keywords = normalize(filter).split(" ").filter(Boolean);
          tools = tools.filter((t) => {
            const haystack = normalize(t.name) + " " + normalize(t.description ?? "");
            return keywords.every((kw) => haystack.includes(kw));
          });
        }

        const toolLines = this.formatToolLines(tools);
        const filterNote = filter ? ` (filter: "${filter}")` : "";
        const text = [
          `${service} — ${tools.length} tools${filterNote}:`,
          "",
          ...toolLines,
          "",
          `Use call({service: "${service}", tool: "<name>", args: {...}}) to call these tools.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      }

      case "deactivate":
        return await this.deactivate(args?.name as string);

      case "restart":
        return await this.restart(args?.name as string);

      case "health":
        return await this.health();

      case "add": {
        const name = args?.name as string;
        const command = args?.command as string;

        if (!name || !command) {
          return {
            content: [
              { type: "text", text: "Both 'name' and 'command' are required" },
            ],
            isError: true,
          };
        }

        if (this.states.has(name)) {
          return {
            content: [
              { type: "text", text: `Service "${name}" already exists` },
            ],
            isError: true,
          };
        }

        const newConfig: ServiceConfig = {
          name,
          command,
          args: (args?.args as string[]) ?? [],
          env: (args?.env as Record<string, string>) ?? {},
          autoActivate: false,
        };

        // Add to runtime
        this.states.set(name, {
          config: newConfig,
          status: "inactive",
          tools: [],
          allTools: [],
        });

        // Persist to config file
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as GatewayConfig;
        raw.services.push(newConfig);
        saveConfig(raw);

        return {
          content: [
            {
              type: "text",
              text: `✓ "${name}" added (${command} ${newConfig.args.join(" ")}). Use call({service: "${name}", tool: "..."}) to use it.`,
            },
          ],
        };
      }

      case "remove": {
        const name = args?.name as string;
        if (!name) {
          return {
            content: [{ type: "text", text: "'name' is required" }],
            isError: true,
          };
        }

        if (!this.states.has(name)) {
          return {
            content: [
              { type: "text", text: `Unknown service: "${name}"` },
            ],
            isError: true,
          };
        }

        // Deactivate if active
        const state = this.states.get(name)!;
        if (state.status === "active") {
          await this.deactivate(name);
        }

        // Remove from runtime
        this.states.delete(name);

        // Persist to config file
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as GatewayConfig;
        raw.services = raw.services.filter((s) => s.name !== name);
        saveConfig(raw);

        return {
          content: [
            { type: "text", text: `✓ "${name}" removed from gateway` },
          ],
        };
      }

      case "call": {
        const service = args?.service as string;
        const tool = args?.tool as string;
        let toolArgs = (args?.args as Record<string, unknown>) ?? {};

        // Handle case where args is passed as a JSON string
        if (typeof toolArgs === "string") {
          try {
            toolArgs = JSON.parse(toolArgs);
          } catch {
            // keep as-is
          }
        }

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

        if (state.status !== "active") {
          return {
            content: [
              {
                type: "text",
                text: `Service "${service}" is ${state.status}. Activate it first with: activate({name: "${service}"})`,
              },
            ],
            isError: true,
          };
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
