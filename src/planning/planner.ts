import { newId } from "../shared/ids.js";
import { sha256 } from "../shared/canonical.js";
import { AelvoError } from "../shared/errors/index.js";
import type { TaskRecord, TaskService } from "../tasks/service.js";

export interface PlanStep {
  id: string;
  description: string;
  dependsOn: string[];
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
}

/** Reject malformed plans before any task is created. */
export function validatePlan(plan: Plan): void {
  if (plan.goal.trim().length === 0) {
    throw new AelvoError("TASK_INVALID", "Plan goal is required");
  }
  if (plan.steps.length === 0) {
    throw new AelvoError("TASK_INVALID", "Plan has no steps");
  }
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (step.id.trim().length === 0) throw new AelvoError("TASK_INVALID", "Plan step id is required");
    if (ids.has(step.id)) throw new AelvoError("TASK_INVALID", `Duplicate plan step id: ${step.id}`);
    if (step.description.trim().length === 0) {
      throw new AelvoError("TASK_INVALID", `Plan step ${step.id} has no description`);
    }
    ids.add(step.id);
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        throw new AelvoError("TASK_INVALID", `Plan step ${step.id} depends on unknown step ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new AelvoError("TASK_DEPENDENCY_CYCLE", "Plan contains a cycle");
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    done.add(id);
  };
  for (const step of plan.steps) visit(step.id);
}

/**
 * Deterministic plan extraction. A request that explicitly enumerates steps is
 * turned into a dependency chain; anything else stays a single step rather
 * than inventing structure the user did not ask for.
 */
export function planFromRequest(input: string): Plan {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const enumerated = lines
    .map((line) => /^(?:\d+[.)]|[-*])\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter((value): value is string => value !== undefined);
  const steps = enumerated.length >= 2 ? enumerated : [input.trim()];
  return {
    goal: input.trim(),
    steps: steps.map((description, index) => ({
      id: `s${index + 1}`,
      description,
      dependsOn: index === 0 ? [] : [`s${index}`],
    })),
  };
}

/**
 * Materialize a plan as durable tasks with real dependency edges. Idempotency
 * keys make retrying the same plan return the existing tasks.
 */
export function materializePlan(plan: Plan, tasks: TaskService): TaskRecord[] {
  validatePlan(plan);
  const goalHash = sha256(plan.goal);
  const created: TaskRecord[] = [];
  const byStep = new Map<string, TaskRecord>();
  const remaining = [...plan.steps];
  while (remaining.length > 0) {
    const index = remaining.findIndex((step) => step.dependsOn.every((dependency) => byStep.has(dependency)));
    if (index === -1) throw new AelvoError("TASK_DEPENDENCY_CYCLE", "Plan dependencies cannot be scheduled");
    const [step] = remaining.splice(index, 1);
    if (step === undefined) break;
    const task = tasks.enqueue({
      kind: "plan_step",
      payload: { goal: plan.goal, stepId: step.id, description: step.description },
      dependencies: step.dependsOn.map((dependency) => byStep.get(dependency)?.id).filter((id): id is string => id !== undefined),
      idempotencyKey: `plan:${goalHash}:${step.id}`,
    });
    tasks.addSteps(task.id, [{ description: step.description }]);
    byStep.set(step.id, task);
    created.push(task);
  }
  return created;
}

export function newPlanStep(description: string, dependsOn: string[] = []): PlanStep {
  return { id: newId("ps"), description, dependsOn };
}
