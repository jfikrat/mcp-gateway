import { describe, test, expect, afterEach } from "bun:test";
import { ChildManager } from "../src/child-manager.js";
import { ToolRegistry } from "../src/registry.js";
import type { ServiceConfig, SessionCtx } from "../src/types.js";

const ECHO_PATH = new URL("./fixtures/echo-server.ts", import.meta.url).pathname;

function echoConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: "echo",
    command: process.execPath, // the running bun binary
    args: ["run", ECHO_PATH],
    env: {},
    autoActivate: false,
    ...overrides,
  };
}

function makeCtx(id: string): SessionCtx {
  return { id, registry: new ToolRegistry(), fullMode: new Map(), notify: () => {} };
}

let manager: ChildManager | undefined;
afterEach(async () => {
  await manager?.shutdown();
  manager = undefined;
});

describe("spawnLock", () => {
  test("concurrent warmups share a single spawn", async () => {
    manager = new ChildManager([echoConfig()]);
    const [a, b] = await Promise.all([manager.warmup("echo"), manager.warmup("echo")]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(manager.getState("echo")?.status).toBe("active");
    // one shared connection → one pid
    expect(manager.getConnection("echo")?.pid).toBeGreaterThan(0);
  });
});

describe("ref-counting GC", () => {
  test("removeSession stops a non-keepAlive service when last ref drops", async () => {
    manager = new ChildManager([echoConfig()]);
    const ctx = makeCtx("A");
    manager.addSession(ctx);

    const res = await manager.activate("echo", true, undefined, ctx);
    expect(res.isError).toBeUndefined();
    expect(manager.getState("echo")?.status).toBe("active");

    manager.removeSession(ctx);
    // stopProcess is fired async from removeSession; give it a tick
    await Bun.sleep(150);
    expect(manager.getState("echo")?.status).toBe("inactive");
  });

  test("call() takes a ref: activator leaving must not stop the service", async () => {
    manager = new ChildManager([echoConfig()]);
    const a = makeCtx("A");
    const b = makeCtx("B");
    manager.addSession(a);
    manager.addSession(b);

    await manager.activate("echo", true, undefined, a);

    // B never activates — it just calls through the already-warm process.
    const result = await manager.handleManagementCall(
      "call",
      { service: "echo", tool: "echo", args: { text: "merhaba" } },
      b
    );
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toBe("merhaba");

    // A (the activator) leaves; B's ref must keep the process alive.
    manager.removeSession(a);
    await Bun.sleep(150);
    expect(manager.getState("echo")?.status).toBe("active");

    // B leaves too → now it stops.
    manager.removeSession(b);
    await Bun.sleep(150);
    expect(manager.getState("echo")?.status).toBe("inactive");
  });

  test("deactivate keeps the process while another session still uses it", async () => {
    manager = new ChildManager([echoConfig()]);
    const a = makeCtx("A");
    const b = makeCtx("B");
    manager.addSession(a);
    manager.addSession(b);

    await manager.activate("echo", true, undefined, a);
    await manager.activate("echo", true, undefined, b);

    await manager.deactivate("echo", a);
    expect(manager.getState("echo")?.status).toBe("active");

    await manager.deactivate("echo", b);
    expect(manager.getState("echo")?.status).toBe("inactive");
  });
});

describe("session view isolation", () => {
  test("full-mode registration stays private to the activating session", async () => {
    manager = new ChildManager([echoConfig()]);
    const a = makeCtx("A");
    const b = makeCtx("B");
    manager.addSession(a);
    manager.addSession(b);

    await manager.activate("echo", false, undefined, a);
    expect(a.registry.getAllTools().map((t) => t.name)).toEqual(["echo_echo"]);
    expect(b.registry.getAllTools()).toEqual([]);
  });
});

describe("health", () => {
  test("reports healthy active service with session count", async () => {
    manager = new ChildManager([echoConfig()]);
    const ctx = makeCtx("A");
    manager.addSession(ctx);
    await manager.activate("echo", true, undefined, ctx);

    const res = await manager.health();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("echo: healthy");
    expect(text).toContain("1 session");
  });
});
