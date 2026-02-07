import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceConfig } from "./types.js";

export class ChildConnection {
  private client: Client;
  private transport: StdioClientTransport;
  private _tools: Tool[] = [];

  constructor(private config: ServiceConfig) {
    this.client = new Client(
      { name: `gateway->${config.name}`, version: "1.0.0" },
      { capabilities: {} }
    );

    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
      stderr: "pipe",
    });
  }

  get pid(): number | null {
    return this.transport.pid;
  }

  get tools(): Tool[] {
    return this._tools;
  }

  set onclose(handler: (() => void) | undefined) {
    this.transport.onclose = handler;
  }

  async connect(): Promise<Tool[]> {
    await this.client.connect(this.transport);

    // Capture stderr for debugging
    const stderr = this.transport.stderr;
    if (stderr && "on" in stderr) {
      (stderr as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          process.stderr.write(`[${this.config.name}] ${line}\n`);
        }
      });
    }

    const result = await this.client.listTools();
    this._tools = result.tools;
    return this._tools;
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    return await this.client.callTool({ name, arguments: args });
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.transport.close();
    } catch {
      // ignore close errors
    }
  }
}
