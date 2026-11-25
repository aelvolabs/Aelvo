import { useEffect, useRef, useState, useCallback } from "react";
import type { UIEvent, ConnectionStatus } from "../types";
import { useSettings } from "../context/SettingsContext";

interface UseWebSocketReturn {
  status: ConnectionStatus;
  lastError: string | null;
  events: UIEvent[];
  lastEvent: UIEvent | null;
  clearEvents: () => void;
  reconnect: () => void;
  sendMessage: (message: string) => boolean;
  sendCommand: (type: string, payload?: Record<string, unknown>) => boolean;
  resolveApproval: (approvalId: string, approved: boolean) => boolean;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null ? (value as RecordValue) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function uiEvent(type: string, action: string, data: RecordValue = {}): UIEvent {
  const icons: Record<string, string> = {
    agent_response: "✓",
    agent_error: "✕",
    agent_delta: "…",
    approval_required: "!",
    tool_event: "⚙",
    run_started: "▶",
    run_cancelled: "■",
    task_updated: "▣",
    system_notice: "•",
  };
  const colors: Record<string, string> = {
    agent_response: "#22c55e",
    agent_error: "#ef4444",
    agent_delta: "#64748b",
    approval_required: "#f59e0b",
    tool_event: "#3b82f6",
    run_started: "#8b5cf6",
    run_cancelled: "#64748b",
    task_updated: "#0ea5e9",
    system_notice: "#64748b",
  };
  return {
    type,
    source: "runtime",
    specialist: "AELVO",
    action,
    data,
    timestamp: Date.now() / 1000,
    icon: icons[type] ?? "•",
    color: colors[type] ?? "#64748b",
  };
}

/**
 * Adapt the bridge's typed runtime protocol to the compact UI event shape.
 * Only messages the server actually emits are rendered; nothing is simulated.
 */
export function toUiEvent(message: unknown): UIEvent | null {
  const envelope = record(message);
  if (!envelope) return null;

  if (envelope.type === "event") {
    const event = record(envelope.event);
    if (!event) return null;
    switch (event.type) {
      case "message.delta":
        return uiEvent("agent_delta", text(event.text), event);
      case "run.started":
        return uiEvent("run_started", "Run started", event);
      case "run.completed":
        return uiEvent("agent_response", text(event.output) || "(no output)", event);
      case "run.failed": {
        const error = record(event.error);
        return uiEvent("agent_error", text(error?.message) || "Run failed", event);
      }
      case "run.cancelled":
        return uiEvent("run_cancelled", "Run cancelled", event);
      case "run.waiting_for_approval": {
        const approval = record(event.approval);
        return uiEvent(
          "approval_required",
          text(approval?.summary) || text(approval?.reason) || "Approval required",
          event,
        );
      }
      case "tool.started":
        return uiEvent("tool_event", `${text(event.tool)} started`, event);
      case "tool.finished":
        return uiEvent(
          "tool_event",
          `${text(event.tool)} ${event.ok === true ? "completed" : "failed"}`,
          event,
        );
      case "task.updated":
        return uiEvent("task_updated", `Task ${text(event.taskId)}: ${text(event.status)}`, event);
      case "system.notice":
        return uiEvent("system_notice", text(event.message), event);
      default:
        return uiEvent(text(event.type) || "runtime_event", text(event.type), event);
    }
  }

  if (envelope.type === "run.state") {
    const status = text(envelope.status);
    if (status === "completed") {
      return uiEvent("agent_response", text(envelope.output) || "(no output)", envelope);
    }
    if (status === "failed") {
      return uiEvent("agent_error", "Run failed", envelope);
    }
    return null;
  }

  if (envelope.type === "error") {
    const error = record(envelope.error);
    return uiEvent("agent_error", text(error?.message) || "Bridge error", envelope);
  }

  return null;
}

export function useWebSocket(): UseWebSocketReturn {
  const { config } = useSettings();
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [lastError, setLastError] = useState<string | null>(null);
  const [events, setEvents] = useState<UIEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<UIEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current || !mountedRef.current) return;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (mountedRef.current) connect();
    }, config.reconnectDelay);
  }, [config.reconnectDelay]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (!mountedRef.current) return;

    setStatus("connecting");
    setLastError(config.token ? null : "Set the bridge token (aelvo serve writes it to dataDir/bridge-token).");

    try {
      const ws = new WebSocket(config.url);

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close();
          return;
        }
        if (!config.token) {
          setStatus("error");
          setLastError("Bridge token missing. Append ?token=<token> to the UI URL or set VITE_BRIDGE_TOKEN.");
          ws.close();
          return;
        }
        // The bridge requires an auth-first handshake before any command.
        ws.send(JSON.stringify({ type: "auth", token: config.token }));
      };

      ws.onmessage = (event: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const message = record(JSON.parse(event.data));
          if (!message) return;
          if (message.type === "ready") {
            setStatus(config.token ? "connecting" : "error");
            return;
          }
          if (message.type === "authenticated") {
            setStatus("connected");
            setLastError(null);
            return;
          }
          if (message.type === "error") {
            const error = record(message.error);
            const detail = text(error?.message) || "Bridge error";
            setLastError(detail);
            if (text(error?.code) === "SERVER_UNAUTHORIZED") setStatus("error");
          }
          const adapted = toUiEvent(message);
          if (adapted) {
            setLastEvent(adapted);
            setEvents((prev) => {
              const next = [...prev, adapted];
              return next.length > config.maxEvents
                ? next.slice(next.length - config.maxEvents)
                : next;
            });
          }
        } catch (error) {
          console.warn("Ignoring malformed WebSocket message:", error);
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setStatus((current) => (current === "error" ? "error" : "disconnected"));
        wsRef.current = null;
        if (!config.token) return;
        scheduleReconnect();
      };

      ws.onerror = () => {
        if (!mountedRef.current) return;
        setStatus("error");
        ws.close();
      };

      wsRef.current = ws;
    } catch {
      if (mountedRef.current) {
        setStatus("error");
        scheduleReconnect();
      }
    }
  }, [config.url, config.token, config.reconnectDelay, config.maxEvents, scheduleReconnect]);

  const sendMessage = useCallback((message: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || status !== "connected") return false;
    try {
      ws.send(JSON.stringify({ type: "run.start", input: message }));
      return true;
    } catch {
      return false;
    }
  }, [status]);

  const sendCommand = useCallback((type: string, payload?: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || status !== "connected") return false;
    try {
      ws.send(JSON.stringify({ type, ...(payload || {}) }));
      return true;
    } catch {
      return false;
    }
  }, [status]);

  const resolveApproval = useCallback((approvalId: string, approved: boolean): boolean => {
    return sendCommand("approval.resolve", { approvalId, approved });
  }, [sendCommand]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setLastEvent(null);
  }, []);

  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    connect();
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { status, lastError, events, lastEvent, clearEvents, reconnect, sendMessage, sendCommand, resolveApproval };
}
