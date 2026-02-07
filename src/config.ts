import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import type { GatewayConfig } from "./types.js";

const CONFIG_PATH = resolve(dirname(import.meta.dir), "gateway.config.json");

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
    svc.timeout ??= 30000;
    svc.args ??= [];
    svc.env ??= {};
  }

  return config;
}
