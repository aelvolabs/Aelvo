import { describe, expect, it } from "vitest";
import { toUiEvent } from "./useWebSocket";

describe("runtime bridge event adaptation", () => {
  it("adapts streamed text and completed output", () => {
    const delta = toUiEvent({
      type: "event",
      event: { type: "message.delta", runId: "run-1", text: "hello" },
    });
    expect(delta?.type).toBe("agent_delta");
    expect(delta?.action).toBe("hello");

    const completed = toUiEvent({
      type: "event",
      event: { type: "run.completed", runId: "run-1", output: "final answer" },
    });
    expect(completed?.type).toBe("agent_response");
    expect(completed?.action).toBe("final answer");
  });

  it("surfaces run failures and bridge errors instead of inventing output", () => {
    const failed = toUiEvent({
      type: "event",
      event: { type: "run.failed", runId: "run-1", error: { code: "EXECUTION_FAILED", message: "provider down" } },
    });
    expect(failed?.type).toBe("agent_error");
    expect(failed?.action).toBe("provider down");

    const error = toUiEvent({
      type: "error",
      error: { code: "SERVER_UNAUTHORIZED", message: "Invalid bridge token" },
    });
    expect(error?.type).toBe("agent_error");
    expect(error?.action).toBe("Invalid bridge token");
  });

  it("preserves approval data needed to answer the approval command", () => {
    const approval = toUiEvent({
      type: "event",
      event: {
        type: "run.waiting_for_approval",
        runId: "run-1",
        approval: { id: "approval-1", summary: "Write src/app.ts", tool: "fs.write" },
      },
    });
    expect(approval?.type).toBe("approval_required");
    expect(approval?.action).toBe("Write src/app.ts");
    expect((approval?.data.approval as { id: string }).id).toBe("approval-1");
  });

  it("ignores unrelated control messages", () => {
    expect(toUiEvent({ type: "ready", authRequired: true })).toBeNull();
    expect(toUiEvent({ type: "authenticated", sessionId: "bridge" })).toBeNull();
    expect(toUiEvent("not a message")).toBeNull();
  });
});
