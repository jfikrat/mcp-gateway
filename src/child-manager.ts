import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceConfig, ServiceState, GatewayConfig, SessionCtx } from "./types.js";
import { ChildConnection } from "./child-connection.js";
import { CONFIG_PATH, saveConfig } from "./config.js";
import { readFileSync } from "fs";

type SpawnResult = { ok: true; allTools: Tool[] } | { ok: false; error: string };

/**
 * Global process layer. Owns the child MCP service processes (one per service,
 * shared by every session) — spawning, crash/keepAlive, ref-counting, routing.
 * The per-session *view* (which services are full-mode, the ListTools a given
 * session sees) lives in SessionCtx, passed into the management calls.
 */
export class ChildManager {
  private states = new Map<string, ServiceState>();
  private connections = new Map<string, ChildConnection>();
  private spawnLocks = new Map<string, Promise<SpawnResult>>();
  private refs = new Map<string, Set<string>>(); // service -> session ids using it
  private sessions = new Set<SessionCtx>(); // connected views (for crash/stop cleanup)
  private restartAttempts = new Map<string, number>();

  constructor(configs: ServiceConfig[]) {
    for (const config of configs) {
      this.states.set(config.name, { config, status: "inactive", allTools: [] });
    }
  }

  // ===== session registration =====

  addSession(ctx: SessionCtx): void {
    this.sessions.add(ctx);
  }

  /** A session disconnected: drop its refs and GC any now-unused, non-keepAlive process. */
  removeSession(ctx: SessionCtx): void {
    this.sessions.delete(ctx);
    for (const [name, set] of this.refs) {
      if (set.delete(ctx.id) && set.size === 0) {
        const st = this.states.get(name);
        if (st && st.status === "active" && !st.config.keepAlive) {
          this.stopProcess(name).catch(() => {});
        }
      }
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

  // ===== process layer (global, shared) =====

  /** Warm a service's process without attaching it to a session (used by autoActivate). */
  async warmup(name: string): Promise<SpawnResult> {
    return await this.ensureActive(name);
  }

  /** Spawn the process if not already running. Concurrent callers share one spawn (spawnLock). */
  private async ensureActive(name: string): Promise<SpawnResult> {
    const state = this.states.get(name);
    if (!state) return { ok: false, error: `Unknown service: ${name}` };
    if (state.status === "active") return { ok: true, allTools: state.allTools };

    let lock = this.spawnLocks.get(name);
    if (!lock) {
      lock = this.spawn(name);
      this.spawnLocks.set(name, lock);
      lock.finally(() => this.spawnLocks.delete(name)).catch(() => {});
    }
    return await lock;
  }

  private async spawn(name: string): Promise<SpawnResult> {
    const state = this.states.get(name)!;
    state.status = "activating";
    state.error = undefined;
    try {
      const conn = new ChildConnection(state.config);
      conn.onclose = () => {
        const s = this.states.get(name);
        if (s && s.status === "active") {
          s.status = "error";
          s.error = "Process exited unexpectedly";
          this.connections.delete(name);
          this.purgeFromSessions(name);
          process.stderr.write(`[gateway] ${name} crashed\n`);
          if (s.config.keepAlive) this.scheduleKeepAliveRestart(name);
        }
      };
      const allTools = await conn.connect();
      this.connections.set(name, conn);
      state.status = "active";
      state.allTools = allTools;
      state.activatedAt = Date.now();
      return { ok: true, allTools };
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      return { ok: false, error: state.error };
    }
  }

  private async stopProcess(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (conn) {
      conn.onclose = undefined;
      await conn.disconnect();
      this.connections.delete(name);
    }
    this.restartAttempts.delete(name);
    this.refs.delete(name);
    const state = this.states.get(name);
    if (state) {
      state.status = "inactive";
      state.allTools = [];
      state.activatedAt = undefined;
      state.error = undefined;
    }
    this.purgeFromSessions(name);
  }

  /** Drop a service from every session view that had it in full mode (on crash/stop). */
  private purgeFromSessions(name: string): void {
    for (const ctx of this.sessions) {
      if (ctx.fullMode.has(name)) {
        ctx.registry.unregisterService(name);
        ctx.fullMode.delete(name);
        ctx.notify();
      }
    }
  }

  private addRef(name: string, sid: string): void {
    let s = this.refs.get(name);
    if (!s) {
      s = new Set();
      this.refs.set(name, s);
    }
    s.add(sid);
  }

  /**
   * Respawn a crashed keepAlive service with exponential backoff (1s→…→30s cap),
   * giving up after 5 consecutive failures. Only restarts from "error" state, so an
   * intentional stop (which sets "inactive") cancels the loop.
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
      if (!st || st.status !== "error") return; // stopped meanwhile → cancel
      const r = await this.ensureActive(name);
      if (!r.ok) {
        this.scheduleKeepAliveRestart(name);
      } else {
        this.restartAttempts.delete(name);
        process.stderr.write(`[gateway] ${name} keepAlive: restarted ✓\n`);
      }
    }, delay);
  }

  // ===== helpers =====

  private filterToolsByGroups(allTools: Tool[], config: ServiceConfig, groups: string[]): Tool[] {
    if (!config.groups) return allTools;
    const allowedNames = new Set<string>();
    for (const group of groups) {
      const toolNames = config.groups[group];
      if (toolNames) for (const name of toolNames) allowedNames.add(name);
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

  // ===== session-aware management =====

  /** Ensure process is up (global, shared), then update THIS session's view. */
  async activate(
    name: string,
    lazy: boolean,
    groups: string[] | undefined,
    ctx: SessionCtx
  ): Promise<CallToolResult> {
    const r = await this.ensureActive(name);
    if (!r.ok) {
      return { content: [{ type: "text", text: `Failed to activate ${name}: ${r.error}` }], isError: true };
    }
    const state = this.states.get(name)!;
    const allTools = r.allTools;
    this.addRef(name, ctx.id);

    if (lazy) {
      // demote: clear any prior full-mode registration in this session
      if (ctx.fullMode.has(name)) {
        ctx.registry.unregisterService(name);
        ctx.fullMode.delete(name);
        ctx.notify();
      }
      const text = [
        `✓ ${name} activated [lazy] — ${allTools.length} tools available (0 registered in context)`,
        "",
        `⚠️ IMPORTANT: You MUST call tools({service: "${name}"}) first to see available tools and their parameters before calling any tool. Do NOT guess tool names or parameters.`,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    }

    // full mode: register schemas into THIS session's registry only
    const tools =
      groups && groups.length > 0 && state.config.groups
        ? this.filterToolsByGroups(allTools, state.config, groups)
        : allTools;
    ctx.registry.unregisterService(name);
    ctx.registry.registerService(name, tools);
    ctx.fullMode.set(name, groups && groups.length > 0 ? groups : undefined);
    ctx.notify();

    const groupInfo = groups && groups.length > 0 ? ` [${groups.join(", ")}]` : "";
    const countInfo = groups && groups.length > 0 ? `${tools.length}/${allTools.length}` : `${tools.length}`;
    const text = [
      `✓ ${name} activated [full]${groupInfo} — ${countInfo} tools registered in your context:`,
      "",
      ...this.formatToolLines(tools),
      "",
      `Use call({service: "${name}", tool: "<name>", args: {...}}) to call these tools.`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }

  /** Remove from THIS session's view; stop the shared process only if unused and not keepAlive. */
  async deactivate(name: string, ctx: SessionCtx): Promise<CallToolResult> {
    const state = this.states.get(name);
    if (!state) {
      return { content: [{ type: "text", text: `Unknown service: ${name}` }], isError: true };
    }

    if (ctx.fullMode.has(name)) {
      ctx.registry.unregisterService(name);
      ctx.fullMode.delete(name);
      ctx.notify();
    }
    this.refs.get(name)?.delete(ctx.id);
    const stillUsed = (this.refs.get(name)?.size ?? 0) > 0;

    if (state.status === "active" && !stillUsed && !state.config.keepAlive) {
      await this.stopProcess(name);
      return { content: [{ type: "text", text: `✓ ${name} deactivated (process stopped)` }] };
    }

    const why = state.config.keepAlive
      ? " — process stays warm (always-on)"
      : stillUsed
        ? " — process still in use by another session"
        : "";
    return { content: [{ type: "text", text: `✓ ${name} removed from your view${why}` }] };
  }

  /** Global: kill + respawn the process. Session views keep their (stable) tool names. */
  async restart(name: string): Promise<CallToolResult> {
    const state = this.states.get(name);
    if (!state) {
      return { content: [{ type: "text", text: `Unknown service: ${name}` }], isError: true };
    }
    const conn = this.connections.get(name);
    if (conn) {
      conn.onclose = undefined;
      await conn.disconnect();
      this.connections.delete(name);
    }
    state.status = "inactive";
    const r = await this.ensureActive(name);
    return r.ok
      ? { content: [{ type: "text", text: `✓ ${name} restarted (${r.allTools.length} tools)` }] }
      : { content: [{ type: "text", text: `Failed to restart ${name}: ${r.error}` }], isError: true };
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
      const n = this.refs.get(name)?.size ?? 0;
      results.push(`${name}: ${healthy ? "healthy" : "unhealthy"} (pid: ${conn.pid ?? "?"}, ${n} session${n === 1 ? "" : "s"})`);
    }
    return { content: [{ type: "text", text: results.join("\n") || "no active services" }] };
  }

  async handleManagementCall(
    toolName: string,
    args: Record<string, unknown> | undefined,
    ctx: SessionCtx
  ): Promise<CallToolResult> {
    switch (toolName) {
      case "services": {
        const lines = this.getAllStates().map((s) => {
          const name = s.config.name;
          const uptime = s.activatedAt ? `${Math.round((Date.now() - s.activatedAt) / 1000)}s` : "-";
          let mode = "";
          if (s.status === "active") {
            const groups = ctx.fullMode.get(name);
            mode = ctx.fullMode.has(name) ? (groups ? ` [full:${groups.join(",")}]` : " [full]") : " [lazy]";
          }
          const tc =
            s.status === "active"
              ? `${s.allTools.length}${ctx.fullMode.has(name) ? "" : " (0 in context)"}`
              : "0";
          return `${name}: ${s.status}${mode} | tools: ${tc} | uptime: ${uptime}${s.error ? ` | error: ${s.error}` : ""}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "activate": {
        const lazy = args?.lazy !== false; // default true
        const rawGroups = args?.groups;
        let groups: string[] | undefined;
        if (Array.isArray(rawGroups)) groups = rawGroups as string[];
        else if (typeof rawGroups === "string") {
          try {
            groups = JSON.parse(rawGroups);
          } catch {
            groups = [rawGroups];
          }
        }
        return await this.activate(args?.name as string, lazy, groups, ctx);
      }

      case "tools": {
        const service = args?.service as string;
        if (!service) {
          return { content: [{ type: "text", text: "'service' is required" }], isError: true };
        }
        const state = this.states.get(service);
        if (!state) {
          return { content: [{ type: "text", text: `Unknown service: "${service}"` }], isError: true };
        }
        if (state.status !== "active") {
          return {
            content: [{ type: "text", text: `Service "${service}" is ${state.status}. Activate it first.` }],
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

        const filterNote = filter ? ` (filter: "${filter}")` : "";
        const text = [
          `${service} — ${tools.length} tools${filterNote}:`,
          "",
          ...this.formatToolLines(tools),
          "",
          `Use call({service: "${service}", tool: "<name>", args: {...}}) to call these tools.`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "deactivate":
        return await this.deactivate(args?.name as string, ctx);

      case "restart":
        return await this.restart(args?.name as string);

      case "health":
        return await this.health();

      case "add": {
        const name = args?.name as string;
        const command = args?.command as string;
        if (!name || !command) {
          return { content: [{ type: "text", text: "Both 'name' and 'command' are required" }], isError: true };
        }
        if (this.states.has(name)) {
          return { content: [{ type: "text", text: `Service "${name}" already exists` }], isError: true };
        }
        const newConfig: ServiceConfig = {
          name,
          command,
          args: (args?.args as string[]) ?? [],
          env: (args?.env as Record<string, string>) ?? {},
          autoActivate: false,
        };
        this.states.set(name, { config: newConfig, status: "inactive", allTools: [] });

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
          return { content: [{ type: "text", text: "'name' is required" }], isError: true };
        }
        if (!this.states.has(name)) {
          return { content: [{ type: "text", text: `Unknown service: "${name}"` }], isError: true };
        }
        if (this.states.get(name)!.status === "active") {
          await this.stopProcess(name);
        }
        this.states.delete(name);

        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as GatewayConfig;
        raw.services = raw.services.filter((s) => s.name !== name);
        saveConfig(raw);

        return { content: [{ type: "text", text: `✓ "${name}" removed from gateway` }] };
      }

      case "call": {
        const service = args?.service as string;
        const tool = args?.tool as string;
        let toolArgs = (args?.args as Record<string, unknown>) ?? {};
        if (typeof toolArgs === "string") {
          try {
            toolArgs = JSON.parse(toolArgs);
          } catch {
            // keep as-is
          }
        }
        if (!service || !tool) {
          return { content: [{ type: "text", text: "Both 'service' and 'tool' are required" }], isError: true };
        }
        const state = this.states.get(service);
        if (!state) {
          return { content: [{ type: "text", text: `Unknown service: "${service}"` }], isError: true };
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
          return { content: [{ type: "text", text: `No connection for service "${service}"` }], isError: true };
        }
        return await conn.callTool(tool, toolArgs);
      }

      default:
        return { content: [{ type: "text", text: `Unknown management tool: ${toolName}` }], isError: true };
    }
  }

  async shutdown(): Promise<void> {
    for (const [, conn] of this.connections) {
      conn.onclose = undefined;
      await conn.disconnect();
    }
    this.connections.clear();
  }
}
