import { z } from "zod";
import type { Db, SqlValue } from "../storage/db.js";
import { newId, nowIso } from "../shared/ids.js";
import { AelvoError } from "../shared/errors/index.js";

export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "approval_blocked",
  "retryable",
  "interrupted",
  "needs_reconciliation",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export interface TaskRecord {
  id: string;
  kind: string;
  status: TaskStatus;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  priority: number;
  dependencies: string[];
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lockedBy: string | null;
  effectUncertain: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskRow {
  id: string;
  kind: string;
  status: TaskStatus;
  payload: string;
  idempotency_key: string | null;
  priority: number;
  dependencies: string;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_by: string | null;
  effect_uncertain: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "cancelled", "approval_blocked"],
  running: ["completed", "failed", "retryable", "cancelled", "interrupted", "needs_reconciliation", "approval_blocked"],
  completed: [],
  failed: ["retryable", "queued"],
  cancelled: [],
  approval_blocked: ["queued", "running", "cancelled"],
  retryable: ["running", "cancelled", "failed"],
  interrupted: ["queued", "cancelled", "needs_reconciliation"],
  needs_reconciliation: ["queued", "completed", "failed", "cancelled"],
};

function toRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    idempotencyKey: row.idempotency_key,
    priority: row.priority,
    dependencies: JSON.parse(row.dependencies) as string[],
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockedBy: row.locked_by,
    effectUncertain: row.effect_uncertain === 1,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface EnqueueInput {
  kind: string;
  payload?: Record<string, unknown>;
  dependencies?: string[];
  priority?: number;
  idempotencyKey?: string;
  maxAttempts?: number;
  availableAt?: string;
}

export interface StepInput {
  description: string;
}

export interface TaskStep {
  id: string;
  taskId: string;
  position: number;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result: string | null;
}

/**
 * Durable task store. SQLite is the source of truth; the event bus only
 * mirrors changes. A claimed task is marked effect-uncertain until it is
 * verified complete, so a crash cannot cause a silent duplicate side effect.
 */
export class TaskService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  enqueue(input: EnqueueInput): TaskRecord {
    if (input.kind.trim().length === 0) {
      throw new AelvoError("TASK_INVALID", "Task kind is required");
    }
    const dependencies = input.dependencies ?? [];
    if (input.idempotencyKey !== undefined) {
      const existing = this.db.get<TaskRow>("SELECT * FROM tasks WHERE idempotency_key = ?", [input.idempotencyKey]);
      if (existing !== undefined) return toRecord(existing);
    }
    const now = nowIso();
    const id = newId("task");
    this.assertDependenciesValid(id, dependencies);
    this.db.run(
      "INSERT INTO tasks (id, kind, status, payload, idempotency_key, priority, dependencies, attempts, max_attempts, available_at, locked_by, effect_uncertain, last_error, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, NULL, 0, NULL, ?, ?)",
      [
        id,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        input.idempotencyKey ?? null,
        input.priority ?? 0,
        JSON.stringify(dependencies),
        input.maxAttempts ?? 3,
        input.availableAt ?? now,
        now,
        now,
      ],
    );
    return this.require(id);
  }

  /** Reject missing dependencies, self-dependency and cycles before insert. */
  private assertDependenciesValid(id: string, dependencies: string[]): void {
    if (new Set(dependencies).size !== dependencies.length) {
      throw new AelvoError("TASK_INVALID", "Duplicate dependencies are not allowed");
    }
    if (dependencies.includes(id)) {
      throw new AelvoError("TASK_DEPENDENCY_CYCLE", "A task cannot depend on itself");
    }
    const edges = new Map<string, string[]>();
    for (const row of this.db.all<{ id: string; dependencies: string }>("SELECT id, dependencies FROM tasks")) {
      edges.set(row.id, JSON.parse(row.dependencies) as string[]);
    }
    for (const dependency of dependencies) {
      if (!edges.has(dependency)) {
        throw new AelvoError("TASK_INVALID", `Unknown dependency: ${dependency}`);
      }
    }
    edges.set(id, dependencies);
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (node: string): void => {
      if (done.has(node)) return;
      if (visiting.has(node)) {
        throw new AelvoError("TASK_DEPENDENCY_CYCLE", "Dependency graph contains a cycle");
      }
      visiting.add(node);
      for (const next of edges.get(node) ?? []) visit(next);
      visiting.delete(node);
      done.add(node);
    };
    for (const node of edges.keys()) visit(node);
  }

  get(id: string): TaskRecord | undefined {
    const row = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  require(id: string): TaskRecord {
    const task = this.get(id);
    if (task === undefined) throw new AelvoError("TASK_NOT_FOUND", `Unknown task: ${id}`);
    return task;
  }

  list(options: { status?: TaskStatus; limit?: number } = {}): TaskRecord[] {
    const params: SqlValue[] = [];
    let where = "";
    if (options.status !== undefined) {
      where = "WHERE status = ?";
      params.push(options.status);
    }
    params.push(options.limit ?? 100);
    return this.db
      .all<TaskRow>(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`, params)
      .map(toRecord);
  }

  /**
   * Claim the next eligible task atomically. Dependencies must be completed.
   * Claiming marks the task running and effect-uncertain in the same write.
   */
  claimNext(workerId: string): TaskRecord | undefined {
    return this.db.transaction(() => {
      const now = nowIso();
      const candidates = this.db.all<TaskRow>(
        "SELECT * FROM tasks WHERE status IN ('queued','retryable') AND available_at <= ? ORDER BY priority DESC, created_at ASC LIMIT 50",
        [now],
      );
      for (const candidate of candidates) {
        const dependencies = JSON.parse(candidate.dependencies) as string[];
        const satisfied = dependencies.every((dependencyId) => {
          const dependency = this.db.get<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id = ?", [dependencyId]);
          return dependency?.status === "completed";
        });
        if (!satisfied) continue;
        this.db.run(
          "UPDATE tasks SET status = 'running', locked_by = ?, attempts = attempts + 1, effect_uncertain = 1, updated_at = ? WHERE id = ?",
          [workerId, now, candidate.id],
        );
        return this.require(candidate.id);
      }
      return undefined;
    });
  }

  /** Mark a task complete only after the caller verified the effect. */
  complete(id: string): TaskRecord {
    const task = this.require(id);
    this.assertTransition(task.status, "completed");
    this.db.run(
      "UPDATE tasks SET status = 'completed', effect_uncertain = 0, locked_by = NULL, updated_at = ? WHERE id = ?",
      [nowIso(), id],
    );
    return this.require(id);
  }

  fail(id: string, error: string, retryable: boolean, backoffMs = 1_000): TaskRecord {
    const task = this.require(id);
    const now = nowIso();
    if (task.effectUncertain && retryable) {
      this.assertTransition(task.status, "needs_reconciliation");
      this.db.run(
        "UPDATE tasks SET status = 'needs_reconciliation', last_error = ?, locked_by = NULL, updated_at = ? WHERE id = ?",
        [error, now, id],
      );
      return this.require(id);
    }
    if (retryable && task.attempts < task.maxAttempts) {
      this.assertTransition(task.status, "retryable");
      this.db.run(
        "UPDATE tasks SET status = 'retryable', last_error = ?, locked_by = NULL, effect_uncertain = 0, available_at = ?, updated_at = ? WHERE id = ?",
        [error, new Date(Date.now() + backoffMs).toISOString(), now, id],
      );
      return this.require(id);
    }
    this.assertTransition(task.status, "failed");
    this.db.run(
      "UPDATE tasks SET status = 'failed', last_error = ?, locked_by = NULL, updated_at = ? WHERE id = ?",
      [error, now, id],
    );
    return this.require(id);
  }

  cancel(id: string): TaskRecord {
    const task = this.require(id);
    this.assertTransition(task.status, "cancelled");
    this.db.run(
      "UPDATE tasks SET status = 'cancelled', locked_by = NULL, updated_at = ? WHERE id = ?",
      [nowIso(), id],
    );
    return this.require(id);
  }

  /** Reconcile a task whose side effect may or may not have happened. */
  resolveReconciliation(id: string, outcome: "completed" | "failed" | "queued"): TaskRecord {
    const task = this.require(id);
    if (task.status !== "needs_reconciliation" && task.status !== "interrupted") {
      throw new AelvoError("TASK_TRANSITION_INVALID", "Task is not awaiting reconciliation");
    }
    this.assertTransition(task.status, outcome);
    this.db.run(
      "UPDATE tasks SET status = ?, effect_uncertain = 0, locked_by = NULL, available_at = ?, updated_at = ? WHERE id = ?",
      [outcome, nowIso(), nowIso(), id],
    );
    return this.require(id);
  }

  /**
   * Restart recovery. A task that was running when the process died keeps
   * effect_uncertain = 1 and is never retried automatically.
   */
  recover(): { interrupted: number; needingReconciliation: number } {
    const now = nowIso();
    const running = this.db.all<{ id: string; effect_uncertain: number }>(
      "SELECT id, effect_uncertain FROM tasks WHERE status = 'running'",
    );
    return this.db.transaction(() => {
      let needingReconciliation = 0;
      for (const task of running) {
        if (task.effect_uncertain === 1) {
          needingReconciliation += 1;
          this.db.run(
            "UPDATE tasks SET status = 'needs_reconciliation', locked_by = NULL, last_error = 'process restarted during execution', updated_at = ? WHERE id = ?",
            [now, task.id],
          );
        } else {
          this.db.run(
            "UPDATE tasks SET status = 'interrupted', locked_by = NULL, last_error = 'process restarted', updated_at = ? WHERE id = ?",
            [now, task.id],
          );
        }
      }
      return { interrupted: running.length - needingReconciliation, needingReconciliation };
    });
  }

  addSteps(taskId: string, steps: StepInput[]): TaskStep[] {
    this.require(taskId);
    return this.db.transaction(() =>
      steps.map((step, index) => {
        const id = newId("step");
        this.db.run(
          "INSERT INTO task_steps (id, task_id, position, description, status, result, updated_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?)",
          [id, taskId, index, step.description, nowIso()],
        );
        return {
          id,
          taskId,
          position: index,
          description: step.description,
          status: "pending" as const,
          result: null,
        };
      }),
    );
  }

  updateStep(stepId: string, status: TaskStep["status"], result?: string): void {
    this.db.run("UPDATE task_steps SET status = ?, result = ?, updated_at = ? WHERE id = ?", [
      status,
      result ?? null,
      nowIso(),
      stepId,
    ]);
  }

  steps(taskId: string): TaskStep[] {
    return this.db
      .all<{ id: string; task_id: string; position: number; description: string; status: TaskStep["status"]; result: string | null }>(
        "SELECT * FROM task_steps WHERE task_id = ? ORDER BY position",
        [taskId],
      )
      .map((row) => ({
        id: row.id,
        taskId: row.task_id,
        position: row.position,
        description: row.description,
        status: row.status,
        result: row.result,
      }));
  }

  private assertTransition(from: TaskStatus, to: TaskStatus): void {
    if (!TRANSITIONS[from].includes(to)) {
      throw new AelvoError("TASK_TRANSITION_INVALID", `Invalid task transition ${from} -> ${to}`);
    }
  }
}
