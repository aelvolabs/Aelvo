# AELVO Behaviour Matrix

**Date:** 2026-11-25
**Source of truth:** `archive/` (legacy implementation) and `src/` (active runtime)
**Machine-readable detail:** `AELVO_PORT_MAPPING.json`

Status meanings:

- **Verified** — selected behavior is implemented, integrated and tested.
- **Partial** — a real implementation exists with recorded missing behavior.
- **Not started** — retained source has no complete port yet.
- **Environment blocked** — requires an unavailable native toolchain/binary.
- **Removed** — intentionally excluded from the active runtime.

| Subsystem | Legacy source | Active target | Status | Behaviour retained / missing |
|---|---|---|---|---|
| Application boot | `main.py` | `src/app.ts` | Partial | one composition root and lifecycle; specialist startup removed |
| CLI | `cli/` | `src/cli/entry.ts` | Partial | run/serve/doctor/config/memory/task/schedule/mcp/plan; legacy coding commands removed |
| Coordinator | `core/orchestration/` | `src/runtime/coordinator/run-coordinator.ts` | Partial | one governed loop, streaming, tool continuation, approval pause/resume; durable plans still materialize as tasks |
| Tool registry | `core/execution/tool_registry.py` | `src/tools/registry/registry.ts` | Partial | registration, descriptors, lookup, cache TTL metadata; full execution strategies not ported |
| Governed executor | `core/execution/tool_registry.py` | `src/tools/executor/executor.ts` | Partial | validation, policy, approvals, evidence, read-back, classified retries, idempotent read cache |
| Execution graph | `runtime_next/models/{plan,node}.py`, `engine/engine.py` | `src/runtime/execution/graph.ts`, `tool-graph.ts` | Partial | topological waves, cycle rejection, lifecycle, retries, contracts, conditions, transformers, snapshots; coordinator graph batches; full plan-node execution missing |
| Structured output parser | `core/orchestration/parser.py` | `src/intelligence/parsing/model-output.ts` | Verified | fenced/direct/embedded JSON, batched calls, lenient controls, kernel typing; coordinator fallback; 7 integration/unit tests |
| Failure recovery | `runtime_next/verification/*`, `recovery/` | `src/runtime/recovery/` | Partial | classification, strategy budgets, retry safety, savepoints, digest verification, restart restoration; node injection/replay/reconciliation missing |
| Security policy | `core/security/`, `core/governance/` | `src/security/policies/policy.ts` | Partial | capability/path/destructive decisions, emergency stop; full risk analytics missing |
| Approvals | `core/security/approval_manager.py` | `src/security/approvals/service.ts` | Partial | single-use, digest-bound, expiring, restart-invalidated; legacy scopes missing |
| Filesystem | `core/filesystem/automation.py` | `src/tools/filesystem/tools.ts` | Partial | 8 tools, atomic writes, containment, secret-file denial, read-back; range-read parity not fully compared |
| Native sandbox | `sandbox_core/` (Rust) | `src/security/sandbox/index.ts` | Environment blocked | typed bridge and fail-closed check; binary/toolchain unavailable, no containment runtime verified |
| Credentials | `auth/cred_storage.py` | `src/security/credentials/` | Partial | OS-backed storage only; only Windows DPAPI exercised |
| Providers | `auth/`, `core/provider_runtime.py` | `src/intelligence/providers/` | Partial | Google Gemini, streaming, function calls, usage; live call unverified |
| Context | `core/orchestration/context_builder.py` | `src/intelligence/context/context-builder.ts` | Partial | memory/preferences/session summary, budgeted compaction, persisted summary; full prioritization missing |
| Sessions | `core/orchestration/session_manager.py` | `src/memory/service.ts` | Partial | session/message persistence and summary field; automatic consolidation missing |
| Memory | `memory/`, `core/rag/` | `src/memory/service.ts` | Partial | provenance, supersession, FTS5 lexical search; semantic retrieval and full ranking deferred |
| Planning | `planning/` | `src/planning/planner.ts` | Partial | deterministic decomposition, validation, dependency materialization; advanced replanning missing |
| Tasks | `shared_task_board/` | `src/tasks/service.ts`, `src/scheduler/` | Ported | durable lifecycle, dependencies, retries, idempotency, crash reconciliation |
| MCP | `mcp/` | `src/mcp/manager.ts` | Partial | official SDK, untrusted descriptions, approval-gated tools; trust scoring/reconnect depth unverified |
| Local bridge | `web/server.py`, `web/web_bridge.py` | `src/runtime/bridge/server.ts` | Partial | loopback, origin allowlist, auth-first token, payload cap, rate limit, schema validation; frontend protocol tested |
| Observability | `runtime_next/monitoring/`, `core/security/security_analytics.py` | `src/observability/` | Partial | redacted logs, bounded metrics, percentiles, health checks; alerting and security analytics missing |
| Web UI | `web/` (Python) | `web/` (React) | Partial | builds; auth-first bridge protocol, real events, approvals, no simulated pipeline; no browser E2E with live provider |
| Coding intelligence | `repo_intelligence/`, `specialists/`, `cognition/` | — | Removed | intentionally excluded; archived for reference |

## Corrected legacy defects

| Defect | Correction |
|---|---|
| Invalid graph cycles silently ordered | `topologicalSort()` throws `TASK_DEPENDENCY_CYCLE` |
| Unexecuted nodes marked successful | Engine reports only executed nodes completed; dependents are blocked |
| Simulated max-mode / false success | No simulated provider or tool success path |
| Approvals not on production path | Every privileged executor call is approval-gated |
| Unauthenticated privileged WebSocket | Auth-first token handshake, origin allowlist, rate limit |
| Unsafe shell fallback | No process tool registered; sandbox absence fails closed |
| Blanket retries | Classification + retry safety decide; unknown/security failures never retry |
| Frontend fabricated seven-agent pipeline | Removed; UI shows only runtime-emitted events and honest offline errors |
| Text tool calls bypassed governance | Parser fallback produces calls that still pass policy, approval and execution |
