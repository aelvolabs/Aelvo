# AELVO Transformation State

**Date:** 2026-11-25
**Branch:** `arch-transformation`
**Baseline:** `main` @ `50af66544df0eed935ea4b0119303d7f78d26ce4`
**Directive:** complete source-driven TypeScript migration and production integration

## Current state

The active runtime is TypeScript with zero production Python. The archived Python
implementation remains in the Git-ignored, build-excluded `archive/`.

| Item | Value |
|---|---:|
| Archived files / Python files | 501 / 495 |
| Archived Python physical LOC | 154,563 |
| Archived production modules / LOC | 388 / 107,599 |
| Archive checksum mismatches | 0 |
| Active production Python files | 0 |
| TypeScript source files / LOC | 47 / 8,252 |
| Vitest tests / files | 60 / 8 |
| Frontend tests / files | 16 / 2 |
| Node installer tests | 7 |
| Symbol-level mappings | 22 |

## Precise port dispositions

The former blanket status has been removed. Every module now has one
of the required implementation states. `AELVO_IMPLEMENTATION_QUEUE.json`
contains 120 dependency-ordered entries (maximum wave 6).

| Disposition | Modules |
|---|---:|
| `INTENTIONALLY_REMOVED` | 267 |
| `PARTIALLY_PORTED` | 110 |
| `ENVIRONMENT_BLOCKED` | 3 |
| `NOT_STARTED` | 7 |
| `VERIFIED_PORT` | 1 |

The 267 removals are coding-agent specialists, obsolete providers, package
namespaces and other excluded behavior. The seven unstarted modules are named
individually in the queue; they are not blocked. The three environment blockers
are native sandbox modules that require a built Rust binary.

## Integrated in this pass

| Area | Implementation | Evidence |
|---|---|---|
| Execution graph | `src/runtime/execution/graph.ts`, `tool-graph.ts` | Topological scheduling, parallel waves, conditional edges, retry policies, contracts, serialization; coordinator executes policy-allowed multi-call batches through the graph |
| Graph production path | `src/runtime/coordinator/run-coordinator.ts` | Three-call graph batch performs real writes; dependency ordering, failure propagation and events are tested through `AelvoApplication` |
| Tool cache | `src/tools/executor/executor.ts` | TTL reads only, mutation invalidation; tested |
| Recovery savepoints | `src/runtime/recovery/checkpoints.ts`, `manager.ts` | SQLite persistence, SHA-256 state binding, restart restoration, tamper rejection; wired into task runs |
| Context compaction | `src/intelligence/context/context-builder.ts` | Deterministic character budget, oldest-message removal, persisted summary |
| Observability | `src/observability/metrics.ts` | Tagged metrics, percentiles, health checks, bounded retention; exposed by the app |
| Structured parser | `src/intelligence/parsing/model-output.ts` | Archived parser port; fenced/direct/embedded JSON, batched calls, lenient controls; wired as fallback and tested for real tool execution |
| Frontend protocol | `web/src/hooks/useWebSocket.ts`, chat/settings | Auth-first bridge handshake, `run.start`, typed event adaptation, approval resolution, honest offline failure; no simulated pipeline |
| Frontend build | `web/dist` | Vite production build succeeds; dev/preview origins allowed by the bridge |

## Verification performed

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | 60 passed / 8 files |
| `npm run test:install` | 7 passed |
| `web/npm run build` | exit 0 |
| `web/npx vitest run` | 16 passed / 2 files |
| `npm pack --dry-run` | 110 files, 935.0 kB, no archive entries |
| `git check-ignore archive/main.py` | ignored |

The bridge and frontend were verified at the protocol and build level. A browser
click-through against a live provider was not run.

## Remaining gates

| Gate | Status | Why |
|---|---|---|
| Complete source-driven port | **incomplete** | 110 partial, 7 not started, 1 verified |
| Graph integrated for all complex work | **partial** | Tool batches use the graph; durable plan execution still materializes tasks |
| Recovery depth | **partial** | Savepoints/restoration integrated; controlled recovery-node injection, replay validation and partial-execution reconciliation are unported |
| Live provider | **unverified** | No authorized Google API key on this host; deterministic fixtures used |
| Rust sandbox | **environment blocked** | `cargo`, `rustup`, `rustc` absent; no built binary; affected capabilities fail closed |
| Cross-platform credentials | **unverified** | Only Windows DPAPI exercised |
| Archive uncommitted-change preservation | **unverified** | Baseline Git-object reconstruction is checksum-clean; preservation of pre-deletion uncommitted Python edits cannot be independently proven from available checkpoints |

## Next queue work

1. Complete the seven `NOT_STARTED` general-purpose modules and the highest-value
   partial modules from `AELVO_IMPLEMENTATION_QUEUE.json`.
2. Wire durable plan execution through the graph and add producer/consumer
   dependency and cancellation tests.
3. Port recovery-node injection, replay validation and partial-execution
   reconciliation against `archive/runtime_next/recovery/`.
4. Deepen MCP trust/reconnect, planning preconditions/replanning, and memory
   ranking.
5. Verify a live Gemini turn and the Rust sandbox when credentials/toolchain are
   available.
