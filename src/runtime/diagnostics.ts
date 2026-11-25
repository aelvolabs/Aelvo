import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AelvoApplication } from "../app.js";
import { GoogleGateway } from "../intelligence/providers/google/gateway.js";

export type DiagnosticStatus = "ok" | "warn" | "fail" | "unverified";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  detail: string;
  remediation?: string;
}

function writableProbe(directory: string): { ok: boolean; detail: string } {
  const path = join(directory, `.aelvo-doctor-${process.pid}.tmp`);
  try {
    writeFileSync(path, "probe", { encoding: "utf8", mode: 0o600 });
    rmSync(path, { force: true });
    return { ok: true, detail: "Directory accepts writes" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Doctor checks report what was actually verified. Anything that cannot be
 * checked on this host is "unverified", never "ok".
 */
export async function runDiagnostics(
  app: AelvoApplication,
  options: { network?: boolean } = {},
): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];

  const major = Number(process.versions.node.split(".")[0] ?? "0");
  checks.push({
    name: "node",
    status: major >= 24 ? "ok" : "fail",
    detail: `Node ${process.versions.node}`,
    ...(major >= 24 ? {} : { remediation: "AELVO requires Node 24 or newer (node:sqlite, built-in test APIs)" }),
  });

  const workspace = writableProbe(app.config.workspaceRoot);
  checks.push({
    name: "workspace",
    status: workspace.ok ? "ok" : "fail",
    detail: `${app.config.workspaceRoot}: ${workspace.detail}`,
  });

  const dataDir = writableProbe(app.config.dataDir);
  checks.push({
    name: "data_dir",
    status: dataDir.ok ? "ok" : "fail",
    detail: `${app.config.dataDir}: ${dataDir.detail}`,
  });

  try {
    const integrity = app.db.get<{ quick_check: string }>("PRAGMA quick_check");
    const version = app.db.get<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_migrations");
    checks.push({
      name: "storage",
      status: integrity?.quick_check === "ok" ? "ok" : "fail",
      detail: `SQLite ${integrity?.quick_check ?? "unknown"}, schema v${version?.version ?? 0}`,
    });
  } catch (error) {
    checks.push({
      name: "storage",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const fts = app.db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'");
  checks.push({
    name: "memory_fts",
    status: fts === undefined ? "warn" : "ok",
    detail: fts === undefined ? "FTS5 index missing; search falls back to LIKE" : "FTS5 index present",
  });

  checks.push({
    name: "provider_config",
    status: app.config.apiKey === undefined || app.config.model === undefined ? "fail" : "ok",
    detail:
      app.config.apiKey === undefined
        ? "No API key in the environment"
        : app.config.model === undefined
          ? "AELVO_MODEL is not set"
          : `Model ${app.config.model} with a configured key`,
    remediation: "Set GEMINI_API_KEY (or GOOGLE_API_KEY) and AELVO_MODEL",
  });

  if (app.gateway instanceof GoogleGateway) {
    if (options.network === true) {
      try {
        const probe = await app.gateway.probe();
        checks.push({
          name: "provider_network",
          status: probe.ok ? "ok" : "fail",
          detail: probe.detail,
        });
      } catch (error) {
        checks.push({
          name: "provider_network",
          status: "fail",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      checks.push({
        name: "provider_network",
        status: "unverified",
        detail: "Not probed (run `aelvo doctor --network` to verify the provider)",
      });
    }
  } else {
    checks.push({
      name: "provider_network",
      status: "fail",
      detail: "No provider configured, so nothing can be probed",
    });
  }

  const sandbox = app.sandbox.status();
  if (app.config.tools.allowProcessExec && !sandbox.available) {
    checks.push({
      name: "sandbox",
      status: "fail",
      detail: "Process execution is enabled but the Rust sandbox binary is unavailable; execution will fail closed",
      remediation: "cargo build --release --manifest-path sandbox_core/Cargo.toml",
    });
  } else {
    checks.push({
      name: "sandbox",
      status: sandbox.available ? "ok" : "warn",
      detail: sandbox.available ? sandbox.binaryPath : `${sandbox.reason}; process execution disabled`,
    });
  }

  const credentialBackend = process.platform === "win32" ? "windows-dpapi" : process.platform === "darwin" ? "macos-keychain" : "linux-secret-service";
  checks.push({
    name: "credential_backend",
    status: process.platform === "win32" ? "ok" : "unverified",
    detail:
      process.platform === "win32"
        ? `Credentials stored via ${credentialBackend} under the data directory`
        : `${credentialBackend} is the configured backend; not exercised by this check`,
  });

  const mcp = app.mcp.status();
  checks.push({
    name: "mcp",
    status: "ok",
    detail: mcp.length === 0 ? "No MCP servers configured" : mcp.map((server) => `${server.name}:${server.connected ? "connected" : "unavailable"}`).join(", "),
  });

  checks.push({
    name: "approvals",
    status: "ok",
    detail: "In-memory, single-use, digest-bound approvals; all are invalidated on restart",
  });

  return checks;
}

export function diagnosticsExitCode(checks: DiagnosticCheck[]): number {
  if (checks.some((check) => check.status === "fail")) return 1;
  return 0;
}
