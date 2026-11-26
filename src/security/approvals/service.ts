import { newId } from "../../shared/ids.js";
import { canonicalJson, sha256 } from "../../shared/canonical.js";
import type { ApprovalRequest, Capability, RequestOrigin, RiskLevel } from "../../shared/contracts/index.js";
import { AelvoError } from "../../shared/errors/index.js";

export type ApprovalDecisionState =
  | "pending"
  | "approved"
  | "denied"
  | "revoked"
  | "consumed"
  | "expired";

export interface ApprovalBinding {
  runId: string;
  sessionId: string;
  tool: string;
  capability: Capability;
  resource: string;
  arguments: Record<string, unknown>;
  executionId?: string;
  origin?: RequestOrigin;
  scope?: string;
  policyEpoch?: number;
}

export function approvalDigest(binding: ApprovalBinding): string {
  return sha256(
    canonicalJson({
      runId: binding.runId,
      sessionId: binding.sessionId,
      tool: binding.tool,
      capability: binding.capability,
      resource: binding.resource,
      arguments: binding.arguments,
      ...(binding.executionId === undefined ? {} : { executionId: binding.executionId }),
      ...(binding.origin === undefined ? {} : { origin: binding.origin }),
      ...(binding.scope === undefined ? {} : { scope: binding.scope }),
      ...(binding.policyEpoch === undefined ? {} : { policyEpoch: binding.policyEpoch }),
    }),
  );
}

interface ApprovalRecord {
  request: ApprovalRequest;
  binding: ApprovalBinding;
  state: ApprovalDecisionState;
  createdAtMs: number;
  expiresAtMs: number;
  decidedAtMs?: number;
  decidedBy?: string;
  decisionReason?: string;
}

const DEFAULT_MAX_RECORDS = 2_000;

/**
 * Single-use approvals bound atomically to the exact action, canonical normalized
 * arguments, run/session/execution identity, scope and policy epoch.
 *
 * Modifying arguments, replaying across sessions or runs, letting approvals expire,
 * revoking them during emergency stop, or mutating policy invalidates them cleanly.
 * Restarting the runtime clears all in-memory approvals (fail closed).
 */
export class ApprovalService {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly digestIndex = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(ttlSeconds: number, maxRecords = DEFAULT_MAX_RECORDS) {
    this.ttlMs = ttlSeconds * 1_000;
    this.maxRecords = Math.max(50, maxRecords);
  }

  request(
    binding: ApprovalBinding,
    summary: string,
    metadata: { riskLevel?: RiskLevel } = {},
  ): ApprovalRequest {
    this.pruneBounded();
    const id = newId("apr");
    const digest = approvalDigest(binding);
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + this.ttlMs;
    const request: ApprovalRequest = {
      id,
      runId: binding.runId,
      tool: binding.tool,
      capability: binding.capability,
      resource: binding.resource,
      digest,
      expiresAt: new Date(expiresAtMs).toISOString(),
      summary,
      sessionId: binding.sessionId,
      ...(binding.executionId === undefined ? {} : { executionId: binding.executionId }),
      ...(binding.origin === undefined ? {} : { origin: binding.origin }),
      ...(metadata.riskLevel === undefined ? {} : { riskLevel: metadata.riskLevel }),
      ...(binding.scope === undefined ? {} : { scope: binding.scope }),
      ...(binding.policyEpoch === undefined ? {} : { policyEpoch: binding.policyEpoch }),
    };
    this.records.set(id, {
      request,
      binding,
      state: "pending",
      createdAtMs,
      expiresAtMs,
    });
    this.digestIndex.set(digest, id);
    return request;
  }

  /**
   * Grant a pending approval. Only an explicit authorized actor (`user`, `cli`,
   * `bridge`, `system`) may grant; model self-approval is rejected unconditionally.
   */
  approve(id: string, decidedBy: "user" | "cli" | "bridge" | "system" | "model" = "user"): boolean {
    if (decidedBy === "model") {
      throw new AelvoError("TOOL_DENIED", "The model is never permitted to approve its own actions");
    }
    const record = this.require(id);
    this.assertNotExpired(id, record);
    if (record.state === "consumed") {
      throw new AelvoError("APPROVAL_ALREADY_USED", "Approval has already been consumed");
    }
    if (record.state === "revoked") {
      throw new AelvoError("APPROVAL_INVALID", "Approval was revoked");
    }
    if (record.state === "denied") {
      throw new AelvoError("APPROVAL_INVALID", "Approval was already denied");
    }
    if (record.state === "approved") {
      return true;
    }
    record.state = "approved";
    record.decidedAtMs = Date.now();
    record.decidedBy = decidedBy;
    return true;
  }

  deny(id: string, decidedBy = "user", reason = "Denied by user"): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    if (record.state === "consumed") {
      throw new AelvoError("APPROVAL_ALREADY_USED", "Cannot deny an already consumed approval");
    }
    record.state = "denied";
    record.decidedAtMs = Date.now();
    record.decidedBy = decidedBy;
    record.decisionReason = reason;
    this.digestIndex.delete(record.request.digest);
  }

  /** Explicitly revoke a pending or unconsumed approval (e.g. session change or emergency stop). */
  revoke(id: string, reason = "Approval revoked"): boolean {
    const record = this.records.get(id);
    if (record === undefined) return false;
    if (record.state === "consumed" || record.state === "denied" || record.state === "expired") {
      return false;
    }
    record.state = "revoked";
    record.decidedAtMs = Date.now();
    record.decisionReason = reason;
    this.digestIndex.delete(record.request.digest);
    return true;
  }

  /** Revoke all pending/approved approvals belonging to `runId`. */
  revokeByRun(runId: string, reason = "Run cancelled"): number {
    let count = 0;
    for (const [id, record] of this.records) {
      if (record.binding.runId === runId && this.revoke(id, reason)) {
        count += 1;
      }
    }
    return count;
  }

  /** Revoke every pending or unconsumed approval (used on emergency stop or global revocation). */
  revokeAll(reason = "Emergency stop / global revocation"): number {
    let count = 0;
    for (const id of this.records.keys()) {
      if (this.revoke(id, reason)) {
        count += 1;
      }
    }
    return count;
  }

  status(id: string): ApprovalDecisionState | undefined {
    const record = this.records.get(id);
    if (record === undefined) return undefined;
    if (
      (record.state === "pending" || record.state === "approved") &&
      Date.now() > record.expiresAtMs
    ) {
      record.state = "expired";
      this.digestIndex.delete(record.request.digest);
    }
    return record.state;
  }

  list(): ApprovalRequest[] {
    this.pruneExpired();
    return [...this.records.values()]
      .filter((record) => record.state === "approved")
      .map((record) => record.request);
  }

  listPending(): ApprovalRequest[] {
    this.pruneExpired();
    return [...this.records.values()]
      .filter((record) => record.state === "pending")
      .map((record) => record.request);
  }

  /**
   * Atomically redeem an approval for a concrete action binding.
   * Transitions `approved` -> `consumed` synchronously before returning so two
   * concurrent execution attempts can never consume the same approval twice.
   */
  redeem(approvalId: string, binding: ApprovalBinding): ApprovalRequest {
    const record = this.require(approvalId);
    this.assertNotExpired(approvalId, record);

    if (record.state === "revoked") {
      throw new AelvoError("APPROVAL_INVALID", `Approval has been revoked: ${record.decisionReason ?? "revoked"}`);
    }
    if (record.state === "denied") {
      throw new AelvoError("APPROVAL_INVALID", "Approval was denied");
    }
    if (record.state === "consumed") {
      throw new AelvoError("APPROVAL_ALREADY_USED", "Approval has already been used");
    }
    if (record.state !== "approved") {
      throw new AelvoError("APPROVAL_INVALID", "Approval has not been granted");
    }
    if (record.binding.sessionId !== binding.sessionId) {
      throw new AelvoError("APPROVAL_DIGEST_MISMATCH", "Approval belongs to a different session");
    }
    if (approvalDigest(binding) !== record.request.digest) {
      throw new AelvoError(
        "APPROVAL_DIGEST_MISMATCH",
        "Action does not match the approved action; approval is invalid",
      );
    }

    record.state = "consumed";
    this.digestIndex.delete(record.request.digest);
    return record.request;
  }

  private assertNotExpired(id: string, record: ApprovalRecord): void {
    if (Date.now() > record.expiresAtMs) {
      record.state = "expired";
      this.digestIndex.delete(record.request.digest);
      this.records.delete(id);
      throw new AelvoError("APPROVAL_EXPIRED", "Approval has expired");
    }
  }

  private require(id: string): ApprovalRecord {
    const record = this.records.get(id);
    if (record === undefined) {
      throw new AelvoError("APPROVAL_INVALID", "Unknown approval");
    }
    return record;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (now > record.expiresAtMs && (record.state === "pending" || record.state === "approved")) {
        record.state = "expired";
        this.digestIndex.delete(record.request.digest);
        this.records.delete(id);
      }
    }
  }

  private pruneBounded(): void {
    this.pruneExpired();
    if (this.records.size < this.maxRecords) return;
    for (const [id, record] of this.records) {
      if (record.state !== "pending" && record.state !== "approved") {
        this.digestIndex.delete(record.request.digest);
        this.records.delete(id);
        if (this.records.size < this.maxRecords) return;
      }
    }
    // Evict oldest if still over budget.
    const oldest = this.records.keys().next().value;
    if (oldest !== undefined) {
      const rec = this.records.get(oldest);
      if (rec) this.digestIndex.delete(rec.request.digest);
      this.records.delete(oldest);
    }
  }
}
