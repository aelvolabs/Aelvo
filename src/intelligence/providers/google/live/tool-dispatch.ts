import type {
  ApprovalRequest,
  ToolCall,
  ToolExecutionRecord,
} from "../../../../shared/contracts/index.js";
import type { ApprovalService } from "../../../../security/approvals/service.js";
import type { ToolContext } from "../../../../tools/registry/types.js";
import { AelvoError } from "../../../../shared/errors/index.js";
import type { ProviderFunctionCall } from "../../types.js";

export interface LiveToolRuntime {
  executeToolCalls(
    calls: ToolCall[],
    context: ToolContext,
    options?: {
      approvalByCall?: Record<string, string>;
      signalsByCall?: Record<string, AbortSignal>;
    },
  ): Promise<ToolExecutionRecord[]>;
}

export interface LiveToolDispatcherCallbacks {
  onResult(record: ToolExecutionRecord, sendResponse: boolean): void;
  onApprovalRequired(call: ToolCall, approval: ApprovalRequest): void;
}

export type LiveCallState =
  | "queued"
  | "executing"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

interface TrackedCall {
  call: ToolCall;
  state: LiveCallState;
  argumentsKey: string;
  context: ToolContext;
  record?: ToolExecutionRecord | undefined;
  approval?: ApprovalRequest | undefined;
  controller?: AbortController | undefined;
  cancellationRequested?: boolean | undefined;
}

function asToolCall(call: ProviderFunctionCall): ToolCall {
  return { id: call.id, name: call.name, arguments: call.args };
}

function responseFor(record: ToolExecutionRecord): Record<string, unknown> {
  if (record.status === "succeeded") {
    return {
      ok: true,
      summary: record.outcome?.summary ?? "",
      data: record.outcome?.data ?? null,
    };
  }
  return {
    ok: false,
    error: record.error ?? {
      code: record.status === "cancelled" ? "EXECUTION_ABORTED" : "EXECUTION_FAILED",
      message: `Tool ${record.call.name} ended with ${record.status}`,
    },
  };
}

function failedRecord(call: ToolCall, code: string, message: string): ToolExecutionRecord {
  return {
    call,
    status: "failed",
    error: { code, message },
    durationMs: 0,
    attempts: 0,
  };
}

/**
 * Bridges Live function calls into the one authoritative governed execution
 * path. It owns only Live-specific identity, deduplication and approval
 * bookkeeping; policy, approvals, evidence and verification remain in the
 * existing coordinator/executor.
 */
export class LiveToolDispatcher {
  private readonly runtime: LiveToolRuntime;
  private readonly approvals: ApprovalService;
  private readonly callbacks: LiveToolDispatcherCallbacks;
  private readonly maxTrackedCalls: number;
  private readonly tracked = new Map<string, TrackedCall>();
  private readonly pendingCancellations = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: {
    runtime: LiveToolRuntime;
    approvals: ApprovalService;
    callbacks: LiveToolDispatcherCallbacks;
    maxTrackedCalls?: number;
  }) {
    this.runtime = options.runtime;
    this.approvals = options.approvals;
    this.callbacks = options.callbacks;
    this.maxTrackedCalls = Math.max(16, options.maxTrackedCalls ?? 256);
  }

  /** Serialize batches so two server messages cannot run the same call concurrently. */
  dispatch(calls: ProviderFunctionCall[], context: ToolContext): Promise<void> {
    const run = this.tail.then(async () => {
      if (this.closed) return;
      await this.dispatchNow(calls, context);
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async resolveApproval(
    approvalId: string,
    approved: boolean,
    decidedBy: "user" | "cli" | "bridge" | "system" | "model" = "user",
  ): Promise<void> {
    if (this.closed) throw new Error("Live tool dispatcher is closed");
    if (decidedBy === "model") {
      throw new AelvoError("APPROVAL_INVALID", "Model output cannot approve or deny Live tool calls");
    }
    const entry = [...this.tracked.values()].find(
      (candidate) => candidate.approval?.id === approvalId,
    );
    if (entry === undefined || entry.state !== "waiting_approval" || entry.approval === undefined) {
      throw new Error("No Live tool call is waiting for this approval");
    }

    if (!approved) {
      this.approvals.deny(approvalId, decidedBy);
      this.finish(entry, {
        call: entry.call,
        status: "denied",
        error: { code: "TOOL_DENIED", message: "The user denied this action" },
        durationMs: 0,
        attempts: 0,
      }, true);
      return;
    }

    this.approvals.approve(approvalId, decidedBy);
    entry.state = "executing";
    try {
      const records = await this.runtime.executeToolCalls([entry.call], entry.context, {
        approvalByCall: { [entry.call.id]: approvalId },
        signalsByCall: entry.controller === undefined ? {} : { [entry.call.id]: entry.controller.signal },
      });
      const record = records[0] ?? failedRecord(entry.call, "EXECUTION_FAILED", "No tool result returned");
      this.finish(entry, record, true);
    } catch (error) {
      this.finish(
        entry,
        failedRecord(
          entry.call,
          "EXECUTION_FAILED",
          error instanceof Error ? error.message : String(error),
        ),
        true,
      );
    }
  }

  /** Cancel only what the provider actually cancelled; completed effects are not undone. */
  cancel(ids: string[]): void {
    for (const id of ids) {
      const entry = this.tracked.get(id);
      if (entry === undefined) {
        this.pendingCancellations.add(id);
        if (this.pendingCancellations.size > this.maxTrackedCalls) {
          const oldest = this.pendingCancellations.values().next().value;
          if (oldest !== undefined) this.pendingCancellations.delete(oldest);
        }
        continue;
      }
      if (entry.state === "completed" || entry.state === "failed") {
        // The external effect already happened. Keep the completed record so a
        // reconnect retry is answered from deduplication rather than re-run.
        continue;
      }
      if (entry.state === "waiting_approval" && entry.approval !== undefined) {
        this.approvals.deny(entry.approval.id);
      }
      entry.cancellationRequested = true;
      entry.controller?.abort(new Error("Live provider cancelled the tool call"));
      entry.state = "cancelled";
      this.callbacks.onResult(
        {
          call: entry.call,
          status: "cancelled",
          error: { code: "EXECUTION_ABORTED", message: "The provider cancelled this tool call" },
          durationMs: 0,
          attempts: 0,
        },
        false,
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.tracked.values()) {
      if (entry.state === "waiting_approval" && entry.approval !== undefined) {
        this.approvals.deny(entry.approval.id);
      }
      entry.controller?.abort(new Error("Live session closed"));
    }
  }

  stateOf(callId: string): LiveCallState | undefined {
    return this.tracked.get(callId)?.state;
  }

  private async dispatchNow(calls: ProviderFunctionCall[], context: ToolContext): Promise<void> {
    const candidates: TrackedCall[] = [];
    const seen = new Set<string>();
    for (const call of calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      if (this.pendingCancellations.has(call.id)) {
        this.callbacks.onResult(
          {
            call: asToolCall(call),
            status: "cancelled",
            error: { code: "EXECUTION_ABORTED", message: "The provider cancelled this tool call" },
            durationMs: 0,
            attempts: 0,
          },
          false,
        );
        continue;
      }
      const argumentsKey = JSON.stringify(call.args);
      const existing = this.tracked.get(call.id);
      if (existing !== undefined) {
        if (existing.argumentsKey !== argumentsKey) {
          this.callbacks.onResult(
            failedRecord(
              asToolCall(call),
              "LIVE_PROTOCOL_INVALID",
              "A reused function-call id changed its arguments; refusing to execute it again",
            ),
            true,
          );
          continue;
        }
        if (existing.state === "completed" || existing.state === "failed") {
          // A reconnect can replay the same call id. Return the recorded
          // outcome; never execute the external action twice.
          const record = existing.record ?? failedRecord(asToolCall(call), "EXECUTION_FAILED", "Missing cached result");
          this.callbacks.onResult(record, true);
        } else if (existing.state === "waiting_approval" && existing.approval !== undefined) {
          this.callbacks.onApprovalRequired(existing.call, existing.approval);
        }
        continue;
      }
      const tracked: TrackedCall = {
        call: {
          id: call.id,
          name: call.name,
          arguments: call.args,
        },
        state: "queued",
        argumentsKey,
        context,
      };
      this.tracked.set(call.id, tracked);
      candidates.push(tracked);
    }

    if (candidates.length === 0) return;

    for (const entry of candidates) {
      entry.state = "executing";
      entry.controller = new AbortController();
    }

    const contextWithSignals: ToolContext = context;
    const signalsByCall = Object.fromEntries(
      candidates.flatMap((entry) =>
        entry.controller === undefined ? [] : [[entry.call.id, entry.controller.signal] as const],
      ),
    );

    let records: ToolExecutionRecord[];
    try {
      records = await this.runtime.executeToolCalls(
        candidates.map((entry) => entry.call),
        contextWithSignals,
        { signalsByCall },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      records = candidates.map((entry) =>
        failedRecord(entry.call, "EXECUTION_FAILED", message),
      );
    }

    const byId = new Map(records.map((record) => [record.call.id, record]));
    for (const entry of candidates) {
      const record = byId.get(entry.call.id) ?? failedRecord(entry.call, "EXECUTION_FAILED", "No tool result returned");
      if (entry.cancellationRequested === true) {
        this.finish(entry, record, false, false);
      } else {
        this.finish(entry, record, record.status !== "approval_required");
      }
      if (record.status === "approval_required" && record.approval !== undefined) {
        this.callbacks.onApprovalRequired(entry.call, record.approval);
      }
    }
    this.prune();
  }

  private finish(
    entry: TrackedCall,
    record: ToolExecutionRecord,
    sendResponse: boolean,
    notify = true,
  ): void {
    entry.record = record;
    entry.approval = record.approval;
    entry.state =
      entry.cancellationRequested === true
        ? "cancelled"
        : record.status === "succeeded"
          ? "completed"
          : record.status === "cancelled"
            ? "cancelled"
            : record.status === "approval_required"
              ? "waiting_approval"
              : "failed";
    if (entry.state !== "waiting_approval") entry.controller = undefined;
    if (notify) this.callbacks.onResult(record, sendResponse);
  }

  private prune(): void {
    if (this.tracked.size <= this.maxTrackedCalls) return;
    for (const [key, entry] of this.tracked) {
      if (entry.state === "completed" || entry.state === "failed" || entry.state === "cancelled") {
        this.tracked.delete(key);
        if (this.tracked.size <= this.maxTrackedCalls) break;
      }
    }
  }
}

export function liveToolResponse(record: ToolExecutionRecord): {
  id: string;
  name: string;
  response: Record<string, unknown>;
} {
  return { id: record.call.id, name: record.call.name, response: responseFor(record) };
}

