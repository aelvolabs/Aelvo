import {
  ExecutionGraph,
  GraphExecutionEngine,
  NodeDefinition,
  RetryPolicy,
} from "./graph.js";
import type { ToolCall, ToolExecutionRecord } from "../../shared/contracts/index.js";
import type { ToolContext } from "../../tools/registry/types.js";
import type { ToolExecutor, ToolPreview } from "../../tools/executor/executor.js";

export interface ToolGraphHooks {
  onStarted?: (call: ToolCall) => void;
  onFinished?: (record: ToolExecutionRecord) => void;
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(left: string[], right: string[]): boolean {
  for (const a of left.map(normalizePath)) {
    for (const b of right.map(normalizePath)) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    }
  }
  return false;
}

function referencesEarlier(call: ToolCall, earlier: string): boolean {
  // Legacy ArgumentRef syntax: "node_002.output.field". A reference is a real
  // data dependency, so the earlier call must finish first.
  return JSON.stringify(call.arguments).includes(`${earlier}.output`);
}

function isToolRecord(value: unknown): value is ToolExecutionRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "call" in value &&
    "status" in value &&
    "durationMs" in value
  );
}

/**
 * Executes a model tool batch through the same ExecutionGraph used by
 * multi-step work. The lightweight sequential path remains for a single call,
 * validation failures and anything requiring approval.
 *
 * Dependencies are derived, not invented: calls that touch the same or nested
 * path are ordered, and explicit `<callId>.output` references create edges.
 * Independent calls run in the same ready wave. Every node still goes through
 * the governed executor, so policy, evidence and verification are unchanged.
 */
export class ToolGraphExecutor {
  private readonly executor: ToolExecutor;

  constructor(executor: ToolExecutor) {
    this.executor = executor;
  }

  async execute(
    calls: ToolCall[],
    context: ToolContext,
    hooks: ToolGraphHooks = {},
    signalsByCall: Record<string, AbortSignal> = {},
  ): Promise<ToolExecutionRecord[] | undefined> {
    if (calls.length < 2) return undefined;
    if (new Set(calls.map((call) => call.id)).size !== calls.length) return undefined;

    const previews: ToolPreview[] = [];
    for (const call of calls) {
      const preview = this.executor.preview(call, context);
      if (preview === undefined || preview.decision.verdict !== "allow") return undefined;
      previews.push(preview);
    }

    const graph = new ExecutionGraph(`tools_${context.runId}`, "model tool batch");
    for (const call of calls) {
      graph.addNode(
        new NodeDefinition({
          id: call.id,
          description: `Tool ${call.name}`,
          nodeType: "tool_call",
          toolName: call.name,
          args: call.arguments,
          retryPolicy: new RetryPolicy({ maxRetries: 0 }),
          retryBudget: 1,
        }),
      );
    }

    for (let index = 1; index < calls.length; index += 1) {
      const call = calls[index];
      const preview = previews[index];
      if (call === undefined || preview === undefined) continue;
      for (let earlier = 0; earlier < index; earlier += 1) {
        const priorCall = calls[earlier];
        const priorPreview = previews[earlier];
        if (priorCall === undefined || priorPreview === undefined) continue;
        if (
          pathsOverlap(preview.paths, priorPreview.paths) ||
          referencesEarlier(call, priorCall.id)
        ) {
          graph.connect(priorCall.id, call.id);
        }
      }
    }

    const engine = new GraphExecutionEngine(graph, {
      runNode: async (node) => {
        const call = calls.find((candidate) => candidate.id === node.id);
        if (call === undefined) throw new Error(`Unknown tool call node ${node.id}`);
        hooks.onStarted?.(call);
        const callSignal = signalsByCall[call.id];
        const record = await this.executor.execute(
          { id: call.id, name: call.name, arguments: call.arguments },
          callSignal === undefined ? context : { ...context, signal: callSignal },
        );
        hooks.onFinished?.(record);
        if (record.status !== "succeeded") {
          throw new Error(record.error?.message ?? `Tool ${call.name} ended with ${record.status}`);
        }
        return record;
      },
    });

    await engine.execute({}, context.signal === undefined ? {} : { signal: context.signal });

    return calls.map((call) => {
      const node = graph.getNode(call.id);
      if (node?.state === "completed" && isToolRecord(node.result)) return node.result;
      return {
        call,
        status: "failed" as const,
        error: {
          code: "EXECUTION_FAILED",
          message: node?.error ?? `Tool ${call.name} was blocked by a failed dependency`,
        },
        durationMs: 0,
        attempts: 0,
      };
    });
  }
}
