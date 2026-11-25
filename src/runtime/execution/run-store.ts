import type { Db } from "../../storage/db.js";
import type { RunStatus, RuntimeEvent } from "../../shared/contracts/index.js";
import { nowIso } from "../../shared/ids.js";

export interface RunRecord {
  id: string;
  sessionId: string;
  input: string;
  status: RunStatus;
  output: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RunRow {
  id: string;
  session_id: string;
  input: string;
  status: RunStatus;
  output: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export class RunStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(id: string, sessionId: string, input: string): RunRecord {
    const now = nowIso();
    this.db.run(
      "INSERT INTO runs (id, session_id, input, status, output, error_code, created_at, updated_at) VALUES (?, ?, ?, 'running', NULL, NULL, ?, ?)",
      [id, sessionId, input, now, now],
    );
    return this.require(id);
  }

  setStatus(id: string, status: RunStatus, output?: string, errorCode?: string): void {
    this.db.run("UPDATE runs SET status = ?, output = ?, error_code = ?, updated_at = ? WHERE id = ?", [
      status,
      output ?? null,
      errorCode ?? null,
      nowIso(),
      id,
    ]);
  }

  appendEvent(id: string, event: RuntimeEvent): void {
    this.db.run("INSERT INTO run_events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)", [
      id,
      event.type,
      JSON.stringify(event),
      nowIso(),
    ]);
  }

  get(id: string): RunRecord | undefined {
    const row = this.db.get<RunRow>("SELECT * FROM runs WHERE id = ?", [id]);
    return row === undefined ? undefined : this.map(row);
  }

  require(id: string): RunRecord {
    const record = this.get(id);
    if (record === undefined) throw new Error(`Unknown run: ${id}`);
    return record;
  }

  recent(limit = 20): RunRecord[] {
    return this.db.all<RunRow>("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?", [limit]).map((row) => this.map(row));
  }

  events(runId: string, limit = 200): RuntimeEvent[] {
    return this.db
      .all<{ payload: string }>("SELECT payload FROM run_events WHERE run_id = ? ORDER BY seq LIMIT ?", [runId, limit])
      .map((row) => JSON.parse(row.payload) as RuntimeEvent);
  }

  private map(row: RunRow): RunRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      input: row.input,
      status: row.status,
      output: row.output,
      errorCode: row.error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
