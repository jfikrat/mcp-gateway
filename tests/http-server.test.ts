import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startHttpServer } from "../src/http-server.js";

// Tight GC timings so the sweeper is observable inside a test run.
process.env.GATEWAY_SESSION_TTL_MS = "300";
process.env.GATEWAY_SESSION_SWEEP_MS = "100";

let baseUrl: string;
let stopServer: () => void;
let getSessions: () => Promise<number>;

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  },
});

async function openSession(): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: INIT_BODY,
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  await res.body?.cancel();
  return sid!;
}

beforeAll(async () => {
  const { port, stop } = await startHttpServer({ services: [], port: 0 });
  baseUrl = `http://127.0.0.1:${port}`;
  stopServer = stop;
  getSessions = async () => {
    const health = await fetch(`${baseUrl}/health`).then((r) => r.json());
    return (health as { sessions: number }).sessions;
  };
});

afterAll(() => {
  stopServer();
});

describe("session lifecycle", () => {
  test("initialize opens a session, DELETE closes it", async () => {
    const sid = await openSession();
    expect(await getSessions()).toBeGreaterThanOrEqual(1);

    const del = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sid },
    });
    expect(del.status).toBe(200);
    expect(await getSessions()).toBe(0);
  });

  test("request without session id is rejected", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
  });

  test("unknown session id → 404", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
  });
});

describe("idle session sweeper", () => {
  test("a session abandoned without DELETE is expired by the sweeper", async () => {
    await openSession();
    expect(await getSessions()).toBeGreaterThanOrEqual(1);

    // TTL 300ms + sweep 100ms → well within 1s the session must be gone.
    await Bun.sleep(1000);
    expect(await getSessions()).toBe(0);
  });

  test("activity keeps a session alive past the TTL", async () => {
    const sid = await openSession();

    // Touch the session every 150ms (< 300ms TTL) for ~3 TTL windows.
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(150);
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": sid,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 10 + i, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }
    expect(await getSessions()).toBeGreaterThanOrEqual(1);

    // cleanup
    await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: { "Mcp-Session-Id": sid } });
  });
});
