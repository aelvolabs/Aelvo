import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  MAX_BRIDGE_MESSAGE_BYTES,
  ServerCommandSchema,
  type RuntimeEvent,
  type ServerResponse,
} from "../../shared/contracts/index.js";
import { AelvoError, toPublicError } from "../../shared/errors/index.js";
import type { Logger } from "../../observability/logger.js";
import type { RunResult } from "../coordinator/run-coordinator.js";

export interface BridgeRuntime {
  startRun(input: string, hooks?: { onRunCreated?: (info: { runId: string; sessionId: string }) => void }): Promise<RunResult>;
  cancel(runId: string): void;
  resolveApproval(approvalId: string, approved: boolean): Promise<RunResult>;
  searchMemory(query: string, limit: number): unknown[];
  state(): Record<string, unknown>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}

export interface BridgeOptions {
  runtime: BridgeRuntime;
  logger: Logger;
  host: string;
  port: number;
  allowedOrigins: string[];
  dataDir: string;
  /** Injected only by tests; otherwise a fresh token is generated and stored. */
  token?: string;
}

export interface BridgeHandle {
  port: number;
  url: string;
  token: string;
  close(): Promise<void>;
}

interface ClientState {
  authed: boolean;
  authTimer: NodeJS.Timeout;
  topics: Set<string>;
  tokens: number;
  lastRefill: number;
}

const AUTH_TIMEOUT_MS = 5_000;
const RATE_BURST = 30;
const RATE_PER_SECOND = 10;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function topicFor(event: RuntimeEvent): string {
  return event.type.split(".", 1)[0] ?? event.type;
}

/**
 * Authenticated loopback bridge for the desktop UI.
 *
 * Defence in depth: loopback bind by default, origin allowlist, per-socket
 * payload cap, auth-first handshake with a per-launch token, constant-time
 * token comparison, token-bucket rate limit, and schema validation of every
 * command. Mutation commands only reach the governed runtime API.
 */
export async function startBridge(options: BridgeOptions): Promise<BridgeHandle> {
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (options.token === undefined) {
    const tokenPath = join(options.dataDir, "bridge-token");
    mkdirSync(options.dataDir, { recursive: true });
    writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      // Windows ACLs are inherited from the user's profile directory.
    }
  }

  const httpServer: Server = createServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("AELVO bridge requires a WebSocket connection");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_MESSAGE_BYTES });

  httpServer.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !options.allowedOrigins.includes(origin)) {
      options.logger.warn({ origin }, "Rejected WebSocket upgrade from disallowed origin");
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  const clients = new Map<WebSocket, ClientState>();
  const send = (ws: WebSocket, message: ServerResponse): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const sendError = (ws: WebSocket, error: unknown): void => {
    const publicError = toPublicError(error);
    send(ws, { type: "error", error: { code: publicError.code, message: publicError.message } });
  };

  const unsubscribe = options.runtime.subscribe((event) => {
    for (const [ws, state] of clients) {
      if (!state.authed) continue;
      if (state.topics.size > 0 && !state.topics.has(topicFor(event)) && !state.topics.has(event.type)) continue;
      send(ws, { type: "event", event });
    }
  });

  wss.on("connection", (ws) => {
    const state: ClientState = {
      authed: false,
      authTimer: setTimeout(() => {
        if (!state.authed) {
          send(ws, { type: "error", error: { code: "SERVER_UNAUTHORIZED", message: "Authentication timed out" } });
          ws.close(4401, "unauthenticated");
        }
      }, AUTH_TIMEOUT_MS),
      topics: new Set(),
      tokens: RATE_BURST,
      lastRefill: Date.now(),
    };
    // Timers must not keep the process alive on their own.
    state.authTimer.unref();
    clients.set(ws, state);
    send(ws, { type: "ready", authRequired: true });

    ws.on("error", (error) => {
      options.logger.warn({ err: error }, "Bridge WebSocket error");
    });

    ws.on("message", (raw) => {
      void (async () => {
        const now = Date.now();
        state.tokens = Math.min(RATE_BURST, state.tokens + ((now - state.lastRefill) / 1_000) * RATE_PER_SECOND);
        state.lastRefill = now;
        if (state.tokens < 1) {
          sendError(ws, new AelvoError("SERVER_RATE_LIMITED", "Too many bridge messages"));
          ws.close(4429, "rate limited");
          return;
        }
        state.tokens -= 1;

        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        if (Buffer.byteLength(text, "utf8") > MAX_BRIDGE_MESSAGE_BYTES) {
          sendError(ws, new AelvoError("SERVER_PAYLOAD_INVALID", "Bridge message too large"));
          ws.close(4400, "payload too large");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          sendError(ws, new AelvoError("SERVER_PAYLOAD_INVALID", "Bridge message is not valid JSON"));
          return;
        }
        const command = ServerCommandSchema.safeParse(parsed);
        if (!command.success) {
          sendError(ws, new AelvoError("SERVER_PAYLOAD_INVALID", "Unknown or malformed bridge command"));
          return;
        }

        if (command.data.type === "auth") {
          if (!safeEqual(command.data.token, token)) {
            options.logger.warn("Rejected bridge authentication");
            sendError(ws, new AelvoError("SERVER_UNAUTHORIZED", "Invalid bridge token"));
            ws.close(4401, "invalid token");
            return;
          }
          clearTimeout(state.authTimer);
          state.authed = true;
          send(ws, { type: "authenticated", sessionId: "bridge" });
          return;
        }

        if (!state.authed) {
          sendError(ws, new AelvoError("SERVER_UNAUTHORIZED", "Authenticate before sending commands"));
          return;
        }

        try {
          switch (command.data.type) {
            case "run.start": {
              let accepted = false;
              await options.runtime.startRun(command.data.input, {
                onRunCreated: ({ runId, sessionId }) => {
                  accepted = true;
                  send(ws, { type: "run.accepted", runId, sessionId });
                },
              }).then((result) => {
                send(ws, {
                  type: "run.state",
                  runId: result.runId,
                  status: result.status,
                  ...(result.output === undefined ? {} : { output: result.output }),
                });
              });
              if (!accepted) {
                sendError(ws, new AelvoError("EXECUTION_FAILED", "Run did not start"));
              }
              break;
            }
            case "run.cancel":
              options.runtime.cancel(command.data.runId);
              send(ws, { type: "run.state", runId: command.data.runId, status: "cancelled" });
              break;
            case "approval.resolve": {
              const result = await options.runtime.resolveApproval(command.data.approvalId, command.data.approved);
              send(ws, {
                type: "run.state",
                runId: result.runId,
                status: result.status,
                ...(result.output === undefined ? {} : { output: result.output }),
              });
              break;
            }
            case "memory.search":
              send(ws, { type: "memory.results", items: options.runtime.searchMemory(command.data.query, command.data.limit) });
              break;
            case "state.get":
              send(ws, { type: "state", runtime: options.runtime.state() });
              break;
            case "subscribe":
              state.topics = new Set(command.data.topics);
              break;
          }
        } catch (error) {
          sendError(ws, error);
        }
      })();
    });

    ws.on("close", () => {
      clearTimeout(state.authTimer);
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  options.logger.info({ host: options.host, port }, "AELVO bridge listening");

  return {
    port,
    url: `ws://${options.host}:${port}`,
    token,
    close: async () => {
      unsubscribe();
      for (const ws of clients.keys()) ws.close(1001, "server shutting down");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
