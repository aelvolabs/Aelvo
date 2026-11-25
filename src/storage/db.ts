import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AelvoError } from "../shared/errors/index.js";
import { MIGRATIONS } from "./schema.js";

export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * Thin, synchronous SQLite wrapper around node:sqlite.
 *
 * Queries are short and local; the runtime keeps long work out of the event
 * loop by batching, not by pretending SQLite is async. Writes use WAL and an
 * explicit busy timeout so a second process cannot corrupt state.
 */
export class Db {
  readonly handle: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.handle = new DatabaseSync(path);
    this.handle.exec("PRAGMA journal_mode = WAL");
    this.handle.exec("PRAGMA foreign_keys = ON");
    this.handle.exec("PRAGMA busy_timeout = 5000");
    this.handle.exec("PRAGMA synchronous = NORMAL");
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  statement(sql: string): StatementSync {
    return this.handle.prepare(sql);
  }

  run(sql: string, params: SqlValue[] = []): { changes: number; lastInsertRowid: number } {
    const result = this.statement(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    // node:sqlite returns untyped rows; every caller supplies a row shape that
    // matches the selected columns. Parsing happens at module boundaries.
    return this.statement(sql).all(...params) as T[];
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  transaction<T>(fn: () => T): T {
    this.handle.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.handle.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.handle.exec("ROLLBACK");
      } catch {
        // The original failure is the one that matters; a rollback failure
        // still leaves the connection usable or throws on the next use.
      }
      throw error;
    }
  }

  close(): void {
    this.handle.close();
  }
}

export function openDatabase(path: string): Db {
  try {
    return new Db(path);
  } catch (error) {
    throw new AelvoError("STORAGE_FAILED", `Unable to open database at ${path}`, { cause: error });
  }
}

export interface MigrationStatus {
  fromVersion: number;
  toVersion: number;
  applied: number[];
}

export function migrate(db: Db): MigrationStatus {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const row = db.get<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_migrations");
  const fromVersion = row?.version ?? 0;
  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        migration.version,
        new Date().toISOString(),
      ]);
    });
    applied.push(migration.version);
  }
  const latest = MIGRATIONS.at(-1)?.version ?? 0;
  return { fromVersion, toVersion: latest, applied };
}
