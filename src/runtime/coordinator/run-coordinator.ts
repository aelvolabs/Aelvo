import { newId } from "../../shared/ids.js";
import {
  type ApprovalRequest,
  type RunStatus,
  type RuntimeEvent,
  type RuntimeRequest,
  type ToolExecutionRecord,
} from "../../shared/contracts/index.js";
import { AelvoError, asAelvoError, toPublicError } from "../../shared/errors/index.js";
import type { ProviderFunctionCall, ProviderGateway, ProviderMessage } from "../../intelligence/providers/types.js";
import type { ContextBuilder } from "../../intelligence/context/context-builder.js";
import type { MemoryService } from "../../memory/service.js";
import type { ToolExecutor } from "../../tools/executor/executor.js";
import type { ToolRegistry } from "../../tools/registry/registry.js";
import type { Logger } from "../../observability/logger.js";
import type { EventBus } from "../events/bus.js";
import type { RunStore } from "../execution/run-store.js";
import type { RunVerifier } from "../verification/verifier.js";
import type { ApprovalService } from "../../security/approvals/service.js";
import type { TaskService } from "../../tasks/service.js";
import { materializePlan, planFromRequest } from "../../planning/planner.js";
import { ToolGraphExecutor } from "../execution/tool-graph.js";
import { parseModelOutput } from "../../intelligence/parsing/model-output.js";

export interface CoordinatorDeps {
  gateway: ProviderGateway;
  registry: ToolRegistry;
  executor: ToolExecutor;
  memory: MemoryService;
  context: ContextBuilder;
  approvals: ApprovalService;
  tasks: TaskService;
  runs: RunStore;
  events: EventBus;
  verifier: RunVerifier;
  logger: Logger;
  maxSteps: number;
}

export interface RunResult {
  runId: string;
  sessionId: string;
  status: RunStatus;
  output?: string;
  approval?: ApprovalRequest;
}

export interface RunHooks {
  /** Called as soon as the durable run row exists, before model output. */
  onRunCreated?: (info: { runId: string; sessionId: string }) => void;
}

interface PendingState {
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  messages: ProviderMessage[];
  calls: ProviderFunctionCall[];
  cursor: number;
  toolExecutions: ToolExecutionRecord[];
  text: string;
  /** Approval attached to the call at `cursor`, when resuming. */
  approvalId?: string;
  deniedCallId?: string;
}

interface WaitingEntry {
  runId: string;
  approvalId: string;
}

/**
 * The single authoritative run coordinator.
 *
 * A conversational turn is one model call. Tool calls are executed through the
 * one governed executor, then returned to the same model loop. No specialist
 * stages, no simulated execution and no success state without evidence.
 */
export class RunCoordinator {
  private readonly deps: CoordinatorDeps;
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Map<string, PendingState>();
  private readonly waiting = new Map<string, WaitingEntry>();
  private readonly toolGraph: ToolGraphExecutor;
  private graphBatches = 0;
  private graphToolCalls = 0;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    this.toolGraph = new ToolGraphExecutor(deps.executor);
  }

  async run(request: RuntimeRequest, hooks: RunHooks = {}): Promise<RunResult> {
    const { memory, runs, tasks } = this.deps;
    if (request.resumeRunId !== undefined) {
      // Pending run state and approvals are intentionally process-local, so a
      // restart cannot silently resume a privileged action. Fail honestly.
      throw new AelvoError(
        "APPROVAL_INVALID",
        "Runs cannot be resumed across processes; submit a new request instead",
        { details: { resumeRunId: request.resumeRunId } },
      );
    }
    const sessionId = request.sessionId ?? memory.createSession().id;
    const session = memory.ensureSession(sessionId);
    memory.appendMessage(session.id, "user", request.input);

    const runId = newId("run");
    runs.create(runId, sessionId, request.input);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.emit(runId, { type: "run.started", runId, sessionId });
    hooks.onRunCreated?.({ runId, sessionId });

    if (request.plan) {
      try {
        const plan = planFromRequest(request.input);
        const created = materializePlan(plan, tasks);
        const output = `Planned ${created.length} step(s):\n${created
          .map((task, index) => `${index + 1}. ${String(task.payload.description ?? "")} (${task.id})`)
          .join("\n")}`;
        memory.appendMessage(sessionId, "assistant", output);
        runs.setStatus(runId, "completed", output);
        this.emit(runId, { type: "run.completed", runId, output });
        return { runId, sessionId, status: "completed", output };
      } catch (error) {
        return this.failRun(runId, error);
      } finally {
        this.controllers.delete(runId);
      }
    }

    try {
      const built = this.deps.context.build(sessionId);
      this.pending.set(runId, {
        runId,
        sessionId,
        signal: controller.signal,
        messages: built.messages,
        calls: [],
        cursor: 0,
        toolExecutions: [],
        text: "",
        ...(this.deps.gateway.capabilities().streaming ? {} : {}),
      });
      return await this.advance(runId, built.system);
    } catch (error) {
      return this.failRun(runId, error);
    } finally {
      this.controllers.delete(runId);
    }
  }

  /** Approve or deny a blocked action and continue the same run. */
  async resolveApproval(approvalId: string, approved: boolean): Promise<RunResult> {
    const waiting = this.waiting.get(approvalId);
    if (waiting === undefined) {
      throw new AelvoError("APPROVAL_INVALID", "No blocked run is waiting for this approval");
    }
    this.waiting.delete(approvalId);
    const state = this.pending.get(waiting.runId);
    if (state === undefined) {
      this.deps.approvals.deny(approvalId);
      throw new AelvoError("APPROVAL_INVALID", "Run state is no longer available");
    }
    if (approved) {
      this.deps.approvals.approve(approvalId);
      state.approvalId = approvalId;
    } else {
      this.deps.approvals.deny(approvalId);
      const call = state.calls[state.cursor];
      if (call !== undefined) state.deniedCallId = call.id;
    }
    this.deps.runs.setStatus(state.runId, "running");
    this.emit(state.runId, { type: "approval.resolved", approvalId, approved });
    try {
      return await this.advance(state.runId, this.deps.context.build(state.sessionId).system);
    } catch (error) {
      return this.failRun(state.runId, error);
    }
  }

  cancel(runId: string): void {
    const controller = this.controllers.get(runId);
    if (controller !== undefined) controller.abort(new AelvoError("EXECUTION_ABORTED", "Run cancelled by user"));
    const run = this.deps.runs.get(runId);
    if (run !== undefined && (run.status === "running" || run.status === "waiting_for_approval")) {
      this.deps.runs.setStatus(runId, "cancelled");
      this.emit(runId, { type: "run.cancelled", runId });
    }
    this.pending.delete(runId);
    for (const [approvalId, entry] of this.waiting) {
      if (entry.runId === runId) this.waiting.delete(approvalId);
    }
  }

  private async advance(runId: string, system: string): Promise<RunResult> {
    const state = this.pending.get(runId);
    if (state === undefined) {
      throw new AelvoError("TASK_NOT_FOUND", `Run state missing for ${runId}`);
    }

    for (let step = 0; step < this.deps.maxSteps; step += 1) {
      if (state.signal.aborted) throw new AelvoError("EXECUTION_ABORTED", "Run cancelled");

      if (state.calls.length === 0) {
        const response = await this.collectModelTurn(state, system);
        // Native function calling is authoritative. Text-encoded calls are a
        // fallback for providers/models that cannot emit native calls; they
        // still pass through the same policy, approval and executor gateway.
        const parsed = response.functionCalls.length === 0 ? parseModelOutput(response.text) : null;
        const functionCalls: ProviderFunctionCall[] =
          parsed?.kind === "tool_calls"
            ? parsed.calls.map((call) => ({ id: newId("call"), name: call.name, args: call.args }))
            : response.functionCalls;
        const textForHistory = parsed?.kind === "tool_calls" ? "" : response.text;
        if (textForHistory.length > 0) {
          state.text = textForHistory;
          this.deps.memory.appendMessage(state.sessionId, "assistant", textForHistory);
        }
        if (functionCalls.length === 0) {
          this.deps.verifier.verifyCompletion({ output: response.text, toolExecutions: state.toolExecutions });
          this.deps.runs.setStatus(runId, "completed", response.text);
          this.emit(runId, { type: "run.completed", runId, output: response.text });
          this.pending.delete(runId);
          return { runId, sessionId: state.sessionId, status: "completed", output: response.text };
        }
        state.calls = functionCalls;
        state.cursor = 0;
        state.messages.push({
          role: "model",
          parts: [
            ...(textForHistory.length > 0 ? [{ kind: "text" as const, text: textForHistory }] : []),
            ...functionCalls.map((call) => ({
              kind: "function_call" as const,
              id: call.id,
              name: call.name,
              args: call.args,
            })),
          ],
        });
      }

      if (
        state.calls.length >= 2 &&
        state.deniedCallId === undefined &&
        state.approvalId === undefined
      ) {
        const batch = await this.toolGraph.execute(
          state.calls.map((call) => ({ id: call.id, name: call.name, arguments: call.args })),
          { runId, sessionId: state.sessionId, signal: state.signal, userInitiated: false },
          {
            onStarted: (call) => {
              this.emit(runId, { type: "tool.started", runId, tool: call.name, callId: call.id });
            },
            onFinished: (record) => {
              this.emit(runId, {
                type: "tool.finished",
                runId,
                tool: record.call.name,
                callId: record.call.id,
                status: record.status,
                durationMs: record.durationMs,
              });
            },
          },
        );
        if (batch !== undefined) {
          this.graphBatches += 1;
          this.graphToolCalls += batch.length;
          for (const record of batch) {
            state.toolExecutions.push(record);
            state.messages.push({
              role: "user",
              parts: [
                {
                  kind: "function_response",
                  id: record.call.id,
                  name: record.call.name,
                  response:
                    record.status === "succeeded"
                      ? { ok: true, summary: record.outcome?.summary ?? "", data: record.outcome?.data ?? null }
                      : { ok: false, error: record.error ?? { code: "EXECUTION_FAILED", message: "Tool failed" } },
                },
              ],
            });
          }
          state.calls = [];
          state.cursor = 0;
          continue;
        }
      }

      while (state.cursor < state.calls.length) {
        const call = state.calls[state.cursor];
        if (call === undefined) break;

        if (state.deniedCallId === call.id) {
          state.messages.push({
            role: "user",
            parts: [{ kind: "function_response", id: call.id, name: call.name, response: { ok: false, error: { code: "APPROVAL_INVALID", message: "The user denied this action" } } }],
          });
          delete state.deniedCallId;
          state.cursor += 1;
          continue;
        }

        const approvalId = state.approvalId;
        delete state.approvalId;
        this.emit(runId, { type: "tool.started", runId, tool: call.name, callId: call.id });
        const record = await this.deps.executor.execute(
          { id: call.id, name: call.name, arguments: call.args },
          { runId, sessionId: state.sessionId, signal: state.signal, userInitiated: false },
          approvalId === undefined ? {} : { approvalId },
        );
        this.emit(runId, {
          type: "tool.finished",
          runId,
          tool: call.name,
          callId: call.id,
          status: record.status,
          durationMs: record.durationMs,
        });

        if (record.status === "approval_required" && record.approval !== undefined) {
          this.deps.runs.setStatus(runId, "waiting_for_approval");
          this.waiting.set(record.approval.id, { runId, approvalId: record.approval.id });
          this.emit(runId, { type: "run.waiting_for_approval", runId, approval: record.approval });
          return {
            runId,
            sessionId: state.sessionId,
            status: "waiting_for_approval",
            approval: record.approval,
          };
        }

        state.toolExecutions.push(record);
        state.messages.push({
          role: "user",
          parts: [
            {
              kind: "function_response",
              id: call.id,
              name: call.name,
              response:
                record.status === "succeeded"
                  ? { ok: true, summary: record.outcome?.summary ?? "", data: record.outcome?.data ?? null }
                  : { ok: false, error: record.error ?? { code: "EXECUTION_FAILED", message: "Tool failed" } },
            },
          ],
        });
        state.cursor += 1;
      }

      state.calls = [];
      state.cursor = 0;
    }

    throw new AelvoError("EXECUTION_FAILED", `Run exceeded ${this.deps.maxSteps} model steps without completing`);
  }

  private async collectModelTurn(state: PendingState, system: string) {
    const tools = this.deps.registry.descriptors();
    const request = {
      system,
      messages: state.messages,
      tools,
      signal: state.signal,
    };
    let text = "";
    let done: { text: string; functionCalls: ProviderFunctionCall[]; usage: { inputTokens: number; outputTokens: number } } | undefined;
    for await (const event of this.deps.gateway.stream(request)) {
      if (event.type === "text") {
        text += event.text;
        this.emit(state.runId, { type: "message.delta", runId: state.runId, text: event.text });
      } else if (event.type === "done") {
        done = event.response;
        this.emit(state.runId, {
          type: "provider.usage",
          provider: this.deps.gateway.name,
          model: this.deps.gateway.model,
          inputTokens: event.response.usage.inputTokens,
          outputTokens: event.response.usage.outputTokens,
        });
      }
    }
    if (done === undefined) {
      throw new AelvoError("PROVIDER_RESPONSE_INVALID", "Provider stream ended without a final response");
    }
    return { text: done.text.length > 0 ? done.text : text, functionCalls: done.functionCalls };
  }

  private failRun(runId: string, error: unknown): RunResult {
    const publicError = toPublicError(error);
    const status: RunStatus = publicError.code === "EXECUTION_ABORTED" ? "cancelled" : "failed";
    const run = this.deps.runs.get(runId);
    this.deps.runs.setStatus(runId, status, undefined, publicError.code);
    this.pending.delete(runId);
    if (status === "cancelled") {
      this.emit(runId, { type: "run.cancelled", runId });
    } else {
      this.emit(runId, { type: "run.failed", runId, error: { code: publicError.code, message: publicError.message } });
      this.deps.logger.warn({ runId, code: publicError.code }, publicError.message);
    }
    return { runId, sessionId: run?.sessionId ?? "", status };
  }

  private emit(runId: string, event: RuntimeEvent): void {
    this.deps.runs.appendEvent(runId, event);
    this.deps.events.publish(event);
  }

  status(runId: string): { runId: string; status: RunStatus; output?: string } {
    const run = this.deps.runs.get(runId);
    if (run === undefined) throw new AelvoError("TASK_NOT_FOUND", `Unknown run: ${runId}`);
    return {
      runId: run.id,
      status: run.status,
      ...(run.output === null ? {} : { output: run.output }),
    };
  }

  activeRuns(): number {
    return this.controllers.size;
  }

  stats(): { graphBatches: number; graphToolCalls: number; cacheEntries: number } {
    return {
      graphBatches: this.graphBatches,
      graphToolCalls: this.graphToolCalls,
      cacheEntries: this.deps.executor.cacheSize(),
    };
  }

  errorFor(error: unknown): { code: string; message: string } {
    const aelvo = asAelvoError(error);
    return { code: aelvo.code, message: aelvo.message };
  }
}
