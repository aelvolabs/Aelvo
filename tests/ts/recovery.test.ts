import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FailureClassifier,
  RecoveryStrategyEngine,
  RetrySafetyEngine,
} from "../../src/runtime/recovery/index.js";
import { CheckpointStore } from "../../src/runtime/recovery/checkpoints.js";
import { RecoveryManager } from "../../src/runtime/recovery/manager.js";
import { migrate, openDatabase } from "../../src/storage/db.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("failure classification", () => {
  const classifier = new FailureClassifier();

  it("classifies timeout evidence as transient", () => {
    const result = classifier.classify({ errorMessage: "Tool exceeded its 5000ms timeout" });
    expect(result.primary).toBe("timeout");
    expect(result.confidenceScore).toBeGreaterThan(0.5);
  });

  it("classifies permission failures and never treats them as tool noise", () => {
    const result = classifier.classify({ errorMessage: "EACCES: permission denied, open '/root/x'" });
    expect(result.primary).toBe("permission_denied");
  });

  it("classifies unknown failures without inventing a cause", () => {
    const result = classifier.classify({ errorMessage: "something unusual happened" });
    expect(result.primary).toBe("unknown_failure");
    expect(result.confidence).toBe("guess");
  });

  it("uses exit codes as an additional signal", () => {
    const result = classifier.classify({ exitCode: 127 });
    expect(result.primary).toBe("dependency_missing");
  });
});

describe("durable recovery", () => {
  it("restores a checkpoint after a database restart and rejects tampering", () => {
    const root = mkdtempSync(join(tmpdir(), "aelvo-recovery-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = join(root, "runtime.db");
    const firstDb = openDatabase(dbPath);
    migrate(firstDb);
    const first = new CheckpointStore(firstDb);
    first.save("task_1", "pre_run", { step: 2, effect: "unknown" });
    firstDb.close();

    const secondDb = openDatabase(dbPath);
    migrate(secondDb);
    cleanups.push(() => secondDb.close());
    const second = new CheckpointStore(secondDb);
    expect(second.restore("task_1", "pre_run")).toEqual({ step: 2, effect: "unknown" });

    secondDb.run("UPDATE recovery_checkpoints SET state = ? WHERE scope_id = ?", [
      JSON.stringify({ step: 99, effect: "forged" }),
      "task_1",
    ]);
    expect(() => second.restore("task_1", "pre_run")).toThrowError(/digest does not match/);
  });

  it("allows only governed, budgeted transient retries", () => {
    const root = mkdtempSync(join(tmpdir(), "aelvo-recovery-policy-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const db = openDatabase(join(root, "runtime.db"));
    migrate(db);
    cleanups.push(() => db.close());
    const manager = new RecoveryManager({ checkpoints: new CheckpointStore(db) });

    expect(manager.evaluateFailure({ scopeId: "a", error: "request timed out", retryCount: 0 }).retryable).toBe(true);
    expect(manager.evaluateFailure({ scopeId: "b", error: "permission denied", retryCount: 0 }).retryable).toBe(false);
    expect(manager.evaluateFailure({ scopeId: "c", error: "strange failure", retryCount: 0 }).retryable).toBe(false);
    expect(manager.evaluateFailure({ scopeId: "d", error: "request timed out", retryCount: 5 }).retryable).toBe(false);
  });
});

describe("retry safety", () => {
  it("never retries unknown or security failures", () => {
    const safety = new RetrySafetyEngine();
    expect(
      safety.evaluate({ nodeId: "a", classification: "unknown_failure", retryability: "safe" }).canRetry,
    ).toBe(false);
    expect(
      safety.evaluate({ nodeId: "b", classification: "permission_denied", retryability: "safe" }).canRetry,
    ).toBe(false);
    expect(
      safety.evaluate({ nodeId: "c", classification: "timeout", retryability: "dangerous" }).canRetry,
    ).toBe(false);
  });

  it("allows a safe transient retry with bounded backoff", () => {
    const safety = new RetrySafetyEngine();
    const decision = safety.evaluate({ nodeId: "d", classification: "timeout", retryability: "safe" });
    expect(decision.canRetry).toBe(true);
    expect(decision.suggestedBackoffMs).toBeGreaterThan(0);
    expect(decision.suggestedBackoffMs).toBeLessThanOrEqual(60_000);
  });

  it("honours per-failure recovery strategy budgets", () => {
    const strategies = new RecoveryStrategyEngine();
    expect(strategies.canRetry("timeout", 0)).toBe(true);
    expect(strategies.canRetry("timeout", 2)).toBe(false);
    expect(strategies.canRetry("permission_denied", 0)).toBe(false);
    expect(strategies.getStrategy("unknown_failure")?.requiresUserApproval).toBe(true);
  });
});
