import { z } from "zod";
import type { Db, SqlValue } from "../storage/db.js";
import { newId, nowIso } from "../shared/ids.js";
import { AelvoError } from "../shared/errors/index.js";

export const MemoryKindSchema = z.enum(["fact", "preference", "goal", "commitment", "outcome", "note", "project"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemorySourceSchema = z.enum(["user_confirmed", "inferred", "imported", "execution"]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  value: string;
  source: MemorySource;
  confidence: number | null;
  scope: string;
  createdAt: string;
  updatedAt: string;
  validFrom: string;
  validTo: string | null;
  supersededBy: string | null;
}

export interface RememberInput {
  kind: MemoryKind;
  value: string;
  subject?: string;
  predicate?: string;
  source?: MemorySource;
  confidence?: number;
  scope?: string;
  origin?: string;
}

interface MemoryRow {
  id: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  value: string;
  source: MemorySource;
  confidence: number | null;
  scope: string;
  valid_from: string;
  valid_to: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

function toItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    predicate: row.predicate,
    value: row.value,
    source: row.source,
    confidence: row.confidence,
    scope: row.scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    supersededBy: row.superseded_by,
  };
}

function ftsText(item: { kind: string; subject: string; predicate: string; value: string }): string {
  return [item.kind, item.subject, item.predicate, item.value].filter((part) => part.length > 0).join(" ");
}

/**
 * Personal memory: durable, provenance-bearing facts and preferences with
 * explicit supersession. Inferred items are never upgraded to confirmed facts
 * implicitly; only a user correction does that.
 */
export class MemoryService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  remember(input: RememberInput): MemoryItem {
    const kind = MemoryKindSchema.parse(input.kind);
    const source = MemorySourceSchema.parse(input.source ?? "user_confirmed");
    const value = input.value.trim();
    if (value.length === 0) throw new AelvoError("TASK_INVALID", "Memory value must not be empty");
    const subject = input.subject ?? "";
    const predicate = input.predicate ?? "";
    const scope = input.scope ?? "personal";
    const now = nowIso();
    const id = newId("mem");
    const confidence = input.confidence ?? (source === "inferred" ? 0.5 : 1);
    if (confidence < 0 || confidence > 1) {
      throw new AelvoError("TASK_INVALID", "Memory confidence must be between 0 and 1");
    }

    this.db.transaction(() => {
      // Insert first: the supersession pointer has a foreign key to this row.
      this.db.run(
        "INSERT INTO memory_items (id, kind, subject, predicate, value, source, confidence, scope, valid_from, valid_to, superseded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
        [id, kind, subject, predicate, value, source, confidence, scope, now, now, now],
      );
      this.db.run("INSERT INTO memory_fts (item_id, text) VALUES (?, ?)", [id, ftsText({ kind, subject, predicate, value })]);
      this.db.run("INSERT INTO memory_provenance (item_id, origin, detail, at) VALUES (?, ?, ?, ?)", [
        id,
        input.origin ?? source,
        JSON.stringify({ source, confidence }),
        now,
      ]);
      if (kind === "fact" || kind === "preference" || kind === "project") {
        const active = this.db.all<{ id: string }>(
          "SELECT id FROM memory_items WHERE kind = ? AND subject = ? AND predicate = ? AND scope = ? AND valid_to IS NULL AND id != ?",
          [kind, subject, predicate, scope, id],
        );
        for (const previous of active) {
          this.db.run("UPDATE memory_items SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ?", [
            now,
            id,
            now,
            previous.id,
          ]);
        }
      }
    });
    const created = this.get(id);
    if (created === undefined) throw new AelvoError("STORAGE_FAILED", "Memory insert was not persisted");
    return created;
  }

  /** Explicit user correction: supersedes the old item with a confirmed value. */
  correct(id: string, value: string, origin = "user_correction"): MemoryItem {
    const existing = this.get(id);
    if (existing === undefined) throw new AelvoError("STORAGE_FAILED", "Memory item not found");
    return this.remember({
      kind: existing.kind,
      subject: existing.subject,
      predicate: existing.predicate,
      value,
      source: "user_confirmed",
      confidence: 1,
      scope: existing.scope,
      origin,
    });
  }

  get(id: string): MemoryItem | undefined {
    const row = this.db.get<MemoryRow>("SELECT * FROM memory_items WHERE id = ?", [id]);
    return row === undefined ? undefined : toItem(row);
  }

  list(options: { kind?: MemoryKind; includeSuperseded?: boolean; limit?: number } = {}): MemoryItem[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.includeSuperseded !== true) clauses.push("valid_to IS NULL");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(options.limit ?? 100);
    return this.db
      .all<MemoryRow>(`SELECT * FROM memory_items ${where} ORDER BY created_at DESC LIMIT ?`, params)
      .map(toItem);
  }

  /** FTS5 search, restricted to currently valid items. */
  search(query: string, limit = 10): MemoryItem[] {
    const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (tokens.length === 0) return [];
    const match = tokens.map((token) => `"${token}"*`).join(" AND ");
    try {
      return this.db
        .all<MemoryRow>(
          `SELECT m.* FROM memory_fts f JOIN memory_items m ON m.id = f.item_id
           WHERE memory_fts MATCH ? AND m.valid_to IS NULL
           ORDER BY bm25(memory_fts) LIMIT ?`,
          [match, limit],
        )
        .map(toItem);
    } catch {
      // A malformed MATCH expression must not break retrieval; fall back to a
      // bounded substring scan over valid items.
      const like = `%${query.replaceAll("%", "").replaceAll("_", "")}%`;
      return this.db
        .all<MemoryRow>(
          "SELECT * FROM memory_items WHERE valid_to IS NULL AND value LIKE ? ORDER BY created_at DESC LIMIT ?",
          [like, limit],
        )
        .map(toItem);
    }
  }

  /** Hard delete removes the item and its index entry; history of others stays. */
  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.run("DELETE FROM memory_fts WHERE item_id = ?", [id]);
      this.db.run("UPDATE memory_items SET superseded_by = NULL WHERE superseded_by = ?", [id]);
      const result = this.db.run("DELETE FROM memory_items WHERE id = ?", [id]);
      return result.changes > 0;
    });
  }

  exportAll(): { items: MemoryItem[]; provenance: Array<Record<string, unknown>> } {
    const rows = this.db.all<MemoryRow>("SELECT * FROM memory_items ORDER BY created_at");
    const provenance = this.db.all<{ item_id: string; origin: string; detail: string; at: string }>(
      "SELECT * FROM memory_provenance ORDER BY id",
    );
    return {
      items: rows.map(toItem),
      provenance: provenance.map((row) => ({
        itemId: row.item_id,
        origin: row.origin,
        detail: JSON.parse(row.detail) as Record<string, unknown>,
        at: row.at,
      })),
    };
  }

  createSession(title?: string): SessionSummary {
    const id = newId("ses");
    const now = nowIso();
    this.db.run("INSERT INTO sessions (id, title, summary, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)", [
      id,
      title ?? null,
      now,
      now,
    ]);
    return { id, title: title ?? null, summary: null, createdAt: now, updatedAt: now };
  }

  ensureSession(id: string, title?: string): SessionSummary {
    const existing = this.getSession(id);
    if (existing !== undefined) return existing;
    const now = nowIso();
    this.db.run("INSERT INTO sessions (id, title, summary, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)", [
      id,
      title ?? null,
      now,
      now,
    ]);
    return { id, title: title ?? null, summary: null, createdAt: now, updatedAt: now };
  }

  getSession(id: string): SessionSummary | undefined {
    const row = this.db.get<{ id: string; title: string | null; summary: string | null; created_at: string; updated_at: string }>(
      "SELECT * FROM sessions WHERE id = ?",
      [id],
    );
    return row === undefined
      ? undefined
      : { id: row.id, title: row.title, summary: row.summary, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  appendMessage(sessionId: string, role: "user" | "assistant" | "tool" | "system", content: string, metadata?: Record<string, unknown>): void {
    this.db.transaction(() => {
      const now = nowIso();
      this.db.run("INSERT INTO messages (session_id, role, content, created_at, metadata) VALUES (?, ?, ?, ?, ?)", [
        sessionId,
        role,
        content,
        now,
        JSON.stringify(metadata ?? {}),
      ]);
      this.db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [now, sessionId]);
    });
  }

  recentMessages(sessionId: string, limit = 20): Array<{ role: string; content: string; at: string }> {
    const rows = this.db.all<{ role: string; content: string; created_at: string }>(
      "SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
      [sessionId, limit],
    );
    return rows.reverse().map((row) => ({ role: row.role, content: row.content, at: row.created_at }));
  }

  setSessionSummary(sessionId: string, summary: string): void {
    this.db.run("UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?", [summary, nowIso(), sessionId]);
  }

  counts(): { items: number; active: number; sessions: number; messages: number } {
    const items = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_items")?.n ?? 0;
    const active = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_items WHERE valid_to IS NULL")?.n ?? 0;
    const sessions = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions")?.n ?? 0;
    const messages = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages")?.n ?? 0;
    return { items, active, sessions, messages };
  }
}
