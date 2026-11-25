/**
 * Failure classification and retry safety ported from
 * runtime_next/verification/{classifier,recovery,retry_safety}.py.
 *
 * The specialist/consensus recovery branches are intentionally excluded: they
 * are coding-pipeline concepts. Classification, strategy budgets, retry
 * safety, failure stability and backoff remain, and the governed executor uses
 * them before retrying any tool.
 */

export type FailureClassification =
  | "syntax_error"
  | "dependency_missing"
  | "permission_denied"
  | "environment_failure"
  | "timeout"
  | "verification_failure"
  | "graph_inconsistency"
  | "serialization_failure"
  | "tool_failure"
  | "stale_runtime_state"
  | "mutex_violation"
  | "replay_divergence"
  | "capability_mismatch"
  | "architecture_violation"
  | "sandbox_escape"
  | "unknown_failure";

export type Confidence = "certain" | "high" | "medium" | "low" | "guess";
export type Retryability = "safe" | "conditional" | "dangerous" | "never";

export interface ClassificationInput {
  errorMessage?: string;
  stderr?: string;
  stdout?: string;
  exitCode?: number | null;
}

export interface ClassificationResult {
  primary: FailureClassification;
  confidence: Confidence;
  confidenceScore: number;
  evidence: Record<string, unknown>;
  alternatives: FailureClassification[];
}

interface TextPattern {
  classification: FailureClassification;
  weight: number;
  patterns: RegExp[];
}

const TEXT_PATTERNS: TextPattern[] = [
  {
    classification: "syntax_error",
    weight: 0.6,
    patterns: [/syntaxerror|syntax error|indentationerror|invalid syntax/i, /unexpected token|unexpected indent|expected .* but found/i],
  },
  {
    classification: "dependency_missing",
    weight: 0.55,
    patterns: [
      /modulenotfounderror|import error|no module named/i,
      /cannot find module|command not found|executable file not found/i,
      /dependency missing|package not found|enoent/i,
    ],
  },
  {
    classification: "permission_denied",
    weight: 0.7,
    patterns: [/permission denied|access denied|eacces|eperm|operation not permitted|403 forbidden/i],
  },
  {
    classification: "environment_failure",
    weight: 0.6,
    patterns: [/econnrefused|enotfound|network is unreachable|offline|service unavailable|502|503/i],
  },
  {
    classification: "timeout",
    weight: 0.75,
    patterns: [/timed out|timeout|etimedout|deadline exceeded|exceeded its \d+ms/i],
  },
  {
    classification: "verification_failure",
    weight: 0.6,
    patterns: [/verification failed|verify failed|evidence missing|hash mismatch|read-back mismatch/i],
  },
  {
    classification: "graph_inconsistency",
    weight: 0.65,
    patterns: [/graph inconsistent|dependency cycle|cycle detected|topological/i],
  },
  {
    classification: "serialization_failure",
    weight: 0.6,
    patterns: [/serialization|deserialize|json parse|unexpected end of json/i],
  },
  {
    classification: "tool_failure",
    weight: 0.4,
    patterns: [/tool execution failed|tool failed|execution failed/i],
  },
  {
    classification: "stale_runtime_state",
    weight: 0.55,
    patterns: [/stale state|stale runtime|snapshot outdated|state version/i],
  },
  {
    classification: "mutex_violation",
    weight: 0.65,
    patterns: [/mutex|lock contention|resource locked|deadlock/i],
  },
  {
    classification: "replay_divergence",
    weight: 0.7,
    patterns: [/replay divergence|nondeterministic replay|replay mismatch/i],
  },
  {
    classification: "capability_mismatch",
    weight: 0.6,
    patterns: [/capability mismatch|missing capability|capability not granted/i],
  },
  {
    classification: "architecture_violation",
    weight: 0.8,
    patterns: [/architecture violation|boundary violation|forbidden dependency/i],
  },
  {
    classification: "sandbox_escape",
    weight: 1,
    patterns: [/sandbox escape|escaped sandbox|containment breach/i],
  },
];

const EXIT_CODE_CLASSIFICATIONS: Record<number, { classification: FailureClassification; weight: number }> = {
  2: { classification: "syntax_error", weight: 0.3 },
  126: { classification: "permission_denied", weight: 0.7 },
  127: { classification: "dependency_missing", weight: 0.8 },
  124: { classification: "timeout", weight: 0.8 },
  137: { classification: "timeout", weight: 0.5 },
  143: { classification: "timeout", weight: 0.4 },
};

function confidenceFor(score: number): Confidence {
  if (score >= 0.95) return "certain";
  if (score >= 0.8) return "high";
  if (score >= 0.6) return "medium";
  if (score >= 0.4) return "low";
  return "guess";
}

/** Port of FailureClassifier: weighted signals, no silent retry of unknown. */
export class FailureClassifier {
  private readonly customPatterns: Array<{ pattern: RegExp; classification: FailureClassification }> = [];

  registerPattern(pattern: RegExp, classification: FailureClassification): void {
    this.customPatterns.push({ pattern, classification });
  }

  classify(input: ClassificationInput): ClassificationResult {
    const text = [input.errorMessage ?? "", input.stderr ?? "", input.stdout ?? ""].join("\n");
    const scores = new Map<FailureClassification, number>();
    const bump = (classification: FailureClassification, weight: number): void => {
      scores.set(classification, (scores.get(classification) ?? 0) + weight);
    };

    if (input.exitCode !== undefined && input.exitCode !== null) {
      const mapped = EXIT_CODE_CLASSIFICATIONS[input.exitCode];
      if (mapped !== undefined) bump(mapped.classification, mapped.weight);
    }

    for (const entry of TEXT_PATTERNS) {
      let matched = false;
      for (const pattern of entry.patterns) {
        if (pattern.test(text)) {
          matched = true;
          break;
        }
      }
      if (matched) bump(entry.classification, entry.weight);
    }

    for (const custom of this.customPatterns) {
      if (custom.pattern.test(text)) bump(custom.classification, 0.5);
    }

    if (scores.size === 0) bump("unknown_failure", 0.1);
    // A single unknown signal is not normalized to certainty: an unclassified
    // failure is reported with its low evidence score, not as a confident
    // classification.
    const onlyUnknown = scores.size === 1 && scores.has("unknown_failure");
    const total = [...scores.values()].reduce((sum, value) => sum + value, 0);
    const ranked = [...scores.entries()]
      .map(([classification, score]) => ({
        classification,
        score: onlyUnknown ? score : total === 0 ? 0 : score / total,
      }))
      .sort((a, b) => b.score - a.score);
    const first = ranked[0] ?? { classification: "unknown_failure" as const, score: 0 };

    return {
      primary: first.classification,
      confidence: confidenceFor(first.score),
      confidenceScore: Number(first.score.toFixed(4)),
      evidence: {
        textAnalyzed: text.length > 0,
        exitCode: input.exitCode ?? null,
        matchedSignals: ranked.length,
      },
      alternatives: ranked.slice(1, 4).map((entry) => entry.classification),
    };
  }
}

export interface RecoveryStrategy {
  id: string;
  failureType: FailureClassification;
  name: string;
  description: string;
  maxRetries: number;
  requiresUserApproval: boolean;
  dangerLevel: "safe" | "reversible" | "destructive";
}

function strategy(
  failureType: FailureClassification,
  name: string,
  description: string,
  maxRetries: number,
  options: { requiresUserApproval?: boolean; dangerLevel?: RecoveryStrategy["dangerLevel"] } = {},
): RecoveryStrategy {
  return {
    id: `strat_${failureType}`,
    failureType,
    name,
    description,
    maxRetries,
    requiresUserApproval: options.requiresUserApproval ?? false,
    dangerLevel: options.dangerLevel ?? "safe",
  };
}

/** Port of RecoveryStrategyEngine defaults, with specialist strategies removed. */
export class RecoveryStrategyEngine {
  private readonly strategies = new Map<FailureClassification, RecoveryStrategy>();

  constructor() {
    const defaults: RecoveryStrategy[] = [
      strategy("syntax_error", "Reinvoke with diagnostics", "Return the error diagnostics to the caller for correction", 3),
      strategy("dependency_missing", "Install missing dependency", "Attempt a safe install or report the missing dependency", 2, {
        dangerLevel: "reversible",
      }),
      strategy("permission_denied", "Block and notify user", "Cannot recover autonomously; requires user action", 0, {
        requiresUserApproval: true,
      }),
      strategy("environment_failure", "Refresh environment", "Refresh capability/environment state and retry", 2),
      strategy("timeout", "Retry with adjusted limits", "Retry with a larger timeout or reduced scope", 2),
      strategy("verification_failure", "Reverify with context", "Re-read the affected state before retrying", 2),
      strategy("graph_inconsistency", "Rebuild graph segment", "Recompute the affected dependency segment", 1, {
        dangerLevel: "reversible",
      }),
      strategy("serialization_failure", "Rollback checkpoint", "Restore the last known-good serialized state", 1, {
        dangerLevel: "reversible",
      }),
      strategy("tool_failure", "Retry with clean state", "Clear per-attempt state and retry", 2),
      strategy("stale_runtime_state", "Refresh runtime state", "Reload capabilities, graph state and replay log", 1),
      strategy("mutex_violation", "Reschedule execution", "Wait and retry with exponential backoff", 3),
      strategy("replay_divergence", "Abort and notify", "Replay divergence requires human review", 0, {
        requiresUserApproval: true,
      }),
      strategy("capability_mismatch", "Refresh capabilities", "Refresh the capability registry and re-evaluate", 2),
      strategy("architecture_violation", "Block and notify", "Architecture violations require human review", 0, {
        requiresUserApproval: true,
      }),
      strategy("sandbox_escape", "Quarantine and notify", "Quarantine the operation and require human review", 0, {
        requiresUserApproval: true,
      }),
      strategy("unknown_failure", "Abort and notify", "Unknown failures are never silently retried", 0, {
        requiresUserApproval: true,
      }),
    ];
    for (const item of defaults) this.strategies.set(item.failureType, item);
  }

  getStrategy(failureType: FailureClassification): RecoveryStrategy | undefined {
    return this.strategies.get(failureType);
  }

  /** A retry is only allowed when the strategy actually has budget. */
  canRetry(failureType: FailureClassification, retryCount: number): boolean {
    const selected = this.strategies.get(failureType);
    return selected !== undefined && selected.maxRetries > 0 && retryCount < selected.maxRetries;
  }
}

export type RecoveryVerdict = "auto_recover" | "require_approval" | "notify_user" | "abort";

export interface RecoveryGovernanceInput {
  failureType: FailureClassification;
  strategy: RecoveryStrategy;
  actionType: string;
  retryCount: number;
  errorMessage?: string;
}

export interface RecoveryGovernanceDecision {
  verdict: RecoveryVerdict;
  reason: string;
  requiresUserIntervention: boolean;
}

/** Port of RecoveryGovernance: autonomy stops for unknown, destructive or
 * security-relevant failures and when the strategy budget is exhausted. */
export class RecoveryGovernance {
  decide(input: RecoveryGovernanceInput): RecoveryGovernanceDecision {
    if (input.failureType === "unknown_failure") {
      return {
        verdict: "abort",
        reason: "Unknown failure classification; autonomous recovery is not safe",
        requiresUserIntervention: true,
      };
    }
    if (
      input.strategy.dangerLevel === "destructive" ||
      input.strategy.requiresUserApproval ||
      input.actionType === "rollback"
    ) {
      return {
        verdict: "require_approval",
        reason: `Recovery action '${input.actionType}' requires explicit approval`,
        requiresUserIntervention: true,
      };
    }
    if (
      input.failureType === "permission_denied" ||
      input.failureType === "sandbox_escape" ||
      input.failureType === "architecture_violation"
    ) {
      return {
        verdict: "notify_user",
        reason: "Security or permission failure requires user intervention",
        requiresUserIntervention: true,
      };
    }
    if (input.retryCount >= input.strategy.maxRetries) {
      return {
        verdict: "notify_user",
        reason: `Recovery budget exhausted (${input.retryCount}/${input.strategy.maxRetries})`,
        requiresUserIntervention: true,
      };
    }
    return {
      verdict: "auto_recover",
      reason: `Safe autonomous recovery using '${input.strategy.name}'`,
      requiresUserIntervention: false,
    };
  }
}

export interface RetrySafetyInput {
  nodeId: string;
  classification: FailureClassification;
  retryability: Retryability;
  retryCount?: number;
  graphConsistent?: boolean;
  capabilityValid?: boolean;
  serializationValid?: boolean;
  replayDivergenceRisk?: number;
}

export interface RetryDecision {
  canRetry: boolean;
  reason: string;
  retryCount: number;
  suggestedBackoffMs: number;
  failureStability: number;
  blockingCondition: string | null;
}

/** Port of RetrySafetyEngine's defensive checks, without runtime graph coupling. */
export class RetrySafetyEngine {
  private readonly retryCounts = new Map<string, number>();
  private readonly failureHistory = new Map<string, FailureClassification[]>();

  evaluate(input: RetrySafetyInput): RetryDecision {
    const retryCount = (this.retryCounts.get(input.nodeId) ?? 0) + 1;
    this.retryCounts.set(input.nodeId, retryCount);
    const history = this.failureHistory.get(input.nodeId) ?? [];
    history.push(input.classification);
    this.failureHistory.set(input.nodeId, history);

    const reasons: string[] = [];
    let blocking: string | null = null;
    const block = (reason: string, condition: string): RetryDecision => {
      reasons.push(reason);
      blocking = blocking ?? condition;
      return {
        canRetry: false,
        reason: reasons.join("; "),
        retryCount,
        suggestedBackoffMs: Math.min(60_000, 500 * 2 ** retryCount),
        failureStability: this.stability(history),
        blockingCondition: blocking,
      };
    };

    if (input.classification === "unknown_failure") {
      return block("Unknown failures are never silently retried", "unknown_failure");
    }
    if (input.retryability === "never") return block("Failure is classified as non-retryable", "non_retryable");
    if (input.retryability === "dangerous") {
      return block("Retry may repeat an unverified side effect", "dangerous_mutation");
    }
    if (input.classification === "permission_denied" || input.classification === "sandbox_escape") {
      return block("Security failures must not be retried automatically", "security_boundary");
    }
    if (input.graphConsistent === false) return block("Graph state is inconsistent", "graph_inconsistency");
    if (input.capabilityValid === false) return block("Capability state is stale", "stale_capability");
    if (input.serializationValid === false) return block("Serialization state is corrupted", "serialization_corruption");
    if ((input.replayDivergenceRisk ?? 0) > 0.7) return block("Replay divergence risk is high", "replay_divergence");
    if (retryCount > 5) return block("Retry budget exhausted", "retry_budget");

    const stability = this.stability(history);
    if (stability < 0.3) reasons.push(`Failure is unstable across retries (stability=${stability.toFixed(2)})`);

    return {
      canRetry: true,
      reason: reasons.length > 0 ? reasons.join("; ") : "Retry is safe",
      retryCount,
      suggestedBackoffMs: Math.min(60_000, 500 * 2 ** retryCount),
      failureStability: stability,
      blockingCondition: null,
    };
  }

  private stability(history: FailureClassification[]): number {
    if (history.length <= 1) return 1;
    const latest = history[history.length - 1];
    if (latest === undefined) return 1;
    const matches = history.filter((item) => item === latest).length;
    return Number((matches / history.length).toFixed(4));
  }
}
