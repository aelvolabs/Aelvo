import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";
import type { ScriptedTurn } from "../../src/intelligence/providers/mock/gateway.js";
import { AelvoApplication } from "../../src/app.js";
import { testConfig } from "./helpers.js";
import { silentLogger } from "../../src/observability/logger.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function app(turns: ScriptedTurn[] = []): Promise<TestApp> {
  const created = await createTestApp(turns);
  cleanups.push(created.cleanup);
  return created;
}

describe("run coordinator", () => {
  it("executes a tool through the governed executor and continues the loop", async () => {
    const { app: runtime, workspace } = await app([
      { kind: "calls", calls: [{ name: "write_file", args: { path: "hello.txt", content: "hi" } }] },
      { kind: "text", text: "File written." },
    ]);
    const result = await runtime.startRun("write hello.txt");
    expect(result.status).toBe("completed");
    expect(result.output).toBe("File written.");
    expect(readFileSync(join(workspace, "hello.txt"), "utf8")).toBe("hi");
    expect(runtime.gateway.requests).toHaveLength(2);
    const events = runtime.runs.events(result.runId);
    expect(events.some((event) => event.type === "tool.finished")).toBe(true);
    expect(events.some((event) => event.type === "run.completed")).toBe(true);
  });

  it("executes a dependency-aware multi-call batch through the graph with real effects", async () => {
    const { app: runtime, workspace } = await app([
      {
        kind: "calls",
        calls: [
          { name: "write_file", args: { path: "a.txt", content: "alpha" } },
          { name: "write_file", args: { path: "b.txt", content: "beta" } },
          { name: "read_file", args: { path: "a.txt" } },
        ],
      },
      { kind: "text", text: "Both files handled." },
    ]);
    const result = await runtime.startRun("write two files and read one");
    expect(result.status).toBe("completed");
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("alpha");
    expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("beta");
    expect(runtime.coordinator.stats()).toMatchObject({ graphBatches: 1, graphToolCalls: 3 });
    const events = runtime.runs.events(result.runId);
    expect(events.filter((event) => event.type === "tool.finished")).toHaveLength(3);
  });

  it("blocks a dependent tool when its prerequisite fails, without hiding the failure", async () => {
    const { app: runtime, workspace } = await app([
      {
        kind: "calls",
        calls: [
          { name: "read_file", args: { path: "missing.txt" } },
          { name: "read_file", args: { path: "missing.txt" } },
          { name: "write_file", args: { path: "independent.txt", content: "ok" } },
        ],
      },
      { kind: "text", text: "Partial result." },
    ]);
    const result = await runtime.startRun("trigger a failure");
    expect(result.status).toBe("completed");
    expect(readFileSync(join(workspace, "independent.txt"), "utf8")).toBe("ok");
    expect(runtime.coordinator.stats().graphToolCalls).toBe(3);
    const finished = runtime.runs
      .events(result.runId)
      .filter((event) => event.type === "tool.finished");
    expect(finished.some((event) => event.type === "tool.finished" && event.status === "failed")).toBe(true);
  });

  it("executes a text-encoded tool call through the same governed executor", async () => {
    const { app: runtime, workspace } = await app([
      {
        kind: "text",
        text: '```json\n{"tool":"write_file","args":{"path":"parsed.txt","content":"from text"}}\n```',
      },
      { kind: "text", text: "Parsed call executed." },
    ]);
    const result = await runtime.startRun("use a text-form tool call");
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Parsed call executed.");
    expect(readFileSync(join(workspace, "parsed.txt"), "utf8")).toBe("from text");
    const events = runtime.runs.events(result.runId);
    expect(events.filter((event) => event.type === "tool.finished")).toHaveLength(1);
  });

  it("pauses for approval and completes only after the user approves", async () => {
    const { app: runtime, workspace } = await app([
      {
        kind: "calls",
        calls: [{ name: "write_file", args: { path: "../approved.txt", content: "ok" } }],
      },
      { kind: "text", text: "Written after approval." },
    ]);
    const paused = await runtime.startRun("write outside");
    expect(paused.status).toBe("waiting_for_approval");
    expect(paused.approval?.capability).toBe("fs.write");
    const resumed = await runtime.resolveApproval(paused.approval?.id ?? "", true);
    expect(resumed.status).toBe("completed");
    expect(existsSync(join(workspace, "..", "approved.txt"))).toBe(true);
  });

  it("does not perform the action when the user denies it", async () => {
    const { app: runtime, workspace } = await app([
      { kind: "calls", calls: [{ name: "delete_path", args: { path: "keep.txt" } }] },
      { kind: "text", text: "Not deleted." },
    ]);
    const file = join(workspace, "keep.txt");
    writeFileSync(file, "keep");
    const paused = await runtime.startRun("delete keep.txt");
    expect(paused.status).toBe("waiting_for_approval");
    const resumed = await runtime.resolveApproval(paused.approval?.id ?? "", false);
    expect(resumed.status).toBe("completed");
    expect(existsSync(file)).toBe(true);
  });

  it("fails honestly when the provider errors", async () => {
    const { app: runtime } = await app([{ kind: "error", error: new Error("provider exploded") }]);
    const result = await runtime.startRun("hello");
    expect(result.status).toBe("failed");
    expect(runtime.runs.require(result.runId).errorCode).toBe("EXECUTION_FAILED");
  });

  it("refuses to resume a run from an earlier process", async () => {
    const { app: runtime } = await app();
    await expect(
      runtime.coordinator.run({ input: "x", plan: false, resumeRunId: "run_other" }),
    ).rejects.toThrowError(/cannot be resumed across processes/);
  });

  it("materializes a plan as durable dependent tasks without calling the model", async () => {
    const { app: runtime } = await app();
    const result = await runtime.coordinator.run({ input: "1. first\n2. second", plan: true });
    expect(result.status).toBe("completed");
    expect(runtime.gateway.requests).toHaveLength(0);
    const tasks = runtime.tasks.list();
    expect(tasks).toHaveLength(2);
    expect(tasks.some((task) => task.dependencies.length === 1)).toBe(true);
  });
});

describe("task runner", () => {
  it("runs a durable task through the coordinator and marks it complete", async () => {
    const { app: runtime } = await app([{ kind: "text", text: "Task finished." }]);
    const task = runtime.tasks.enqueue({ kind: "chat", payload: { input: "do the task" } });
    const outcomes = await runtime.runDueTasks(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("completed");
    expect(runtime.tasks.require(task.id).status).toBe("completed");
  });

  it("refuses a task that needs approval instead of leaving it running", async () => {
    const { app: runtime, workspace } = await app([
      { kind: "calls", calls: [{ name: "delete_path", args: { path: "x.txt" } }] },
    ]);
    writeFileSync(join(workspace, "x.txt"), "x");
    const task = runtime.tasks.enqueue({ kind: "chat", payload: { input: "delete x.txt" } });
    const outcomes = await runtime.runDueTasks(1);
    expect(outcomes[0]?.status).toBe("approval_required");
    const failed = runtime.tasks.require(task.id);
    expect(failed.status).toBe("failed");
    expect(existsSync(join(workspace, "x.txt"))).toBe(true);
  });
});

describe("unconfigured runtime", () => {
  it("fails a run with PROVIDER_NOT_CONFIGURED rather than simulating a reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "aelvo-unconf-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const runtime = await AelvoApplication.create({
      config: testConfig(workspace, join(root, "data")),
      logger: silentLogger,
      packageRoot: root,
    });
    try {
      const result = await runtime.startRun("hello");
      expect(result.status).toBe("failed");
      expect(runtime.runs.require(result.runId).errorCode).toBe("PROVIDER_NOT_CONFIGURED");
      expect(runtime.state().provider).toMatchObject({ name: "unconfigured", configured: false });
    } finally {
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
