import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from "./registry.js";

export interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  autoActivate?: boolean;
  /** Always-on: respawn with backoff if the process crashes (for stateful singletons). */
  keepAlive?: boolean;
  groups?: Record<string, string[]>;
}

export interface GatewayConfig {
  services: ServiceConfig[];
}

export type ServiceStatus = "inactive" | "activating" | "active" | "error";

/** Global, shared process state for a service (one per service, all sessions see it). */
export interface ServiceState {
  config: ServiceConfig;
  status: ServiceStatus;
  allTools: Tool[];
  activatedAt?: number;
  error?: string;
}

export interface ToolRoute {
  service: string;
  originalName: string;
}

/**
 * Per-connection view. Process liveness is global, but which services this
 * particular session has promoted to full (schema-injected) mode — and the
 * resulting ListTools — is private to the session.
 */
export interface SessionCtx {
  id: string;
  registry: ToolRegistry;
  /** service name -> groups (or undefined for all tools); presence = full mode here */
  fullMode: Map<string, string[] | undefined>;
  /** sendToolListChanged for just this session's server */
  notify: () => void;
}
