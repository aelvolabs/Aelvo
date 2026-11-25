# AELVO Transformation Report

**Date:** 2026-11-25
**Branch:** `arch-transformation`
**Baseline:** `main` @ `50af66544df0eed935ea4b0119303d7f78d26ce4`
**Verdict: INCOMPLETE.** The core runtime, graph integration, recovery
savepoints, frontend build and packaging pass verification. The source-driven
port still has 110 partial modules, 7 unstarted modules and 3 native-sandbox
environment blockers.

## 1. Module accounting

`AELVO_PORT_MAPPING.json` accounts for **388/388** production Python modules.
The former generic status label has been eliminated.

| Disposition | Modules |
|---|---:|
| `INTENTIONALLY_REMOVED` | 267 |
| `PARTIALLY_PORTED` | 110 |
| `ENVIRONMENT_BLOCKED` | 3 |
| `NOT_STARTED` | 7 |
| `VERIFIED_PORT` | 1 |

`AELVO_IMPLEMENTATION_QUEUE.json` contains **120** dependency-ordered retained
entries over six waves. Symbol-level mappings increased from 17 to **22**,
including the parser, graph engine, classifier, retry safety, checkpoints and
metrics.

## 2. Completed and integrated

| Area | Target | Verified behavior |
|---|---|---|
| Execution graph | `src/runtime/execution/graph.ts` | Topological order, cycle rejection, parallel ready waves, lifecycle, retries, conditional edges, output contracts, transformers, snapshots; 7 tests |
| Production graph path | `src/runtime/execution/tool-graph.ts` | Coordinator routes policy-allowed multi-call batches through the graph with real filesystem effects, dependency ordering, failure propagation and events |
| Governed executor | `src/tools/executor/executor.ts` | Zod validation, policy, single-use approvals, evidence, read-back, classification-driven retries, idempotent read cache |
| Recovery | `src/runtime/recovery/` | Classification, strategy budgets, retry safety, SQLite savepoints, digest verification, restart restoration, task-run integration |
| Context | `src/intelligence/context/context-builder.ts` | Token/character budget, oldest-message compaction, persisted deterministic summary |
| Observability | `src/observability/metrics.ts` | Bounded tagged series, percentiles, execution/cache counters, health checks |
| Structured output | `src/intelligence/parsing/model-output.ts` | Archived parser port; fenced/direct/embedded JSON, batched calls, lenient control characters, kernel-command typing; coordinator fallback still passes policy and approvals |
| Frontend | `web/` | Auth-first bridge handshake, `run.start`, typed event adaptation, approval buttons, real-offline failure, no simulated specialist pipeline; production build succeeds |

## 3. Verification actually run

| Command / check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | 60 passed / 8 files |
| `npm run test:install` | 7 passed |
| `web/npm run build` | exit 0, `web/dist` produced |
| `web/npx vitest run` | 16 passed / 2 files |
| `npm pack --dry-run` | 110 files, 935.0 kB |
| Archive exclusion | no archive entries in the package; `git check-ignore archive/main.py` matched |

The bridge socket tests verify auth rejection, origin rejection, payload limits
and governed run commands. Frontend tests verify adaptation of deltas,
completion, failures and approvals. A browser click-through was not run.

## 4. Precise residual blockers

1. **Port backlog:** 110 modules are `PARTIALLY_PORTED`; 7 are `NOT_STARTED`.
   These are inspection/implementation work, not environmental blockers.
2. **Graph scope:** tool batches use the real graph; durable plan execution still
   materializes tasks rather than running every plan through graph nodes.
3. **Recovery depth:** savepoints and restart restoration are integrated.
   Controlled recovery-node injection, replay validation and partial-execution
   reconciliation remain unported.
4. **Native sandbox:** `cargo`/`rustup`/`rustc` are absent and
   `sandbox_core/target` is missing. Path containment and process restrictions
   are not claimed verified; unsafe capabilities remain disabled.
5. **Live provider:** no `GEMINI_API_KEY`/`GOOGLE_API_KEY` was available.
   Google implementation uses deterministic fixtures; no live result is claimed.
6. **Platform credentials:** only Windows DPAPI was exercised.
7. **Archive provenance:** archive checksums match the reconstructed baseline.
   Preservation of uncommitted Python edits that may have existed before deletion
   cannot be independently proven from the available Git objects.
8. **Frontend E2E:** the UI builds and protocol behavior is tested, but no
   end-to-end browser session with a live model was executed.

## 5. Final state

| Measure | Value |
|---|---:|
| Active TypeScript files / LOC | 47 / 8,252 |
| Archived production modules / LOC | 388 / 107,599 |
| Vitest tests | 60 |
| Frontend tests | 16 |
| Installer tests | 7 |
| Active production Python files | 0 |

The application remains Node-only. `archive/` stays ignored and excluded from
builds, tests and packaging. No commit or push was performed.
