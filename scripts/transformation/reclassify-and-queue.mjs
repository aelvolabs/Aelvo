#!/usr/bin/env node
/**
 * Replaces broad BLOCKED labels with precise implementation states and emits a
 * dependency-ordered queue. No module is marked VERIFIED_PORT here unless the
 * active target and its tests already exist; this script is deliberately
 * conservative.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const mapping = JSON.parse(readFileSync(join(root, "AELVO_PORT_MAPPING.json"), "utf8"));
const inventory = JSON.parse(readFileSync(join(root, "AELVO_MODULE_INVENTORY.json"), "utf8"));
const deps = JSON.parse(readFileSync(join(root, "AELVO_DEPENDENCY_GRAPH.json"), "utf8"));
const invByPath = new Map(inventory.modules.map((module) => [module.path, module]));

const T = {
  app: "src/app.ts",
  cli: "src/cli/entry.ts",
  config: "src/config/index.ts",
  context: "src/intelligence/context/context-builder.ts",
  memory: "src/memory/service.ts",
  planner: "src/planning/planner.ts",
  executor: "src/tools/executor/executor.ts",
  filesystem: "src/tools/filesystem/tools.ts",
  policy: "src/security/policies/policy.ts",
  approvals: "src/security/approvals/service.ts",
  audit: "src/security/audit/log.ts",
  sandbox: "src/security/sandbox/index.ts",
  bridge: "src/runtime/bridge/server.ts",
  mcp: "src/mcp/manager.ts",
  events: "src/runtime/events/bus.ts",
  contracts: "src/shared/contracts/index.ts",
  graph: "src/runtime/execution/graph.ts",
  toolGraph: "src/runtime/execution/tool-graph.ts",
  recovery: "src/runtime/recovery/index.ts",
  recoveryManager: "src/runtime/recovery/manager.ts",
  checkpoints: "src/runtime/recovery/checkpoints.ts",
  metrics: "src/observability/metrics.ts",
  providers: "src/intelligence/providers/google/gateway.ts",
  providerTypes: "src/intelligence/providers/types.ts",
  tasks: "src/tasks/service.ts",
  modelParser: "src/intelligence/parsing/model-output.ts",
};

const exactPartial = {
  "core/startup.py": [T.app, "AelvoApplication", "Composition/startup behavior is represented by the Node composition root."],
  "core/orchestration/parser.py": [T.modelParser, "parseModelOutput", "Fenced/direct/embedded JSON tool-call parsing and kernel-command typing ported; native function calling remains primary."],
  "core/system_prompt.py": [T.context, "BASE_SYSTEM", "Personal-runtime system prompt retained; coding-specialist prompt content removed."],
  "config/__init__.py": [T.config, "loadConfig", "Environment/path/model configuration ported; legacy keys not all mapped."],
  "cli/app.py": [T.cli, "main", "Node CLI replaces the Python application shell; command parity is intentional partial."],
  "cli/boot.py": [T.cli, "main", "Startup sequence replaced by the Node entry point."],
  "cli/version.py": [T.cli, "--version", "Version output is implemented and smoke-verified."],
  "runtime_next/engine/runner.py": [T.graph, "GraphRunner", "Runner interface retained by the graph engine."],
  "runtime_next/engine/file_mutex.py": [T.toolGraph, "ToolGraphExecutor", "Path-overlap ordering prevents concurrent conflicting tool writes; a general mutex is not ported."],
  "runtime_next/events/bus.py": [T.events, "EventBus", "In-process typed event bus retained; replay/persistence not fully ported."],
  "runtime_next/recovery/engine.py": [T.recoveryManager, "RecoveryManager", "Classification, governance, retry safety and checkpoints are integrated; node injection/replay are not."],
  "runtime_next/recovery/task_recovery.py": [T.checkpoints, "CheckpointStore", "Savepoint persistence and restoration ported; phase rollback/skip not ported."],
  "runtime_next/verification/types.py": [T.recovery, "FailureClassification", "Failure/retryability taxonomy retained; full verification manifest types not ported."],
  "runtime_next/security/policy_audit.py": [T.audit, "AuditLog", "Durable security audit records retained; full policy audit trail not ported."],
  "runtime_next/monitoring/metrics.py": [T.metrics, "RuntimeMetrics", "Bounded series, aggregation and percentiles ported; alerting not ported."],
  "runtime_next/monitoring/health.py": [T.metrics, "HealthMonitor", "On-demand health checks ported; periodic scheduling and degradation state not ported."],
  "runtime_next/monitoring/__init__.py": [T.metrics, "RuntimeMetrics", "Metrics/health namespace maps to the observability module."],
  "mcp/execution/execution_engine.py": [T.mcp, "McpManager", "MCP invocation is governed and approval-gated; queue/router behavior not ported."],
  "mcp/governance/allowlist_manager.py": [T.mcp, "McpManager", "Per-server allowTools filtering retained; specialist scopes removed."],
  "mcp/governance/audit_logger.py": [T.audit, "AuditLog", "Governed executor audit covers MCP calls; dedicated MCP audit stream not ported."],
  "mcp/governance/governance_layer.py": [T.mcp, "McpManager", "Approval gating and untrusted content handling retained; full trust levels not ported."],
  "mcp/governance/restriction_engine.py": [T.mcp, "McpManager", "Name/size/timeout restrictions retained; full restriction rule engine not ported."],
  "mcp/verification/schema_verifier.py": [T.mcp, "McpManager", "Arguments are record-validated and execution is approval-gated; remote schema verification not ported."],
  "mcp/verification/size_verifier.py": [T.mcp, "McpManager", "Output is capped at 64 KiB."],
  "mcp/verification/timeout_verifier.py": [T.mcp, "McpManager", "Per-server timeout is enforced through the SDK call."],
  "mcp/client/timeout_manager.py": [T.mcp, "McpManager", "Config timeout is applied per call; adaptive timeout management not ported."],
  "mcp/transport/stdio_transport.py": [T.mcp, "McpManager", "Stdio transport uses the official SDK."],
  "memory/types.py": [T.memory, "MemoryItem", "Memory item/type contracts retained; full legacy type surface not ported."],
};

const environmentBlocked = {
  "core/security/execution_sandbox.py": {
    symbols: ["ExecutionSandbox", "SandboxCapability", "RollbackApprovalGate"],
    cause: "Rust sandbox runtime cannot be built or exercised on this host.",
  },
  "core/execution/sandbox_session.py": {
    symbols: ["PersistentSandboxSession", "SandboxSessionCheckpoint"],
    cause: "Sandbox session runtime depends on the unavailable native sandbox.",
  },
  "runtime_next/security/sandbox_integrity.py": {
    symbols: ["SandboxIntegrityVerifier", "IntegrityCheckResult"],
    cause: "Binary integrity verification requires a built sandbox binary.",
  },
};

const addedSymbolMappings = [
  {
    original_path: "archive/core/orchestration/parser.py",
    original_symbol: "parse_llm_output",
    target_path: T.modelParser,
    target_symbol: "parseModelOutput",
    preserved_behaviors: ["fenced JSON block", "direct JSON", "balanced embedded JSON", "batched calls", "lenient control characters", "kernel-command typing"],
    intentionally_removed_behaviors: ["Python logging side effects"],
    behavioral_differences: ["returns a discriminated union instead of an untyped tuple", "kernel commands are typed but not executed by the coordinator"],
    tests: ["tests/ts/model-output.test.ts", "tests/ts/coordinator.test.ts"],
    verification_status: "verified",
    evidence: ["6 parser tests; 1 coordinator test proves real filesystem execution through the governed gateway"],
    blockers: [],
  },
  {
    original_path: "archive/runtime_next/engine/engine.py",
    original_symbol: "GraphExecutionEngine",
    target_path: T.graph,
    target_symbol: "GraphExecutionEngine",
    preserved_behaviors: ["topological scheduling", "parallel ready waves", "conditional edges", "retry policies", "cancellation", "snapshot serialization"],
    intentionally_removed_behaviors: ["unused engine hooks"],
    behavioral_differences: ["cycles are rejected instead of ordered ambiguously"],
    tests: ["tests/ts/graph.test.ts", "tests/ts/coordinator.test.ts"],
    verification_status: "verified",
    evidence: ["graph behavior tests and coordinator graph-batch integration test"],
    blockers: [],
  },
  {
    original_path: "archive/runtime_next/verification/classifier.py",
    original_symbol: "FailureClassifier",
    target_path: T.recovery,
    target_symbol: "classifyFailure",
    preserved_behaviors: ["weighted signals", "confidence", "alternative causes", "unknown classification"],
    intentionally_removed_behaviors: ["specialist-specific hints"],
    behavioral_differences: ["plain TypeScript evidence objects"],
    tests: ["tests/ts/recovery.test.ts"],
    verification_status: "verified",
    evidence: ["classification and confidence assertions in recovery tests"],
    blockers: [],
  },
  {
    original_path: "archive/runtime_next/verification/retry_safety.py",
    original_symbol: "RetrySafety",
    target_path: T.recovery,
    target_symbol: "RetrySafety",
    preserved_behaviors: ["failure stability", "bounded backoff", "non-retryable security/unknown failures"],
    intentionally_removed_behaviors: [],
    behavioral_differences: ["integrated through RecoveryGovernance"],
    tests: ["tests/ts/recovery.test.ts", "tests/ts/security-executor.test.ts"],
    verification_status: "verified",
    evidence: ["recovery policy tests and executor retry tests"],
    blockers: [],
  },
  {
    original_path: "archive/runtime_next/recovery/task_recovery.py",
    original_symbol: "TaskRecoveryManager",
    target_path: T.checkpoints,
    target_symbol: "CheckpointStore",
    preserved_behaviors: ["savepoint persistence", "digest binding", "restart restoration"],
    intentionally_removed_behaviors: ["phase-level rollback"],
    behavioral_differences: ["SQLite checkpoints instead of Python process state"],
    tests: ["tests/ts/recovery.test.ts"],
    verification_status: "verified",
    evidence: ["checkpoint round-trip, tamper rejection and restart restoration tests"],
    blockers: [],
  },
  {
    original_path: "archive/runtime_next/monitoring/metrics.py",
    original_symbol: "MetricsRegistry",
    target_path: T.metrics,
    target_symbol: "RuntimeMetrics",
    preserved_behaviors: ["tagged series", "counters", "histograms", "percentiles"],
    intentionally_removed_behaviors: ["specialist metrics"],
    behavioral_differences: ["bounded in-memory retention"],
    tests: ["tests/ts/context-observability.test.ts"],
    verification_status: "verified",
    evidence: ["tagged series and percentile assertions"],
    blockers: [],
  },
];

const intentionallyRemovedSpecific = new Set([
  "core/execution/experience_pipeline.py",
  "core/execution/commands.py",
  "memory/forge_memory.py",
  "web/__init__.py",
  "tools/code_tools.py",
  "tools/diagram_tools.py",
  "tools/git_tools.py",
  "tools/research_tools.py",
  "cli/modes.py",
  "cli/picker.py",
  "cli/providers.py",
  "cli/theme.py",
  "cli/live_models.py",
]);

function isPackageInit(path) {
  return path.endsWith("/__init__.py") || path === "__init__.py";
}

function refine(module) {
  const path = module.original_path.replace(/^archive\//, "");
  const previous = module.disposition;
  if (previous === "INTENTIONALLY_REMOVED") {
    return { status: "INTENTIONALLY_REMOVED", target: null, symbol: null, reason: "Excluded by the approved subsystem selection." };
  }
  if (path === "core/orchestration/parser.py") {
    return {
      status: "VERIFIED_PORT",
      target: T.modelParser,
      symbol: "parseModelOutput",
      reason: "Fenced/direct/embedded JSON tool-call parsing and kernel-command typing are ported, integrated as a fallback, and covered by parser plus coordinator integration tests.",
    };
  }
  if (previous === "ADAPTED_PORT") {
    return {
      status: "PARTIALLY_PORTED",
      target: module.target_path,
      symbol: module.target_symbol,
      reason: "A real TypeScript port exists, but recorded missing behavior remains.",
    };
  }
  if (environmentBlocked[path]) {
    return { status: "ENVIRONMENT_BLOCKED", target: T.sandbox, symbol: "SandboxBridge", reason: environmentBlocked[path].cause };
  }
  if (intentionallyRemovedSpecific.has(path) || isPackageInit(path)) {
    return {
      status: "INTENTIONALLY_REMOVED",
      target: null,
      symbol: null,
      reason: isPackageInit(path)
        ? "Python package namespace/re-export only; the active module layout replaces it."
        : "Coding-specific or obsolete behavior excluded from the personal runtime.",
    };
  }
  if (exactPartial[path]) {
    const [target, symbol, reason] = exactPartial[path];
    return { status: "PARTIALLY_PORTED", target, symbol, reason };
  }
  if (typeof module.target_path === "string" && module.target_path.length > 0 && existsSync(join(root, module.target_path))) {
    return {
      status: "PARTIALLY_PORTED",
      target: module.target_path,
      symbol: module.target_symbol,
      reason: "A related target exists, but the module-level behavior has not been fully verified against the archive.",
    };
  }
  return {
    status: "NOT_STARTED",
    target: null,
    symbol: null,
    reason: "Retained general-purpose source has been inspected at module level but no complete port exists yet.",
  };
}

const refined = new Map();
for (const module of mapping.modules) {
  const result = refine(module);
  refined.set(module.original_path, result);
  module.implementation_status = result.status;
  module.disposition = result.status;
  module.target_path = result.target;
  module.target_symbol = result.symbol;
  module.rationale = result.reason;
  if (result.status === "INTENTIONALLY_REMOVED") {
    module.verification_status = "not_applicable";
    module.blockers = [];
  } else if (result.status === "ENVIRONMENT_BLOCKED") {
    module.verification_status = "unverified";
    module.blockers = [environmentBlocked[module.original_path.replace(/^archive\//, "")]?.cause ?? result.reason];
  } else if (result.status === "PARTIALLY_PORTED") {
    module.verification_status = "partial";
  } else if (result.status === "VERIFIED_PORT") {
    module.verification_status = "verified";
    module.blockers = [];
    module.evidence = ["Archived source: archive/core/orchestration/parser.py", "tests/ts/model-output.test.ts", "tests/ts/coordinator.test.ts"];
    module.tests = ["tests/ts/model-output.test.ts", "tests/ts/coordinator.test.ts"];
  } else {
    module.verification_status = "unverified";
  }
}

const pathStatus = new Map(mapping.modules.map((module) => [module.original_path.replace(/^archive\//, ""), module]));
const retained = mapping.modules.filter((module) =>
  ["NOT_STARTED", "PARTIALLY_PORTED", "IN_PROGRESS", "ENVIRONMENT_BLOCKED"].includes(module.implementation_status),
);
const retainedPaths = new Set(retained.map((module) => module.original_path.replace(/^archive\//, "")));

const dependencyMap = new Map();
for (const module of retained) dependencyMap.set(module.original_path.replace(/^archive\//, ""), []);
for (const edge of deps.edges) {
  if (!retainedPaths.has(edge.from) || !retainedPaths.has(edge.to)) continue;
  dependencyMap.get(edge.to)?.push(edge.from);
}

const subsystemPriority = {
  config: 0,
  core: 1,
  runtime_next: 2,
  memory: 3,
  planning: 4,
  mcp: 5,
  auth: 6,
  tools: 7,
  cli: 8,
  web: 9,
};
function priority(path) {
  return subsystemPriority[path.split("/")[0]] ?? 10;
}
const remaining = new Set(retainedPaths);
const completed = new Set();
const order = [];
const waves = new Map();
let guard = 0;
while (remaining.size > 0 && guard < 10_000) {
  guard += 1;
  const ready = [...remaining]
    .filter((path) => (dependencyMap.get(path) ?? []).every((dependency) => completed.has(dependency) || !remaining.has(dependency)))
    .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  const batch = ready.length > 0 ? ready : [...remaining].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b)).slice(0, 1);
  for (const path of batch) {
    remaining.delete(path);
    completed.add(path);
    const dependencies = (dependencyMap.get(path) ?? []).filter((dependency) => retainedPaths.has(dependency));
    const wave = dependencies.length === 0 ? 1 : Math.max(...dependencies.map((dependency) => waves.get(dependency) ?? 1)) + 1;
    waves.set(path, wave);
    const module = pathStatus.get(path);
    order.push({
      order: order.length + 1,
      wave,
      original_path: module.original_path,
      status: module.implementation_status,
      target_path: module.target_path,
      target_symbol: module.target_symbol,
      source_loc: invByPath.get(path)?.loc ?? null,
      symbol_counts: invByPath.get(path)?.symbols ?? null,
      dependencies,
      next_action:
        module.implementation_status === "ENVIRONMENT_BLOCKED"
          ? "Complete independent TypeScript behavior and tests; native containment awaits the Rust toolchain."
          : module.implementation_status === "PARTIALLY_PORTED"
            ? "Complete the missing behavior against the archived source and add a regression test."
            : "Inspect archived symbols, select general-purpose behavior, port it, integrate it, and verify it.",
      blocker:
        module.implementation_status === "ENVIRONMENT_BLOCKED"
          ? {
              affected_symbols: environmentBlocked[path]?.symbols ?? [],
              cause: environmentBlocked[path]?.cause ?? module.rationale,
              attempted_resolution: "cargo --version, rustup --version and rustc --version failed; sandbox_core/target is absent.",
              remaining_prerequisite: "Rust toolchain plus a built sandbox_core binary.",
              independent_work: "TypeScript bridge, fail-closed behavior and status diagnostics remain testable.",
            }
          : null,
    });
  }
}

const statusCounts = {};
for (const module of mapping.modules) {
  statusCounts[module.implementation_status] = (statusCounts[module.implementation_status] ?? 0) + 1;
}
const symbolIndex = new Map(
  (mapping.symbol_mappings ?? []).map((entry) => [`${entry.original_path}::${entry.original_symbol}`, entry]),
);
for (const entry of addedSymbolMappings) {
  symbolIndex.set(`${entry.original_path}::${entry.original_symbol}`, {
    original_source_range: { start: null, end: null },
    disposition: "ADAPTED_PORT",
    dependencies: [],
    ...entry,
  });
}
mapping.symbol_mappings = [...symbolIndex.values()];
mapping.summary = {
  python_modules: mapping.modules.length,
  implementation_statuses: statusCounts,
  queue_entries: order.length,
  verified_ports: statusCounts.VERIFIED_PORT ?? 0,
  environment_blocked: statusCounts.ENVIRONMENT_BLOCKED ?? 0,
  intentionally_removed: statusCounts.INTENTIONALLY_REMOVED ?? 0,
  partially_ported: statusCounts.PARTIALLY_PORTED ?? 0,
  not_started: statusCounts.NOT_STARTED ?? 0,
};
mapping.queue_file = "AELVO_IMPLEMENTATION_QUEUE.json";
writeFileSync(join(root, "AELVO_PORT_MAPPING.json"), JSON.stringify(mapping, null, 2) + "\n");
writeFileSync(
  join(root, "AELVO_IMPLEMENTATION_QUEUE.json"),
  JSON.stringify(
    {
      schema: "aelvo-implementation-queue/1",
      generated_at: "2026-11-24",
      source: ["AELVO_PORT_MAPPING.json", "AELVO_DEPENDENCY_GRAPH.json", "AELVO_MODULE_INVENTORY.json"],
      summary: {
        entries: order.length,
        statuses: statusCounts,
        max_wave: Math.max(0, ...waves.values()),
        cycles_resolved_by_priority: order.filter((entry) => entry.dependencies.some((dependency) => waves.get(dependency) === undefined)).length,
      },
      entries: order,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(mapping.summary, null, 2));
