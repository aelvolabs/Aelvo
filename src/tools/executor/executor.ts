import { performance } from "node:perf_hooks";
import { ZodError } from "zod";
import {
  ToolOutcomeSchema,
  type ToolCall,
  type ToolExecutionRecord,
  type ToolOutcome,
} from "../../shared/contracts/index.js";
import { AelvoError, asAelvoError, toPublicError } from "../../shared/errors/index.js";
import { canonicalJson, sha256 } from "../../shared/canonical.js";
import type { AnyTool } from "../registry/types.js";
import type { PolicyDecision } from "../../security/policies/policy.js";
import type { AuditLog } from "../../security/audit/log.js";
import type { ApprovalService } from "../../security/approvals/service.js";
import type { PolicyService } from "../../security/policies/policy.js";
import type { Logger } from "../../observability/logger.js";
import type { RuntimeMetrics } from "../../observability/metrics.js";
import type { ToolContext } from "../registry/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import { FailureClassifier, RetrySafetyEngine } from "../../runtime/recovery/index.js";

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  policy: PolicyService;
  approvals: ApprovalService;
  audit: AuditLog;
  logger: Logger;
  defaultTimeoutMs: number;
  metrics?: RuntimeMetrics;
}

export interface ExecuteOptions {
  approvalId?: string;
  userInitiated?: boolean;
  maxAttempts?: number;
  bypassCache?: boolean;
}

export interface ToolPreview {
  tool: AnyTool;
  input: unknown;
  resource: string;
  paths: string[];
  decision: PolicyDecision;
}

interface CacheEntry {
  toolName: string;
  outcome: ToolOutcome;
  expiresAtMs: number;
}

/**
 * The single governed execution gateway.
 *
 * Invariants enforced here, not by convention:
 *  - arguments are parsed before anything runs;
 *  - policy is consulted before anything runs;
 *  - destructive/privileged actions need a single-use approval bound to the
 *    exact digested action;
 *  - success requires tool-provided evidence and an independent verification
 *    pass;
 *  - every attempt is audited.
 */
export class ToolExecutor {
  private readonly options: ToolExecutorOptions;
  private readonly classifier = new FailureClassifier();
  private readonly retrySafety = new RetrySafetyEngine();
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: ToolExecutorOptions) {
    this.options = options;
  }

  /**
   * Resolve a call through registry validation and policy without executing it.
   * The coordinator uses this to decide whether a batch can run through the
   * execution graph; the executor still re-checks everything on execution.
   */
  preview(call: ToolCall): ToolPreview | undefined {
    try {
      const tool = this.options.registry.get(call.name);
      const input = tool.inputSchema.parse(call.arguments);
      const resource = tool.resource(input);
      const paths = tool.paths(input);
      const decision = this.options.policy.evaluate({
        capability: tool.capability,
        resource,
        paths,
        destructive: tool.destructive,
        runId: "preview",
        actor: "model",
        userInitiated: false,
      });
      return { tool, input, resource, paths, decision };
    } catch {
      // Validation or path resolution failures take the sequential path so the
      // model receives the normal structured error and audit entry.
      return undefined;
    }
  }

  async execute(call: ToolCall, context: ToolContext, options: ExecuteOptions = {}): Promise<ToolExecutionRecord> {
    const started = performance.now();
    const { registry, policy, approvals, audit, logger } = this.options;
    const userInitiated = options.userInitiated ?? context.userInitiated;

    const tool = registry.get(call.name);
    let input: unknown;
    try {
      input = tool.inputSchema.parse(call.arguments);
    } catch (error) {
      const detail = error instanceof ZodError ? error.issues.map((issue) => issue.message).join("; ") : String(error);
      audit.record({
        runId: context.runId,
        actor: userInitiated ? "user" : "model",
        action: call.name,
        capability: tool.capability,
        decision: "failed",
        detail: { phase: "validation", error: detail },
      });
      return this.failure(call, "TOOL_INPUT_INVALID", `Invalid arguments: ${detail}`, started, 0);
    }

    let resource: string;
    let paths: string[];
    try {
      resource = tool.resource(input);
      paths = tool.paths(input);
    } catch (error) {
      const publicError = toPublicError(error);
      audit.record({
        runId: context.runId,
        actor: userInitiated ? "user" : "model",
        action: call.name,
        capability: tool.capability,
        decision: "deny",
        detail: { phase: "path", error: publicError.message },
      });
      return this.failure(call, publicError.code, publicError.message, started, 0);
    }

    const decision = policy.evaluate({
      capability: tool.capability,
      resource,
      paths,
      destructive: tool.destructive,
      runId: context.runId,
      actor: userInitiated ? "user" : "model",
      userInitiated,
    });

    if (decision.verdict === "deny") {
      audit.record({
        runId: context.runId,
        actor: userInitiated ? "user" : "model",
        action: call.name,
        capability: tool.capability,
        resource,
        decision: "deny",
        detail: { reason: decision.reason },
      });
      return this.failure(call, "TOOL_DENIED", decision.reason, started, 0);
    }

    if (decision.verdict === "approval") {
      const binding = {
        runId: context.runId,
        sessionId: context.sessionId,
        tool: call.name,
        capability: tool.capability,
        resource,
        arguments: input as Record<string, unknown>,
      };
      if (options.approvalId === undefined) {
        const request = approvals.request(binding, tool.summary(input));
        audit.record({
          runId: context.runId,
          actor: userInitiated ? "user" : "model",
          action: call.name,
          capability: tool.capability,
          resource,
          decision: "approval_requested",
          detail: { approvalId: request.id, digest: request.digest },
        });
        return {
          call,
          status: "approval_required",
          approval: request,
          durationMs: Math.round(performance.now() - started),
          attempts: 0,
        };
      }
      try {
        approvals.redeem(options.approvalId, binding);
        audit.record({
          runId: context.runId,
          actor: "user",
          action: call.name,
          capability: tool.capability,
          resource,
          decision: "approval_granted",
          detail: { approvalId: options.approvalId },
        });
      } catch (error) {
        const publicError = toPublicError(error);
        audit.record({
          runId: context.runId,
          actor: "user",
          action: call.name,
          capability: tool.capability,
          resource,
          decision: "deny",
          detail: { phase: "approval", error: publicError.message },
        });
        return {
          call,
          status: "denied",
          error: { code: publicError.code, message: publicError.message },
          durationMs: Math.round(performance.now() - started),
          attempts: 0,
        };
      }
    }

    const cacheKey =
      tool.cacheTtlMs === undefined || options.bypassCache === true
        ? undefined
        : sha256(canonicalJson({ tool: call.name, arguments: input }));
    if (cacheKey !== undefined) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        if (cached.expiresAtMs > Date.now()) {
          audit.record({
            runId: context.runId,
            actor: userInitiated ? "user" : "model",
            action: call.name,
            capability: tool.capability,
            resource,
            decision: "executed",
            detail: { cached: true },
          });
          this.options.metrics?.record("tool.cache.hit", 1, { tool: call.name });
          return {
            call,
            status: "succeeded",
            outcome: cached.outcome,
            durationMs: 0,
            attempts: 0,
          };
        }
        this.cache.delete(cacheKey);
      }
    }

    const timeoutMs = tool.timeoutMs ?? this.options.defaultTimeoutMs;
    const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? (tool.idempotent ? 2 : 1), 3));
    let attempts = 0;
    let lastError: AelvoError | undefined;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const outcome = await this.runOnce(call, tool, input, context, timeoutMs);
        audit.record({
          runId: context.runId,
          actor: userInitiated ? "user" : "model",
          action: call.name,
          capability: tool.capability,
          resource,
          decision: "executed",
          detail: { attempts, evidence: outcome.evidence.length },
        });
        if (!tool.idempotent || tool.capability !== "fs.read") {
          // Any successful mutation invalidates reads made before it.
          this.cache.clear();
        } else if (cacheKey !== undefined && tool.cacheTtlMs !== undefined) {
          this.cache.set(cacheKey, {
            toolName: call.name,
            outcome,
            expiresAtMs: Date.now() + tool.cacheTtlMs,
          });
        }
        const durationMs = Math.round(performance.now() - started);
        this.options.metrics?.record("tool.execution", durationMs, { tool: call.name, status: "succeeded" });
        return {
          call,
          status: "succeeded",
          outcome,
          durationMs,
          attempts,
        };
      } catch (error) {
        const aelvoError = asAelvoError(error);
        lastError = aelvoError;
        const aborted = aelvoError.code === "EXECUTION_ABORTED";
        if (aborted) {
          audit.record({
            runId: context.runId,
            actor: userInitiated ? "user" : "model",
            action: call.name,
            capability: tool.capability,
            resource,
            decision: "cancelled",
            detail: { attempts },
          });
          return {
            call,
            status: "cancelled",
            error: { code: aelvoError.code, message: aelvoError.message },
            durationMs: Math.round(performance.now() - started),
            attempts,
          };
        }
        const classification = this.classifier.classify({
          errorMessage: aelvoError.message,
          exitCode: null,
        });
        const decision = this.retrySafety.evaluate({
          nodeId: `${context.runId}:${call.name}`,
          classification: classification.primary,
          retryability: aelvoError.retryable ? "safe" : "never",
          retryCount: attempts,
        });
        const canRetry = decision.canRetry && tool.idempotent && attempts < maxAttempts;
        logger.debug(
          { tool: call.name, attempt: attempts, code: aelvoError.code, classification: classification.primary, canRetry },
          "tool attempt failed",
        );
        if (!canRetry) break;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            context.signal.removeEventListener("abort", abort);
            resolve();
          }, Math.min(1_000, decision.suggestedBackoffMs));
          const abort = (): void => {
            clearTimeout(timer);
            reject(new AelvoError("EXECUTION_ABORTED", "Tool retry cancelled"));
          };
          context.signal.addEventListener("abort", abort, { once: true });
        });
      }
    }

    const error = lastError ?? new AelvoError("EXECUTION_FAILED", "Tool execution failed");
    audit.record({
      runId: context.runId,
      actor: userInitiated ? "user" : "model",
      action: call.name,
      capability: tool.capability,
      resource,
      decision: "failed",
      detail: { attempts, code: error.code, message: error.message },
    });
    return this.failure(call, error.code, error.message, started, attempts);
  }

  private async runOnce(
    call: ToolCall,
    tool: ReturnType<ToolRegistry["get"]>,
    input: unknown,
    context: ToolContext,
    timeoutMs: number,
  ) {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
    const scopedContext: ToolContext = { ...context, signal };
    const outcome = await this.withAbort(
      tool.execute(input, scopedContext),
      signal,
      timeoutMs,
    );
    const parsed = ToolOutcomeSchema.safeParse(outcome);
    if (!parsed.success) {
      throw new AelvoError("EVIDENCE_MISSING", "Tool returned an invalid or evidence-free outcome", {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    if (tool.verify !== undefined) {
      const verification = await this.withAbort(
        tool.verify(input, parsed.data, scopedContext),
        signal,
        timeoutMs,
      );
      if (!verification.ok) {
        throw new AelvoError("VERIFICATION_FAILED", `Verification failed: ${verification.detail}`, {
          details: { tool: call.name, verification: verification.detail },
        });
      }
    }
    return parsed.data;
  }

  /** Race an operation against abort/timeout without leaking a pending promise. */
  private withAbort<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
        finish(() =>
          reject(
            new AelvoError(
              timedOut ? "EXECUTION_TIMEOUT" : "EXECUTION_ABORTED",
              timedOut ? `Tool exceeded its ${timeoutMs}ms timeout` : "Tool execution was cancelled",
              { retryable: timedOut },
            ),
          ),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  /** Explicit invalidation for callers that changed state outside a tool. */
  invalidateCache(toolName?: string): number {
    if (toolName === undefined) {
      const count = this.cache.size;
      this.cache.clear();
      return count;
    }
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (entry.toolName === toolName) {
        this.cache.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  cacheSize(): number {
    return this.cache.size;
  }

  private failure(
    call: ToolCall,
    code: string,
    message: string,
    started: number,
    attempts: number,
  ): ToolExecutionRecord {
    const durationMs = Math.round(performance.now() - started);
    this.options.metrics?.record("tool.execution", durationMs, {
      tool: call.name,
      status: code === "TOOL_DENIED" ? "denied" : "failed",
    });
    return {
      call,
      status: code === "TOOL_DENIED" ? "denied" : "failed",
      error: { code, message },
      durationMs,
      attempts,
    };
  }
}
