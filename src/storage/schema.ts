export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Versioned schema history. Migrations are append-only: never edit an applied
 * migration, add a new one.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "runtime_core",
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','waiting_for_approval','completed','failed','cancelled')),
        output TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX runs_session_idx ON runs(session_id, created_at);

      CREATE TABLE run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX run_events_run_idx ON run_events(run_id, seq);

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        run_id TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        capability TEXT,
        resource TEXT,
        decision TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX audit_log_at_idx ON audit_log(at);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','approval_blocked','retryable','interrupted','needs_reconciliation')),
        payload TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        priority INTEGER NOT NULL DEFAULT 0,
        dependencies TEXT NOT NULL DEFAULT '[]',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        available_at TEXT NOT NULL,
        locked_by TEXT,
        effect_uncertain INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX tasks_status_idx ON tasks(status, available_at, priority);

      CREATE TABLE task_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','skipped')),
        result TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX task_steps_task_idx ON task_steps(task_id, position);

      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        task_kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        next_run_at TEXT NOT NULL,
        every_seconds INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_task_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX schedules_due_idx ON schedules(enabled, next_run_at);
    `,
  },
  {
    version: 2,
    name: "personal_memory",
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX messages_session_idx ON messages(session_id, id);

      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('fact','preference','goal','commitment','outcome','note','project')),
        subject TEXT NOT NULL DEFAULT '',
        predicate TEXT NOT NULL DEFAULT '',
        value TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('user_confirmed','inferred','imported','execution')),
        confidence REAL,
        scope TEXT NOT NULL DEFAULT 'personal',
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        superseded_by TEXT REFERENCES memory_items(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX memory_items_active_idx ON memory_items(kind, subject, predicate, scope, valid_to);
      CREATE INDEX memory_items_created_idx ON memory_items(created_at);

      CREATE VIRTUAL TABLE memory_fts USING fts5(item_id UNINDEXED, text, tokenize = 'unicode61');

      CREATE TABLE memory_provenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        origin TEXT NOT NULL,
        detail TEXT NOT NULL,
        at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "credential_metadata",
    sql: `
      CREATE TABLE credential_metadata (
        name TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        hint TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: "recovery_checkpoints",
    sql: `
      CREATE TABLE recovery_checkpoints (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        label TEXT NOT NULL,
        state TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX recovery_checkpoints_scope_idx ON recovery_checkpoints(scope_id, created_at);
    `,
  },
];
