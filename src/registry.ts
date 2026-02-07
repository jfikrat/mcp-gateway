import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRoute } from "./types.js";

export class ToolRegistry {
  private routes = new Map<string, ToolRoute>();
  private serviceTools = new Map<string, Tool[]>();

  registerService(service: string, tools: Tool[]): void {
    const prefixed: Tool[] = tools.map((tool) => ({
      ...tool,
      name: `${service}_${tool.name}`,
    }));

    // Store prefixed tools for this service
    this.serviceTools.set(service, prefixed);

    // Build route map
    for (const tool of tools) {
      const prefixedName = `${service}_${tool.name}`;
      this.routes.set(prefixedName, {
        service,
        originalName: tool.name,
      });
    }
  }

  unregisterService(service: string): void {
    const tools = this.serviceTools.get(service);
    if (tools) {
      for (const tool of tools) {
        this.routes.delete(tool.name);
      }
    }
    this.serviceTools.delete(service);
  }

  resolve(prefixedName: string): ToolRoute | undefined {
    return this.routes.get(prefixedName);
  }

  getAllTools(): Tool[] {
    const all: Tool[] = [];
    for (const tools of this.serviceTools.values()) {
      all.push(...tools);
    }
    return all;
  }

  getServiceToolCount(service: string): number {
    return this.serviceTools.get(service)?.length ?? 0;
  }
}
