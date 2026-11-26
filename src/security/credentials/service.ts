import type { Db } from "../../storage/db.js";
import { nowIso } from "../../shared/ids.js";
import { AelvoError, isAelvoError } from "../../shared/errors/index.js";
import {
  DpapiCredentialBackend,
  KeychainCredentialBackend,
  SecretServiceCredentialBackend,
  assertCredentialName,
  type CredentialBackend,
} from "./backends.js";
import {
  credentialHint,
  validateCredentialSecret,
  type CredentialType,
} from "./validation.js";

export interface CredentialMetadata {
  name: string;
  credentialType: CredentialType;
  backend: string;
  hint: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  usageCount: number;
  expiresAt: string | null;
  valid: boolean;
}

export interface SetCredentialOptions {
  credentialType?: CredentialType;
  label?: string;
  expiresAt?: string;
}

export interface CredentialCheck {
  name: string;
  valid: boolean;
  reason: string;
  metadata?: CredentialMetadata;
}

interface CredentialRow {
  name: string;
  credential_type: string;
  backend: string;
  hint: string;
  label: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  usage_count: number;
  expires_at: string | null;
  is_valid: number;
}

function mapMetadata(row: CredentialRow): CredentialMetadata {
  const expiresAt = row.expires_at;
  const expired = expiresAt !== null && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= Date.now();
  return {
    name: row.name,
    credentialType: row.credential_type as CredentialType,
    backend: row.backend,
    hint: row.hint,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    usageCount: row.usage_count,
    expiresAt,
    valid: row.is_valid === 1 && !expired,
  };
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
 *
 * The secret is written to exactly one backend. Metadata never contains the
 * value, only a last-four hint. Reads validate metadata, expiration and format
 * before returning a secret to the application (never to a model tool).
 */
export class CredentialService {
  private readonly db: Db;
  private readonly backend: CredentialBackend;
  private readonly listeners = new Set<(name: string) => void | Promise<void>>();

  constructor(db: Db, backend: CredentialBackend) {
    this.db = db;
    this.backend = backend;
  }

  /** Subscribe to credential writes and deletions so consumers can drop cached clients. */
  onChange(listener: (name: string) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async notifyChange(name: string): Promise<void> {
    for (const listener of this.listeners) {
      await listener(name);
    }
  }

  async set(name: string, secret: string, options: SetCredentialOptions = {}): Promise<CredentialMetadata> {
    assertCredentialName(name);
    if (!(await this.backend.available())) {
      throw new AelvoError("CREDENTIAL_STORE_UNAVAILABLE", `Credential backend ${this.backend.kind} is unavailable`);
    }
    const validation = validateCredentialSecret(secret, name);
    if (!validation.valid) {
      throw new AelvoError("CREDENTIAL_INVALID", validation.reason, { details: { name } });
    }
    if (options.expiresAt !== undefined) {
      const expiry = Date.parse(options.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now()) {
        throw new AelvoError("CONFIG_INVALID", "Credential expiry must be a future ISO timestamp");
      }
    }

    await this.backend.write(name, secret);
    const now = nowIso();
    const credentialType = options.credentialType ?? "api_key";
    const label = options.label ?? name;
    try {
      this.db.run(
        `INSERT INTO credential_metadata
           (name, credential_type, backend, hint, label, created_at, updated_at,
            last_used_at, usage_count, expires_at, is_valid)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, 1)
         ON CONFLICT(name) DO UPDATE SET
           credential_type = excluded.credential_type,
           backend = excluded.backend,
           hint = excluded.hint,
           label = excluded.label,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at,
           is_valid = 1`,
        [name, credentialType, this.backend.kind, credentialHint(secret), label, now, now, options.expiresAt ?? null],
      );
    } catch (error) {
      // Do not leave an orphaned secret when metadata persistence fails.
      try {
        await this.backend.remove(name);
      } catch {
        // The original storage failure is the useful one.
      }
      throw new AelvoError("STORAGE_FAILED", "Credential metadata could not be stored", { cause: error });
    }
    const metadata = this.metadata(name);
    if (metadata === undefined) {
      throw new AelvoError("STORAGE_FAILED", "Credential metadata disappeared after write");
    }
    await this.notifyChange(name);
    return metadata;
  }

  /** Validated lookup used by provider resolution and diagnostics. */
  async find(name: string): Promise<string | undefined> {
    try {
      return await this.resolve(name);
    } catch (error) {
      if (isAelvoError(error) && error.code === "CREDENTIAL_NOT_FOUND") return undefined;
      throw error;
    }
  }

  /**
   * Read a credential only when its metadata is present, valid and unexpired.
   * A missing/expired credential is an explicit error, never an empty value.
   */
  async resolve(name: string): Promise<string> {
    assertCredentialName(name);
    const metadata = this.metadata(name);
    if (metadata === undefined || !metadata.valid) {
      if (metadata?.expiresAt !== null && metadata?.expiresAt !== undefined && Date.parse(metadata.expiresAt) <= Date.now()) {
        throw new AelvoError("CREDENTIAL_EXPIRED", `Credential ${name} has expired`);
      }
      throw new AelvoError("CREDENTIAL_NOT_FOUND", `No valid credential named ${name}`);
    }
    const secret = await this.backend.read(name);
    if (secret === undefined) {
      throw new AelvoError("CREDENTIAL_NOT_FOUND", `No credential named ${name}`);
    }
    const validation = validateCredentialSecret(secret, name);
    if (!validation.valid) {
      throw new AelvoError("CREDENTIAL_INVALID", validation.reason, { details: { name } });
    }
    this.db.run(
      "UPDATE credential_metadata SET last_used_at = ?, usage_count = usage_count + 1 WHERE name = ?",
      [nowIso(), name],
    );
    return secret;
  }

  async require(name: string): Promise<string> {
    return this.resolve(name);
  }

  async delete(name: string): Promise<boolean> {
    assertCredentialName(name);
    await this.backend.remove(name);
    const result = this.db.run("DELETE FROM credential_metadata WHERE name = ?", [name]);
    if (result.changes > 0) {
      await this.notifyChange(name);
    }
    return result.changes > 0;
  }

  metadata(name: string): CredentialMetadata | undefined {
    assertCredentialName(name);
    const row = this.db.get<CredentialRow>(
      `SELECT name, credential_type, backend, hint, label, created_at, updated_at,
              last_used_at, usage_count, expires_at, is_valid
       FROM credential_metadata WHERE name = ?`,
      [name],
    );
    return row === undefined ? undefined : mapMetadata(row);
  }

  list(): CredentialMetadata[] {
    const rows = this.db.all<CredentialRow>(
      `SELECT name, credential_type, backend, hint, label, created_at, updated_at,
              last_used_at, usage_count, expires_at, is_valid
       FROM credential_metadata ORDER BY updated_at DESC, name ASC`,
    );
    return rows.map(mapMetadata);
  }

  /** Check presence/format/expiry without returning the secret. */
  async check(name: string): Promise<CredentialCheck> {
    try {
      const metadata = this.metadata(name);
      if (metadata === undefined) return { name, valid: false, reason: "Credential metadata not found" };
      if (!metadata.valid) {
        return { name, valid: false, reason: metadata.expiresAt === null ? "Credential marked invalid" : "Credential expired", metadata };
      }
      const secret = await this.backend.read(name);
      if (secret === undefined) return { name, valid: false, reason: "Secret not found in backend", metadata };
      const validation = validateCredentialSecret(secret, name);
      return { name, valid: validation.valid, reason: validation.reason, metadata };
    } catch (error) {
      return {
        name,
        valid: false,
        reason: error instanceof AelvoError ? error.message : "Credential check failed",
      };
    }
  }

  /**
   * Explicit opt-in migration of an environment key into secure storage.
   * It never overwrites an existing credential.
   */
  async importEnvironment(
    env: NodeJS.ProcessEnv,
    keys: string[],
    name: string,
    options: SetCredentialOptions = {},
  ): Promise<{ migrated: boolean; reason: string; metadata?: CredentialMetadata }> {
    if (this.metadata(name) !== undefined) {
      return { migrated: false, reason: "A credential with this name already exists" };
    }
    const source = keys.find((key) => (env[key] ?? "").trim().length > 0);
    if (source === undefined) {
      return { migrated: false, reason: `None of ${keys.join(", ")} is set` };
    }
    const value = (env[source] ?? "").trim();
    const metadata = await this.set(name, value, { ...options, label: options.label ?? source });
    return { migrated: true, reason: `Imported from ${source}`, metadata };
  }

  async backendAvailable(): Promise<boolean> {
    try {
      return await this.backend.available();
    } catch {
      return false;
    }
  }

  get backendKind(): string {
    return this.backend.kind;
  }
}
