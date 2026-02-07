import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  autoActivate?: boolean;
  timeout?: number; // connection timeout ms, default 30000
}

export interface GatewayConfig {
  services: ServiceConfig[];
}

export type ServiceStatus = "inactive" | "activating" | "active" | "error";

export interface ServiceState {
  config: ServiceConfig;
  status: ServiceStatus;
  tools: Tool[];
  activatedAt?: number;
  error?: string;
}

export interface ToolRoute {
  service: string;
  originalName: string;
}
