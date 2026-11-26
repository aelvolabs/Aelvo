import { z } from "zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { AelvoError } from "../shared/errors/index.js";
import { toPublicError } from "../shared/errors/index.js";

const EnvSchema = z.object({
  AELVO_DATA_DIR: z.string().min(1).optional(),
  AELVO_WORKSPACE: z.string().min(1).optional(),
  AELVO_MODEL: z.string().min(1).optional(),
  AELVO_LIVE_MODEL: z.string().min(1).optional(),
  AELVO_LIVE_VOICE: z.string().min(1).max(100).optional(),
  AELVO_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  AELVO_HOST: z.string().default("127.0.0.1"),
  AELVO_PORT: z.coerce.number().int().min(1).max(65_535).default(4317),
  AELVO_APPROVAL_TTL_SECONDS: z.coerce.number().int().min(10).max(3_600).default(120),
  AELVO_TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  AELVO_MAX_TOOL_OUTPUT_BYTES: z.coerce.number().int().min(1_024).max(10_000_000).default(256_000),
  AELVO_MAX_RUN_STEPS: z.coerce.number().int().min(1).max(50).default(12),
  AELVO_ALLOW_PROCESS_EXEC: z.enum(["0", "1"]).default("0"),
  AELVO_ALLOW_NETWORK_TOOLS: z.enum(["0", "1"]).default("0"),
  AELVO_AUTONOMY: z.enum(["restricted", "balanced", "high"]).default("balanced"),
  AELVO_ORIGINS: z.string().optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GOOGLE_API_KEY: z.string().min(1).optional(),
});

export interface AelvoConfig {
  dataDir: string;
  dbPath: string;
  workspaceRoot: string;
  model: string | undefined;
  liveModel: string | undefined;
  liveVoice: string | undefined;
  apiKey: string | undefined;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  server: { host: string; port: number; allowedOrigins: string[] };
  approvals: { ttlSeconds: number };
  tools: { timeoutMs: number; maxOutputBytes: number; allowProcessExec: boolean; allowNetwork: boolean };
  security?: { autonomy: "restricted" | "balanced" | "high" };
  runtime: { maxRunSteps: number };
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
}

/**
 * Load a local development `.env` without logging its contents. Existing
 * process environment variables retain precedence, matching the rest of the
 * credential-resolution path (explicit environment over local file).
 */
export function loadLocalEnvFile(options: { cwd?: string; filename?: string } = {}): boolean {
  const path = resolve(options.cwd ?? process.cwd(), options.filename ?? ".env");
  if (!existsSync(path)) return false;
  try {
    process.loadEnvFile(path);
    return true;
  } catch (error) {
    throw new AelvoError("CONFIG_INVALID", "Unable to load the local .env configuration", {
      cause: error,
    });
  }
}

/**
 * Configuration is read once and validated. Optional values stay `undefined`
 * rather than becoming empty strings, so "not configured" is explicit.
 */
export function loadConfig(options: LoadConfigOptions = {}): AelvoConfig {
  const env = options.env ?? process.env;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new AelvoError("CONFIG_INVALID", "Invalid AELVO configuration", {
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    });
  }
  const value = parsed.data;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const dataDir = resolve(value.AELVO_DATA_DIR ?? join(home, ".aelvo"));
  const workspaceRoot = resolve(value.AELVO_WORKSPACE ?? cwd);
  const port = value.AELVO_PORT;
  const defaultOrigins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    // Vite dev/preview origins for the bundled React client.
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
  ].filter((origin, index, all) => all.indexOf(origin) === index);
  const allowedOrigins = value.AELVO_ORIGINS === undefined
    ? defaultOrigins
    : value.AELVO_ORIGINS.split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0);

  return {
    dataDir,
    dbPath: join(dataDir, "aelvo.db"),
    workspaceRoot,
    model: value.AELVO_MODEL,
    liveModel: value.AELVO_LIVE_MODEL,
    liveVoice: value.AELVO_LIVE_VOICE,
    apiKey: value.GEMINI_API_KEY ?? value.GOOGLE_API_KEY,
    logLevel: value.AELVO_LOG_LEVEL,
    server: { host: value.AELVO_HOST, port, allowedOrigins },
    approvals: { ttlSeconds: value.AELVO_APPROVAL_TTL_SECONDS },
    tools: {
      timeoutMs: value.AELVO_TOOL_TIMEOUT_MS,
      maxOutputBytes: value.AELVO_MAX_TOOL_OUTPUT_BYTES,
      allowProcessExec: value.AELVO_ALLOW_PROCESS_EXEC === "1",
      allowNetwork: value.AELVO_ALLOW_NETWORK_TOOLS === "1",
    },
    security: { autonomy: value.AELVO_AUTONOMY },
    runtime: { maxRunSteps: value.AELVO_MAX_RUN_STEPS },
  };
}

export function describeConfig(config: AelvoConfig): Record<string, unknown> {
  return {
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    workspaceRoot: config.workspaceRoot,
    model: config.model ?? null,
    liveModel: config.liveModel ?? null,
    liveVoice: config.liveVoice ?? null,
    providerConfigured: config.apiKey !== undefined,
    server: config.server,
    tools: config.tools,
    runtime: config.runtime,
  };
}

export function configErrorToPublic(value: unknown): ReturnType<typeof toPublicError> {
  return toPublicError(value);
}
