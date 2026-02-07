import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import type { GatewayConfig } from "./types.js";

export const CONFIG_PATH = resolve(dirname(import.meta.dir), "gateway.config.json");

export function saveConfig(config: GatewayConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function expandEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => {
    return process.env[a || b] ?? "";
  });
}

export function loadConfig(): GatewayConfig {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config: GatewayConfig = JSON.parse(raw);

  if (!config.services || !Array.isArray(config.services)) {
    throw new Error("Invalid config: 'services' array required");
  }

  for (const svc of config.services) {
    if (!svc.name || !svc.command) {
      throw new Error(`Invalid service config: name and command required`);
    }
    svc.autoActivate ??= false;
    svc.args = (svc.args ?? []).map(expandEnvVars);
    svc.env = Object.fromEntries(
      Object.entries(svc.env ?? {}).map(([k, v]) => [k, expandEnvVars(v)])
    );
  }

  return config;
}
