import type { Db } from "../../storage/db.js";
import { nowIso } from "../../shared/ids.js";
import { redactValue } from "../../observability/redact.js";

export interface AuditEntry {
  runId?: string;
  actor: "model" | "user" | "system" | "bridge";
  action: string;
  capability?: string;
  resource?: string;
  decision: "allow" | "deny" | "approval_requested" | "approval_granted" | "executed" | "failed" | "cancelled";
  detail?: Record<string, unknown>;
}

/**
 * Append-only security audit trail. Every privileged decision and every
 * execution attempt is recorded before the caller can claim success.
 */
export class AuditLog {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  record(entry: AuditEntry): void {
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
        JSON.stringify(redactValue(entry.detail ?? {})),
      ],
    );
  }

  recent(limit = 50): AuditEntry[] {
    const rows = this.db.all<{
      run_id: string | null;
      actor: string;
      action: string;
      capability: string | null;
      resource: string | null;
      decision: string;
      detail: string;
      at: string;
    }>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", [limit]);
    return rows.map((row) => ({
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      actor: row.actor as AuditEntry["actor"],
      action: row.action,
      ...(row.capability === null ? {} : { capability: row.capability }),
      ...(row.resource === null ? {} : { resource: row.resource }),
      decision: row.decision as AuditEntry["decision"],
      detail: { ...(JSON.parse(row.detail) as Record<string, unknown>), at: row.at },
    }));
  }
}
