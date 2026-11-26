#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, describeConfig, loadLocalEnvFile } from "../config/index.js";
import { AelvoApplication } from "../app.js";
import { startBridge } from "../runtime/bridge/server.js";
import { runDiagnostics, diagnosticsExitCode } from "../runtime/diagnostics.js";
import { probeLiveSession } from "../intelligence/providers/google/live-probe.js";
import { GoogleGateway } from "../intelligence/providers/google/gateway.js";
import { GOOGLE_API_KEY_CREDENTIAL, resolveGoogleApiKey } from "../security/credentials/provider.js";
import { planFromRequest, materializePlan } from "../planning/planner.js";
import { toPublicError } from "../shared/errors/index.js";
import type { ApprovalRequest, RunStatus } from "../shared/contracts/index.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_APPROVAL = 3;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      if (equals !== -1) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[body] = next;
          index += 1;
        } else {
          flags[body] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function print(value: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const HELP = `AELVO 3.0 — local personal intelligence runtime

Usage: aelvo <command> [options]

Commands:
  run <request>              Run one governed turn (prompts for approvals in a TTY)
  chat                       Interactive multi-turn session
  serve                      Start the authenticated local WebSocket bridge
  doctor [--network] [--json]  Report verified environment checks
  memory list|search|remember|correct|delete|export
  credential set|list|check|delete|import-env
  task list|add|run|recover|steps|reconcile
  schedule list|add|cancel|tick
  mcp status|connect
  config show
  models [--limit N] [--json]  List available Google Gemini models and capabilities
  probe-live                 Verify a Gemini Live session (requires key and model)
  version

Environment:
  AELVO_MODEL, AELVO_LIVE_MODEL, AELVO_LIVE_VOICE,
  GEMINI_API_KEY|GOOGLE_API_KEY, AELVO_DATA_DIR, AELVO_WORKSPACE,
  AELVO_LOG_LEVEL, AELVO_ORIGINS, AELVO_ALLOW_PROCESS_EXEC, AELVO_ALLOW_NETWORK_TOOLS
`;

async function promptApproval(approval: ApprovalRequest): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\nApproval required: ${approval.summary}\n  tool: ${approval.tool}\n  capability: ${approval.capability}\n  resource: ${approval.resource}\n  digest: ${approval.digest}\nApprove? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function executeWithApprovals(
  app: AelvoApplication,
  input: string,
  sessionId?: string,
): Promise<{ status: RunStatus; runId: string; output?: string; approval?: ApprovalRequest }> {
  let result = await app.startRun(input, {}, sessionId);
  while (result.status === "waiting_for_approval" && result.approval !== undefined) {
    const approval = result.approval;
    const approved = await promptApproval(approval);
    if (!approved) {
      app.cancel(result.runId);
      return { ...result, status: "cancelled" };
    }
    result = await app.resolveApproval(approval.id, true);
  }
  return result;
}

function reportRun(result: { runId: string; status: RunStatus; output?: string; approval?: ApprovalRequest }): number {
  if (result.status === "waiting_for_approval") {
    print(
      {
        runId: result.runId,
        status: result.status,
        approval: result.approval,
        detail: "Approval requires an interactive terminal; the run was left unapproved",
      },
      true,
    );
    return EXIT_APPROVAL;
  }
  if (result.status === "completed") {
    if (result.output !== undefined) process.stdout.write(`${result.output}\n`);
    return EXIT_OK;
  }
  print({ runId: result.runId, status: result.status }, true);
  return EXIT_ERROR;
}

async function commandMemory(app: AelvoApplication, args: ParsedArgs): Promise<number> {
  const asJson = args.flags.json === true;
  const [subcommand] = args.positional;
  switch (subcommand) {
    case "list": {
      const kind = flagString(args.flags, "kind");
      const items = app.memory.list({
        limit: Number(flagString(args.flags, "limit") ?? 50),
        ...(kind === undefined ? {} : { kind: kind as "fact" }),
        ...(args.flags.all === true ? { includeSuperseded: true } : {}),
      });
      print(asJson ? items : items.map((item) => `${item.id} [${item.kind}] ${item.subject} ${item.predicate}: ${item.value}${item.validTo === null ? "" : " (superseded)"}`).join("\n") || "No memory items.", asJson);
      return EXIT_OK;
    }
    case "search": {
      const query = args.positional.slice(1).join(" ");
      if (query.length === 0) throw new Error("memory search requires a query");
      const items = app.memory.search(query, Number(flagString(args.flags, "limit") ?? 10));
      print(asJson ? items : items.map((item) => `${item.id} ${item.value}`).join("\n") || "No matches.", asJson);
      return EXIT_OK;
    }
    case "remember": {
      const value = args.positional.slice(1).join(" ");
      if (value.length === 0) throw new Error("memory remember requires a value");
      const subject = flagString(args.flags, "subject");
      const predicate = flagString(args.flags, "predicate");
      const item = app.memory.remember({
        value,
        kind: (flagString(args.flags, "kind") ?? "fact") as "fact",
        ...(subject === undefined ? {} : { subject }),
        ...(predicate === undefined ? {} : { predicate }),
      });
      print(asJson ? item : `Remembered ${item.id}`, asJson);
      return EXIT_OK;
    }
    case "correct": {
      const [id, ...rest] = args.positional.slice(1);
      if (id === undefined || rest.length === 0) throw new Error("usage: memory correct <id> <value>");
      const item = app.memory.correct(id, rest.join(" "));
      print(asJson ? item : `Corrected ${item.id}`, asJson);
      return EXIT_OK;
    }
    case "delete": {
      const id = args.positional[1];
      if (id === undefined) throw new Error("usage: memory delete <id>");
      const deleted = app.memory.delete(id);
      print({ id, deleted }, asJson);
      return deleted ? EXIT_OK : EXIT_ERROR;
    }
    case "export": {
      print(app.memory.exportAll(), true);
      return EXIT_OK;
    }
    default:
      process.stderr.write("usage: aelvo memory list|search|remember|correct|delete|export\n");
      return EXIT_USAGE;
  }
}

async function commandCredential(app: AelvoApplication, args: ParsedArgs): Promise<number> {
  const asJson = args.flags.json === true;
  const [subcommand, positionalName] = args.positional;
  const name = positionalName ?? GOOGLE_API_KEY_CREDENTIAL;
  switch (subcommand) {
    case "list": {
      const items = app.credentials.list();
      print(
        asJson
          ? items
          : items
              .map((item) => `${item.name} [${item.credentialType}] ${item.backend} ${item.hint} valid=${item.valid}`)
              .join("\n") || "No stored credentials.",
        asJson,
      );
      return EXIT_OK;
    }
    case "set": {
      const fromEnv = flagString(args.flags, "from-env");
      let secret: string;
      if (fromEnv !== undefined) {
        secret = (process.env[fromEnv] ?? "").trim();
        if (secret.length === 0) {
          throw new Error(`Environment variable ${fromEnv} is not set`);
        }
      } else {
        if (process.stdin.isTTY) {
          process.stderr.write("Refusing to read a secret from an interactive terminal. Pipe it on stdin or use --from-env.\n");
          return EXIT_USAGE;
        }
        secret = readFileSync(0, "utf8").trim();
      }
      const expiresAt = flagString(args.flags, "expires-at");
      const metadata = await app.credentials.set(name, secret, {
        credentialType: "api_key",
        label: flagString(args.flags, "label") ?? name,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      print(metadata, asJson);
      return EXIT_OK;
    }
    case "check": {
      const result = await app.credentials.check(name);
      print(result, asJson);
      return result.valid ? EXIT_OK : EXIT_ERROR;
    }
    case "delete": {
      const deleted = await app.credentials.delete(name);
      print({ name, deleted }, asJson);
      return deleted ? EXIT_OK : EXIT_ERROR;
    }
    case "import-env": {
      const result = await app.credentials.importEnvironment(
        process.env,
        ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        name,
        { credentialType: "api_key", label: "Imported Google API key" },
      );
      print(result, asJson);
      return result.migrated ? EXIT_OK : EXIT_ERROR;
    }
    default:
      process.stderr.write("usage: aelvo credential set|list|check|delete|import-env\n");
      return EXIT_USAGE;
  }
}

async function commandTask(app: AelvoApplication, args: ParsedArgs): Promise<number> {
  const asJson = args.flags.json === true;
  const [subcommand] = args.positional;
  switch (subcommand) {
    case "list": {
      const status = flagString(args.flags, "status");
      const tasks = app.tasks.list({
        limit: Number(flagString(args.flags, "limit") ?? 50),
        ...(status === undefined ? {} : { status: status as "queued" }),
      });
      print(asJson ? tasks : tasks.map((task) => `${task.id} [${task.status}] ${task.kind}${task.effectUncertain ? " (effect uncertain)" : ""}`).join("\n") || "No tasks.", asJson);
      return EXIT_OK;
    }
    case "add": {
      const kind = args.positional[1];
      const input = args.positional.slice(2).join(" ");
      if (kind === undefined || input.length === 0) throw new Error("usage: task add <kind> <instruction>");
      const task = app.tasks.enqueue({ kind, payload: { input } });
      print(asJson ? task : `Enqueued ${task.id}`, asJson);
      return EXIT_OK;
    }
    case "run": {
      const outcomes = await app.runDueTasks(Number(flagString(args.flags, "limit") ?? 1));
      print(asJson ? outcomes : outcomes.map((outcome) => `${outcome.taskId}: ${outcome.status} ${outcome.detail}`).join("\n") || "No runnable tasks.", asJson);
      return outcomes.some((outcome) => outcome.status === "failed") ? EXIT_ERROR : EXIT_OK;
    }
    case "recover": {
      print(app.tasks.recover(), asJson);
      return EXIT_OK;
    }
    case "steps": {
      const id = args.positional[1];
      if (id === undefined) throw new Error("usage: task steps <taskId>");
      print(app.tasks.steps(id), asJson);
      return EXIT_OK;
    }
    case "reconcile": {
      const id = args.positional[1];
      const outcome = args.positional[2] as "completed" | "failed" | "queued" | undefined;
      if (id === undefined || outcome === undefined) throw new Error("usage: task reconcile <taskId> completed|failed|queued");
      print(app.tasks.resolveReconciliation(id, outcome), asJson);
      return EXIT_OK;
    }
    default:
      process.stderr.write("usage: aelvo task list|add|run|recover|steps|reconcile\n");
      return EXIT_USAGE;
  }
}

async function commandSchedule(app: AelvoApplication, args: ParsedArgs): Promise<number> {
  const asJson = args.flags.json === true;
  const [subcommand] = args.positional;
  switch (subcommand) {
    case "list":
      print(app.scheduler.list(), asJson);
      return EXIT_OK;
    case "add": {
      const kind = args.positional[1];
      const runAt = flagString(args.flags, "at");
      if (kind === undefined || runAt === undefined) throw new Error("usage: schedule add <kind> --at <iso> [--every <seconds>]");
      const every = flagString(args.flags, "every");
      const schedule = app.scheduler.add({
        taskKind: kind,
        runAt,
        ...(every === undefined ? {} : { everySeconds: Number(every) }),
      });
      print(schedule, asJson);
      return EXIT_OK;
    }
    case "cancel": {
      const id = args.positional[1];
      if (id === undefined) throw new Error("usage: schedule cancel <id>");
      app.scheduler.cancel(id);
      print({ id, cancelled: true }, asJson);
      return EXIT_OK;
    }
    case "tick":
      print(app.scheduler.tick(), asJson);
      return EXIT_OK;
    default:
      process.stderr.write("usage: aelvo schedule list|add|cancel|tick\n");
      return EXIT_USAGE;
  }
}

async function commandChat(app: AelvoApplication): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const session = app.memory.createSession("CLI chat");
  try {
    for (;;) {
      const line = (await rl.question("you> ")).trim();
      if (line.length === 0) continue;
      if (line === "/exit" || line === "/quit") return EXIT_OK;
      if (line === "/state") {
        print(app.state(), false);
        continue;
      }
      const result = await executeWithApprovals(app, line, session.id);
      if (result.status === "completed") {
        process.stdout.write(`aelvo> ${result.output ?? ""}\n`);
      } else if (result.status === "cancelled") {
        process.stdout.write("aelvo> [cancelled]\n");
      } else {
        process.stdout.write(`aelvo> [${result.status}]\n`);
      }
    }
  } finally {
    rl.close();
  }
}

async function commandServe(app: AelvoApplication): Promise<number> {
  const bridge = await startBridge({
    runtime: {
      startRun: (input, hooks, sessionId) => app.startRun(input, hooks ?? {}, sessionId),
      cancel: (runId) => app.cancel(runId),
      resolveApproval: (approvalId, approved) => app.resolveApproval(approvalId, approved, "bridge"),
      searchMemory: (query, limit) => app.searchMemory(query, limit),
      state: () => app.state(),
      subscribe: (listener) => app.subscribe(listener),
      activateEmergencyStop: (reason) => app.activateEmergencyStop("bridge", reason),
      resumeEmergencyStop: (reason) => app.resumeEmergencyStop("bridge", reason),
    },
    audit: app.audit,
    logger: app.logger,
    host: app.config.server.host,
    port: app.config.server.port,
    allowedOrigins: app.config.server.allowedOrigins,
    dataDir: app.config.dataDir,
  });

  const timer = setInterval(() => {
    void (async () => {
      try {
        app.scheduler.tick();
        const outcomes = await app.runDueTasks(3);
        if (outcomes.length > 0) app.logger.info({ outcomes }, "Executed due tasks");
      } catch (error) {
        app.logger.warn({ error: toPublicError(error) }, "Scheduled task cycle failed");
      }
    })();
  }, 30_000);
  timer.unref();

  print({ url: bridge.url, tokenPath: join(app.config.dataDir, "bridge-token") }, true);
  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await bridge.close();
    app.close();
    process.exit(EXIT_OK);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {
    // Run until a signal arrives.
  });
  return EXIT_OK;
}

async function main(argv: string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  if (command === "version" || command === "--version" || command === "-v") {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    print({ name: "aelvo", version: packageJson.version }, true);
    return EXIT_OK;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return EXIT_OK;
  }

  const args = parseArgs(rest);
  const asJson = args.flags.json === true;
  // Local checkout configuration is loaded without printing values; explicit
  // process environment variables still take precedence.
  loadLocalEnvFile();
  const config = loadConfig();
  const app = await AelvoApplication.create({ config });
  try {
    switch (command) {
      case "run": {
        const input = args.positional.join(" ");
        if (input.length === 0) {
          process.stderr.write("usage: aelvo run <request>\n");
          return EXIT_USAGE;
        }
        const result = await executeWithApprovals(app, input, flagString(args.flags, "session"));
        if (asJson) print(result, true);
        else if (result.status === "completed" && result.output !== undefined) process.stdout.write(`${result.output}\n`);
        if (result.status === "waiting_for_approval") return reportRun(result);
        return result.status === "completed" ? EXIT_OK : EXIT_ERROR;
      }
      case "chat":
        return await commandChat(app);
      case "serve":
        return await commandServe(app);
      case "doctor": {
        const checks = await runDiagnostics(app, { network: args.flags.network === true });
        if (asJson) {
          print({ checks, ok: diagnosticsExitCode(checks) === 0 }, true);
        } else {
          for (const check of checks) {
            process.stdout.write(`${check.status.toUpperCase().padEnd(10)} ${check.name.padEnd(18)} ${check.detail}\n`);
            if (check.remediation !== undefined && check.status !== "ok") {
              process.stdout.write(`${"".padEnd(29)}fix: ${check.remediation}\n`);
            }
          }
        }
        return diagnosticsExitCode(checks);
      }
      case "memory":
        return await commandMemory(app, args);
      case "credential":
        return await commandCredential(app, args);
      case "task":
        return await commandTask(app, args);
      case "schedule":
        return await commandSchedule(app, args);
      case "mcp": {
        const [subcommand] = args.positional;
        if (subcommand === "status") {
          print(app.mcp.status(), asJson);
          return EXIT_OK;
        }
        if (subcommand === "connect") {
          const servers = app.mcp.loadConfig(app.config.dataDir);
          const statuses = await app.mcp.connectAll(servers);
          print(statuses, asJson);
          return statuses.every((status) => status.connected) ? EXIT_OK : EXIT_ERROR;
        }
        process.stderr.write("usage: aelvo mcp status|connect\n");
        return EXIT_USAGE;
      }
      case "config":
        print(
          {
            ...describeConfig(config),
            providerCredentialSource: app.providerCredentialSource,
            credentialBackend: app.credentials.backendKind,
          },
          true,
        );
        return EXIT_OK;
      case "models": {
        if (!(app.gateway instanceof GoogleGateway)) {
          print({ models: [], detail: "Google provider is not configured" }, asJson);
          return EXIT_ERROR;
        }
        const limit = Number(flagString(args.flags, "limit") ?? 50);
        const models = await app.gateway.listModels(Number.isFinite(limit) && limit > 0 ? limit : 50);
        print(
          asJson
            ? { model: app.gateway.model, models }
            : models
                .map(
                  (m) =>
                    `${m.model.padEnd(32)} in=${m.inputTokenLimit ?? "?"} out=${m.outputTokenLimit ?? "?"} tools=${String(m.details.functionCalling)} live=${String(m.details.liveSession)}`,
                )
                .join("\n") || "No models returned.",
          asJson,
        );
        return EXIT_OK;
      }
      case "probe-live": {
        const resolved = await resolveGoogleApiKey(app.credentials, config.apiKey);
        const liveModel = config.liveModel ?? config.model;
        if (resolved.apiKey === undefined || liveModel === undefined) {
          print(
            {
              status: "unverified",
              detail: resolved.detail ?? "A key and AELVO_LIVE_MODEL (or AELVO_MODEL) are required",
            },
            true,
          );
          return EXIT_ERROR;
        }
        const result = await probeLiveSession({ apiKey: resolved.apiKey, model: liveModel });
        print(result, true);
        return result.status === "verified" ? EXIT_OK : EXIT_ERROR;
      }
      case "plan": {
        const input = args.positional.join(" ");
        if (input.length === 0) throw new Error("usage: aelvo plan <goal>");
        const plan = planFromRequest(input);
        const tasks = args.flags.materialize === true ? materializePlan(plan, app.tasks) : [];
        print({ plan, tasks }, true);
        return EXIT_OK;
      }
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
        return EXIT_USAGE;
    }
  } finally {
    if (command !== "serve") app.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const publicError = toPublicError(error);
    process.stderr.write(`${JSON.stringify({ error: publicError })}\n`);
    process.exit(EXIT_ERROR);
  },
);
