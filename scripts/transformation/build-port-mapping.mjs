#!/usr/bin/env node
/**
 * Builds AELVO_PORT_MAPPING.json from the archived module inventory.
 *
 * Rules are explicit and conservative: a module is only marked ported when a
 * TypeScript implementation actually exists and its verification status is
 * recorded. Coding-specific modules are marked INTENTIONALLY_REMOVED; retained
 * modules without a complete TS implementation are BLOCKED, never assumed.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const inventory = JSON.parse(readFileSync(join(root, "AELVO_MODULE_INVENTORY.json"), "utf8"));
const pythonModules = inventory.modules.filter((m) => m.language === "Python");

const T = {
  app: "src/app.ts",
  cli: "src/cli/entry.ts",
  config: "src/config/index.ts",
  context: "src/intelligence/context/context-builder.ts",
  providers: "src/intelligence/providers/google/gateway.ts",
  providerTypes: "src/intelligence/providers/types.ts",
  unconfigured: "src/intelligence/providers/unconfigured.ts",
  memory: "src/memory/service.ts",
  planner: "src/planning/planner.ts",
  tasks: "src/tasks/service.ts",
  scheduler: "src/scheduler/index.ts",
  executor: "src/tools/executor/executor.ts",
  registry: "src/tools/registry/registry.ts",
  filesystem: "src/tools/filesystem/tools.ts",
  policy: "src/security/policies/policy.ts",
  approvals: "src/security/approvals/service.ts",
  paths: "src/security/paths.ts",
  sandbox: "src/security/sandbox/index.ts",
  credentials: "src/security/credentials/service.ts",
  audit: "src/security/audit/log.ts",
  bridge: "src/runtime/bridge/server.ts",
  mcp: "src/mcp/manager.ts",
  events: "src/runtime/events/bus.ts",
  contracts: "src/shared/contracts/index.ts",
  graph: "src/runtime/execution/graph.ts",
  recovery: "src/runtime/recovery/index.ts",
  runs: "src/runtime/execution/run-store.ts",
  verifier: "src/runtime/verification/verifier.ts",
  diagnostics: "src/runtime/diagnostics.ts",
  observability: "src/observability/logger.ts",
};

const codingRemoved = {
  disposition: "INTENTIONALLY_REMOVED",
  target: null,
  targetSymbol: null,
  preserved: [],
  removed: ["coding-specialist pipeline behaviour excluded by the approved subsystem selection"],
  differences: ["removed from the active runtime; archived source remains available"],
  status: "not_applicable",
  blocker: "",
};

const exact = {
  "main.py": {
    disposition: "ADAPTED_PORT",
    target: T.app,
    targetSymbol: "AelvoApplication",
    preserved: ["process composition", "startup sequencing"],
    removed: ["Python bootstrap", "specialist pipeline wiring"],
    differences: ["Node/TypeScript composition root replaces Python boot"],
    status: "partial",
    blocker: "Only the personal-runtime surface is wired; legacy specialist startup was intentionally discarded.",
  },
  "core/execution/tool_registry.py": {
    disposition: "ADAPTED_PORT",
    target: T.executor,
    targetSymbol: "ToolExecutor",
    preserved: [
      "registration and lookup",
      "structured results",
      "retry limits",
      "timeout handling",
      "capability metadata",
    ],
    removed: ["execution strategy batches", "result cache", "tag/category query API"],
    differences: [
      "one governed executor is authoritative",
      "success additionally requires evidence and verification",
      "retry decisions use failure classification and retry safety",
    ],
    status: "partial",
    blocker: "ExecutionStrategy batching, TTL result caching and category/tag queries are not yet ported.",
  },
  "core/filesystem/automation.py": {
    disposition: "ADAPTED_PORT",
    target: T.filesystem,
    targetSymbol: "createFilesystemTools",
    preserved: ["read", "list", "search", "write", "edit", "delete", "info", "atomic write", "workspace containment"],
    removed: ["Python fallback execution path"],
    differences: ["native Node filesystem APIs", "policy and evidence are enforced by the governed executor"],
    status: "partial",
    blocker: "Range reads and every legacy edge case have not been regression-compared to the archived implementation.",
  },
  "core/security/approval_manager.py": {
    disposition: "ADAPTED_PORT",
    target: T.approvals,
    targetSymbol: "ApprovalService",
    preserved: ["request lifecycle", "single-use redemption", "digest binding", "expiry"],
    removed: ["specialist approval scopes"],
    differences: ["approvals are process-local and invalidated on restart"],
    status: "partial",
    blocker: "Only the personal-runtime approval surface is exercised; legacy approval scopes were not all ported.",
  },
  "core/security/execution_governance.py": {
    disposition: "ADAPTED_PORT",
    target: T.policy,
    targetSymbol: "PolicyService",
    preserved: ["capability gating", "workspace containment", "destructive approval", "emergency stop"],
    removed: ["model-supplied safety classification"],
    differences: ["one code-owned policy service replaces duplicate governance stacks"],
    status: "partial",
    blocker: "Legacy risk scoring and policy monitoring are not fully ported.",
  },
  "core/security/execution_sandbox.py": {
    disposition: "BLOCKED",
    target: T.sandbox,
    targetSymbol: "SandboxBridge",
    preserved: ["fail-closed availability check"],
    removed: ["Python sandbox fallback"],
    differences: ["Rust binary is the only containment authority"],
    status: "unverified",
    blocker: "Rust sandbox is not built on this host; runtime containment cannot be verified.",
  },
  "core/security/security_analytics.py": {
    disposition: "BLOCKED",
    target: T.observability,
    targetSymbol: "createLogger",
    preserved: [],
    removed: ["fabricated agent activity metrics"],
    differences: [],
    status: "unverified",
    blocker: "Security analytics aggregation is not yet ported; only structured logging exists.",
  },
  "core/governance/kernel.py": {
    disposition: "ADAPTED_PORT",
    target: T.memory,
    targetSymbol: "MemoryService",
    preserved: ["fact supersession", "provenance", "session storage"],
    removed: ["coding governance and multi-agent consensus"],
    differences: ["SQLite is authoritative; no Chroma dependency"],
    status: "partial",
    blocker: "Legacy importance/retrieval ranking was only partially ported.",
  },
  "core/orchestration/context_builder.py": {
    disposition: "ADAPTED_PORT",
    target: T.context,
    targetSymbol: "ContextBuilder",
    preserved: ["memory injection", "preference presentation", "session summary", "workspace identity"],
    removed: ["workspace tree crawling", "specialist memory attribution", "provider registry prompt"],
    differences: ["context is built for one coordinator instead of seven specialists"],
    status: "partial",
    blocker: "Token-budget management and conversation compaction are not yet ported.",
  },
  "core/orchestration/session_manager.py": {
    disposition: "ADAPTED_PORT",
    target: T.memory,
    targetSymbol: "MemoryService",
    preserved: ["session records", "message history", "session summary field"],
    removed: ["periodic Chroma consolidation"],
    differences: ["summaries are stored in SQLite and generated explicitly"],
    status: "partial",
    blocker: "Automatic periodic summarization/consolidation is not implemented.",
  },
  "core/orchestration/parser.py": {
    disposition: "BLOCKED",
    target: null,
    targetSymbol: null,
    preserved: [],
    removed: [],
    differences: [],
    status: "unverified",
    blocker: "The tolerant structured-output parser was not ported; native provider function calls are used instead.",
  },
  "core/provider_runtime.py": {
    disposition: "ADAPTED_PORT",
    target: T.providers,
    targetSymbol: "GoogleGateway",
    preserved: ["provider normalization", "streaming", "usage accounting", "cancellation"],
    removed: ["22-provider registry"],
    differences: ["Google Gemini is the only live provider; unconfigured mode fails loudly"],
    status: "partial",
    blocker: "Live provider streaming has not been verified without an API key.",
  },
  "core/registry/models.py": {
    disposition: "ADAPTED_PORT",
    target: T.providerTypes,
    targetSymbol: "ProviderGateway",
    preserved: ["capability metadata", "message/tool contracts"],
    removed: ["legacy provider-specific model tables"],
    differences: ["model id comes from configuration"],
    status: "partial",
    blocker: "Provider capability metadata is minimal.",
  },
  "auth/cred_storage.py": {
    disposition: "ADAPTED_PORT",
    target: T.credentials,
    targetSymbol: "CredentialService",
    preserved: ["OS-backed storage", "no plaintext fallback"],
    removed: ["legacy file vault"],
    differences: ["DPAPI/Keychain/secret-tool backends"],
    status: "partial",
    blocker: "Only the Windows DPAPI backend has been exercised.",
  },
  "auth/types.py": {
    disposition: "ADAPTED_PORT",
    target: T.providerTypes,
    targetSymbol: "ProviderGateway",
    preserved: ["provider request/response types"],
    removed: ["provider-specific Python types"],
    differences: ["Zod/TypeScript contracts"],
    status: "partial",
    blocker: "Full legacy provider type coverage was not migrated.",
  },
  "memory/user_model.py": {
    disposition: "ADAPTED_PORT",
    target: T.memory,
    targetSymbol: "MemoryService",
    preserved: ["preferences", "provenance", "validity/supersession"],
    removed: ["coding-specific learned patterns"],
    differences: ["SQLite FTS5 instead of Chroma; lexical retrieval only"],
    status: "partial",
    blocker: "Semantic retrieval and full preference scoring are not implemented.",
  },
  "runtime_next/models/plan.py": {
    disposition: "ADAPTED_PORT",
    target: T.graph,
    targetSymbol: "ExecutionGraph",
    preserved: ["nodes", "edges", "topological order", "critical path", "retry policy", "output contracts", "conditions", "transformers"],
    removed: ["specialist node type", "pattern learning"],
    differences: ["cycles are rejected instead of silently ordering the remainder"],
    status: "partial",
    blocker: "Graph execution is not yet the default path for interactive runs.",
  },
  "runtime_next/models/node.py": {
    disposition: "ADAPTED_PORT",
    target: T.graph,
    targetSymbol: "NodeDefinition",
    preserved: ["lifecycle state", "history", "retry budget", "start/end times"],
    removed: ["specialist attribution"],
    differences: ["typed TypeScript lifecycle"],
    status: "partial",
    blocker: "Checkpoint persistence for individual nodes is not implemented.",
  },
  "runtime_next/engine/engine.py": {
    disposition: "ADAPTED_PORT",
    target: T.graph,
    targetSymbol: "GraphExecutionEngine",
    preserved: ["topological execution", "node lifecycle", "retry cycles", "event publication"],
    removed: ["recovery-engine coupling", "coding runner"],
    differences: [
      "parallel ready waves are explicit",
      "failed dependencies block dependents",
      "unexecuted nodes are never marked completed",
    ],
    status: "partial",
    blocker: "The engine is tested standalone; coordinator integration is pending.",
  },
  "runtime_next/models/events.py": {
    disposition: "ADAPTED_PORT",
    target: T.contracts,
    targetSymbol: "RuntimeEventSchema",
    preserved: ["typed runtime events", "event validation"],
    removed: ["specialist/coding event families"],
    differences: ["one discriminated-union event vocabulary"],
    status: "partial",
    blocker: "Event replay and persisted event history are not fully ported.",
  },
  "runtime_next/verification/classifier.py": {
    disposition: "ADAPTED_PORT",
    target: T.recovery,
    targetSymbol: "FailureClassifier",
    preserved: ["weighted text signals", "exit codes", "confidence", "alternatives", "unknown never retried"],
    removed: ["graph/capability snapshot analysis", "specialist signals"],
    differences: ["unknown-only evidence is not normalized to certainty"],
    status: "partial",
    blocker: "Graph-state and capability-state classification inputs are not wired yet.",
  },
  "runtime_next/verification/recovery.py": {
    disposition: "ADAPTED_PORT",
    target: T.recovery,
    targetSymbol: "RecoveryStrategyEngine",
    preserved: ["strategy registry", "per-failure retry budgets", "approval-required failures"],
    removed: ["consensus/specialist recovery", "node injection"],
    differences: ["strategies are advisory to the governed executor, not autonomous graph mutation"],
    status: "partial",
    blocker: "Recovery action execution and node injection are not implemented.",
  },
  "runtime_next/verification/retry_safety.py": {
    disposition: "ADAPTED_PORT",
    target: T.recovery,
    targetSymbol: "RetrySafetyEngine",
    preserved: ["unknown/security never retry", "dangerous mutation check", "failure stability", "bounded backoff"],
    removed: ["replay log analysis", "capability snapshot checks"],
    differences: ["optional graph/capability inputs default to consistent"],
    status: "partial",
    blocker: "Replay and serialization state checks are not wired.",
  },
  "runtime_next/verification/types.py": {
    disposition: "BLOCKED",
    target: T.recovery,
    targetSymbol: "FailureClassification",
    preserved: ["failure taxonomy", "retryability", "confidence"],
    removed: ["coding verification types"],
    differences: [],
    status: "partial",
    blocker: "Full verification result/manifest type system was not ported.",
  },
  "runtime_next/recovery/engine.py": {
    disposition: "BLOCKED",
    target: T.recovery,
    targetSymbol: "RecoveryStrategyEngine",
    preserved: ["classification-to-strategy direction"],
    removed: ["consensus/specialist recovery", "monitoring and security orchestration imports"],
    differences: [],
    status: "unverified",
    blocker: "The full graph-coupled recovery orchestrator was not ported.",
  },
  "runtime_next/recovery/task_recovery.py": {
    disposition: "BLOCKED",
    target: T.tasks,
    targetSymbol: "TaskService",
    preserved: ["durable task states", "retryable/failed transitions"],
    removed: ["architect escalation", "savepoint rollback"],
    differences: [],
    status: "unverified",
    blocker: "Task-level savepoint/rollback and phase recovery are not implemented.",
  },
  "mcp/execution/executor.py": {
    disposition: "ADAPTED_PORT",
    target: T.mcp,
    targetSymbol: "McpManager",
    preserved: ["tool listing", "governed invocation", "approval gating"],
    removed: ["coding-specific MCP integrations"],
    differences: ["official SDK protocol handling", "untrusted tool descriptions"],
    status: "partial",
    blocker: "MCP connection recovery and full trust scoring were not verified.",
  },
  "cli/__main__.py": {
    disposition: "ADAPTED_PORT",
    target: T.cli,
    targetSymbol: "main",
    preserved: ["entry point", "exit codes"],
    removed: ["coding workflow commands"],
    differences: ["Node CLI with doctor/config/run/chat/memory/task/serve"],
    status: "partial",
    blocker: "Legacy command parity was intentionally not preserved.",
  },
  "config/settings.py": {
    disposition: "ADAPTED_PORT",
    target: T.config,
    targetSymbol: "loadConfig",
    preserved: ["environment-driven paths and model selection"],
    removed: ["coding mode settings"],
    differences: ["AELVO_MODEL is required for live provider use"],
    status: "partial",
    blocker: "Legacy configuration keys were not all mapped.",
  },
};

function targetFor(path) {
  if (path.startsWith("tests/") || path.includes("/tests/") || /(^|\/)test_[^/]*\.py$/.test(path)) {
    return { ...codingRemoved, removed: ["Python test suite retired with the production runtime"] };
  }
  if (path.startsWith("audit_artifacts/")) {
    return { ...codingRemoved, removed: ["audit helper only; archived, not runtime"] };
  }
  if (
    path.startsWith("repo_intelligence/") ||
    path.startsWith("specialists/") ||
    path.startsWith("cognition/") ||
    path.startsWith("shared_task_board/") ||
    path.startsWith("learning/")
  ) {
    return codingRemoved;
  }
  if (path.startsWith("planning/debt_forecasting") || path.startsWith("planning/plan_evolution") || path.startsWith("planning/critique_evolution") || path.startsWith("planning/self_critique")) {
    return codingRemoved;
  }
  if (path.startsWith("runtime_next/plan/")) return codingRemoved;
  if (path.startsWith("runtime_next/recovery/consensus") || path.startsWith("runtime_next/recovery/specialist")) return codingRemoved;
  if (path.startsWith("runtime_next/verification/")) return codingRemoved;
  if (path.startsWith("runtime_next/")) {
    if (path.startsWith("runtime_next/security/")) {
      return {
        disposition: "BLOCKED", target: T.sandbox, targetSymbol: "SandboxBridge",
        preserved: ["fail-closed sandbox direction"], removed: [], differences: [],
        status: "unverified", blocker: "Runtime security scanner/integrity verification is not ported; sandbox binary absent.",
      };
    }
    return {
      disposition: "BLOCKED", target: null, targetSymbol: null,
      preserved: [], removed: [], differences: [],
      status: "unverified", blocker: "No verified TypeScript port yet; archived source remains the reference.",
    };
  }
  if (path.startsWith("repo_intelligence/")) return codingRemoved;
  if (path.startsWith("core/execution/")) {
    return {
      disposition: "BLOCKED", target: T.executor, targetSymbol: "ToolExecutor",
      preserved: ["governed execution direction"], removed: [], differences: [],
      status: "unverified", blocker: "Process/sandbox execution is not exposed; this module has no full TS port.",
    };
  }
  if (path.startsWith("core/filesystem/")) {
    return {
      disposition: "BLOCKED", target: T.filesystem, targetSymbol: "createFilesystemTools",
      preserved: ["filesystem policy direction"], removed: [], differences: [],
      status: "unverified", blocker: "No module-level behavioural comparison recorded for this file.",
    };
  }
  if (path.startsWith("core/security/")) {
    return {
      disposition: "BLOCKED", target: T.policy, targetSymbol: "PolicyService",
      preserved: ["code-owned policy direction"], removed: [], differences: [],
      status: "unverified", blocker: "This security module has not been fully ported or verified.",
    };
  }
  if (path.startsWith("core/orchestration/")) return codingRemoved;
  if (path.startsWith("core/rag/")) {
    return {
      disposition: "BLOCKED", target: T.memory, targetSymbol: "MemoryService",
      preserved: ["retrieval direction"], removed: ["Chroma vector dependency"],
      differences: ["SQLite FTS5 lexical retrieval only"], status: "unverified",
      blocker: "Semantic retrieval is explicitly deferred; lexical retrieval is not equivalent.",
    };
  }
  if (path.startsWith("core/scraping/") || path.startsWith("core/workers/")) return codingRemoved;
  if (path.startsWith("core/")) {
    return {
      disposition: "BLOCKED", target: null, targetSymbol: null,
      preserved: [], removed: [], differences: [], status: "unverified",
      blocker: "No verified TypeScript port yet; archived source remains the reference.",
    };
  }
  if (path.startsWith("auth/")) {
    if (path.includes("cred_storage") || path.includes("types.py")) {
      return { ...exact[path] };
    }
    if (path.includes("google")) {
      return {
        disposition: "ADAPTED_PORT", target: T.providers, targetSymbol: "GoogleGateway",
        preserved: ["Google request/response normalization"], removed: [], differences: [],
        status: "partial", blocker: "Live Google calls are unverified without an API key.",
      };
    }
    if (path.includes("circuit") || path.includes("ratelimit") || path.includes("monitor")) {
      return {
        disposition: "BLOCKED", target: T.providers, targetSymbol: "GoogleGateway",
        preserved: ["provider resilience direction"], removed: [], differences: [],
        status: "unverified", blocker: "Provider circuit breaker/rate-limit handling is not ported.",
      };
    }
    return { ...codingRemoved, removed: ["obsolete provider implementation; only Google Gemini is supported"] };
  }
  if (path.startsWith("mcp/integrations/") || path.startsWith("mcp/recovery/") || path.startsWith("mcp/memory/")) return codingRemoved;
  if (path.startsWith("mcp/")) {
    return {
      disposition: "BLOCKED", target: T.mcp, targetSymbol: "McpManager",
      preserved: ["MCP configuration and tool listing direction"], removed: ["coding integrations"],
      differences: ["official TypeScript SDK"], status: "partial",
      blocker: "Full governance/trust/recovery behaviour for this MCP module is not verified.",
    };
  }
  if (path === "web/server.py" || path === "web/web_bridge.py") {
    return {
      disposition: "ADAPTED_PORT", target: T.bridge, targetSymbol: "LocalBridgeServer",
      preserved: ["loopback binding", "authenticated commands", "event streaming"],
      removed: ["unauthenticated privileged operations"],
      differences: ["token/origin checks are mandatory", "64 KiB cap and rate limit"],
      status: "partial", blocker: "Frontend build absent; end-to-end browser verification not performed.",
    };
  }
  if (path.startsWith("web/")) {
    return {
      disposition: "BLOCKED", target: T.bridge, targetSymbol: "LocalBridgeServer",
      preserved: [], removed: [], differences: [], status: "unverified",
      blocker: "Legacy Python web backend module; not rebuilt in the React shell.",
    };
  }
  if (path.startsWith("cli/")) {
    return {
      disposition: "BLOCKED", target: T.cli, targetSymbol: "main",
      preserved: [], removed: ["coding workflow commands"], differences: [],
      status: "unverified", blocker: "No dedicated TS port for this legacy CLI module.",
    };
  }
  if (path.startsWith("planning/")) {
    return {
      disposition: "BLOCKED", target: T.planner, targetSymbol: "planFromRequest",
      preserved: ["goal decomposition direction"], removed: [], differences: [],
      status: "partial", blocker: "Only deterministic step extraction/materialization is ported.",
    };
  }
  if (path.startsWith("memory/")) {
    return {
      disposition: "BLOCKED", target: T.memory, targetSymbol: "MemoryService",
      preserved: ["personal memory direction"], removed: [], differences: [],
      status: "unverified", blocker: "No dedicated TS port for this memory module.",
    };
  }
  if (path.startsWith("tools/")) {
    return {
      disposition: "BLOCKED", target: T.filesystem, targetSymbol: "createFilesystemTools",
      preserved: [], removed: [], differences: [], status: "unverified",
      blocker: "Legacy Python tool module not ported; only filesystem tools are exposed.",
    };
  }
  if (path.startsWith("config/")) {
    return {
      disposition: "BLOCKED", target: T.config, targetSymbol: "loadConfig",
      preserved: [], removed: [], differences: [], status: "unverified",
      blocker: "No dedicated TS port for this config module.",
    };
  }
  return {
    disposition: "BLOCKED", target: null, targetSymbol: null,
    preserved: [], removed: [], differences: [], status: "unverified",
    blocker: "Unclassified legacy module; no port claimed.",
  };
}

const modules = pythonModules.map((m) => {
  const mapped = exact[m.path] ?? targetFor(m.path);
  return {
    original_path: `archive/${m.path}`,
    original_symbol: null,
    original_source_range: { start: null, end: null },
    disposition: mapped.disposition,
    target_path: mapped.target,
    target_symbol: mapped.targetSymbol,
    preserved_behaviors: mapped.preserved,
    intentionally_removed_behaviors: mapped.removed,
    behavioral_differences: mapped.differences,
    dependencies: m.direct_dependencies,
    tests: [],
    verification_status: mapped.status,
    evidence: [
      `Archived source: archive/${m.path}`,
      `Inventory disposition: ${m.recommended_disposition}; subsystem: ${m.subsystem}`,
      ...(mapped.blocker === "" ? [] : [mapped.blocker]),
    ],
    blockers: mapped.blocker === "" ? [] : [mapped.blocker],
  };
});

const symbolMappings = [
  ["core/execution/tool_registry.py", "ToolExecutionRegistry", T.executor, "ToolExecutor", "ADAPTED_PORT"],
  ["core/filesystem/automation.py", "FileAutomation", T.filesystem, "createFilesystemTools", "ADAPTED_PORT"],
  ["core/orchestration/context_builder.py", "ContextBuilder", T.context, "ContextBuilder", "ADAPTED_PORT"],
  ["core/security/approval_manager.py", "ApprovalManager", T.approvals, "ApprovalService", "ADAPTED_PORT"],
  ["memory/user_model.py", "UserModel", T.memory, "MemoryService", "ADAPTED_PORT"],
  ["runtime_next/models/plan.py", "ExecutionPlan", T.graph, "ExecutionGraph", "ADAPTED_PORT"],
  ["runtime_next/models/plan.py", "RetryPolicy", T.graph, "RetryPolicy", "DIRECT_PORT"],
  ["runtime_next/models/plan.py", "OutputContract", T.graph, "OutputContract", "DIRECT_PORT"],
  ["runtime_next/models/plan.py", "EdgeCondition", T.graph, "EdgeCondition", "DIRECT_PORT"],
  ["runtime_next/models/plan.py", "DataTransformer", T.graph, "DataTransformer", "DIRECT_PORT"],
  ["runtime_next/models/node.py", "NodeDefinition", T.graph, "NodeDefinition", "ADAPTED_PORT"],
  ["runtime_next/engine/engine.py", "ExecutionGraph", T.graph, "ExecutionGraph", "ADAPTED_PORT"],
  ["runtime_next/engine/engine.py", "ExecutionEngine", T.graph, "GraphExecutionEngine", "ADAPTED_PORT"],
  ["runtime_next/verification/classifier.py", "FailureClassifier", T.recovery, "FailureClassifier", "ADAPTED_PORT"],
  ["runtime_next/verification/recovery.py", "RecoveryStrategyEngine", T.recovery, "RecoveryStrategyEngine", "ADAPTED_PORT"],
  ["runtime_next/verification/retry_safety.py", "RetrySafetyEngine", T.recovery, "RetrySafetyEngine", "ADAPTED_PORT"],
  ["runtime_next/models/events.py", "BaseEvent", T.contracts, "RuntimeEventSchema", "ADAPTED_PORT"],
].map(([originalPath, originalSymbol, targetPath, targetSymbol, disposition]) => ({
  original_path: `archive/${originalPath}`,
  original_symbol: originalSymbol,
  original_source_range: { start: null, end: null },
  disposition,
  target_path: targetPath,
  target_symbol: targetSymbol,
  preserved_behaviors: ["see module mapping"],
  intentionally_removed_behaviors: [],
  behavioral_differences: ["see module mapping"],
  dependencies: [],
  tests: [],
  verification_status: "partial",
  evidence: ["Symbol read in archived source and compared with the TypeScript implementation."],
  blockers: ["Symbol-level regression fixtures are not yet complete."],
}));

const counts = {};
for (const m of modules) counts[m.disposition] = (counts[m.disposition] ?? 0) + 1;
const statusCounts = {};
for (const m of modules) statusCounts[m.verification_status] = (statusCounts[m.verification_status] ?? 0) + 1;

const output = {
  schema: "aelvo-port-mapping/1",
  generated_at: "2026-11-24",
  source_revision: inventory.generated_for_revision,
  source_of_truth: [
    "archive/ (git-ignored legacy Python implementation)",
    "AELVO_MODULE_INVENTORY.json",
    "AELVO_DEPENDENCY_GRAPH.json",
    "src/",
  ],
  summary: {
    python_modules: modules.length,
    dispositions: counts,
    verification_statuses: statusCounts,
    symbol_mappings: symbolMappings.length,
  },
  symbol_mappings: symbolMappings,
  modules,
};

writeFileSync(join(root, "AELVO_PORT_MAPPING.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output.summary, null, 2));
