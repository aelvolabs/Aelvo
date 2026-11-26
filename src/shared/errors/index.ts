/**
 * Error taxonomy. Every failure crossing a module boundary is one of these
 * codes, so callers never have to interpret free-form messages and no failure
 * can be silently swallowed.
 */
export type ErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_MISSING"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_QUOTA_EXCEEDED"
  | "PROVIDER_INVALID_REQUEST"
  | "PROVIDER_MODEL_UNSUPPORTED"
  | "PROVIDER_CONTEXT_LENGTH"
  | "PROVIDER_CONTENT_BLOCKED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_ABORTED"
  | "LIVE_SESSION_STATE_INVALID"
  | "LIVE_SESSION_CLOSED"
  | "LIVE_QUEUE_OVERFLOW"
  | "LIVE_PROTOCOL_INVALID"
  | "LIVE_RESUMPTION_UNAVAILABLE"
  | "TOOL_NOT_FOUND"
  | "TOOL_INPUT_INVALID"
  | "TOOL_DENIED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_DIGEST_MISMATCH"
  | "APPROVAL_ALREADY_USED"
  | "EMERGENCY_STOP"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PATH_PROTECTED"
  | "PATH_INVALID"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_ABORTED"
  | "EXECUTION_FAILED"
  | "VERIFICATION_FAILED"
  | "EVIDENCE_MISSING"
  | "SANDBOX_UNAVAILABLE"
  | "CREDENTIAL_STORE_UNAVAILABLE"
  | "CREDENTIAL_NOT_FOUND"
  | "CREDENTIAL_INVALID"
  | "CREDENTIAL_EXPIRED"
  | "STORAGE_FAILED"
  | "TASK_INVALID"
  | "TASK_DEPENDENCY_CYCLE"
  | "TASK_TRANSITION_INVALID"
  | "TASK_NOT_FOUND"
  | "MCP_UNAVAILABLE"
  | "MCP_TOOL_NOT_ALLOWED"
  | "SERVER_UNAUTHORIZED"
  | "SERVER_ORIGIN_REJECTED"
  | "SERVER_PAYLOAD_INVALID"
  | "SERVER_RATE_LIMITED";

export interface AelvoErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

export class AelvoError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AelvoErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AelvoError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export function isAelvoError(value: unknown): value is AelvoError {
  return value instanceof AelvoError;
}

/** Convert anything thrown into an AelvoError without losing the cause. */
export function asAelvoError(value: unknown, fallback: ErrorCode = "EXECUTION_FAILED"): AelvoError {
  if (isAelvoError(value)) return value;
  if (value instanceof Error) {
    return new AelvoError(fallback, value.message, { cause: value });
  }
  return new AelvoError(fallback, String(value));
}

/** Serializable error shape for IPC, logs and model tool results. */
export interface PublicError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export function toPublicError(value: unknown): PublicError {
  const error = asAelvoError(value);
  const base: PublicError = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
  return Object.keys(error.details).length > 0 ? { ...base, details: error.details } : base;
}
