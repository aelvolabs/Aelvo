import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";
import { defineTool } from "../../src/tools/registry/types.js";
import { approvalDigest } from "../../src/security/approvals/service.js";
import { SandboxBridge } from "../../src/security/sandbox/index.js";
import type { ToolContext } from "../../src/tools/registry/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function app(turns: Parameters<typeof createTestApp>[0] = []): Promise<TestApp> {
  const created = await createTestApp(turns);
  cleanups.push(created.cleanup);
  return created;
}

function context(): ToolContext {
  return {
    runId: "run_test",
    sessionId: "ses_test",
    signal: new AbortController().signal,
    userInitiated: false,
  };
}

describe("sandbox boundary", () => {
  it("fails closed when the Rust sandbox binary is absent", () => {
    const bridge = new SandboxBridge(join(process.cwd(), "tests", "ts", "missing-package"));
    expect(bridge.status().available).toBe(false);
    expect(() => bridge.assertAvailable()).toThrowError(/Rust sandbox binary not built/);
  });
});

describe("policy", () => {
  it("allows reads and writes inside the workspace", async () => {
    const { app: runtime, workspace } = await app();
    const read = runtime.policy.evaluate({
      capability: "fs.read",
      resource: "a.txt",
      paths: [join(workspace, "a.txt")],
      destructive: false,
      runId: "run",
      actor: "model",
      userInitiated: false,
    });
    expect(read.verdict).toBe("allow");
  });

  it("requires approval outside the workspace and for deletion", async () => {
    const { app: runtime, workspace } = await app();
    const outside = runtime.policy.evaluate({
      capability: "fs.write",
      resource: "x",
      paths: [join(workspace, "..", "x.txt")],
      destructive: false,
      runId: "run",
      actor: "model",
      userInitiated: false,
    });
    expect(outside.verdict).toBe("approval");
    const deletion = runtime.policy.evaluate({
      capability: "fs.delete",
      resource: "x",
      paths: [join(workspace, "x.txt")],
      destructive: true,
      runId: "run",
      actor: "model",
      userInitiated: false,
    });
    expect(deletion.verdict).toBe("approval");
  });

  it("denies credential access and disabled process execution", async () => {
    const { app: runtime } = await app();
    expect(
      runtime.policy.evaluate({
        capability: "credentials",
        resource: "token",
        paths: [],
        destructive: false,
        runId: "run",
        actor: "model",
        userInitiated: false,
      }).verdict,
    ).toBe("deny");
    expect(
      runtime.policy.evaluate({
        capability: "process.exec",
        resource: "cmd",
        paths: [],
        destructive: true,
        runId: "run",
        actor: "model",
        userInitiated: false,
      }).verdict,
    ).toBe("deny");
  });
});

describe("approvals", () => {
  it("binds an approval to the digested action and allows one use", async () => {
    const { app: runtime } = await app();
    const binding = {
      runId: "run1",
      sessionId: "ses1",
      tool: "delete_path",
      capability: "fs.delete" as const,
      resource: "a.txt",
      arguments: { path: "a.txt" },
    };
    const request = runtime.approvals.request(binding, "Delete a.txt");
    runtime.approvals.approve(request.id);
    expect(() =>
      runtime.approvals.redeem(request.id, { ...binding, arguments: { path: "b.txt" } }),
    ).toThrowError(/does not match/);
    runtime.approvals.redeem(request.id, binding);
    expect(() => runtime.approvals.redeem(request.id, binding)).toThrowError(/already been used/);
    expect(approvalDigest(binding)).toHaveLength(64);
  });
});

describe("governed executor", () => {
  it("rejects invalid arguments before the tool runs", async () => {
    const { app: runtime } = await app();
    const record = await runtime.executor.execute(
      { id: "call1", name: "write_file", arguments: { path: 42 } },
      context(),
    );
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("TOOL_INPUT_INVALID");
  });

  it("executes a write only with evidence and independent verification", async () => {
    const { app: runtime, workspace } = await app();
    const record = await runtime.executor.execute(
      { id: "call2", name: "write_file", arguments: { path: "notes/a.txt", content: "hello" } },
      context(),
    );
    expect(record.status).toBe("succeeded");
    expect(record.outcome?.evidence.length).toBeGreaterThan(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(workspace, "notes", "a.txt"), "utf8")).toBe("hello");
  });

  it("caches verified idempotent reads and invalidates them after a mutation", async () => {
    const { app: runtime, workspace } = await app();
    writeFileSync(join(workspace, "cached.txt"), "stable");
    const first = await runtime.executor.execute(
      { id: "read1", name: "read_file", arguments: { path: "cached.txt" } },
      context(),
    );
    expect(first.status).toBe("succeeded");
    const second = await runtime.executor.execute(
      { id: "read2", name: "read_file", arguments: { path: "cached.txt" } },
      context(),
    );
    expect(second.status).toBe("succeeded");
    expect(second.durationMs).toBe(0);
    expect(runtime.executor.cacheSize()).toBe(1);

    const write = await runtime.executor.execute(
      { id: "write1", name: "write_file", arguments: { path: "cached.txt", content: "changed", overwrite: true } },
      context(),
    );
    expect(write.status).toBe("succeeded");
    expect(runtime.executor.cacheSize()).toBe(0);
  });

  it("never executes a destructive tool without an approval", async () => {
    const { app: runtime, workspace } = await app();
    const file = join(workspace, "delete-me.txt");
    writeFileSync(file, "x");
    const record = await runtime.executor.execute(
      { id: "call3", name: "delete_path", arguments: { path: "delete-me.txt" } },
      context(),
    );
    expect(record.status).toBe("approval_required");
    const { existsSync } = await import("node:fs");
    expect(existsSync(file)).toBe(true);
  });

  it("denies secret-bearing filenames even inside the workspace", async () => {
    const { app: runtime } = await app();
    const record = await runtime.executor.execute(
      { id: "call4", name: "write_file", arguments: { path: ".env", content: "KEY=1" } },
      context(),
    );
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("PATH_PROTECTED");
  });

  it("fails when a tool's own verification rejects the result", async () => {
    const { app: runtime } = await app();
    runtime.registry.register(
      defineTool({
        name: "unverified_tool",
        description: "test tool whose verification always fails",
        capability: "fs.read",
        destructive: false,
        idempotent: false,
        inputSchema: z.object({}),
        resource: () => "test",
        paths: () => [],
        summary: () => "test",
        async execute() {
          return {
            summary: "claimed success",
            data: {},
            evidence: [{ kind: "file_stat" as const, detail: {} }],
          };
        },
        async verify() {
          return { ok: false, detail: "read-back mismatch" };
        },
      }),
    );
    const record = await runtime.executor.execute({ id: "call5", name: "unverified_tool", arguments: {} }, context());
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("VERIFICATION_FAILED");
  });
});
