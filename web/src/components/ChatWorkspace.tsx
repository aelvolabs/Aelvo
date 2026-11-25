import { useState, useRef, useEffect, useCallback } from "react";
import type { UIEvent, ChatMessage } from "../types";
import { ChatMessageBubble } from "./ChatMessage";

interface ChatWorkspaceProps {
  events: UIEvent[];
  connectionStatus: string;
  lastError?: string | null;
  sendMessage?: (message: string) => boolean;
  resolveApproval?: (approvalId: string, approved: boolean) => boolean;
}

interface PendingApproval {
  id: string;
  summary: string;
}

let msgCounter = 0;

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++msgCounter}`;
}

export function ChatWorkspace({
  events,
  connectionStatus,
  lastError,
  sendMessage,
  resolveApproval,
}: ChatWorkspaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pendingAssistantRef = useRef<{ messageId: string } | null>(null);
  const lastEventCountRef = useRef(0);
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const addMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const patchMessage = useCallback((messageId: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) =>
      prev.map((message) => (message.id === messageId ? { ...message, ...patch } : message))
    );
  }, []);

  const finishPending = useCallback(() => {
    pendingAssistantRef.current = null;
    if (pendingTimeoutRef.current) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
    setIsProcessing(false);
  }, []);

  // Render only events the runtime actually emitted. No simulated pipeline.
  useEffect(() => {
    if (events.length <= lastEventCountRef.current) return;
    const fresh = events.slice(lastEventCountRef.current);
    lastEventCountRef.current = events.length;
    const pending = pendingAssistantRef.current;

    for (const event of fresh) {
      if (event.type === "agent_delta" && pending) {
        setMessages((prev) =>
          prev.map((message) => {
            if (message.id !== pending.messageId) return message;
            const prior = message.streamedContent === "Thinking…" ? "" : message.streamedContent ?? "";
            return { ...message, streamedContent: prior + event.action, streaming: true };
          })
        );
      } else if (event.type === "agent_response" && pending) {
        patchMessage(pending.messageId, {
          content: event.action,
          streamedContent: undefined,
          streaming: false,
        });
        finishPending();
      } else if (event.type === "agent_error" && pending) {
        patchMessage(pending.messageId, {
          content: `⚠️ ${event.action}`,
          streamedContent: undefined,
          streaming: false,
        });
        finishPending();
      } else if (event.type === "approval_required" && pending) {
        const approval = event.data.approval as Record<string, unknown> | undefined;
        const id = typeof approval?.id === "string" ? approval.id : "";
        if (id) {
          setPendingApproval({ id, summary: event.action });
          patchMessage(pending.messageId, {
            content: `Approval required: ${event.action}`,
            streamedContent: undefined,
            streaming: false,
          });
        }
        finishPending();
      } else if (event.type === "run_cancelled" && pending) {
        patchMessage(pending.messageId, {
          content: "Run cancelled.",
          streamedContent: undefined,
          streaming: false,
        });
        finishPending();
      }
    }
  }, [events, patchMessage, finishPending]);

  const handleSend = useCallback(() => {
    const request = input.trim();
    if (!request || isProcessing) return;
    setInput("");

    const now = Date.now() / 1000;
    addMessage({
      id: genId("user"),
      role: "user",
      content: request,
      timestamp: now,
    });

    const assistantId = genId("assistant");
    addMessage({
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: now + 0.5,
      streaming: true,
      streamedContent: "Thinking…",
    });
    setIsProcessing(true);

    // Set the event cursor before sending so no early delta is skipped.
    lastEventCountRef.current = events.length;
    if (!sendMessage || !sendMessage(request)) {
      patchMessage(assistantId, {
        content: lastError
          ? `⚠️ Not connected: ${lastError}`
          : "⚠️ Not connected to the AELVO runtime.",
        streamedContent: undefined,
        streaming: false,
      });
      setIsProcessing(false);
      return;
    }

    pendingAssistantRef.current = { messageId: assistantId };
    if (pendingTimeoutRef.current) clearTimeout(pendingTimeoutRef.current);
    pendingTimeoutRef.current = setTimeout(() => {
      if (pendingAssistantRef.current?.messageId === assistantId) {
        patchMessage(assistantId, {
          content: "⚠️ The runtime did not return a result within two minutes.",
          streamedContent: undefined,
          streaming: false,
        });
        finishPending();
      }
    }, 120_000);
  }, [input, isProcessing, addMessage, sendMessage, events.length, lastError, patchMessage, finishPending]);

  useEffect(() => {
    return () => {
      if (pendingTimeoutRef.current) {
        clearTimeout(pendingTimeoutRef.current);
        pendingTimeoutRef.current = null;
      }
    };
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const resolve = useCallback(
    (approved: boolean) => {
      if (!pendingApproval) return;
      if (!resolveApproval?.(pendingApproval.id, approved)) {
        setPendingApproval(null);
        return;
      }
      const assistantId = genId("assistant");
      addMessage({
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: Date.now() / 1000,
        streaming: true,
        streamedContent: approved ? "Approval granted. Resuming…" : "Approval denied. Closing run…",
      });
      pendingAssistantRef.current = { messageId: assistantId };
      setIsProcessing(true);
      setPendingApproval(null);
    },
    [pendingApproval, resolveApproval, addMessage]
  );

  return (
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden bg-brand-cream/60">
        <header className="border-b border-surface-border px-6 py-3 flex items-center justify-between shrink-0 bg-white/70 backdrop-blur-md">
          <h2 className="text-lg font-extrabold text-ink">Chat</h2>
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                connectionStatus === "connected"
                  ? "bg-accent-green animate-pulse-glow"
                  : connectionStatus === "connecting"
                    ? "bg-accent-amber animate-pulse"
                    : "bg-accent-red"
              }`}
            />
            <span className="text-ink-soft font-medium capitalize">{connectionStatus}</span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-lg">
                <div className="text-5xl mb-4 animate-float">◈</div>
                <h3 className="text-xl font-extrabold text-gradient mb-2">AELVO</h3>
                <p className="text-sm text-ink-soft leading-relaxed mb-6">
                  Requests run through the governed execution runtime, with tool effects,
                  approvals, and recovery state reported live. Nothing is simulated.
                </p>
                <div className="mt-6 grid grid-cols-2 gap-2 max-w-sm mx-auto">
                  {[
                    "Summarize the current workspace",
                    "List the files in this project",
                    "Explain the execution graph",
                    "Check runtime health",
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => setInput(suggestion)}
                      className="text-[10px] text-ink-soft hover:text-brand-deep hover:border-brand-orange/50 bg-white border border-surface-border rounded-lg px-2.5 py-2 text-left transition-all duration-150 shadow-soft hover:shadow-card hover:-translate-y-0.5 leading-relaxed"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto">
              {messages.map((message) => (
                <ChatMessageBubble key={message.id} message={message} />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {pendingApproval && (
          <div className="border-t border-accent-amber/30 bg-accent-amber/5 px-6 py-3 shrink-0">
            <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
              <p className="text-xs text-ink">{pendingApproval.summary}</p>
              <div className="flex gap-2 shrink-0">
                <button className="btn-ghost" onClick={() => resolve(false)}>Deny</button>
                <button className="btn-primary" onClick={() => resolve(true)}>Approve</button>
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-surface-border px-6 py-4 shrink-0 bg-white/70 backdrop-blur-md">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-end gap-3">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  isProcessing
                    ? "AELVO is processing your request..."
                    : "Ask AELVO to inspect, change, or explain the workspace..."
                }
                disabled={isProcessing}
                rows={2}
                className="input-field"
              />
              <button
                onClick={handleSend}
                disabled={isProcessing || !input.trim()}
                className="btn-primary"
              >
                {isProcessing ? (
                  <>
                    <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Working...
                  </>
                ) : (
                  <>
                    Send
                    <span className="text-xs opacity-70">↵</span>
                  </>
                )}
              </button>
            </div>
            <p className="text-[10px] text-ink-muted mt-2">
              {connectionStatus === "connected"
                ? "Connected to the authenticated runtime bridge."
                : lastError ?? "Waiting for the authenticated runtime bridge."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
