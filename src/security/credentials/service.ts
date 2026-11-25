import type { Db } from "../../storage/db.js";
import { nowIso } from "../../shared/ids.js";
import { AelvoError } from "../../shared/errors/index.js";
import {
  DpapiCredentialBackend,
  KeychainCredentialBackend,
  SecretServiceCredentialBackend,
  type CredentialBackend,
} from "./backends.js";

export interface CredentialMetadata {
  name: string;
  backend: string;
  hint: string;
  updatedAt: string;
}

export function createPlatformBackend(dataDir: string): CredentialBackend {
  switch (process.platform) {
    case "win32":
      return new DpapiCredentialBackend(`${dataDir}/credentials`);
    case "darwin":
      return new KeychainCredentialBackend();
    default:
      return new SecretServiceCredentialBackend();
  }
}

/**
 * Credential access with OS-backed storage and metadata only in SQLite.
 * Secrets are never persisted by this service outside the OS backend, never
 * returned to tools and never included in metadata.
 */
export class CredentialService {
  private readonly db: Db;
  private readonly backend: CredentialBackend;

  constructor(db: Db, backend: CredentialBackend) {
    this.db = db;
    this.backend = backend;
  }

  async set(name: string, secret: string): Promise<CredentialMetadata> {
    if (secret.length === 0) {
      throw new AelvoError("CONFIG_INVALID", "Credential value must not be empty");
    }
    await this.backend.write(name, secret);
    const hint = secret.length <= 4 ? "****" : `****${secret.slice(-4)}`;
    this.db.run(
      "INSERT INTO credential_metadata (name, backend, hint, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET backend=excluded.backend, hint=excluded.hint, updated_at=excluded.updated_at",
      [name, this.backend.kind, hint, nowIso()],
    );
    return { name, backend: this.backend.kind, hint, updatedAt: nowIso() };
  }

  async find(name: string): Promise<string | undefined> {
    return this.backend.read(name);
  }

  async require(name: string): Promise<string> {
    const value = await this.backend.read(name);
    if (value === undefined) {
      throw new AelvoError("CREDENTIAL_NOT_FOUND", `No credential named ${name}`);
    }
    return value;
  }

  async delete(name: string): Promise<void> {
    await this.backend.remove(name);
    this.db.run("DELETE FROM credential_metadata WHERE name = ?", [name]);
  }

  list(): CredentialMetadata[] {
    const rows = this.db.all<{ name: string; backend: string; hint: string; updated_at: string }>(
      "SELECT name, backend, hint, updated_at FROM credential_metadata ORDER BY name",
    );
    return rows.map((row) => ({
      name: row.name,
      backend: row.backend,
      hint: row.hint,
      updatedAt: row.updated_at,
    }));
  }

  async backendAvailable(): Promise<boolean> {
    return this.backend.available();
  }

  get backendKind(): string {
    return this.backend.kind;
  }
}
