import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createTestApp, type TestApp } from "./helpers.js";
import { startBridge, type BridgeHandle } from "../../src/runtime/bridge/server.js";

type Message = { type: string; [key: string]: unknown };

interface TestClient {
  ws: WebSocket;
  next(predicate?: (message: Message) => boolean, timeoutMs?: number): Promise<Message>;
  close(): void;
}

const resources: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (resources.length > 0) await resources.pop()?.();
});

function client(url: string, options: WebSocket.ClientOptions = {}): TestClient {
  const ws = new WebSocket(url, options);
  const queue: Message[] = [];
  const waiters: Array<{ predicate: (message: Message) => boolean; resolve: (message: Message) => void; timer: NodeJS.Timeout }> = [];
  // The receiver reports an oversize payload as a socket error; the test that
  // sends one asserts the close code instead.
  ws.on("error", () => undefined);
  ws.on("message", (data) => {
    const message = JSON.parse(String(data)) as Message;
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) {
      queue.push(message);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    ws,
    next(predicate = () => true, timeoutMs = 4_000) {
      const index = queue.findIndex(predicate);
      if (index !== -1) {
        const [message] = queue.splice(index, 1);
        if (message !== undefined) return Promise.resolve(message);
      }
      return new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for bridge message")), timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
    close() {
      ws.close();
    },
  };
}

async function start(turns: Parameters<typeof createTestApp>[0] = []): Promise<{
  app: TestApp;
  bridge: BridgeHandle;
  clients: TestClient[];
}> {
  const app = await createTestApp(turns);
  const bridge = await startBridge({
    runtime: {
      startRun: (input, hooks) => app.app.startRun(input, hooks ?? {}),
      cancel: (runId) => app.app.cancel(runId),
      resolveApproval: (approvalId, approved) => app.app.resolveApproval(approvalId, approved),
      searchMemory: (query, limit) => app.app.searchMemory(query, limit),
      state: () => app.app.state(),
      subscribe: (listener) => app.app.subscribe(listener),
    },
    logger: app.app.logger,
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: ["http://localhost:5173"],
    dataDir: app.dataDir,
    token: "test-token",
  });
  const clients: TestClient[] = [];
  resources.push(async () => {
    for (const item of clients) item.close();
    await bridge.close();
    app.cleanup();
  });
  return { app, bridge, clients };
}

function newClient(clients: TestClient[], url: string, options?: WebSocket.ClientOptions): TestClient {
  const created = client(url, options);
  clients.push(created);
  return created;
}

describe("local bridge", () => {
  it("requires authentication before any command", async () => {
    const { bridge, clients } = await start();
    const socket = newClient(clients, bridge.url);
    await socket.next((message) => message.type === "ready");
    socket.ws.send(JSON.stringify({ type: "state.get" }));
    const error = await socket.next((message) => message.type === "error");
    expect((error.error as { code: string }).code).toBe("SERVER_UNAUTHORIZED");
  });

  it("rejects a wrong token and closes the socket", async () => {
    const { bridge, clients } = await start();
    const socket = newClient(clients, bridge.url);
    await socket.next((message) => message.type === "ready");
    socket.ws.send(JSON.stringify({ type: "auth", token: "wrong" }));
    const error = await socket.next((message) => message.type === "error");
    expect((error.error as { code: string }).code).toBe("SERVER_UNAUTHORIZED");
    const code = await new Promise<number>((resolve) => socket.ws.on("close", resolve));
    expect(code).toBe(4401);
  });

  it("rejects a disallowed origin at upgrade time", async () => {
    const { bridge, clients } = await start();
    const socket = newClient(clients, bridge.url, { origin: "http://evil.example" });
    const status = await new Promise<number>((resolve, reject) => {
      socket.ws.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.ws.on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("streams events and returns state after authenticating", async () => {
    const { bridge, clients } = await start([{ kind: "text", text: "Hello from the bridge." }]);
    const socket = newClient(clients, bridge.url);
    await socket.next((message) => message.type === "ready");
    socket.ws.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await socket.next((message) => message.type === "authenticated");

    socket.ws.send(JSON.stringify({ type: "state.get" }));
    const state = await socket.next((message) => message.type === "state");
    expect((state.runtime as { provider: { name: string } }).provider.name).toBe("mock");

    socket.ws.send(JSON.stringify({ type: "subscribe", topics: ["run", "message"] }));
    socket.ws.send(JSON.stringify({ type: "run.start", input: "say hello" }));
    await socket.next((message) => message.type === "run.accepted");
    const delta = await socket.next((message) => message.type === "event" && (message.event as { type: string }).type === "message.delta");
    expect((delta.event as { text: string }).text).toContain("Hello");
    const final = await socket.next((message) => message.type === "run.state");
    expect(final.status).toBe("completed");
  });

  it("closes a connection that exceeds the message size cap", async () => {
    const { bridge, clients } = await start();
    const socket = newClient(clients, bridge.url);
    await socket.next((message) => message.type === "ready");
    socket.ws.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await socket.next((message) => message.type === "authenticated");
    const code = new Promise<number>((resolve) => socket.ws.on("close", resolve));
    socket.ws.send(JSON.stringify({ type: "state.get", padding: "x".repeat(70 * 1024) }));
    expect([1009, 4400]).toContain(await code);
  });
});
