import { AelvoError, isAelvoError } from "../../../../shared/errors/index.js";
import { computeRetryDelayMs } from "../rate-limit.js";
import type { LiveReconnectConfig } from "../../types.js";

export interface LiveRecoveryPolicyOptions extends LiveReconnectConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const RETRYABLE_CODES = new Set([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_ABORTED",
]);

export class LiveRecoveryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly allowReplacementSession: boolean;
  private readonly random: () => number;

  constructor(options: LiveRecoveryPolicyOptions = {}) {
    this.maxAttempts = Math.max(0, Math.min(10, options.maxAttempts ?? 3));
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 4_000);
    this.allowReplacementSession = options.allowReplacementSession ?? true;
    this.random = options.random ?? Math.random;
  }

  shouldRetry(error: unknown): boolean {
    if (isAelvoError(error)) {
      if (error.code === "PROVIDER_AUTH" || error.code === "PROVIDER_QUOTA_EXCEEDED") return false;
      if (error.code === "PROVIDER_INVALID_REQUEST" || error.code === "LIVE_PROTOCOL_INVALID") return false;
      return error.retryable || RETRYABLE_CODES.has(error.code);
    }
    return false;
  }

  delay(attempt: number, retryAfterMs?: number): number {
    return computeRetryDelayMs({
      attempt,
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      random: this.random,
    });
  }

  unavailable(reason: string): AelvoError {
    return new AelvoError("LIVE_RESUMPTION_UNAVAILABLE", reason, { retryable: false });
  }
}
