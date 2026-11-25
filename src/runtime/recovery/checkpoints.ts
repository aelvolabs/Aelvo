import type { Db } from "../../storage/db.js";
import { nowIso, newId } from "../../shared/ids.js";
import { sha256 } from "../../shared/canonical.js";
import { AelvoError } from "../../shared/errors/index.js";

export interface CheckpointRecord {
  id: string;
  scopeId: string;
  label: string;
  state: unknown;
  stateHash: string;
  createdAt: string;
}

interface CheckpointRow {
  id: string;
  scope_id: string;
  label: string;
  state: string;
  state_hash: string;
  created_at: string;
}

function toRecord(row: CheckpointRow): CheckpointRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.state);
  } catch (error) {
    throw new AelvoError("STORAGE_FAILED", "Recovery checkpoint contains invalid JSON", { cause: error });
  }
  return {
    id: row.id,
    scopeId: row.scope_id,
    label: row.label,
    state: parsed,
    stateHash: row.state_hash,
    createdAt: row.created_at,
  };
}

/**
 * Durable recovery checkpoints. The digest covers the exact serialized state,
 * so a checkpoint edited outside the runtime is rejected on restore instead of
 * being replayed as trusted state.
 */
export class CheckpointStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  save(scopeId: string, label: string, state: unknown): CheckpointRecord {
    if (scopeId.trim().length === 0) throw new AelvoError("TASK_INVALID", "Checkpoint scope is required");
    const serialized = JSON.stringify(state);
    const record: CheckpointRecord = {
      id: newId("ckpt"),
      scopeId,
      label,
      state,
      stateHash: sha256(serialized),
      createdAt: nowIso(),
    };
    this.db.run(
      "INSERT INTO recovery_checkpoints (id, scope_id, label, state, state_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [record.id, record.scopeId, record.label, serialized, record.stateHash, record.createdAt],
    );
    return record;
  }

  latest(scopeId: string, label?: string): CheckpointRecord | undefined {
    const row =
      label === undefined
        ? this.db.get<CheckpointRow>(
            "SELECT * FROM recovery_checkpoints WHERE scope_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [scopeId],
          )
        : this.db.get<CheckpointRow>(
            "SELECT * FROM recovery_checkpoints WHERE scope_id = ? AND label = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [scopeId, label],
          );
    return row === undefined ? undefined : toRecord(row);
  }

  list(scopeId: string): CheckpointRecord[] {
    return this.db
      .all<CheckpointRow>(
        "SELECT * FROM recovery_checkpoints WHERE scope_id = ? ORDER BY created_at ASC, rowid ASC",
        [scopeId],
      )
      .map(toRecord);
  }

  /** Restores only a checkpoint whose digest still matches its serialized state. */
  restore(scopeId: string, label?: string): unknown {
    const checkpoint = this.latest(scopeId, label);
    if (checkpoint === undefined) {
      throw new AelvoError("TASK_NOT_FOUND", `No recovery checkpoint for ${scopeId}`);
    }
    const serialized = JSON.stringify(checkpoint.state);
    if (sha256(serialized) !== checkpoint.stateHash) {
      throw new AelvoError("VERIFICATION_FAILED", "Recovery checkpoint digest does not match; refusing to replay");
    }
    return checkpoint.state;
  }

  clear(scopeId: string): number {
    return this.db.run("DELETE FROM recovery_checkpoints WHERE scope_id = ?", [scopeId]).changes;
  }

  count(scopeId?: string): number {
    const row =
      scopeId === undefined
        ? this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_checkpoints")
        : this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_checkpoints WHERE scope_id = ?", [scopeId]);
    return row?.n ?? 0;
  }
}
