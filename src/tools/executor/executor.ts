import { performance } from "node:perf_hooks";
import { ZodError } from "zod";
import {
  ToolOutcomeSchema,
  type RequestOrigin,
  type ToolCall,
  type ToolExecutionRecord,
  type ToolOutcome,
} from "../../shared/contracts/index.js";
import { AelvoError, asAelvoError, toPublicError } from "../../shared/errors/index.js";
import { canonicalJson, sha256 } from "../../shared/canonical.js";
import type { AnyTool, ToolContext } from "../registry/types.js";
import type { PolicyDecision, PolicyService } from "../../security/policies/policy.js";
import type { AuditLog } from "../../security/audit/log.js";
import type { ApprovalBinding, ApprovalService } from "../../security/approvals/service.js";
import type { Logger } from "../../observability/logger.js";
import type { RuntimeMetrics } from "../../observability/metrics.js";
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
  origin?: RequestOrigin;
  decidedBy?: "user" | "cli" | "bridge" | "system" | "model";
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
  policyEpoch: number;
  outcome: ToolOutcome;
  expiresAtMs: number;
}

/**
 * The single governed execution gateway.
 *
 * Authoritative security pipeline:
 *   Request -> Identity & schema validation -> Capability & scope evaluation ->
 *   Policy decision -> Single-use digest-bound approval -> Pre-execution
 *   TOCTOU re-validation -> Execution -> Verification -> Accurate audit.
 */
export class ToolExecutor {
  private readonly options: ToolExecutorOptions;
  private readonly classifier = new FailureClassifier();
  private readonly retrySafety = new RetrySafetyEngine();
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: ToolExecutorOptions) {
    this.options = options;
    this.options.policy.onChange(() => {
      this.cache.clear();
    });
  }

  /**
   * Resolve a call through registry validation and policy without executing it.
   * Uses caller context when available so preview reflects active session/task grants.
   */
  preview(call: ToolCall, context?: Partial<ToolContext>): ToolPreview | undefined {
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
        runId: context?.runId ?? "preview",
        ...(context?.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        ...(context?.taskId === undefined ? {} : { taskId: context.taskId }),
        ...(context?.origin === undefined ? {} : { origin: context.origin }),
        toolName: call.name,
        actor: context?.userInitiated ? "user" : "model",
        userInitiated: context?.userInitiated ?? false,
      });
      return { tool, input, resource, paths, decision };
    } catch {
      return undefined;
    }
  }

  async execute(call: ToolCall, context: ToolContext, options: ExecuteOptions = {}): Promise<ToolExecutionRecord> {
    const started = performance.now();
    const { registry, policy, approvals, audit, logger } = this.options;
    const userInitiated = options.userInitiated ?? context.userInitiated;
    const actor: "user" | "model" = userInitiated ? "user" : "model";
    const origin: RequestOrigin = options.origin ?? context.origin ?? "system";
    const executionId = call.id;

    let tool: AnyTool;
    try {
      tool = registry.get(call.name);
    } catch (error) {
      const publicError = toPublicError(error);
      audit.record({
        runId: context.runId,
        sessionId: context.sessionId,
        executionId,
        origin,
        actor,
        action: call.name,
        decision: "deny",
        decisionReason: publicError.message,
        riskLevel: "high",
        executionStatus: "denied",
      });
      return this.failure(call, publicError.code, publicError.message, started, 0);
    }

    let input: unknown;
    try {
      input = tool.inputSchema.parse(call.arguments);
    } catch (error) {
      const detail = error instanceof ZodError ? error.issues.map((issue) => issue.message).join("; ") : String(error);
      audit.record({
        runId: context.runId,
        sessionId: context.sessionId,
        executionId,
        origin,
        actor,
        action: call.name,
        capability: tool.capability,
        decision: "failed",
        decisionReason: detail,
        riskLevel: "moderate",
        executionStatus: "failed",
        detail: { phase: "validation", error: detail },
      });
      return this.failure(call, "TOOL_INPUT_INVALID", `Invalid arguments: ${detail}`, started, 0);
    }

    const resolveResourceAndPaths = (): { resource: string; paths: string[] } => ({
      resource: tool.resource(input),
      paths: tool.paths(input),
    });

    let resource: string;
    let paths: string[];
    try {
      ({ resource, paths } = resolveResourceAndPaths());
    } catch (error) {
      const publicError = toPublicError(error);
      audit.record({
        runId: context.runId,
        sessionId: context.sessionId,
        executionId,
        origin,
        actor,
        action: call.name,
        capability: tool.capability,
        decision: "deny",
        decisionReason: publicError.message,
        riskLevel: "high",
        executionStatus: "denied",
        detail: { phase: "path", error: publicError.message },
      });
      return this.failure(call, publicError.code, publicError.message, started, 0);
    }

    const evalPolicy = (targetResource: string, targetPaths: string[]): PolicyDecision => {
      const t0 = performance.now();
      const decision = policy.evaluate({
        capability: tool.capability,
        resource: targetResource,
        paths: targetPaths,
        destructive: tool.destructive,
        runId: context.runId,
        sessionId: context.sessionId,
        ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
        origin,
        toolName: call.name,
        actor,
        userInitiated,
      });
      this.options.metrics?.record("security.policy_ms", performance.now() - t0, {
        capability: tool.capability,
      });
      return decision;
    };

    const decision = evalPolicy(resource, paths);
    if (options.approvalId === undefined) {
      audit.record({
        runId: context.runId,
        sessionId: context.sessionId,
        executionId,
        origin,
        actor,
        action: call.name,
        capability: tool.capability,
        resource,
        scope: decision.scope,
        decision: "requested",
        decisionReason: decision.reason,
        riskLevel: decision.riskLevel,
        executionStatus: "evaluating",
      });
    }

    if (decision.verdict === "deny") {
      audit.record({
        runId: context.runId,
        sessionId: context.sessionId,
        executionId,
        origin,
        actor,
        action: call.name,
        capability: tool.capability,
        resource,
        scope: decision.scope,
        decision: "deny",
        decisionReason: decision.reason,
        riskLevel: decision.riskLevel,
        executionStatus: "denied",
      });
      return this.failure(
        call,
        policy.isEmergencyStopActive() ? "EMERGENCY_STOP" : "TOOL_DENIED",
        decision.reason,
        started,
        0,
      );
    }

    let redeemedApprovalId: string | undefined;
    if (decision.verdict === "approval") {
      const binding: ApprovalBinding = {
        runId: context.runId,
        sessionId: context.sessionId,
        executionId,
        origin,
        tool: call.name,
        capability: tool.capability,
        resource,
        scope: decision.scope,
        policyEpoch: decision.policyEpoch,
        arguments: input as Record<string, unknown>,
      };
      if (options.approvalId === undefined) {
        const request = approvals.request(binding, tool.summary(input), { riskLevel: decision.riskLevel });
        audit.record({
          runId: context.runId,
          sessionId: context.sessionId,
          executionId,
          origin,
          actor,
          action: call.name,
          capability: tool.capability,
          resource,
          scope: decision.scope,
          decision: "approval_requested",
          decisionReason: decision.reason,
          riskLevel: decision.riskLevel,
          approvalId: request.id,
          executionStatus: "approval_required",
          detail: { digest: request.digest },
        });
        return {
          call,
          status: "approval_required",
          approval: request,
          durationMs: Math.round(performance.now() - started),
          attempts: 0,
        };
      }
      if (options.decidedBy === "model") {
        throw new AelvoError("TOOL_DENIED", "The model cannot authorize its own tool approvals");
      }
      try {
        const tRedeem0 = performance.now();
        approvals.redeem(options.approvalId, binding);
        this.options.metrics?.record("security.approval_redeem_ms", performance.now() - tRedeem0, {
          capability: tool.capability,
        });
        redeemedApprovalId = options.approvalId;
        audit.record({
          runId: context.runId,
          sessionId: context.sessionId,
          executionId,
          origin,
          actor: "user",
          action: call.name,
          capability: tool.capability,
          resource,
          scope: decision.scope,
          decision: "approval_granted",
          decisionReason: "Single-use digest-bound approval redeemed",
          riskLevel: decision.riskLevel,
          approvalId: options.approvalId,
          executionStatus: "authorized",
        });
      } catch (error) {
        const publicError = toPublicError(error);
        audit.record({
          runId: context.runId,
          sessionId: context.sessionId,
          executionId,
          origin,
          actor: "user",
          action: call.name,
          capability: tool.capability,
          resource,
          scope: decision.scope,
          decision: "deny",
          decisionReason: publicError.message,
          riskLevel: decision.riskLevel,
          approvalId: options.approvalId,
          executionStatus: "denied",
          detail: { phase: "approval" },
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
        : sha256(canonicalJson({ tool: call.name, arguments: input, scope: decision.scope }));
    if (cacheKey !== undefined) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        if (cached.expiresAtMs > Date.now() && cached.policyEpoch === policy.policyEpoch) {
          audit.record({
            runId: context.runId,
            sessionId: context.sessionId,
            executionId,
            origin,
            actor,
            action: call.name,
            capability: tool.capability,
            resource,
            scope: decision.scope,
            decision: "executed",
            decisionReason: decision.reason,
            riskLevel: decision.riskLevel,
            executionStatus: "succeeded",
            verified: true,
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
        // Pre-execution TOCTOU guard: re-verify paths, symlink safety, emergency stop,
        // and policy epoch immediately before dispatching the tool implementation.
        const fresh = resolveResourceAndPaths();
        const freshDecision = evalPolicy(fresh.resource, fresh.paths);
        if (freshDecision.verdict === "deny") {
          const code = policy.isEmergencyStopActive() ? "EMERGENCY_STOP" : "TOOL_DENIED";
          throw new AelvoError(code, freshDecision.reason, {
            details: { phase: "pre_execution_recheck" },
          });
        }
        if (freshDecision.verdict === "approval" && decision.verdict !== "approval") {
          throw new AelvoError(
            "TOOL_DENIED",
            "Security policy tightened before execution; explicit approval is now required",
            { details: { phase: "pre_execution_recheck" } },
          );
        }
        if (
          redeemedApprovalId !== undefined &&
          (freshDecision.policyEpoch !== decision.policyEpoch || fresh.resource !== resource)
        ) {
          throw new AelvoError(
            "APPROVAL_INVALID",
            "Security policy or target resource changed after approval was granted",
            { details: { phase: "pre_execution_recheck" } },
          );
        }

        const outcome = await this.runOnce(call, tool, input, context, timeoutMs);
        audit.record({
          runId: context.runId,
          sessionId: context.sessionId,
          executionId,
          origin,
          actor,
          action: call.name,
          capability: tool.capability,
          resource: fresh.resource,
          scope: freshDecision.scope,
          decision: "executed",
          decisionReason: freshDecision.reason,
          riskLevel: freshDecision.riskLevel,
          ...(redeemedApprovalId === undefined ? {} : { approvalId: redeemedApprovalId }),
          executionStatus: "succeeded",
          verified: true,
          detail: { attempts, evidence: outcome.evidence.length },
        });
        if (!tool.idempotent || tool.capability !== "fs.read") {
          this.cache.clear();
        } else if (cacheKey !== undefined && tool.cacheTtlMs !== undefined) {
          this.cache.set(cacheKey, {
            toolName: call.name,
            policyEpoch: policy.policyEpoch,
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
        const uncertain =
          (aborted || aelvoError.code === "EXECUTION_TIMEOUT") &&
          (tool.destructive || !tool.idempotent);
        if (
          aelvoError.code === "TOOL_DENIED" ||
          aelvoError.code === "APPROVAL_INVALID" ||
          aelvoError.code === "EMERGENCY_STOP"
        ) {
          audit.record({
            runId: context.runId,
            sessionId: context.sessionId,
            executionId,
            origin,
            actor,
            action: call.name,
            capability: tool.capability,
            resource,
            scope: decision.scope,
            decision: "deny",
            decisionReason: aelvoError.message,
            riskLevel: decision.riskLevel,
            ...(redeemedApprovalId === undefined ? {} : { approvalId: redeemedApprovalId }),
            executionStatus: "denied",
            detail: { attempts },
          });
          return this.failure(call, aelvoError.code, aelvoError.message, started, attempts);
        }
        if (aborted) {
          audit.record({
            runId: context.runId,
            sessionId: context.sessionId,
            executionId,
            origin,
            actor,
            action: call.name,
            capability: tool.capability,
            resource,
            scope: decision.scope,
            decision: uncertain ? "effect_uncertain" : "cancelled",
            decisionReason: aelvoError.message,
            riskLevel: decision.riskLevel,
            ...(redeemedApprovalId === undefined ? {} : { approvalId: redeemedApprovalId }),
            executionStatus: "cancelled",
            cancelled: true,
            verified: false,
            detail: { attempts, effectUncertain: uncertain },
          });
          return {
            call,
            status: "cancelled",
            error: {
              code: aelvoError.code,
              message: uncertain
                ? `${aelvoError.message} (external side effect uncertain; refusing blind replay)`
                : aelvoError.message,
            },
            durationMs: Math.round(performance.now() - started),
            attempts,
          };
        }
        const classification = this.classifier.classify({
          errorMessage: aelvoError.message,
          exitCode: null,
        });
        const retryDecision = this.retrySafety.evaluate({
          nodeId: `${context.runId}:${call.name}`,
          classification: classification.primary,
          retryability: aelvoError.retryable ? "safe" : "never",
          retryCount: attempts,
        });
        const canRetry = retryDecision.canRetry && tool.idempotent && attempts < maxAttempts;
        logger.debug(
          { tool: call.name, attempt: attempts, code: aelvoError.code, classification: classification.primary, canRetry },
          "tool attempt failed",
        );
        if (!canRetry) break;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            context.signal.removeEventListener("abort", abort);
            resolve();
          }, Math.min(1_000, retryDecision.suggestedBackoffMs));
          const abort = (): void => {
            clearTimeout(timer);
            reject(new AelvoError("EXECUTION_ABORTED", "Tool retry cancelled"));
          };
          context.signal.addEventListener("abort", abort, { once: true });
        });
      }
    }

    const error = lastError ?? new AelvoError("EXECUTION_FAILED", "Tool execution failed");
    const uncertainTimeout =
      error.code === "EXECUTION_TIMEOUT" && (tool.destructive || !tool.idempotent);
    audit.record({
      runId: context.runId,
      sessionId: context.sessionId,
      executionId,
      origin,
      actor,
      action: call.name,
      capability: tool.capability,
      resource,
      scope: decision.scope,
      decision: uncertainTimeout ? "effect_uncertain" : "failed",
      decisionReason: error.message,
      riskLevel: decision.riskLevel,
      ...(redeemedApprovalId === undefined ? {} : { approvalId: redeemedApprovalId }),
      executionStatus: "failed",
      verified: false,
      detail: { attempts, code: error.code, effectUncertain: uncertainTimeout },
    });
    return this.failure(
      call,
      error.code,
      uncertainTimeout
        ? `${error.message} (external side effect uncertain)`
        : error.message,
      started,
      attempts,
    );
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
      status: code === "TOOL_DENIED" || code === "EMERGENCY_STOP" ? "denied" : "failed",
    });
    return {
      call,
      status: code === "TOOL_DENIED" || code === "EMERGENCY_STOP" ? "denied" : "failed",
      error: { code, message },
      durationMs,
      attempts,
    };
  }
}
