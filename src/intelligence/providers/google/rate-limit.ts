import { AelvoError } from "../../../shared/errors/index.js";

export interface RateLimiterOptions {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  minIntervalMs?: number;
  now?: () => number;
  random?: () => number;
}

/**
 * Wait for `ms` milliseconds unless `signal` aborts first.
 * Cleans up abort listeners unconditionally so long-lived signals do not leak.
 */
export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new AelvoError("PROVIDER_ABORTED", "Provider request was cancelled", { cause: signal.reason });
  }
  if (ms <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new AelvoError("PROVIDER_ABORTED", "Provider request was cancelled", { cause: signal?.reason }));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Bounded token-bucket limiter for RPM, TPM, and minimum request spacing.
 * Zero-wait fast path when no limit thresholds are configured.
 */
export class ProviderRateLimiter {
  private readonly requestsPerMinute: number | undefined;
  private readonly tokensPerMinute: number | undefined;
  private readonly minIntervalMs: number;
  private readonly now: () => number;

  private requestTokens: number;
  private tokenBudget: number;
  private lastRefillAt: number;
  private lastRequestAt = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.requestsPerMinute =
      options.requestsPerMinute !== undefined && options.requestsPerMinute > 0
        ? options.requestsPerMinute
        : undefined;
    this.tokensPerMinute =
      options.tokensPerMinute !== undefined && options.tokensPerMinute > 0
        ? options.tokensPerMinute
        : undefined;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 0);
    this.now = options.now ?? (() => Date.now());
    this.lastRefillAt = this.now();
    this.requestTokens = this.requestsPerMinute ?? Number.POSITIVE_INFINITY;
    this.tokenBudget = this.tokensPerMinute ?? Number.POSITIVE_INFINITY;
  }

  private refill(): void {
    const current = this.now();
    const elapsedMinutes = Math.max(0, current - this.lastRefillAt) / 60_000;
    this.lastRefillAt = current;

    if (this.requestsPerMinute !== undefined) {
      this.requestTokens = Math.min(this.requestsPerMinute, this.requestTokens + elapsedMinutes * this.requestsPerMinute);
    }
    if (this.tokensPerMinute !== undefined) {
      this.tokenBudget = Math.min(this.tokensPerMinute, this.tokenBudget + elapsedMinutes * this.tokensPerMinute);
    }
  }

  async acquire(estimatedTokens = 0, signal?: AbortSignal): Promise<number> {
    if (
      this.requestsPerMinute === undefined &&
      this.tokensPerMinute === undefined &&
      this.minIntervalMs === 0
    ) {
      if (signal?.aborted) {
        throw new AelvoError("PROVIDER_ABORTED", "Provider request was cancelled", { cause: signal.reason });
      }
      return 0;
    }

    let totalWaitMs = 0;
    for (;;) {
      this.refill();
      const current = this.now();
      let waitMs = 0;

      if (this.minIntervalMs > 0 && this.lastRequestAt > 0) {
        const sinceLast = current - this.lastRequestAt;
        if (sinceLast < this.minIntervalMs) {
          waitMs = Math.max(waitMs, this.minIntervalMs - sinceLast);
        }
      }

      if (this.requestsPerMinute !== undefined && this.requestTokens < 1) {
        const needed = 1 - this.requestTokens;
        waitMs = Math.max(waitMs, Math.ceil((needed / this.requestsPerMinute) * 60_000));
      }

      const tokenDemand = Math.max(0, estimatedTokens);
      if (this.tokensPerMinute !== undefined && tokenDemand > 0 && this.tokenBudget < tokenDemand) {
        const cappedDemand = Math.min(tokenDemand, this.tokensPerMinute);
        if (this.tokenBudget < cappedDemand) {
          const needed = cappedDemand - this.tokenBudget;
          waitMs = Math.max(waitMs, Math.ceil((needed / this.tokensPerMinute) * 60_000));
        }
      }

      if (waitMs <= 0) {
        if (this.requestsPerMinute !== undefined) {
          this.requestTokens = Math.max(0, this.requestTokens - 1);
        }
        if (this.tokensPerMinute !== undefined && tokenDemand > 0) {
          this.tokenBudget = Math.max(0, this.tokenBudget - Math.min(tokenDemand, this.tokensPerMinute));
        }
        this.lastRequestAt = current;
        return totalWaitMs;
      }

      await sleepWithAbort(waitMs, signal);
      totalWaitMs += waitMs;
    }
  }
}

function readHeaderValue(headers: unknown, targetName: string): string | undefined {
  if (headers === null || headers === undefined) return undefined;
  const lowerTarget = targetName.toLowerCase();

  if (typeof (headers as { get?: unknown }).get === "function") {
    const val = (headers as { get: (k: string) => string | null }).get(targetName);
    return val ?? undefined;
  }

  if (typeof headers === "object") {
    for (const [key, val] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === lowerTarget && typeof val === "string") {
        return val;
      }
    }
  }
  return undefined;
}

/**
 * Extract a server-supplied retry delay (`Retry-After` header or Google RPC
 * `retryDelay` / `retry in Xs` hint), clamped cleanly to `[0, maxMs]`.
 */
export function extractRetryAfterMs(error: unknown, maxMs = 30_000): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;

  const headerSources = [
    record.headers,
    (record.response as Record<string, unknown> | undefined)?.headers,
    (record.sdkHttpResponse as Record<string, unknown> | undefined)?.headers,
  ];
  for (const source of headerSources) {
    const retryAfter = readHeaderValue(source, "retry-after");
    if (retryAfter !== undefined) {
      const asSeconds = Number(retryAfter.trim());
      if (Number.isFinite(asSeconds) && asSeconds >= 0) {
        return Math.min(maxMs, Math.round(asSeconds * 1_000));
      }
      const asDate = Date.parse(retryAfter);
      if (!Number.isNaN(asDate)) {
        return Math.min(maxMs, Math.max(0, asDate - Date.now()));
      }
    }
  }

  if (typeof record.retryDelayMs === "number" && Number.isFinite(record.retryDelayMs) && record.retryDelayMs >= 0) {
    return Math.min(maxMs, Math.round(record.retryDelayMs));
  }

  const msg = record.message;
  if (typeof msg === "string") {
    const match = /(?:retry\s+(?:in|after)\s+|"retryDelay"\s*:\s*")(\d+(?:\.\d+)?)\s*s/i.exec(msg);
    if (match?.[1] !== undefined) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(maxMs, Math.round(seconds * 1_000));
      }
    }
  }

  return undefined;
}

export interface BackoffComputeInput {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMs?: number;
  random?: () => number;
}

/**
 * Bounded exponential backoff with jitter (`[0.5x, 1.0x]` full-floor jitter),
 * respecting `Retry-After` up to `maxDelayMs`.
 */
export function computeRetryDelayMs(input: BackoffComputeInput): number {
  const exp = Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** Math.max(0, input.attempt - 1));
  const rand = Math.max(0, Math.min(1, (input.random ?? Math.random)()));
  const jittered = Math.round(exp * (0.5 + rand * 0.5));
  const target =
    input.retryAfterMs !== undefined ? Math.max(jittered, Math.min(input.maxDelayMs, input.retryAfterMs)) : jittered;
  return Math.max(0, Math.min(input.maxDelayMs, target));
}
