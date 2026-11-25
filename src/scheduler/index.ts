import type { Db } from "../storage/db.js";
import { newId, nowIso } from "../shared/ids.js";
import { AelvoError } from "../shared/errors/index.js";
import type { TaskRecord, TaskService } from "../tasks/service.js";

export interface ScheduleRecord {
  id: string;
  taskKind: string;
  payload: Record<string, unknown>;
  nextRunAt: string;
  everySeconds: number | null;
  enabled: boolean;
  lastTaskId: string | null;
  createdAt: string;
}

interface ScheduleRow {
  id: string;
  task_kind: string;
  payload: string;
  next_run_at: string;
  every_seconds: number | null;
  enabled: number;
  last_task_id: string | null;
  created_at: string;
}

function toRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    taskKind: row.task_kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    nextRunAt: row.next_run_at,
    everySeconds: row.every_seconds,
    enabled: row.enabled === 1,
    lastTaskId: row.last_task_id,
    createdAt: row.created_at,
  };
}

/**
 * Minimal durable scheduler for reminders and recurring workflows. It creates
 * durable tasks; it never executes work itself, so every scheduled action goes
 * through the same governance path as an interactive request.
 */
export class Scheduler {
  private readonly db: Db;
  private readonly tasks: TaskService;

  constructor(db: Db, tasks: TaskService) {
    this.db = db;
    this.tasks = tasks;
  }

  add(input: { taskKind: string; payload?: Record<string, unknown>; runAt: string; everySeconds?: number }): ScheduleRecord {
    const runAt = new Date(input.runAt);
    if (Number.isNaN(runAt.getTime())) {
      throw new AelvoError("TASK_INVALID", "runAt must be an ISO timestamp");
    }
    if (input.everySeconds !== undefined && input.everySeconds < 10) {
      throw new AelvoError("TASK_INVALID", "Recurring schedules must be at least 10 seconds apart");
    }
    const id = newId("sch");
    this.db.run(
      "INSERT INTO schedules (id, task_kind, payload, next_run_at, every_seconds, enabled, last_task_id, created_at) VALUES (?, ?, ?, ?, ?, 1, NULL, ?)",
      [
        id,
        input.taskKind,
        JSON.stringify(input.payload ?? {}),
        runAt.toISOString(),
        input.everySeconds ?? null,
        nowIso(),
      ],
    );
    return this.require(id);
  }

  list(): ScheduleRecord[] {
    return this.db.all<ScheduleRow>("SELECT * FROM schedules ORDER BY next_run_at").map(toRecord);
  }

  cancel(id: string): void {
    this.db.run("UPDATE schedules SET enabled = 0 WHERE id = ?", [id]);
  }

  require(id: string): ScheduleRecord {
    const row = this.db.get<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", [id]);
    if (row === undefined) throw new AelvoError("TASK_NOT_FOUND", `Unknown schedule: ${id}`);
    return toRecord(row);
  }

  /** Create tasks for everything due. Idempotent per schedule occurrence. */
  tick(now = new Date()): TaskRecord[] {
    const due = this.db.all<ScheduleRow>(
      "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 100",
      [now.toISOString()],
    );
    const created: TaskRecord[] = [];
    for (const schedule of due) {
      const task = this.tasks.enqueue({
        kind: schedule.task_kind,
        payload: { ...(JSON.parse(schedule.payload) as Record<string, unknown>), scheduleId: schedule.id },
        idempotencyKey: `${schedule.id}:${schedule.next_run_at}`,
      });
      created.push(task);
      const next = schedule.every_seconds === null
        ? null
        : new Date(now.getTime() + schedule.every_seconds * 1_000).toISOString();
      this.db.run("UPDATE schedules SET last_task_id = ?, next_run_at = ?, enabled = ? WHERE id = ?", [
        task.id,
        next ?? schedule.next_run_at,
        next === null ? 0 : 1,
        schedule.id,
      ]);
    }
    return created;
  }
}
