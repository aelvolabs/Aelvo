import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function app(): Promise<TestApp> {
  const created = await createTestApp();
  cleanups.push(created.cleanup);
  return created;
}

describe("memory", () => {
  it("supersedes an older fact with the same subject and predicate", async () => {
    const { app: runtime } = await app();
    const first = runtime.memory.remember({
      value: "likes tea",
      kind: "preference",
      subject: "user",
      predicate: "drink",
    });
    const second = runtime.memory.remember({
      value: "likes coffee",
      kind: "preference",
      subject: "user",
      predicate: "drink",
    });
    const items = runtime.memory.list({ kind: "preference" });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(second.id);
    const old = runtime.memory.get(first.id);
    expect(old?.validTo).not.toBeNull();
    expect(old?.supersededBy).toBe(second.id);
  });

  it("searches current memory and excludes deleted items", async () => {
    const { app: runtime } = await app();
    const item = runtime.memory.remember({
      value: "favourite editor is neovim",
      kind: "preference",
      subject: "user",
      predicate: "editor",
    });
    expect(runtime.memory.search("neovim")).toHaveLength(1);
    runtime.memory.delete(item.id);
    expect(runtime.memory.search("neovim")).toHaveLength(0);
  });

  it("records a correction with provenance instead of silently rewriting", async () => {
    const { app: runtime } = await app();
    const item = runtime.memory.remember({
      value: "lives in Hyderabad",
      kind: "fact",
      subject: "user",
      predicate: "city",
    });
    const corrected = runtime.memory.correct(item.id, "lives in Bengaluru");
    expect(corrected.source).toBe("user_confirmed");
    expect(corrected.value).toBe("lives in Bengaluru");
    const exported = runtime.memory.exportAll();
    expect(exported.items.some((entry) => entry.id === corrected.id)).toBe(true);
    expect(
      exported.provenance.some((entry) => entry.itemId === corrected.id && entry.origin === "user_correction"),
    ).toBe(true);
  });
});

describe("durable tasks", () => {
  it("validates dependencies, including unknown and self references", async () => {
    const { app: runtime } = await app();
    expect(() => runtime.tasks.enqueue({ kind: "plan_step", dependencies: ["task_missing"] })).toThrowError(
      /Unknown dependency/,
    );
    const task = runtime.tasks.enqueue({ kind: "plan_step", payload: { input: "step" } });
    expect(() => runtime.tasks.enqueue({ kind: "plan_step", dependencies: [task.id, task.id] })).toThrowError(
      /Duplicate dependencies/,
    );
  });

  it("marks a claimed task effect-uncertain until it is completed", async () => {
    const { app: runtime } = await app();
    runtime.tasks.enqueue({ kind: "chat", payload: { input: "hello" } });
    const claimed = runtime.tasks.claimNext("worker-1");
    expect(claimed?.status).toBe("running");
    expect(claimed?.effectUncertain).toBe(true);
    expect(claimed?.lockedBy).toBe("worker-1");
    if (claimed === undefined) throw new Error("no task claimed");
    const completed = runtime.tasks.complete(claimed.id);
    expect(completed.status).toBe("completed");
    expect(completed.effectUncertain).toBe(false);
  });

  it("rejects invalid state transitions", async () => {
    const { app: runtime } = await app();
    const task = runtime.tasks.enqueue({ kind: "chat", payload: { input: "hi" } });
    expect(() => runtime.tasks.complete(task.id)).toThrowError(/Invalid task transition/);
  });

  it("recovers interrupted tasks after a simulated crash", async () => {
    const { app: runtime } = await app();
    runtime.tasks.enqueue({ kind: "chat", payload: { input: "long job" } });
    runtime.tasks.claimNext("worker-1");
    const recovery = runtime.tasks.recover();
    expect(recovery.needingReconciliation).toBeGreaterThanOrEqual(1);
    const task = runtime.tasks.list({ status: "needs_reconciliation" })[0];
    expect(task?.lastError).toMatch(/restarted/i);
    expect(task?.effectUncertain).toBe(true);
  });

  it("creates exactly one task per schedule occurrence", async () => {
    const { app: runtime } = await app();
    const schedule = runtime.scheduler.add({
      taskKind: "reminder",
      payload: { input: "drink water" },
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const first = runtime.scheduler.tick();
    const second = runtime.scheduler.tick();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(runtime.tasks.list()).toHaveLength(1);
    expect(runtime.scheduler.require(schedule.id).enabled).toBe(false);
  });
});
