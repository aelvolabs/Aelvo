import type { Db, SqlValue } from "../../storage/db.js";
import type { RequestOrigin, RiskLevel } from "../../shared/contracts/index.js";
import { newId, nowIso } from "../../shared/ids.js";
import { redactValue } from "../../observability/redact.js";

export type AuditDecision =
  | "requested"
  | "allow"
  | "deny"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "approval_revoked"
  | "executed"
  | "failed"
  | "cancelled"
  | "effect_uncertain"
  | "emergency_stop"
  | "emergency_resume";

export interface AuditEntry {
  eventId?: string;
  runId?: string;
  sessionId?: string;
  executionId?: string;
  origin?: RequestOrigin;
  actor: "model" | "user" | "system" | "bridge" | "cli";
  action: string;
  capability?: string;
  resource?: string;
  scope?: string;
  decision: AuditDecision;
  decisionReason?: string;
  riskLevel?: RiskLevel;
  approvalId?: string;
  executionStatus?: string;
  cancelled?: boolean;
  verified?: boolean;
  detail?: Record<string, unknown>;
}

/**
 * Append-only security audit trail backed by SQLite.
 *
 * Every authorization decision and observed execution outcome is redacted before
 * persistence. Note: an ordinary SQLite table is durable local evidence, not
 * hardware-level tamper immunity.
 */
export class AuditLog {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  record(entry: AuditEntry): string {
    const eventId = entry.eventId ?? newId("aud");
    const envelope: Record<string, unknown> = {
      ...(entry.detail ?? {}),
      eventId,
      ...(entry.origin === undefined ? {} : { origin: entry.origin }),
      ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
      ...(entry.executionId === undefined ? {} : { executionId: entry.executionId }),
      ...(entry.scope === undefined ? {} : { scope: entry.scope }),
      ...(entry.decisionReason === undefined ? {} : { decisionReason: entry.decisionReason }),
      ...(entry.riskLevel === undefined ? {} : { riskLevel: entry.riskLevel }),
      ...(entry.approvalId === undefined ? {} : { approvalId: entry.approvalId }),
      ...(entry.executionStatus === undefined ? {} : { executionStatus: entry.executionStatus }),
      ...(entry.cancelled === undefined ? {} : { cancelled: entry.cancelled }),
      ...(entry.verified === undefined ? {} : { verified: entry.verified }),
    };
    this.db.run(
      "INSERT INTO audit_log (at, run_id, actor, action, capability, resource, decision, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        nowIso(),
        entry.runId ?? null,
        entry.actor,
        entry.action,
        entry.capability ?? null,
        entry.resource ?? null,
        entry.decision,
        JSON.stringify(redactValue(envelope)),
      ],
    );
    return eventId;
  }

  recent(limit = 50): AuditEntry[] {
    return this.query({ limit });
  }

  query(options: { runId?: string; decision?: AuditDecision; limit?: number } = {}): AuditEntry[] {
    const limit = Math.max(1, Math.min(500, options.limit ?? 50));
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (options.runId !== undefined) {
      where.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.decision !== undefined) {
      where.push("decision = ?");
      params.push(options.decision);
    }
    const sql =
      `SELECT * FROM audit_log ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")} `}ORDER BY id DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.all<{
      run_id: string | null;
      actor: string;
      action: string;
      capability: string | null;
      resource: string | null;
      decision: string;
      detail: string;
      at: string;
    }>(sql, params);

    return rows.map((row) => {
      const parsed = JSON.parse(row.detail) as Record<string, unknown>;
      return {
        ...(typeof parsed.eventId === "string" ? { eventId: parsed.eventId } : {}),
        ...(row.run_id === null ? {} : { runId: row.run_id }),
        ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
        ...(typeof parsed.executionId === "string" ? { executionId: parsed.executionId } : {}),
        ...(typeof parsed.origin === "string" ? { origin: parsed.origin as RequestOrigin } : {}),
        actor: row.actor as AuditEntry["actor"],
        action: row.action,
        ...(row.capability === null ? {} : { capability: row.capability }),
        ...(row.resource === null ? {} : { resource: row.resource }),
        ...(typeof parsed.scope === "string" ? { scope: parsed.scope } : {}),
        decision: row.decision as AuditDecision,
        ...(typeof parsed.decisionReason === "string" ? { decisionReason: parsed.decisionReason } : {}),
        ...(typeof parsed.riskLevel === "string" ? { riskLevel: parsed.riskLevel as RiskLevel } : {}),
        ...(typeof parsed.approvalId === "string" ? { approvalId: parsed.approvalId } : {}),
        ...(typeof parsed.executionStatus === "string" ? { executionStatus: parsed.executionStatus } : {}),
        ...(typeof parsed.cancelled === "boolean" ? { cancelled: parsed.cancelled } : {}),
        ...(typeof parsed.verified === "boolean" ? { verified: parsed.verified } : {}),
        detail: { ...parsed, at: row.at },
      };
    });
  }
}
