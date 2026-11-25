import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextBuilder } from "../../src/intelligence/context/context-builder.js";
import { RuntimeMetrics } from "../../src/observability/metrics.js";
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

describe("context compaction", () => {
  it("drops oldest history to the budget and persists a deterministic summary", async () => {
    const { app: runtime } = await app();
    const session = runtime.memory.createSession("compaction");
    for (let index = 0; index < 40; index += 1) {
      runtime.memory.appendMessage(session.id, index % 2 === 0 ? "user" : "assistant", `message ${index} ${"x".repeat(80)}`);
    }
    const builder = new ContextBuilder({
      memory: runtime.memory,
      workspaceRoot: runtime.config.workspaceRoot,
      maxContextChars: 500,
    });
    const built = builder.build(session.id);
    expect(built.droppedMessages).toBeGreaterThan(0);
    expect(built.messages.length).toBeLessThan(40);
    expect(built.system).toContain("Earlier conversation was compacted");
    expect(runtime.memory.getSession(session.id)?.summary).toContain("Earlier conversation was compacted");
    expect(built.estimatedTokens).toBeGreaterThan(0);

    const second = builder.build(session.id);
    expect(second.system).toContain("Session summary:");
  });
});

describe("runtime metrics", () => {
  it("aggregates bounded tagged series and percentiles", () => {
    const metrics = new RuntimeMetrics(10);
    for (let value = 1; value <= 10; value += 1) {
      metrics.record("tool.execution", value, { tool: "read_file" });
    }
    const series = metrics.get("tool.execution", { tool: "read_file" });
    expect(series?.count).toBe(10);
    expect(series?.avg()).toBe(5.5);
    expect(series?.percentile(95)).toBe(10);
    expect(metrics.summary()["tool.execution[tool=read_file]"]?.count).toBe(10);
    expect(metrics.get("tool.execution", { tool: "unknown" })).toBeUndefined();
  });
});
