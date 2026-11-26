import type { TaskService, TaskRecord } from "../../tasks/service.js";
import type { RunCoordinator } from "../coordinator/run-coordinator.js";
import type { Logger } from "../../observability/logger.js";
import type { RecoveryManager } from "../recovery/manager.js";
import type { PolicyService } from "../../security/policies/policy.js";
import type { AuditLog } from "../../security/audit/log.js";

export interface TaskRunOutcome {
  taskId: string;
  runId?: string;
  status: "completed" | "failed" | "skipped" | "approval_required";
  detail: string;
}

export interface TaskRunnerOptions {
  tasks: TaskService;
  coordinator: RunCoordinator;
  logger: Logger;
  recovery?: RecoveryManager;
  policy?: PolicyService;
  audit?: AuditLog;
}

const EXECUTABLE_KINDS = new Set(["plan_step", "chat", "reminder"]);

/**
 * Executes durable tasks through the same coordinator, executor and policy as
 * an interactive turn. A task never runs a tool directly and never invents a
 * result: its run must complete with evidence, or the task fails.
 */
export class TaskRunner {
  private readonly options: TaskRunnerOptions;

  constructor(options: TaskRunnerOptions) {
    this.options = options;
  }

  private inputFor(task: TaskRecord): string | undefined {
    if (typeof task.payload.input === "string" && task.payload.input.trim().length > 0) {
      return task.payload.input;
    }
    if (typeof task.payload.description === "string" && task.payload.description.trim().length > 0) {
      const goal = typeof task.payload.goal === "string" ? task.payload.goal : undefined;
      return goal === undefined ? task.payload.description : `Goal: ${goal}\nStep: ${task.payload.description}`;
    }
    return undefined;
  }

  async runOne(workerId = "task-runner"): Promise<TaskRunOutcome | undefined> {
    const { tasks, coordinator, logger, policy, audit } = this.options;
    if (policy?.isEmergencyStopActive()) {
      audit?.record({
        origin: "task",
        actor: "system",
        action: "task.run",
        decision: "deny",
        decisionReason: "Emergency stop is active; background task execution suspended",
      });
      return undefined;
    }

    const task = tasks.claimNext(workerId);
    if (task === undefined) return undefined;

    if (!EXECUTABLE_KINDS.has(task.kind)) {
      tasks.fail(task.id, `No runner is registered for task kind "${task.kind}"`, false);
      return { taskId: task.id, status: "failed", detail: `Unsupported task kind: ${task.kind}` };
    }
    const input = this.inputFor(task);
    if (input === undefined) {
      tasks.fail(task.id, "Task payload has no executable instruction", false);
      return { taskId: task.id, status: "failed", detail: "Task payload has no input or description" };
    }

    const [step] = tasks.steps(task.id);
    if (step !== undefined) tasks.updateStep(step.id, "running");
    const { recovery } = this.options;
    recovery?.saveCheckpoint(task.id, "pre_run", {
      taskId: task.id,
      kind: task.kind,
      payload: task.payload,
      attempts: task.attempts,
      status: task.status,
    });

    let result;
    try {
      result = await coordinator.run(
        { input, plan: false },
        {},
        { origin: "task", taskId: task.id },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const evaluation = recovery?.evaluateFailure({ scopeId: task.id, error: message, retryCount: task.attempts });
      tasks.fail(task.id, message, evaluation?.retryable ?? true);
      logger.warn({ taskId: task.id, recovery: evaluation?.reason }, `Task execution failed: ${message}`);
      recovery?.clearCheckpoints(task.id);
      return {
        taskId: task.id,
        status: "failed",
        detail: evaluation === undefined ? message : `${message} [${evaluation.reason}]`,
      };
    }

    if (result.status === "completed") {
      if (step !== undefined) tasks.updateStep(step.id, "completed", result.output ?? "");
      tasks.complete(task.id);
      recovery?.clearCheckpoints(task.id);
      return { taskId: task.id, runId: result.runId, status: "completed", detail: "Run completed with verified output" };
    }

    if (result.status === "waiting_for_approval") {
      // Approval state is intentionally in-memory and per-process; a durable
      // task must not silently resume a privileged action after a restart.
      coordinator.cancel(result.runId);
      if (step !== undefined) tasks.updateStep(step.id, "failed", "Approval required; rerun interactively");
      tasks.fail(task.id, "Task requires interactive approval", false);
      recovery?.clearCheckpoints(task.id);
      return {
        taskId: task.id,
        runId: result.runId,
        status: "approval_required",
        detail: "Task requires interactive approval and was not executed",
      };
    }

    const detail = `Run ended with status ${result.status}`;
    if (step !== undefined) tasks.updateStep(step.id, "failed", detail);
    const evaluation = recovery?.evaluateFailure({ scopeId: task.id, error: detail, retryCount: task.attempts });
    tasks.fail(task.id, detail, result.status === "cancelled" ? false : evaluation?.retryable ?? true);
    recovery?.clearCheckpoints(task.id);
    return {
      taskId: task.id,
      runId: result.runId,
      status: "failed",
      detail: evaluation === undefined ? detail : `${detail} [${evaluation.reason}]`,
    };
  }

  async runDue(limit = 1): Promise<TaskRunOutcome[]> {
    if (this.options.policy?.isEmergencyStopActive()) {
      this.options.audit?.record({
        origin: "task",
        actor: "system",
        action: "task.run_due",
        decision: "deny",
        decisionReason: "Emergency stop is active; due task batch suspended",
      });
      return [];
    }
    const outcomes: TaskRunOutcome[] = [];
    for (let index = 0; index < limit; index += 1) {
      const outcome = await this.runOne();
      if (outcome === undefined) break;
      outcomes.push(outcome);
      if (outcome.status === "approval_required") break;
    }
    return outcomes;
  }
}
