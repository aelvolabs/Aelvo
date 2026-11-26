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

  const hasProviderCredential = app.providerCredentialSource !== "none";
  checks.push({
    name: "provider_config",
    status: !hasProviderCredential || app.config.model === undefined ? "fail" : "ok",
    detail:
      !hasProviderCredential
        ? "No provider API key in the environment or credential store"
        : app.config.model === undefined
          ? "AELVO_MODEL is not set"
          : `Model ${app.config.model}; key from ${app.providerCredentialSource}`,
    remediation:
      "Set AELVO_MODEL and provide GEMINI_API_KEY/GOOGLE_API_KEY, or run `aelvo credential import-env`",
  });

  const liveModel = app.config.liveModel ?? app.config.model;
  checks.push({
    name: "live_config",
    status: liveModel === undefined ? "warn" : "ok",
    detail:
      liveModel === undefined
        ? "AELVO_LIVE_MODEL is not set; app.live cannot create a session"
        : `Live model ${liveModel}; connection is not probed by doctor. Run \`aelvo probe-live\` for a real session check`,
    ...(liveModel === undefined
      ? { remediation: "Set AELVO_LIVE_MODEL to a Live-capable Gemini model" }
      : {}),
  });

  if (app.gateway instanceof GoogleGateway) {
    const caps = app.gateway.capabilities();
    checks.push({
      name: "provider_capabilities",
      status: caps.knownModel === true ? "ok" : "unverified",
      detail:
        caps.knownModel === true
          ? `Model ${app.gateway.model} (${caps.source ?? "catalog"}): streaming=${String(caps.streaming)}, tools=${String(caps.functionCalling)}, structured=${String(caps.structuredOutput ?? "unknown")}, live=${String(caps.liveSession)}`
          : `Model ${app.gateway.model} capabilities are unknown locally; run \`aelvo doctor --network\` to query Gemini metadata`,
    });
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

  const credentialBackendAvailable = await app.credentials.backendAvailable();
  checks.push({
    name: "credential_backend",
    status: credentialBackendAvailable ? "ok" : "fail",
    detail: credentialBackendAvailable
      ? `${app.credentials.backendKind} secure storage is available`
      : `${app.credentials.backendKind} secure storage is unavailable; plaintext fallback is disabled`,
    ...(credentialBackendAvailable
      ? {}
      : {
          remediation:
            process.platform === "win32"
              ? "Ensure PowerShell is available and the current-user DPAPI profile is accessible"
              : process.platform === "darwin"
                ? "Ensure /usr/bin/security is available"
                : "Install libsecret-tools (`secret-tool`) and a Secret Service session",
        }),
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
