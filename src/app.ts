import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AelvoConfig } from "./config/index.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { HealthMonitor, RuntimeMetrics } from "./observability/metrics.js";
import { openDatabase, migrate, type Db } from "./storage/db.js";
import { assertSafePath, type PathPolicy } from "./security/paths.js";
import { PolicyService } from "./security/policies/policy.js";
import { ApprovalService } from "./security/approvals/service.js";
import { AuditLog } from "./security/audit/log.js";
import { createPlatformBackend, CredentialService } from "./security/credentials/service.js";
import { SandboxBridge } from "./security/sandbox/index.js";
import { ToolRegistry } from "./tools/registry/registry.js";
import { createFilesystemTools } from "./tools/filesystem/tools.js";
import { ToolExecutor } from "./tools/executor/executor.js";
import { MemoryService } from "./memory/service.js";
import { TaskService } from "./tasks/service.js";
import { Scheduler } from "./scheduler/index.js";
import { EventBus } from "./runtime/events/bus.js";
import { RunStore } from "./runtime/execution/run-store.js";
import { RunVerifier } from "./runtime/verification/verifier.js";
import { ContextBuilder } from "./intelligence/context/context-builder.js";
import { RunCoordinator, type RunHooks, type RunResult } from "./runtime/coordinator/run-coordinator.js";
import { GoogleGateway } from "./intelligence/providers/google/gateway.js";
import { UnconfiguredGateway } from "./intelligence/providers/unconfigured.js";
import type { ProviderGateway } from "./intelligence/providers/types.js";
import { McpManager } from "./mcp/manager.js";
import { TaskRunner, type TaskRunOutcome } from "./runtime/tasks/task-runner.js";
import { CheckpointStore } from "./runtime/recovery/checkpoints.js";
import { RecoveryManager } from "./runtime/recovery/manager.js";
import type { RuntimeEvent, RuntimeRequest } from "./shared/contracts/index.js";
import { AelvoError } from "./shared/errors/index.js";

export interface CreateApplicationOptions {
  config: AelvoConfig;
  logger?: Logger;
  /** Injected by tests; production builds choose from configuration. */
  gateway?: ProviderGateway;
  packageRoot?: string;
}

/**
 * One composition root. Every production command builds this graph, so there
 * is exactly one coordinator, one executor, one policy service and one store
 * per process.
 */
export class AelvoApplication {
  readonly config: AelvoConfig;
  readonly logger: Logger;
  readonly db: Db;
  readonly paths: PathPolicy;
  readonly policy: PolicyService;
  readonly approvals: ApprovalService;
  readonly audit: AuditLog;
  readonly credentials: CredentialService;
  readonly sandbox: SandboxBridge;
  readonly registry: ToolRegistry;
  readonly executor: ToolExecutor;
  readonly memory: MemoryService;
  readonly tasks: TaskService;
  readonly scheduler: Scheduler;
  readonly runs: RunStore;
  readonly events: EventBus;
  readonly verifier: RunVerifier;
  readonly context: ContextBuilder;
  readonly coordinator: RunCoordinator;
  readonly gateway: ProviderGateway;
  readonly mcp: McpManager;
  readonly taskRunner: TaskRunner;
  readonly checkpoints: CheckpointStore;
  readonly recovery: RecoveryManager;
  readonly metrics: RuntimeMetrics;
  readonly health: HealthMonitor;

  private constructor(options: CreateApplicationOptions, parts: {
    logger: Logger;
    db: Db;
    gateway: ProviderGateway;
  }) {
    this.config = options.config;
    this.logger = parts.logger;
    this.db = parts.db;

    const home = homedir();
    this.paths = {
      workspaceRoot: this.config.workspaceRoot,
      protectedPaths: [
        this.config.dataDir,
        join(home, ".ssh"),
        join(home, ".aws"),
        join(home, ".gnupg"),
        join(home, ".config", "gcloud"),
        join(home, ".kube"),
      ],
    };

    this.audit = new AuditLog(this.db);
    this.approvals = new ApprovalService(this.config.approvals.ttlSeconds);
    this.policy = new PolicyService({
      paths: this.paths,
      allowProcessExec: this.config.tools.allowProcessExec,
      allowNetwork: this.config.tools.allowNetwork,
    });
    this.credentials = new CredentialService(this.db, createPlatformBackend(this.config.dataDir));
    this.sandbox = new SandboxBridge(options.packageRoot ?? process.cwd());

    this.registry = new ToolRegistry();
    for (const tool of createFilesystemTools({
      paths: this.paths,
      maxOutputBytes: this.config.tools.maxOutputBytes,
    })) {
      this.registry.register(tool);
    }

    this.metrics = new RuntimeMetrics();
    this.executor = new ToolExecutor({
      registry: this.registry,
      policy: this.policy,
      approvals: this.approvals,
      audit: this.audit,
      logger: this.logger,
      defaultTimeoutMs: this.config.tools.timeoutMs,
      metrics: this.metrics,
    });

    this.memory = new MemoryService(this.db);
    this.tasks = new TaskService(this.db);
    this.scheduler = new Scheduler(this.db, this.tasks);
    this.runs = new RunStore(this.db);
    this.events = new EventBus();
    this.verifier = new RunVerifier();
    this.context = new ContextBuilder({
      memory: this.memory,
      workspaceRoot: this.config.workspaceRoot,
    });
    this.gateway = parts.gateway;
    this.coordinator = new RunCoordinator({
      gateway: this.gateway,
      registry: this.registry,
      executor: this.executor,
      memory: this.memory,
      context: this.context,
      approvals: this.approvals,
      tasks: this.tasks,
      runs: this.runs,
      events: this.events,
      verifier: this.verifier,
      logger: this.logger,
      maxSteps: this.config.runtime.maxRunSteps,
    });
    this.mcp = new McpManager({ registry: this.registry, logger: this.logger });
    this.checkpoints = new CheckpointStore(this.db);
    this.recovery = new RecoveryManager({ checkpoints: this.checkpoints, logger: this.logger });
    this.taskRunner = new TaskRunner({
      tasks: this.tasks,
      coordinator: this.coordinator,
      logger: this.logger,
      recovery: this.recovery,
    });
    this.health = new HealthMonitor();
    this.health.register("storage", () => {
      const check = this.db.get<{ quick_check: string }>("PRAGMA quick_check");
      return { healthy: check?.quick_check === "ok", detail: check?.quick_check ?? "unknown" };
    });
    this.health.register("sandbox", () => {
      const status = this.sandbox.status();
      return { healthy: status.available || !this.config.tools.allowProcessExec, detail: status.reason };
    });
    this.health.register("provider", () => ({
      healthy: this.gateway.name !== "unconfigured",
      detail: this.gateway.name === "unconfigured" ? "No live provider configured" : `${this.gateway.name}/${this.gateway.model}`,
    }));
  }

  static async create(options: CreateApplicationOptions): Promise<AelvoApplication> {
    const logger = options.logger ?? createLogger(options.config.logLevel);
    mkdirSync(options.config.dataDir, { recursive: true });
    mkdirSync(options.config.workspaceRoot, { recursive: true });
    const db = openDatabase(options.config.dbPath);
    try {
      migrate(db);
    } catch (error) {
      db.close();
      throw new AelvoError("STORAGE_FAILED", "Database migration failed", { cause: error });
    }

    let gateway: ProviderGateway;
    if (options.gateway !== undefined) {
      gateway = options.gateway;
    } else if (options.config.apiKey !== undefined && options.config.model !== undefined) {
      gateway = new GoogleGateway({ apiKey: options.config.apiKey, model: options.config.model });
    } else {
      gateway = new UnconfiguredGateway();
    }

    const app = new AelvoApplication(options, { logger, db, gateway });
    const recovery = app.tasks.recover();
    if (recovery.interrupted > 0 || recovery.needingReconciliation > 0) {
      logger.warn(recovery, "Recovered interrupted task state from a previous process");
    }
    return app;
  }

  async startRun(input: string, hooks: RunHooks = {}, sessionId?: string): Promise<RunResult> {
    if (input.trim().length === 0) {
      throw new AelvoError("TASK_INVALID", "Request text must not be empty");
    }
    const request: RuntimeRequest = { input, plan: false, ...(sessionId === undefined ? {} : { sessionId }) };
    return this.coordinator.run(request, hooks);
  }

  cancel(runId: string): void {
    this.coordinator.cancel(runId);
  }

  async resolveApproval(approvalId: string, approved: boolean): Promise<RunResult> {
    return this.coordinator.resolveApproval(approvalId, approved);
  }

  searchMemory(query: string, limit = 10): ReturnType<MemoryService["search"]> {
    return this.memory.search(query, limit);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  state(): Record<string, unknown> {
    const provider = this.gateway;
    return {
      workspaceRoot: this.config.workspaceRoot,
      provider: {
        name: provider.name,
        model: provider.model,
        configured: provider.name !== "unconfigured",
        capabilities: provider.capabilities(),
      },
      runs: this.runs.recent(10),
      tasks: {
        pending: this.tasks.list({ limit: 200 }).filter((task) => task.status !== "completed" && task.status !== "cancelled").length,
        recent: this.tasks.list({ limit: 10 }),
      },
      memory: this.memory.counts(),
      approvals: this.approvals.list(),
      mcp: this.mcp.status(),
      sandbox: this.sandbox.status(),
      emergencyStop: this.policy.isEmergencyStopActive(),
      activeRuns: this.coordinator.activeRuns(),
      recovery: this.recovery.stats(),
      metrics: this.metrics.summary(),
      health: { status: this.health.status(), checks: this.health.run() },
    };
  }

  /** Resolve a user path through the same policy tools use. */
  resolveWorkspacePath(path: string): string {
    return assertSafePath(path, this.paths);
  }

  runDueTasks(limit = 1): Promise<TaskRunOutcome[]> {
    return this.taskRunner.runDue(limit);
  }

  close(): void {
    void this.mcp.disconnectAll();
    this.db.close();
  }
}

export { planFromRequest, materializePlan, validatePlan } from "./planning/planner.js";
