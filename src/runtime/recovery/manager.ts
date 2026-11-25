import { CheckpointStore, type CheckpointRecord } from "./checkpoints.js";
import {
  FailureClassifier,
  RecoveryGovernance,
  RecoveryStrategyEngine,
  RetrySafetyEngine,
  type FailureClassification,
  type RecoveryGovernanceDecision,
  type RecoveryStrategy,
} from "./index.js";
import type { Logger } from "../../observability/logger.js";

export interface RecoveryEvaluationInput {
  scopeId: string;
  error: string;
  retryCount?: number;
  graphConsistent?: boolean;
  capabilityValid?: boolean;
  serializationValid?: boolean;
}

export interface RecoveryEvaluation {
  scopeId: string;
  classification: FailureClassification;
  confidenceScore: number;
  strategy: RecoveryStrategy | undefined;
  governance: RecoveryGovernanceDecision;
  retryable: boolean;
  reason: string;
}

export interface RecoveryManagerOptions {
  checkpoints: CheckpointStore;
  logger?: Logger;
}

/**
 * Coordinates durable checkpoints with the ported classification, strategy,
 * retry-safety and governance layers. It deliberately does not replay a
 * checkpoint automatically: a checkpoint is restored only by an explicit
 * caller that has reconciled any uncertain external effect.
 */
export class RecoveryManager {
  private readonly checkpoints: CheckpointStore;
  private readonly logger: Logger | undefined;
  private readonly classifier = new FailureClassifier();
  private readonly strategies = new RecoveryStrategyEngine();
  private readonly safety = new RetrySafetyEngine();
  private readonly governance = new RecoveryGovernance();
  private evaluations = 0;
  private allowedRetries = 0;

  constructor(options: RecoveryManagerOptions) {
    this.checkpoints = options.checkpoints;
    this.logger = options.logger;
  }

  saveCheckpoint(scopeId: string, label: string, state: unknown): CheckpointRecord {
    return this.checkpoints.save(scopeId, label, state);
  }

  restoreCheckpoint(scopeId: string, label?: string): unknown {
    return this.checkpoints.restore(scopeId, label);
  }

  latestCheckpoint(scopeId: string, label?: string): CheckpointRecord | undefined {
    return this.checkpoints.latest(scopeId, label);
  }

  clearCheckpoints(scopeId: string): number {
    return this.checkpoints.clear(scopeId);
  }

  evaluateFailure(input: RecoveryEvaluationInput): RecoveryEvaluation {
    this.evaluations += 1;
    const classification = this.classifier.classify({ errorMessage: input.error });
    const strategy = this.strategies.getStrategy(classification.primary);
    const retryCount = input.retryCount ?? 0;

    if (strategy === undefined) {
      const governance: RecoveryGovernanceDecision = {
        verdict: "abort",
        reason: "No recovery strategy is registered for this failure",
        requiresUserIntervention: true,
      };
      return {
        scopeId: input.scopeId,
        classification: classification.primary,
        confidenceScore: classification.confidenceScore,
        strategy: undefined,
        governance,
        retryable: false,
        reason: governance.reason,
      };
    }

    const governance = this.governance.decide({
      failureType: classification.primary,
      strategy,
      actionType: strategy.requiresUserApproval ? "escalate" : "retry",
      retryCount,
      ...(input.error.length === 0 ? {} : { errorMessage: input.error }),
    });

    const retryability =
      strategy.maxRetries > 0 && !strategy.requiresUserApproval ? "safe" : "never";
    const decision = this.safety.evaluate({
      nodeId: input.scopeId,
      classification: classification.primary,
      retryability,
      retryCount,
      ...(input.graphConsistent === undefined ? {} : { graphConsistent: input.graphConsistent }),
      ...(input.capabilityValid === undefined ? {} : { capabilityValid: input.capabilityValid }),
      ...(input.serializationValid === undefined ? {} : { serializationValid: input.serializationValid }),
    });

    const retryable =
      governance.verdict === "auto_recover" &&
      strategy.maxRetries > 0 &&
      decision.canRetry &&
      retryCount < strategy.maxRetries;
    if (retryable) this.allowedRetries += 1;

    const reason = retryable
      ? `${classification.primary}: ${strategy.name} (${governance.reason})`
      : `${classification.primary}: ${governance.reason}; ${decision.reason}`;
    this.logger?.debug(
      {
        scopeId: input.scopeId,
        classification: classification.primary,
        verdict: governance.verdict,
        retryable,
      },
      "recovery evaluated",
    );

    return {
      scopeId: input.scopeId,
      classification: classification.primary,
      confidenceScore: classification.confidenceScore,
      strategy,
      governance,
      retryable,
      reason,
    };
  }

  stats(): { evaluations: number; allowedRetries: number; checkpoints: number } {
    return {
      evaluations: this.evaluations,
      allowedRetries: this.allowedRetries,
      checkpoints: this.checkpoints.count(),
    };
  }
}
