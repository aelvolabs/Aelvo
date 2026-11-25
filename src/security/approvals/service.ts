import { newId } from "../../shared/ids.js";
import { canonicalJson, sha256 } from "../../shared/canonical.js";
import type { ApprovalRequest, Capability } from "../../shared/contracts/index.js";
import { AelvoError } from "../../shared/errors/index.js";

export interface ApprovalBinding {
  runId: string;
  sessionId: string;
  tool: string;
  capability: Capability;
  resource: string;
  arguments: Record<string, unknown>;
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
    }),
  );
}

interface ApprovalRecord {
  request: ApprovalRequest;
  binding: ApprovalBinding;
  approved: boolean;
  used: boolean;
  expiresAtMs: number;
}

/**
 * Single-use approvals bound to the exact action, normalized arguments,
 * workspace scope and run identity. Changing any of them invalidates the
 * approval; restarting the runtime invalidates every approval (fail closed).
 */
export class ApprovalService {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly digestIndex = new Map<string, string>();
  private readonly ttlMs: number;

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1_000;
  }

  request(binding: ApprovalBinding, summary: string): ApprovalRequest {
    const id = newId("apr");
    const digest = approvalDigest(binding);
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    const request: ApprovalRequest = {
      id,
      runId: binding.runId,
      tool: binding.tool,
      capability: binding.capability,
      resource: binding.resource,
      digest,
      expiresAt,
      summary,
    };
    this.records.set(id, {
      request,
      binding,
      approved: false,
      used: false,
      expiresAtMs: Date.now() + this.ttlMs,
    });
    this.digestIndex.set(digest, id);
    return request;
  }

  /** Mark an approval as granted. Returns false for unknown/expired records. */
  approve(id: string): boolean {
    const record = this.require(id);
    if (Date.now() > record.expiresAtMs) {
      this.records.delete(id);
      throw new AelvoError("APPROVAL_EXPIRED", "Approval has expired");
    }
    record.approved = true;
    return true;
  }

  deny(id: string): void {
    this.records.delete(id);
    for (const [digest, approvalId] of this.digestIndex) {
      if (approvalId === id) this.digestIndex.delete(digest);
    }
  }

  list(): ApprovalRequest[] {
    this.pruneExpired();
    return [...this.records.values()]
      .filter((record) => record.approved && !record.used)
      .map((record) => record.request);
  }

  /**
   * Redeem an approval for a concrete action. The caller passes the binding it
   * is about to execute; a mismatch is rejected rather than silently accepted.
   */
  redeem(approvalId: string, binding: ApprovalBinding): ApprovalRequest {
    const record = this.require(approvalId);
    if (Date.now() > record.expiresAtMs) {
      this.records.delete(approvalId);
      throw new AelvoError("APPROVAL_EXPIRED", "Approval has expired");
    }
    if (!record.approved) {
      throw new AelvoError("APPROVAL_INVALID", "Approval has not been granted");
    }
    if (record.used) {
      throw new AelvoError("APPROVAL_ALREADY_USED", "Approval has already been used");
    }
    if (approvalDigest(binding) !== record.request.digest) {
      throw new AelvoError(
        "APPROVAL_DIGEST_MISMATCH",
        "Action does not match the approved action; approval is invalid",
      );
    }
    record.used = true;
    return record.request;
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
      if (now > record.expiresAtMs) {
        this.records.delete(id);
        this.digestIndex.delete(record.request.digest);
      }
    }
  }
}
