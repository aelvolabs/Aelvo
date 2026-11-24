# AELVO — Exhaustive Architecture Audit and Reduction Analysis

**Repository:** `https://github.com/aelvolabs/Aelvo`
**Revision audited:** `50af66544df0eed935ea4b0119303d7f78d26ce4` (`main`, 2026-11-10)
**Audit date:** 2026-11-24
**Audit type:** read-only architectural investigation. No production file, schema, dependency, configuration or Git state was modified by this audit.

---

## 0. How to read this report

Every material claim is tagged with its evidence class:

| Tag | Meaning |
|---|---|
| **[M]** | Measured by a script over the working tree (counts, LOC, import graph, test results). |
| **[E]** | Executed during this audit (CLI boot, isolated probe, pytest run). |
| **[S]** | Verified by reading the source path and line references cited. |
| **[I]** | Inferred from structure/patterns; not executed. |
| **[U]** | Unverified: environment or credentials prevented measurement. |

Static import reachability is **not** proof of execution. A module reachable by import may never be called; a module unreachable by import may be loaded dynamically. Both directions are called out explicitly where they matter.

**Deliverables produced by this audit**

- `AELVO_ARCHITECTURE_AUDIT.md` (this file)
- `AELVO_MODULE_INVENTORY.json` — 388 production Python modules + 58 non-Python source files
- `AELVO_DEPENDENCY_GRAPH.json` — 377 nodes / 1,077 static import edges
- `AELVO_REMOVAL_MANIFEST.md` — grouped removal candidates with prerequisites and risk
- `audit_artifacts/` — the read-only analysers and raw measurements used above

---

## 1. Executive summary

AELVO is a real, coherent, multi-layer Python agent platform — not a mock and not a README-only project. It boots, it registers 22 providers, it dispatches a tool set through a path jail (Rust when built, Python fallback otherwise), and it has 2,668 tests, of which 2,646 passed and 15 failed in this environment. It also contains several large subsystems that are **not on any production execution path**, and several architectural claims that the code does not support.

The most consequential findings for the future voice-first personal intelligence product are:

1. **The centre of gravity is a coding agent.** The prompt protocol, tool set, verification model, repository intelligence, task board, specialists, and even memory categories are built around "open a folder, edit code, run tests, report". The transferable personal-assistant value is a minority of the 107,599 production lines.
2. **The seven-specialist architecture is presentation, not execution.** In the default `high` mode, the "pipeline" makes **one** consolidated LLM call with all specialist prompts concatenated, then attributes the same output to every phase. There are no per-specialist model calls in that path. **[S]** `core/orchestration/pipeline.py:507-621`, `:1607-1647`.
3. **`max` mode is a simulation.** The task-board pipeline makes **no LLM call at all**; it creates tasks, publishes static "findings", and explicitly publishes `"Mode B — simulated execution (no real command)"`. **[S]** `core/orchestration/task_board_pipeline.py:65-274`, `:1133`.
4. **`medium` mode silently does not execute tools.** `_execute_direct_turn` never wires the tool executor; `NodeRunner.run_node` then returns a fabricated `{"status": "success"}`. This was reproduced: two LLM calls, node state `COMPLETED`, **no file written**. **[E]** probe output in §32; **[S]** `core/orchestration/orchestrator.py:161`, `:960-1034`, `:1573`; `runtime_next/engine/runner.py:20-31`.
5. **Large dead layers inflate the codebase.** 114 production modules are statically unreachable from every entry point, including:
   - all 22 `auth/providers/*` adapters and the entire `auth/auth/*` mode layer (zero importers),
   - the entire `core/security/*` platform (6 modules, ~4,000 LOC, zero importers),
   - 14 of 15 `learning/*` modules (`learning/engine.py`, knowledge graph, accumulator, confidence, analytics),
   - all 20 `mcp/integrations/*` modules.
6. **The "hardened sandbox" is not currently enforcing much.** The Rust binary is absent from this checkout, so every file/command operation takes the Python fallback, which runs commands with `shell=True`. The Rust policy allowlist itself contains `bash`, `sh`, `powershell`, `cmd`, `python`, `node`, `npm`, `sed`, `awk`, `find`, `curl`, so even a compiled sandbox cannot confine a command's filesystem access; it only filters the command string. The strongest component is the path jail (`fs_jail.rs`), which does canonicalise and reject symlink/hardlink escapes.
7. **The web bridge is an unauthenticated privileged RPC surface.** It exposes `user_message`, `fs_read`, `fs_list`, `fs_set_workspace`, `provider_save_key`, and `provider_remove_key` on a WebSocket with no token, origin check, or authorisation. It binds `127.0.0.1` by default but honours `AELVO_HOST`, so a user setting `0.0.0.0` exposes filesystem reads and provider-key writes to the network. **[S]** `web/web_bridge.py:505-575`, `web/server.py:96-190`.
8. **There is no voice, Gemini Live, Electron, wake-word, calendar, email, or multilingual code in the repository.** Google integration uses the deprecated `google-generativeai` SDK, not `@google/genai`. All of the future product's defining capabilities are new construction, not migration.
9. **The provider and memory layers are duplicated and over-built.** There are two provider catalogues (20 vs 22 providers) and two provider runtimes; health, metrics, events, retries and circuit breakers exist in at least two places. Memory is a SQLite + Chroma hybrid with decay/reconciliation and a lexical fallback, when a personal assistant needs durable facts, preferences, commitments and schedules.
10. **The current working tree is inconsistent.** An earlier, uncommitted TypeScript migration scaffold rewrote `package.json` (version `3.0.0`, `"type": "module"`, `bin` → `dist/cli/entry.js`) and added `tsconfig.json` / `vitest.config.ts` / `node_modules`, but there is **no `src/` and no `dist/`**. This breaks 3 existing npm-packaging tests (`3.0.0 != 2.4.5`; `require is not defined in ES module scope`). This audit preserves that work and treats it as an external, unfinished change (§2.4, §31).

**Bottom line.** The minimum coherent foundation for the future AELVO is roughly **20–26k lines of genuinely transferable Python-equivalent behaviour** (security path jail/audit/resource control, tool contracts, provider adapters + credential vault, event/graph primitives, session/context plumbing, user-preference memory, a subset of parsers and the tolerance-tested JSON/tool parser), plus the Rust sandbox concept, plus the React chat/files/settings shell. The remaining **~80k lines** are coding-specific, simulated, duplicated, or unreachable and should not be carried forward. A balanced transformation (Scenario B, §25) is the recommended path; the aggressive Scenario C is viable if schedule pressure outweighs continuity of behaviour.

---

## 2. Current repository state and revision

### 2.1 Git state at audit time

| Item | Value | Evidence |
|---|---|---|
| Branch | `main` | **[M]** |
| HEAD | `50af66544df0eed935ea4b0119303d7f78d26ce4` | **[M]** |
| Commit subject | `fix(npm): Mac permission denied + CRLF protection + version bump` | **[M]** |
| Commits in history | 66 | **[M]** |
| Tracked modifications | `bin/aelvo.js`, `bin/install.js`, `package.json`, `requirements-cli.txt` | **[M]** |
| Untracked | `AGENT_REPORT.md`, `requirements-dev.txt`, `tests/install/`, `tsconfig.json`, `vitest.config.ts`, `node_modules/` | **[M]** |

No commit, reset, checkout, delete or file edit of existing source was performed. All new files are analysis artifacts or the requested reports.

### 2.2 What the uncommitted changes are

- `bin/aelvo.js` + `bin/install.js` + `requirements-cli.txt` + `tests/install/` are a **prior, uncommitted npm-installer hardening effort** (Python interpreter discovery, pinned dependency set, lockfiles, install tests). They are not part of the TypeScript work and must not be discarded. `AGENT_REPORT.md` is a prior agent's findings report; its headline defect (medium-mode no-op) was independently reproduced here.
- `package.json` is now a **TypeScript migration manifest** written by an earlier session: version `3.0.0`, `"type": "module"`, `main: dist/main.js`, `bin` pointing at `dist/cli/entry.js`, dependencies for `@google/genai`, `openai`, `@anthropic-ai/sdk`, `zod`, `pino`, `ws`, and a `verify` script. There is no `src/` directory and no build output.
- `tsconfig.json` (strict NodeNext, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) and `vitest.config.ts` exist but compile nothing.
- `node_modules/` is installed (111 packages) but unused by any source.

### 2.3 Consequences currently observable

The existing packaging tests fail against the modified manifest:

```
tests/test_npm_packaging.py:25  AssertionError: assert '3.0.0' == '2.4.5'
tests/test_npm_packaging.py:86  ReferenceError: require is not defined in ES module scope
tests/test_npm_packaging.py:116 AssertionError: assert None == 'node bin/install.js'
```

Cause: the manifest declares `"type": "module"` while `bin/aelvo.js` and `bin/install.js` use CommonJS `require`, and the scripts no longer describe the Python launcher. **[E]**

**Audit position:** this work is preserved and explicitly excluded from the architectural judgement of the Python system. It is, however, a live blocker for any packaging/release decision until the independent architect either completes or reverts it.

### 2.4 Configuration and secrets

- `.env` exists and `.env.example` documents `LLM_PROVIDER`, `API_KEY`, `MODEL`, `AELVO_LLM_TIMEOUT`, `AELVO_LLM_MAX_RETRIES`, `AELVO_MAX_TOKENS`.
- The environment reports an OpenAI credential as present (`/list-providers` shows `openai ✓`). **No value was read, printed, or used.** No network request was made during this audit.
- Global state resolves through `AELVO_DATA_DIR` (`config/settings.py:17-31`); otherwise it writes into the package root. Credential vault default: `<data>/.aelvo_runtime/credential_vault.db` (`core/provider_runtime.py:55-61`).

---

## 3. Measured repository statistics

### 3.1 Methodology

- **Scope:** the working tree, excluding `.git`, `.venv`, `node_modules`, `__pycache__`, `backups`, `workspace`, `.aelvo_runtime`, `dist`, `target`, `.pytest_cache`.
- **Classification:** a Python file is a test if any path segment is `tests`/`test`, or its name starts `test_`, ends `_test.py`, or contains `.test.`.
- **LOC:** physical lines. **Effective LOC:** non-blank lines that do not begin with `#` (docstrings therefore count as code). Python only for effective-LOC tables.
- **Symbols:** Python `ast` class/function definitions (including nested), production files only.
- **Import graph:** `ast` `Import` / `ImportFrom` / literal `__import__`; relative imports resolved against the containing package; edges only when the target resolves to an existing project module. Dynamic registry patterns are *not* edges.
- **Reachability:** breadth-first over import edges from `main.py`, `cli/__main__.py`, `cli/app.py`, `web/server.py`, `cli/boot.py`.

### 3.2 Source volume by language

| Language | Files | Lines | Effective lines | Test files |
|---|---:|---:|---:|---:|
| Python (all) | 491 | 153,043 | 122,188 | 103 |
| Python (production) | 388 | 107,599 | 86,863 | 0 |
| Python (tests) | 103 | 45,444 | 35,325 | 103 |
| Rust | 9 | 5,777 | 4,326 | 0 |
| TypeScript React (`.tsx`) | 25 | 3,821 | 3,380 | 1 |
| TypeScript (`.ts`, incl. configs) | 9 | 792 | 700 | 0 |
| JavaScript (`.js`, incl. launchers/configs) | 15 | 2,748 | 2,483 | 6 |
| **Total code** | **549** | **166,181** | — | — |

**File totals (baseline):** 568 project files were indexed excluding ignored/vendored/build paths, of which **549 were code files** (491 Python, 9 Rust, 25 `.tsx`, 9 `.ts`, 15 `.js`) and 19 are configuration, workflow or documentation files. The often-quoted "118k lines" is **not** the production figure: production Python is **107,599 physical / 86,863 effective** lines. Tests add 45,444.

**Python production line breakdown (measured):** 107,599 physical = 15,641 blank + 5,095 comment-only + 86,863 non-blank non-comment. Docstrings are counted as code, so the true executable share is lower than 86,863.

### 3.3 Production volume by subsystem

| Subsystem | Prod files | Prod LOC | Prod effective | Test files | Test LOC |
|---|---:|---:|---:|---:|---:|
| `runtime_next/` | 73 | 21,155 | 17,142 | 27 | 8,917 |
| `core/` | 43 | 18,181 | 14,579 | 0 | 0 |
| `repo_intelligence/` | 24 | 12,914 | 10,222 | 0 | 0 |
| `auth/` | 68 | 11,087 | 9,179 | 10 | 1,276 |
| `mcp/` | 92 | 9,194 | 7,411 | 0 | 0 |
| `learning/` | 15 | 6,591 | 5,253 | 0 | 0 |
| `cognition/` | 18 | 6,574 | 5,425 | 2 | 876 |
| `specialists/` | 9 | 6,328 | 5,139 | 0 | 0 |
| `planning/` | 9 | 4,191 | 3,324 | 0 | 0 |
| `cli/` | 13 | 3,309 | 2,629 | 0 | 0 |
| `shared_task_board/` | 8 | 2,762 | 2,230 | 0 | 0 |
| `main.py` (root) | 1 | 1,796 | 1,466 | 0 | 0 |
| `tools/` | 6 | 1,349 | 1,077 | 0 | 0 |
| `web/` (Python) | 3 | 1,229 | 1,025 | 0 | 0 |
| `memory/` | 4 | 807 | 666 | 0 | 0 |
| `config/` | 2 | 132 | 96 | 0 | 0 |
| **Total** | **388** | **107,599** | **86,863** | **103** | **45,444** |

`runtime_next/` includes its own 27 test files; excluding them, its production footprint is 21,155 LOC, the largest in the repository.

### 3.4 Symbols, modules and dependency shape

| Metric | Value | Evidence |
|---|---:|---|
| Production Python modules | 388 | **[M]** |
| Production classes | 1,004 | **[M]** |
| Production functions/methods | 3,929 (async: 1,167) | **[M]** |
| Python test files / collected tests | 103 / 2,668 | **[M]** |
| Internal import graph nodes / edges | 377 / 1,077 | **[M]** |
| Entry points resolved in graph | 5 | **[M]** |
| Import cycles (SCC size > 1) | 2 | **[M]** |
| Statically unreachable production modules | 114 (29.4%) | **[M]** |
| Exact duplicate function bodies (≥8 statements) | 1 group | **[M]** |
| External third-party top-level imports | 27 | **[M]** |
| Largest module | `main.py` 1,796 LOC | **[M]** |
| Largest production subsystem | `runtime_next/` 21,155 LOC | **[M]** |

### 3.5 Dependency and duplication indicators

- 34 direct LLM invocation sites across production files (`chat.completions.create`, `messages.create`, `generate_content`).
- 62 `sqlite3.connect` sites; 39 `threading` uses; 24 `asyncio.create_task/gather` sites; 9 `subprocess` sites; exactly **1** `shell=True` in the Python production tree (`core/filesystem/automation.py:_py_execute`) — plus the Rust process launcher.
- 14 files reference `chromadb`; 31 references to `scrapy` (mostly optional/lazy); 6 to `websockets`.
- Only **one** exact duplicate function: `HermesContext._estimate_complexity` == `HermesSpecialist._estimate_complexity` (`cognition/hermes_context.py:234`, `specialists/hermes.py:440`). The duplication problem is **module-level**, not copy-paste: parallel provider, security, monitoring, event, retry and orchestration implementations (§17).

### 3.6 Test corpus

| Suite | Collected | Passed | Failed | Skipped | Errors |
|---|---:|---:|---:|---:|---:|
| `tests/` | 2,043 | 2,022 | 14 | 7 | 1 collection error |
| `auth/tests/` | 139 | 139 | 0 | 0 | 0 |
| `cognition/tests/` | 95 | 95 | 0 | 0 | 0 |
| `runtime_next/tests/` | 155 | 154 | 1 | 0 | 0 |
| `runtime_next/plan/tests/` | 236 | 236 | 0 | 0 | 0 |
| **Total** | **2,668** | **2,646** | **15** | **7** | **1** |

The 15 failures and 1 collection error below are environmental or caused by the uncommitted manifest change, not by a broken test expectation:

| Failure | Root cause |
|---|---|
| `test_web_bridge_providers.py` collection | `websockets` not installed in the audit venv |
| `test_forge.py` linter/formatter (2) | `ruff` / formatter binaries absent |
| `test_forge.py` memory roundtrip | Chroma embedding path unavailable (`Expected distinctive text in hits: []`) |
| `test_fs_python_fallback.py::test_python_exec` | `python` not on `PATH` (Windows Store stub), script not executed |
| `test_npm_packaging.py` (3) | Uncommitted `package.json` rewrite (§2.3) |
| `test_phase14_monitoring_integration.py` (2) | Monitoring health expectations against unavailable checks |
| `test_shutdown.py` | Capability state expectation (`'broken' != 'available'`) |
| `test_system_prompt_cache.py` (4) | Lazy `chromadb` / `scrapy` loaders absent |
| `runtime_next/tests/test_capability_registry.py::test_tool_detection` | Capability detection environment expectation |

**Interpretation:** the unit-test corpus is broad and mostly green, but it is heavily weighted to *components in isolation*. It does not catch the `medium`-mode no-op (the probe in §32 does), and it does not exercise the unauthenticated web surface or the simulated Mode B. Test count is not evidence of integrated product capability.

---

## 4. Actual current runtime architecture

### 4.1 There are three entry paths, not one

| Path | Trigger | Components built | Missing components |
|---|---|---|---|
| **Lean CLI** | `python -m cli` (`Aelvo`/`aelvo` on PATH via `bin/aelvo.js`) | kernel, jailed FS, memory, tool registry, provider runtime, agent, orchestrator, runtime status CLI | MCP (explicitly `mcp_cli=None`), cognitive engine, repo intelligence, long-horizon planning |
| **Full CLI mode** | `python main.py` with `AELVO_CLI=1` or `AELVO_ASK=...` | everything in `main_async`: repo intelligence, cognitive engine, LHP, MCP platform + discovery, then CLI REPL | — |
| **Web mode** | `python main.py --web` (or default `python main.py`) | same as full CLI, then aiohttp static server + WebSocket bridge | built frontend (absent unless `web/dist` exists) |

Evidence: **[S]** `cli/boot.py:22-219`; `main.py:1327-1668`; `web/server.py:96-190`; `cli/__main__.py`.

This split is important for the future product: the *lean* path — what most users actually get from npm — does not initialise the MCP platform, cognitive engine, repository intelligence or planning. Those four subsystems are therefore irrelevant to the default terminal experience and only exist in the web/full boot.

### 4.2 Startup sequence (full boot)

1. `load_dotenv` from the package `.env`; logging configured to a file with a quiet console (`main.py:20-40`, `:1686-1733`).
2. Resolve the opened folder: `AELVO_FOLDER` → `AELVO_PROJECT` → cwd. Scaffold `<folder>/.aelvo/{memory.db,anchor.md,backups}` (`main.py:171-228`).
3. Detect provider credentials from env then encrypted vault (`core/startup.py:detect_provider`).
4. Build `AelvoKernel` (SQLite audit/state/checkpoints) → `AelvoFileSystem` (jail) → `MemoryEngine` (SQLite + lazy Chroma) → tool registry (dict of closures) → `MemorySearcher` → extended tools (`main.py:1369-1395`).
5. Initialise `RepoIntelligenceEngine` and run `initialize(full_scan=False)` (`main.py:1402-1406`).
6. Initialise `CognitiveEngine` with repo intelligence, ForgeMemory, kernel, specialist registry (`main.py:1412-1421`).
7. Initialise `ProviderRuntime` (22 providers, credential vault, health/usage/fallback/diagnostics) and store any detected key (`main.py:1425-1459`).
8. Build `AelvoAgent` only if a provider config exists; otherwise `agent=None` (`main.py:1464-1485`).
9. Build `Orchestrator` (event bus, file mutex, capability registry, execution graph, recovery engine, verification pipeline, plan calibration, plan executor, two pipelines) (`main.py:1488-1495`; constructor at `core/orchestration/orchestrator.py:103-330`).
10. Attach `cognitive_engine`, wire blackboard to event bus, start long-horizon planning (`main.py:1497-1508`).
11. Build the MCP platform (13 components), run `discover_all()`, create `MCPCommandLineInterface` (`main.py:1510-1555`).
12. Create runtime status CLI; if `AELVO_CLI`/`AELVO_ASK`, enter REPL; otherwise start web server + WS bridge (`main.py:1560-1668`).

### 4.3 A representative request, by effort mode

Modes are persisted per folder in `.aelvo/mode` and can be changed with `/mode`.**[S]** `cli/modes.py`.

| Mode | Model calls | Tools | What actually happens |
|---|---|---|---|
| `low` | 1 | none | Direct `send_user_message_async` with a chat-only system prompt (no tool protocol). Returns raw text. (`orchestrator.py:960-1034`) |
| `medium` | 1 + up to 30 loop calls | **silently none** | Direct call with the full tool prompt, then `_execute_tool_loop`. The loop builds a `NodeDefinition` and calls `NodeRunner.run_node`; the runner's `_tool_executor` is `None` in this path, so it returns fabricated success. Reproduced in §32. |
| `high` (default) | **1** (+ tool-loop calls) | via tool loop | Builds a heuristic `HermesContext` (no model call), optionally asks the ARCHITECT heuristics for mode A/B, then `RuntimePipeline.run` builds **one consolidated prompt containing every active specialist prompt** and makes **one** LLM call. The same output is attributed to all phases; each specialist's `post_process` writes memory, and each `verify_output` runs text heuristics. (`pipeline.py:507-621`, `:1607-1647`) |
| `max` | **0** | none | Mode B task board: classifies the request by keyword, creates tasks, publishes static findings/implementation/security/execution entries to an in-memory blackboard, and returns an aggregated summary. Execution is explicitly simulated. (`task_board_pipeline.py:65-274`, `:1133`) |

Force-routes (`@FORGE fix this`) use a different graph path that *does* wire the tool executor and executes specialist nodes (`orchestrator.py:1090-1130`).

### 4.4 Background work at runtime

- `EventBus` task draining an `asyncio.Queue`, optionally appending JSONL to `<workspace>/runtime_events.log` (`runtime_next/events/bus.py`).
- `CapabilityRegistry.start_monitoring()` task.
- Provider health monitor with per-provider HTTP checks every 120s (`core/provider_runtime.py:start_monitoring`).
- LHP event subscription and session boundary persistence.
- Memory tool executor: `ThreadPoolExecutor(max_workers=4)` in `MemoryEngine` (`core/governance/kernel.py`).
- Shutdown is explicitly bounded (`main.py:259-320`) because these tasks previously hung process exit.

### 4.5 Persistence boundaries

| Store | Contents | Path |
|---|---|---|
| Per-folder SQLite | `state`, `episodes`, `sessions`, `semantic_memory`, `retained_memory`, `audit_trail`, checkpoints | `<folder>/.aelvo/memory.db` |
| Chroma (optional) | “vector memory” collections per project | `<folder>/.aelvo/chroma_db` |
| Global SQLite | project registry, user meta | `<data>/global_memory.db` |
| Credential vault | PBKDF2-encrypted credentials | `<data>/.aelvo_runtime/credential_vault.db` |
| Runtime events | JSONL event log | `<workspace>/runtime_events.log` |
| Plan calibration | JSON state | `<workspace>/.aelvo_runtime` |
| LLM cache | completion cache (2h TTL) | `<data>/llm_cache.db` |

### 4.6 Security enforcement points actually on the path

1. **Path jail** in `AelvoFileSystem._validate_path` → Rust `resolve_path` if binary exists, else Python mirror (`core/filesystem/automation.py`).
2. **Rust policy** for command strings (`sandbox_core/src/policy.rs`), if the binary is built.
3. **Web workspace containment** in `_resolve_fs_path` (`web/web_bridge.py:284-304`).
4. **Constraint/honesty checks** in the legacy `MemoryEngine.execute_turn` (`core/governance/kernel.py`), used only by the legacy path — not by the orchestrator tool loop.
5. **No approval gate** is on the production tool path: `core/security/approval_manager.py` and `execution_governance.py` are never imported.

---

## 5. Dependency analysis

Full machine-readable graph: `AELVO_DEPENDENCY_GRAPH.json` (377 nodes, 1,077 edges, per-edge line references).

### 5.1 Graph shape

- The graph is **layered but leaking**: `main.py` and `core/orchestration/*` sit in the middle and depend on nearly every domain package; `runtime_next/models/plan.py`, `auth/types.py` and `cognition/types.py` are the most reused leaf contracts (zero internal outgoing edges, high in-degree).
- Average out-degree is low (2.9 edges/module); a small number of hubs carry most coupling: `main.py` (35 internal targets across 68 import statements) and `core/orchestration/orchestrator.py` (36 internal targets, 54 imports).
- There are **2 strongly connected components**:
  1. `cli/app.py ↔ cli/commands.py ↔ cli/providers.py ↔ main.py ↔ web/server.py ↔ web/web_bridge.py` — the CLI, entry point and web layer form one 6-module cycle. This is a real layering defect: `main.py` imports `cli.app`, the CLI imports `main` lazily, and the web bridge imports the CLI provider helpers.
  2. `runtime_next/recovery/engine.py ↔ runtime_next/recovery/consensus_recovery.py` — recovery recursion.

### 5.2 Reachability: what is actually wired?

114 of 388 production modules (29.4%) are unreachable from every static entry point. By subsystem:

| Subsystem | Unreachable modules | Interpretation |
|---|---:|---|
| `mcp/` | 33 | All `mcp/integrations/*` (specialist/execution-graph/repo glue) and optional recovery/transport facets. Core MCP is wired only through `main.py`. |
| `auth/` | 40 | The entire `auth/providers/*` (22 adapters) and `auth/auth/*` (8 mode files), plus events, ratelimiter, circuit breaker, streaming. |
| `learning/` | 14 | Everything except `learning/agent_metrics.py`. |
| `runtime_next/` | 13 | `plan/builder.py`, `plan/intelligence.py`, `plan/allocator.py`, `verification/consistency.py`, `driven_recovery.py`, package `__init__`s. |
| `core/` | 8 | All six `core/security/*` modules plus `core/workers/python_worker.py` and `core/security/__init__.py`. |
| `shared_task_board/` | 5 | `models.py`, `context_schemas.py`, `result_schemas.py`, `collaboration_orchestrator.py`; only `board.py`/`task.py` are used (lazily) by Mode B. |
| `planning/` | 1 | Package `__init__.py`. |

**Caveats (important):**

- `runtime_next/plan/builder.py` and `verification/driven_recovery.py` are unreachable but are imported by **tests**, so they are “test-only”, not simply dead. They may be intended for future wiring.
- Two literal `__import__` sites exist (`cli/commands.py:429`, `cli/__main__.py:111`, plus `additional_verifiers.py:182/190`), but they import modules already in the graph through other edges; they do not explain the 114.
- `mcp/__init__.py` re-exports 13 subpackages, which is why some MCP modules are reachable even though the CLI never initialises MCP.

### 5.3 Blast radius (reverse reachability)

Selected removal-relevant counts (number of production modules that transitively import the target):

| Target | Dependents | Consequence |
|---|---:|---|
| `specialists/__init__.py` | 14+ | Orchestrator, pipeline, router, task board, workers, MCP specialist integrations, runtime capability registry. Specialists cannot be removed without touching orchestration. |
| `runtime_next/models/plan.py` | 20+ | Cognition planner/replan/engine, coordination, runtime capability/engine/verification, orchestrator. It is a genuine shared contract. |
| `cognition/types.py` | 20+ | Blackboard, memory, specialists, learning, MCP collaborations, planning. |
| `repo_intelligence/types.py` | 9 | `learning/*` and `repo_intelligence/*`; removing repo intelligence without extracting types breaks the (already dead) learning subsystem. |
| `core/governance/kernel.py` | 8 | `core.execution`, FS, memory searcher, orchestrator, web/CLI boot. It is the memory-and-state spine. |
| `core/filesystem/automation.py` | 6 | Tools, orchestrator FS, CLI, web, workers. |
| `learning/agent_metrics.py` | 2 | Orchestrator only — the sole live part of `learning/`. |
| `auth/adapters/*` | 2 | `main.py` and `core/provider_runtime.py` — the live provider normalisation. |
| `core/security/*` | 0 | Nothing imports it; removal is independent (except its own tests). |
| `auth/providers/*` | 0 | Nothing imports it; removal is independent (except `auth/tests`). |

Exact per-module dependents are in `AELVO_DEPENDENCY_GRAPH.json` (`blast_radius`) and per module in `AELVO_MODULE_INVENTORY.json` (`consumers`).

### 5.4 Coupling that will fight a TypeScript migration

- **Global mutable module state:** `main.py` exports mutable workspace globals (`WORKSPACE_PATH`, `DB_PATH`, `ANCHOR_PATH`, `BACKUP_DIR`, `_ws_name`) and mutates them on folder switch; `core/system_prompt.py` keeps a parallel copy with `configure_paths()`. In TypeScript this must become an injected `WorkspaceContext`.
- **Monkey-patching:** LHP replaces `orchestrator.build_shared_context` at runtime (`planning/integration.py:190-215`). This is not portable to a typed, frozen service graph and should not be carried forward.
- **Dict-based tool registry:** tools are untyped closures keyed by name with `(**kwargs)` swallowing unknown arguments (`main.py:build_tool_registry`). It has no schemas, so there is no validation boundary between model output and OS calls.
- **Stringly-typed events:** the web bridge serialises arbitrary event objects by introspecting `__dict__` (`web/web_bridge.py:928-1012`), so the frontend contract is not compile-time checked.
- **SQLite shared by unrelated concerns:** state, audit, sessions, memory, checkpoints and plan calibration all share `memory.db`, making isolated migration of one concern impossible without a data migration.

---

## 6. Complete subsystem inventory

| Subsystem | Production shape | Primary functionality | Runtime role | Disposition |
|---|---|---|---|---|
| `auth/` | 68 files, 11,087 LOC; adapters used, 22 provider adapters + 8 auth modes unused | Credential vault (PBKDF2 + SQLite), provider catalogue, message/tool-call/structured-output adapters, health/usage/fallback, diagnostics | Adapters and vault are live; most of the package is dead | **EXTRACT** the vault + adapters + types; **REMOVE** parallel provider/auth layers; **CONSOLIDATE** duplicate catalogue |
| `core/` | 43 files, 18,181 LOC | Kernel/governance, jail + tools, orchestration, RAG, scraping, security platform, workers | Kernel/FS/orchestration/RAG are live; security platform and workers are not | Mixed: **EXTRACT** tool semantics/governance; **REDESIGN** orchestration; **REMOVE** dead workers |
| `runtime_next/` | 73 files, 21,155 LOC (27 test files) | Plan/node/event models, sequential graph engine, recovery, verification, monitoring, governance, capability registry, architect brain | Event bus, engine, recovery, verification, capability registry are constructed by the orchestrator | **EXTRACT** models/events/engine/recovery ideas; **REDESIGN** verification; **OPTIONAL** architect brain |
| `repo_intelligence/` | 24 files, 12,914 LOC | Python AST + TS regex indexing, symbol/dependency/call graphs, architecture map, health/risk/drift, repository memory | Initialised at full boot; queried only through cognitive planner/architect paths | **OPTIONAL** with **EXTRACT** of scanner/parser/graph primitives |
| `mcp/` | 92 files, 9,194 LOC | Registry, trust levels, discovery, transports, capability negotiation, execution, governance, verification, recovery, specialist integrations | Only initialised in full/web boot; model cannot call MCP tools directly | **REPLACE** protocol/transport with official SDK; **EXTRACT** trust/governance/verification |
| `cognition/` | 18 files, 6,574 LOC | Blackboard, consensus, planner/replan, strategy memory, trust, HermesContext | HermesContext is live; blackboard/consensus used by simulated Mode B; rest mostly idle | **EXTRACT** coordination primitives; **REDESIGN** for personal tasks |
| `specialists/` | 9 files, 6,328 LOC | Seven prompt builders + keyword activation + verification heuristics + post-process memory | Consolidated into one prompt in `high`; graph nodes in forced routes | **CONSOLIDATE** into prompt fragments; **REMOVE** multi-agent framing |
| `learning/` | 15 files, 6,591 LOC | Graph-delta pattern extraction, knowledge graph, confidence, analytics, specialist effectiveness | Only `agent_metrics.py` is live | **REMOVE** except metrics |
| `planning/` | 9 files, 4,191 LOC | Goal hierarchy, milestones, multi-session continuity, self-critique, debt forecasting, LHP integration | Full boot only; attaches by monkey-patching shared context | **EXTRACT** continuity; **OPTIONAL** rest |
| `shared_task_board/` | 8 files, 2,762 LOC | Task model, state machine, in-memory board, collaboration orchestrator | Board/task used by simulated Mode B | **OPTIONAL**; **EXTRACT** state machine |
| `cli/` | 13 files, 3,309 LOC | Lean boot, REPL, slash commands, provider/model pickers, live model list, update check | Primary terminal interface | **REDESIGN** as optional developer CLI |
| `tools/` | 6 files, 1,349 LOC | Lint/format/typecheck/test/symbol, security scanning, diagrams, git, research helpers | Registered into the live tool dict | **OPTIONAL**; **EXTRACT** security/research helpers |
| `web/` | 3 Python files, 1,229 LOC + 25 TSX (3,821) + TS configs | aiohttp static server, unauthenticated WS bridge, React dashboard | Web boot; build output absent | **REPLACE** server/bridge; **REDESIGN** frontend for voice-first |
| `memory/` | 4 files, 807 LOC | User preference heuristics, typed Forge memory, memory types | User model live; Forge memory used by cognition | **EXTRACT** user model + conflict resolution; **REDESIGN** storage |
| `config/` | 2 files, 132 LOC | Thresholds, timeouts, importance weights, data-dir resolution | Live | **EXTRACT** constants |
| `main.py` | 1 file, 1,796 LOC | Universal LLM adapter, tool registry, boot orchestration, globals | Live entry point | **REDESIGN** |
| `sandbox_core/` | 9 Rust files, 5,777 LOC | Path jail, process wrapper, command policy, audit, checkpoints, resource governor, threat detection, workspace zones | Optional binary; absent in this checkout | **KEEP/REDESIGN** as native security foundation |

### 6.1 Per-module classification

Every production module has an entry in `AELVO_MODULE_INVENTORY.json` with: path, LOC, effective LOC, subsystem, declared docstring description, class/function counts, static reachability, in/out degree, direct dependencies, consumers, coding-specific score, personal-assistant relevance, recommended disposition, confidence, and rationale. Counts across all 446 entries: 142 EXTRACT, 78 REMOVE, 85 REDESIGN, 27 REPLACE, 20 CONSOLIDATE, 80 OPTIONAL, 12 INVESTIGATE, 2 KEEP. Python-only (388 modules): EXTRACT 138, OPTIONAL 74, REMOVE 71, REDESIGN 51, REPLACE 27, CONSOLIDATE 20, INVESTIGATE 7.

---

## 7. Functional maturity assessment

| Subsystem | Maturity | Evidence |
|---|---|---|
| CLI boot / provider selection | **4/5 — solid** | `python -m cli --version` boots in 0.78 s and prints platform/provider table **[E]**; `--list-providers` lists 22 providers with credential status **[E]**; one-shot run with no key fails cleanly, exit 0, scaffolds `.aelvo` **[E]** |
| Jailed file tools | **4/5 — solid, but jail bypassed by shell** | read/write/edit/list/grep/search/tree are implemented with size caps and path validation (`automation.py`); directory-read guard is good; traversal rejected. Commands are a separate, weaker path. |
| Tool loop | **2/5 — works only in `high`/forced paths** | `medium` silently no-ops (reproduced). `high` tool loop is the same loop, but the executor is wired by `pipeline.py` before it runs. `MAX_STEPS=30`, 3 consecutive failures (`orchestrator.py:1457-1464`). |
| Canonical pipeline | **2/5 — single-call prompt consolidation** | 1,756 LOC named as a 7-phase pipeline, but one LLM call and per-phase attribution of the same output. Verification is per-specialist text heuristics. |
| Mode B task board | **1/5 — simulation** | No LLM call; static findings; simulated execution string. |
| Execution graph engine | **2/5 — sequential, no cancellation** | Topological sort then a `for` loop; `parallel` flag unused; no `abort`/`cancel`; retries re-dispatch pending nodes; recovery hook exists. |
| Event bus | **3/5 — functional but in-process** | Queue + subscribers + JSONL replay; no backpressure, no persistence beyond the log, no cross-process bus. |
| Recovery | **3/5 — plausible, coding-taxonomy bound** | 812-line engine + specialist/task/consensus recovery; failure types are coding-oriented (`timeout`, `rate_limit`, `lock_contention`). |
| Verification | **2/5 — syntax checks marketed as verification** | `CodeVerifier` runs `ast.parse`; `TypeCheckVerifier` runs `py_compile`; graph/consistency/additional verifiers exist but are heuristic. |
| Repository intelligence | **3/5 — real but Python-centric** | Python AST parser + TypeScript regex parser + symbol/dependency/call graphs + architecture map; other languages are regex-only or unsupported. |
| Specialists | **2/5 — prompt templates** | No per-specialist model calls in `high`; keyword activation; `post_process` writes memory; verification is regex/structure checks. |
| Cognition / consensus | **2/5 — implemented, mostly unexercised** | Blackboard, extended consensus, planner, strategy memory are real classes with tests (95 pass), but only blackboard/consensus are touched, in simulated Mode B. |
| Planning (LHP) | **2/5 — attached, not in the turn** | Persists goal hierarchy and session boundaries, injects context via monkey-patch; `on_turn_complete` is not called by the lean CLI. |
| Memory | **3/5 — real hybrid, fragile retrieval** | SQLite system-of-record + Chroma vector + lexical fallback; decay, dedup, reinforcement; Chroma model download is an external dependency; retrieval test fails without it. |
| Learning | **1/5 — dead** | Only `AgentMetricsTracker` is wired; the pattern-extraction pipeline has no production caller. |
| Provider ecosystem | **3/5 — broad but duplicated** | 22 providers, three SDK families, retries/timeouts; two catalogues and two runtimes; `google-generativeai` is deprecated. |
| MCP | **2/5 — protocol exists, not integrated with the model** | Handshake (`initialize`, `tools/list`), `tools/call`, trust levels, governance; only reachable through `#mcp` CLI commands, not tool calling. |
| Security platform | **3/5 as code, 0/5 as integration** | Approval, governance, security memory, analytics are substantial; zero importers. |
| Rust sandbox | **3/5 path jail, 1/5 command confinement** | See §12; no binary in checkout; allowlist includes shells/interpreters. |
| Frontend | **2/5 — prototype dashboard** | 3.8k TSX, 7 pages, 1 component test; no build output; no auth; engineering-centric views. |
| Web bridge | **2/5 — functional but unsafe** | Works locally; unauthenticated privileged RPC; tight per-client timeouts; no schema validation. |
| Packaging | **1/5 currently** | npm installer is elaborate, but the modified manifest breaks existing tests and points at a non-existent `dist/`. |

---

## 8. Capability relevance assessment for the future product

Scale: 0 = irrelevant, 5 = essential. “Coding” and “Personal” are independent.

| Subsystem | Coding relevance | Personal-assistant relevance | Rationale |
|---|---:|---:|---|
| Tool execution contracts / jail | 5 | 5 | OS control requires a validated, jailed, auditable tool boundary — the hard part transfers. |
| Rust sandbox (path jail/audit/resource) | 5 | 5 | Core of safe autonomous OS access. |
| Security governance/approvals | 4 | 5 | Essential and currently unwired; must become mandatory. |
| Provider adapters + credential vault | 4 | 4 | Gemini-first, but multi-provider fallback and secure keys still matter. |
| Event bus / graph models | 4 | 4 | Background workflows and observable state need typed events and durable runs. |
| Session/context plumbing | 4 | 4 | Conversation state and resumability. |
| User preference memory | 2 | 5 | Directly needed for a personal assistant. |
| Verification/recovery | 5 | 3 | Personal tasks need outcome checks, not lint/typecheck. |
| Planning / goal hierarchy | 4 | 4 | Scheduling, reminders and multi-step errands need goals; language/domain must change. |
| Specialists (HERMES…HERALD) | 5 | 2 | Engineering role-play; only intent/risk heuristics transfer. |
| Repository intelligence | 5 | 1 | Only useful if coding remains an optional capability. |
| Learning (pattern extraction) | 5 | 0 | Engineering deltas; no personal value. |
| MCP protocol layer | 3 | 5 | Essential integration surface for personal tools. |
| MCP specialist integrations | 5 | 0 | Coding glue, unreachable. |
| CLI | 5 | 2 | Useful developer/debug interface, not the product. |
| Web dashboard | 4 | 4 | Chat/files/settings views reusable; agent/task/knowledge views need replacement. |
| Task board (Mode B) | 4 | 2 | Simulated today; the state machine concept is reusable, the implementation is not. |

---

## 9. Coding-specific architecture assessment

The following are not incidental features — they are structural assumptions embedded across the codebase:

1. **The system prompt is a coding-agent tool protocol.** `core/system_prompt.py` defines FORMAT 1 (JSON tool array with `rationale`), FORMAT 2 (`#lock`/`#checkpoint` kernel commands), FORMAT 3 (`respond`), plus a “CODEBASE QUESTIONS” protocol. There is no conversational, scheduling, OS-control, or voice protocol.
2. **The workspace is the unit of everything.** All memory, anchors, checkpoints, events, plan calibration and even the default DB path are scoped to an opened folder (`.aelvo/`). A personal assistant needs a user-scoped, cross-device model.
3. **Tools are developer tools.** 15 of the registered tools are file/code/git/lint/test operations; the only non-coding tools are `search_memory`, `save_constraint`, and optional scraping.
4. **Verification means code verification.** Lint/typecheck/graph-consistency/unit-test verification types dominate; there is no notion of “did the reminder get scheduled”, “was the email sent”, or “does the calendar match intent”.
5. **Failure taxonomy is engineering failure.** Retryable failures are `timeout`, `rate_limit`, `lock_contention`; recovery strategies are replan/rollback/isolate for code changes.
6. **Role vocabulary is engineering.** HERMES (intent), ARCHITECT (plan), ORACLE (research), FORGE (code), SENTINEL (security), TERMINUS (deploy), HERALD (report). Even the “consensus” participants debate implementation choices.
7. **Memory categories are engineering.** `CODE_PATTERN`, `ERROR_RECOVERY`, `DEVOPS_PATTERN`, `ARCHITECTURE_MAP`, `CONVENTION`, `CI_KNOWLEDGE`, `REVIEW_PATTERN` — 7 of 17 categories are code-specific.
8. **Repository intelligence is 12,914 LOC** of symbol/call/architecture/refactor/drift analysis, with no equivalent for personal knowledge.
9. **The dashboard is an engineering control room**: agents, task board, knowledge explorer, verification/recovery/consensus state, git-style file browser.
10. **The installer bootstraps Python**, pinned Python packages and Python venvs — irrelevant to the target runtime and actively harmful to startup time.

---

## 10. Reusable general-purpose infrastructure

These are the assets with genuine transfer value, ranked by value per line:

| Asset | Path | Why it transfers | Extraction shape |
|---|---|---|---|
| Path jail with symlink/hardlink handling | `sandbox_core/src/fs_jail.rs` | Canonicalises root, resolves links, rejects escapes; the single most security-critical reusable component | Keep as Rust library/process; add tests for junction points and TOCTOU |
| Structured audit log | `sandbox_core/src/audit.rs` | Security event schema + append-only workspace audit | Keep, extend to user/device scope |
| Resource governor | `sandbox_core/src/resource.rs` | CPU/memory/process/handle limits around child processes | Keep; enforce cross-platform |
| Threat classification | `sandbox_core/src/threat_detection.rs` | Severity-scored command findings | Extract patterns into a policy service |
| Encrypted credential vault | `auth/cred_storage.py`, `auth/types.py` | PBKDF2-encrypted SQLite store with metadata; avoids plaintext keys | Port to a dedicated secrets service (OS keychain preferred) |
| Provider normalisation adapters | `auth/adapters/*` | Canonical message/tool/structured-output conversion across providers | Port as typed adapters; replace SDK-specific calls with official TS SDKs |
| Curated provider catalogue | `core/registry/models.py`, `auth/config.py` | Real base URLs, models, context windows, cost tiers | Consolidate into one typed catalogue |
| Tolerant tool-call parser | `core/orchestration/parser.py` | Handles code fences, arrays, raw JSON, salvage extraction | Port with Zod validation at the boundary |
| Streaming prose/tool-JSON filter | `core/orchestration/stream_filter.py` | Hides protocol JSON from streamed prose | Port; simplify with a typed stream event model |
| Session summarisation | `core/orchestration/session_manager.py` | Cadence-based compaction | Port with token budgeting |
| User preference heuristics | `memory/user_model.py` | Formality/verbosity/format/frustration signals from conversation | Port and replace with explicit, editable preferences |
| Typed event bus | `runtime_next/events/bus.py`, `models/events.py` | Async pub/sub with JSONL replay | Port to a durable queue if background work must survive restarts |
| Plan/node/edge models | `runtime_next/models/plan.py` | Edge conditions, retry policies, output contracts, critical path | Port as shared contracts; add cancellation/parallelism |
| Recovery taxonomy | `runtime_next/recovery/*` | Failure classification → recovery action selection | Redesign for personal-task failure modes |
| MCP trust model | `mcp/registry/trust_manager.py` | 5-level trust with human acknowledgement gates | Port as the third-party integration trust layer |
| MCP verification checks | `mcp/verification/*` | Schema/size/timeout/content-safety for untrusted tool output | Port alongside a prompt-injection boundary |
| React chat/files/settings views | `web/src/components/ChatWorkspace.tsx`, `pages/FilesPage.tsx`, `pages/ProvidersPage.tsx` | Interaction patterns and layout | Redesign visually, keep the component decomposition |
| Tool registry metadata | `core/execution/tool_registry.py` | Specs, timeouts, retry policy, caching, categories | Port and make it the *only* tool dispatch path |
| Approval manager (unwired) | `core/security/approval_manager.py` | Approval lifecycle, escalation paths, expiry | Port into the mandatory security gate |
| Security memory/analytics (unwired) | `core/security/security_memory.py`, `security_analytics.py` | Violation history, posture scoring, recommendations | Port as governance telemetry |

---

## 11. Individual specialist assessments

Common facts that apply to all seven:

- Every specialist extends `BaseSpecialist` (`specialists/base.py`), which requires `get_system_prompt`, `post_process`, `build_memory_context`, `verify_output`, and offers a default `execute()` that builds a prompt and makes **one** `agent.send_user_message_async` call. **[S]**
- In the default `high` mode that `execute()` is **never called per specialist**. `RuntimePipeline.run` builds one consolidated prompt from each specialist's `get_system_prompt()` and makes a single call; the output is copied into every phase result. **[S]** `pipeline.py:553-621`.
- `post_process` runs after that single output and writes memory heuristically. `verify_output` runs text/regex checks.
- In Mode B, none of the specialists' prompts or LLMs are used; only their blackboard helper methods (`pickup_task`, `publish_finding`, `submit_for_review`, …) are called, with static content. **[S]** `task_board_pipeline.py:433-560`.

| Specialist | LOC | Actual implementation | Runtime role | Assessment | Disposition |
|---|---:|---|---|---|---|
| **HERMES** | 771 | `create_hermes_context` builds intent, goals, constraints, risk, complexity, permissions from keyword/regex heuristics and the user model; response calibration strips preambles/hedges, trims word budget, hoists code. **[S]** `hermes.py:325-645` | Produces the immutable HermesContext consumed by orchestration; also calibrates responses | Genuinely useful compact heuristics, but engineering-flavoured (permissions from “read/write” verbs) | **EXTRACT** heuristics + user model; drop the agent framing |
| **ARCHITECT** | 1,137 | 14-section plan prompt, mode selection (`select_execution_mode`), decision records, consensus review, `apply_decision`; plan object comes from `runtime_next/plan`. **[S]** | Mode A/B selection; plan generation in forced/plan paths | Large prompt surface; mode selection is heuristic; planning duplicates `runtime_next/plan` | **CONSOLIDATE** mode gating into a small policy; **OPTIONAL** plans |
| **ORACLE** | 556 | Research prompt; blackboard `pickup_task` / `publish_finding` / question answering; post-process extracts scrape events into research memory. **[S]** | Research phase; findings on blackboard | No actual web research in the specialist; relies on tools/history | **EXTRACT** research workflow idea; **REMOVE** coding research prompt |
| **FORGE** | 1,049 | Coding prompt; pattern extraction from edits; review submission; parses tool calls from history; language/project detection. **[S]** | Implementation phase | Most coding-specific component after repo intelligence | **REMOVE** (optional coding capability if retained later) |
| **SENTINEL** | 747 | Security prompt; approve/reject implementation, escalate to architect, challenge low confidence, review findings. **[S]** | Security gate in Mode B | The approval *semantics* are useful, but this duplicates the far more capable dead `core/security/approval_manager.py` | **EXTRACT** gate idea; prefer `core/security` platform |
| **TERMINUS** | 726 | Execution prompt; command sequence planning; architect gate; publishes execution results/failure reports. **[S]** | Execution phase | Gate concept is useful; execution in Mode B is simulated | **EXTRACT** gate; **REMOVE** rest |
| **HERALD** | 1,129 | Communication classification, draft variants, report/consensus/recovery summaries. **[S]** | Reporting phase; session summaries | Templating and summary structure are reusable for a personal assistant's daily brief | **EXTRACT** summary/report templates; **REMOVE** engineering report prose |

**Verification reality:** specialist `verify_output` methods check, for example, empty output, Mermaid syntax, tool-call ordering, secret regexes, destructive-command regexes, and communication structure (`pipeline.py:_verify_phase_output_sync`). These are text heuristics, not execution verification. A response can pass every specialist check while the claimed tool never ran — exactly the `medium`-mode failure in §32.

**Duplication:** `_estimate_complexity` is byte-for-byte identical in `cognition/hermes_context.py:234` and `specialists/hermes.py:440`.

---

## 12. Security and sandbox assessment

### 12.1 What is actually enforced on the production path

| Control | Status | Evidence |
|---|---|---|
| Workspace path containment for file tools | **Enforced** | `_validate_path_python` rejects `..`, encoded traversal, null bytes and resolves symlinks before containment (`automation.py`); Rust jail canonicalises and checks inode/hardlink properties (`fs_jail.rs:195-443`) |
| Command allowlist | **Partially enforced, bypassable** | Rust policy filters the base command and regexes (`policy.rs:38-99`), but the allowlist includes `bash`, `sh`, `zsh`-piped, `powershell`, `cmd`, `python`, `node`, `npm`, `sed`, `awk`, `find`, `curl` |
| Command filesystem confinement | **Not enforced** | No chroot/namespace/job object; a child process can read/write any path the user can |
| Python fallback command policy | **Weak** | `subprocess.run(command, shell=True, ...)` with the same allowlist and regexes (`automation.py:_py_execute`) |
| Approval gate for risky tools | **Absent** | `core/security/*` is never imported (0 production importers) |
| Model-independent policy decisions | **Partial** | Static allowlist/regex only; no capability policy bound to tool identity |
| Unauthenticated local RPC | **Present** | WS `fs_read`/`fs_set_workspace`/`provider_save_key` with no token (`web_bridge.py:505-575`) |
| Audit trail | **Partial** | SQLite `audit_trail` + `episodes`; Rust append-only audit only when the binary exists; not tamper-evident |
| Credential encryption | **Present but machine-bound** | Fernet + PBKDF2 over machine ID and optional passphrase (`cred_storage.py:42-115`); any process as the same user can derive it |
| Prompt-injection boundary | **Absent** | Tool results and web content are injected into the conversation verbatim (`AelvoAgent.feed_result`) |

### 12.2 Security findings (ordered by consequence for an autonomous personal assistant)

**SEC-1 (Critical) — Command execution is not confined.**
Even the Rust sandbox permits `bash`, `sh`, `powershell`, `cmd`, `python`, `node`, `npm`, `sed`, `awk`, `find`, `curl` (policy.rs allowlist, lines 38-69). `bash -c 'cat ~/.ssh/id_rsa'` passes the base-name check, contains none of the blocked regexes, and runs with the user's full filesystem rights. The jail applies to file *tool actions*, not to child processes. This invalidates any claim that the sandbox provides OS-level confinement for autonomous operation.

**SEC-2 (Critical) — The Python fallback uses `shell=True`.**
When the Rust binary is absent — which is the case in this checkout (`sandbox_core/target` absent) — `_py_execute` runs `subprocess.run(command, shell=True, cwd=base_path)` after a base-name allowlist and regex checks (`automation.py`). Shell metacharacters not covered by the eight injection regexes are executable; allowlisted interpreters make arbitrary code execution trivial. On Linux/macOS, the launcher also cannot find the binary because `_sandbox_binary_path()` hardcodes `sandbox_core.exe`, so the fallback is the *default*, not an edge case.

**SEC-3 (High) — Unauthenticated privileged WebSocket.**
`WebBridge` accepts any client and handles `user_message` (agent turn), `fs_read`/`fs_list` (read any file under the workspace root, including `.env` if the user opened the repo), `fs_set_workspace` (re-root the agent), and `provider_save_key`/`provider_remove_key` (mutate credentials). There is no token, no origin allowlist, no message schema validation, and no per-action authorisation (`web_bridge.py:505-575`, `:775-925`). The server binds `127.0.0.1` by default but honours `AELVO_HOST`, so a single environment change exposes it to the LAN. Browsers can also reach localhost sockets; without an Origin check this is a DNS-rebinding/CSRF target.

**SEC-4 (High) — No approval gate, no privilege model.**
The 4,000-line `core/security/` platform (approval manager, execution governance, sandbox policy, security memory, analytics, orchestrator) has zero production importers. Every tool call goes straight from parsed model output to execution (`_graph_tool_executor`, `orchestrator.py:930-959`). The only invariant is a `rationale` string the model writes itself — i.e. the model approves its own actions.

**SEC-5 (High) — Untrusted content is not delimited.**
Tool results, scraped pages and MCP responses are formatted into chat messages and fed back to the model (`AelvoAgent.feed_result`; `mcp/execution/execution_engine.py`). There is no provenance marking, no instruction/content separation, and no policy on “content that tries to give orders”. For a personal assistant with email, web and file access this is the primary exfiltration vector.

**SEC-6 (Medium) — Credentials are recoverable by any process as the user.**
The vault derives its encryption key from a machine ID plus an optional passphrase. This protects against casual file copying, not against local malware running as the same user. There is no OS keychain integration (DPAPI/Keychain/libsecret).

**SEC-7 (Medium) — Audit is not tamper-evident and is split.**
SQLite `audit_trail`/`episodes` are mutable by any code with DB access; Rust audit writes JSONL only when the binary is used; security events do not flow to a single append-only log. For “high autonomy” this is insufficient.

**SEC-8 (Medium) — Retry can repeat side effects.**
The tool loop retries failed tools through the node runner without an idempotency key, and `bash_exec`/`write_file`/`edit_file` have side effects. The structured `RetryPolicy` in `runtime_next/models/plan.py` is not applied by the live loop.

**SEC-9 (Medium) — Workspace checkpoints are write-only optimism.**
`checkpoint.rs` snapshots before writes, but no production code restores a checkpoint on a bad edit; the `#restore` kernel command is manual.

### 12.3 Rust sandbox capability assessment

The sandbox is a **one-shot process** that reads a JSON request from stdin, runs one action, and writes one JSON response. It is 5,777 LOC across nine modules.

| Module | LOC | What it genuinely provides | Limitations |
|---|---:|---|---|
| `fs_jail.rs` | 1,340 | Canonicalised workspace root; symlink resolution; inode/hardlink checks; rejects escaping paths; Windows `\\?\` normalisation | No TOCTOU protection between check and use; path checks do not constrain child processes |
| `policy.rs` | 484 | Allowlist, blocked patterns, injection regexes, path-operation policy | Allowlist includes shells/interpreters; content regexes are bypassable by quoting/encoding |
| `process.rs` | 431 | `bash_exec` with timeout (cap 300 s), 10 MB output cap, process-tree kill, resource governor wiring | Commands are not confined; cwd only |
| `resource.rs` | 476 | CPU/memory/process/handle limits (platform-specific) | Enforced per child, not a security boundary; Windows/Linux behaviour differs |
| `threat_detection.rs` | 676 | Severity-scored threat patterns, blocks critical findings | Pattern-based; false negatives expected |
| `audit.rs` | 475 | Structured security/policy events | Not coupled to the Python audit store; no remote/signed log |
| `checkpoint.rs` | 712 | Workspace snapshots before writes | No automatic rollback; workspace-only scope |
| `workspace_intelligence.rs` | 833 | Deny lists, protected files, read/write zones | Coding-workspace assumptions (source extensions, ignored dirs) |
| `main.rs` | 350 | JSON request/response pipeline, policy → threat → workspace → handler → audit | One action per process spawn; no long-lived session |

**Verdict:** the path jail, audit schema, resource governor and checkpoint code are worth keeping and hardening. The command policy is **not** a confinement mechanism and must not be presented as one. A future personal assistant needs an explicit capability model (which apps, which folders, which network hosts, which accounts), an approval gate for irreversible actions, and OS-level sandboxing (AppContainer/Job Objects on Windows, sandbox-exec/namespaces on macOS/Linux) where available — none of which exist today.

### 12.4 Security bottom line

- **Safe to reuse:** path canonicalisation/containment, structured audit schema, resource limits, threat-taxonomy ideas, trust-level model, verification-of-untrusted-output checks.
- **Must be redesigned:** command execution, approvals, credential storage (OS keychain), network policy, prompt-injection boundary, web RPC authentication, audit integrity.
- **Must not be claimed:** “secure sandbox”, “LLM cannot approve its own actions”, “workspace isolation for commands”. The code does not currently support those claims.

---

## 13. Memory and learning assessment

### 13.1 What exists

**`MemoryEngine` (`core/governance/kernel.py`) is the memory spine.** It creates six SQLite tables (`state`, `episodes`, `sessions`, `semantic_memory`, `retained_memory`, `metadata`) plus triggers, and uses Chroma as a *second* store (`chroma_db` under the folder state). It implements:

- **Write paths:** `retained_memory` on `respond` with `retain_memory`; `save_constraint`; specialist `post_process`; session summaries; mission-log digests every 50 episodes.
- **Retrieval:** `MemorySearcher` over the Chroma collection, with a lexical set-overlap fallback when Chroma is unavailable (`LocalMemoryCollection`), plus a hybrid lexical/dense retriever in `core/rag/rag.py`.
- **Lifecycle:** importance decay (0.98/turn in `decay_memory`), reinforcement on use (+0.05 importance, +1 usage), dedup/override thresholds (0.95/0.85), and a reconciliation pass between SQLite and Chroma.
- **Governance:** anchor constraints with a hash guard that raises “Anchor changed. Manual state resync required”; honesty checking of tool output against locked constraints; a 3-failure circuit breaker; audit episodes with truncated logs.

**User model (`memory/user_model.py`)** extracts formality, verbosity, workflow mode, response-format and recommendation preferences, expertise domains, and frustration signals from the last N messages, then writes them as `user_preference` memory entries. It is heuristic and deterministic, not learned.

**Typed memory (`memory/forge_memory.py`)** provides query/write by memory type, conflict resolution, and specialist-specific categories.

### 13.2 What is not real learning

`learning/` is 6,591 LOC of “pattern extraction”: dependency-graph deltas → edit classification → subgraph extraction → accumulation → knowledge graph. It is engineering-specific (it needs `repo_intelligence` graph snapshots) and **has no production caller**. The only live piece is `learning/agent_metrics.py`, a per-specialist event counter used by the dashboard. There are no model weights, no training loop, no gradient updates; calling this “learning” would be inaccurate.

### 13.3 Fitness for a personal assistant

The storage mechanics are real; the **domain schema is wrong**. A personal assistant needs:

- durable **entities** (people, places, accounts, projects) with aliases and relationships;
- **facts** with provenance, confidence and validity windows (not “importance 0.6”);
- **commitments/reminders/tasks** with due dates, recurrence and status;
- **preferences** that are explicit, editable and auditable (not inferred only);
- **conversation/episode history** with retention policy and redaction;
- **cross-session, cross-device** scope — today everything is scoped to the opened folder, which is meaningless for a personal assistant;
- encryption at rest, export/delete, and a migration path.

Chroma is an avoidable operational dependency for this scale: it downloads an embedding model on first use, adds ~2.5 s of import time (explicitly deferred in the code), and fails the repository's own retrieval test when unavailable. SQLite with FTS5 plus optional embeddings is sufficient and far more robust.

**Verdict:** **EXTRACT** the user-preference heuristics, conflict-resolution logic and retention/decay ideas; **REDESIGN** storage around a personal schema in SQLite. Do not port Chroma or the folder-scoped memory model.

---

## 14. MCP assessment

**Scope:** 92 files / 9,194 LOC, organised as registry, client, discovery, capability, execution, governance, verification, recovery, memory, transport, events, and coding-specialist integrations.

### 14.1 Protocol completeness (as implemented)

| MCP capability | Implemented? | Evidence |
|---|---|---|
| JSON-RPC 2.0 message envelope | Yes | `mcp/transport/base_transport.py:22` |
| `initialize` handshake + `notifications/initialized` | Yes | `mcp/client/capability_negotiator.py:56-95` |
| Protocol version negotiation | Yes (`2025-03-26` default) | `capability_negotiator.py:61` |
| `tools/list` discovery | Yes | `capability_negotiator.py:205` |
| `tools/call` execution | Yes | `mcp/execution/execution_engine.py:166` |
| Resources / prompts / templates | Data models + catalogues present | `mcp/registry/models.py:40-88`, `mcp/capability/*` |
| Transports | stdio subprocess, HTTP, WebSocket | `mcp/transport/*` |
| Reconnection / failover / isolation | Yes | `mcp/recovery/*` |
| Trust levels (trusted/verified/sandboxed/quarantined/blocked) | Yes | `mcp/registry/trust_manager.py:21-135` |
| Governance (allowlist, permission model, restriction, audit) | Yes | `mcp/governance/*` |
| Verification (schema/size/timeout/content safety/trust) | Yes | `mcp/verification/*` |
| Host-side server registry persistence | Yes | `mcp/registry/registry_store.py` |

This is a genuine protocol implementation, not a stub.

### 14.2 The integration gap

The MCP platform is **not connected to the model's tool loop**. `main.py` constructs it and runs `discover_all()`, but the only way to use it is the `#mcp` kernel command handled in `_execute_tool_loop` (`orchestrator.py:1430-1440`). The lean CLI passes `mcp_cli=None` (`cli/boot.py:210`), so MCP is absent from the default terminal experience. Discovered MCP tools are never injected into the tool registry the model sees, and MCP resources/prompts are never used in context construction. **[S]**

Additionally, all 20 `mcp/integrations/*` modules (specialist collaboration, execution-graph nodes, repo lens, planning resource) are statically unreachable. They represent a substantial investment with no runtime effect.

### 14.3 Replacement analysis

| Component | Recommendation | Reason |
|---|---|---|
| Transports, JSON-RPC framing, handshake, session lifecycle | **REPLACE** with the official TypeScript MCP SDK | Maintained protocol compliance, transport security, versioning; hand-rolled transports are a maintenance liability |
| Server registry + discovery | **REPLACE/EXTRACT** | SDK covers servers; keep discovery UX and config import |
| Capability catalogues | **REPLACE** | Duplicate what the SDK returns |
| Trust manager | **EXTRACT** | Five-level trust + human acknowledgement is a genuine policy asset |
| Governance (allowlist/permission/restriction/audit) | **EXTRACT** | Directly reusable for third-party tool permissions |
| Verification pipeline | **EXTRACT** | Useful for untrusted tool output; pair with prompt-injection boundary |
| Recovery/failover | **OPTIONAL** | Largely subsumed by SDK + bounded retry |
| `mcp/integrations/*` | **REMOVE** | Coding-specific, unreachable |

**Estimated reduction:** ~9.2k LOC → roughly **1.5–2.5k LOC** of policy/trust/verification on top of the official SDK, plus configuration. Losses: bespoke recovery orchestration and the existing registry data format (migratable). The official SDK is a **new dependency** but removes a large protocol-maintenance surface; it is well justified.

---

## 15. Provider architecture assessment

### 15.1 Two catalogues, two runtimes

| Layer | Contents | Used? |
|---|---|---|
| `core/registry/models.py` | 22 providers, curated models, abilities, context windows, cost tiers, pricing-derived enrichment | Yes — CLI, boot, agent config |
| `auth/config.py` | 20 providers (overlapping, different defaults/pricing) | Yes — `core/provider_runtime` builds the registry from it |
| `auth/providers/*` | 22 per-provider adapter classes | **No — zero importers** |
| `auth/auth/*` | API-key/oauth/browser/cloud/local/refresh/session modes | **No — zero importers** (boto3/azure/vertex code lives only here) |
| `auth/runtime/*` | Registry, health, usage, fallback, diagnostics, model registry, capability | Partly — constructed by `provider_runtime` |
| `auth/adapters/*` | Message/tool/structured/streaming/multimodal normalisation | Yes — used by `AelvoAgent` and `provider_runtime` |

Consequences: provider metadata can disagree between the two catalogues; the CLI advertises 22 providers while `auth/config` has 20; two different notion of “provider health” exist (`auth/runtime/health.py` and `auth/monitoring/health.py`).

### 15.2 What actually works

- **OpenAI-compatible path** (`SDKType.OPENAI`): a single `openai.OpenAI` client with optional `base_url`. This genuinely covers OpenAI, Groq, Mistral, Cohere (compat endpoint), DeepSeek, Moonshot, NVIDIA, Together, OpenRouter, xAI, Fireworks, Perplexity, Hugging Face (inference API compatibility varies), and the four local runtimes (Ollama, LM Studio, vLLM, llama.cpp). **[S]** `main.py:_call_llm`.
- **Anthropic path**: native `Anthropic` client, streaming via `messages.stream`. **[S]**
- **Google path**: deprecated `google.generativeai` (`GenerativeModel.generate_content`) — not `@google/genai`. **[S]** `main.py`.
- **Azure OpenAI**: catalogued as OpenAI SDK with **no `base_url` and no deployment mapping**, so a client cannot target an Azure resource as configured. **[I]** from `core/registry/models.py:591-615` + `main.py` client construction.
- **AWS Bedrock / Vertex**: catalogued with the OpenAI SDK and no native clients; the only `boto3`/`vertexai` code is in the unreachable `auth/auth/cloud.py`. They cannot work as wired. **[S]**
- **Model identifiers are partly speculative** (`claude-sonnet-5`, `claude-opus-5`, `gemini-3.1-pro-preview`, `gpt-oss-120b`). Some may never exist or may have been renamed. **[U]** — no live provider verification was performed (only a credential is present; no request was made). The product must discover models or fail clearly, not assume IDs.

### 15.3 Fitness for a Gemini-first personal assistant

- The adapters are worth keeping: canonical-message conversion, tool-call normalisation, structured-output validation, streaming chunk normalisation.
- The 22-provider sprawl is not. A Gemini-first product needs **one first-class Gemini path** (`@google/genai`, including future Live API), **one optional OpenAI-compatible path** (covers most alternatives and all local runtimes), and **optionally Anthropic**. That is 3 adapters, not 22.
- The health/usage/fallback layer is in-memory and dashboard-oriented; for a personal assistant, latency/fallback matters but can be implemented in ~200 lines around the provider call, with durable metrics only if needed.
- The credential vault is reusable but should move to the OS keychain.

**Verdict:** **REPLACE** the runtime bootstrap and per-provider files; **EXTRACT** the adapters, catalogue data (after verification) and vault; **REMOVE** Azure/Bedrock/Vertex catalog entries until a real native implementation exists.

---

## 16. Frontend reuse assessment

**Scale:** 25 `.tsx` files / 3,821 LOC, 9 `.ts` files / 792 LOC, Vite + React 19 + Tailwind. One component test (`AgentDashboard.test.tsx`, 168 LOC). `web/dist` is **absent**; `web/node_modules` is absent, so the dashboard cannot be served from a clean checkout. **[E]**

### 16.1 Communication contract

The frontend consumes a JSON event envelope `{type, source, specialist, action, data, timestamp, icon, color}` (`web/src/types.ts`) and sends `user_message`, `providers_list`, `provider_save_key`, `provider_remove_key`, `fs_list`, `fs_read`, `fs_workspace`, `fs_set_workspace`, `agent_metrics`, `ping` (`web_bridge.py:536-566`). The backend converts runtime events to this envelope by introspecting attributes (`:928-1012`). **There is no shared schema**; it is stringly typed on both sides.

### 16.2 View-by-view reuse

| View / component | LOC | Value for voice-first assistant | Disposition |
|---|---:|---|---|
| `ChatWorkspace` + `ChatMessage` | 596 | Conversation surface, streaming placeholder, agent steps | **KEEP concept, REDESIGN** (voice-first, multilingual, timeline) |
| `FilesPage` | 412 | Folder browser with path containment | **KEEP concept** for file/OS actions, redesign permissions UX |
| `ProvidersPage` | 278 | Provider/model/key setup | **KEEP concept**, simplify to Gemini + optional providers |
| `DashboardPage` / `SystemOverview` | 202 | Status tiles | **REDESIGN** for personal brief (today, tasks, reminders) |
| `AgentDashboard` | 354 | Seven-agent activity gauges | **REMOVE** — there are no real agents |
| `TaskBoard` / `TaskSummary` | 388 | Kanban of coding tasks | **OPTIONAL** — replace with personal task/reminder views |
| `KnowledgeExplorer` | 486 | Engineering knowledge entries/challenges | **REPLACE** with personal knowledge/memory explorer |
| `ConsensusState` / `TrustScore` | 258 | Consensus and trust dashboards | **REMOVE** consensus; **EXTRACT** trust for integrations |
| `VerificationState` / `RecoveryState` | 224 | Code verification/recovery state | **REDESIGN** as action outcome/rollback state |
| `EventFeed` | 77 | Live event log | **KEEP** (developer/debug drawer) |
| `SettingsContext`, `Layout`, `ErrorBoundary` | 261 | App shell | **KEEP** |

**Missing for the future product:** i18n (English/Telugu/Hindi), audio capture/playback, push-to-talk and wake-word UI, calendar/email views, permission/approval dialogs, onboarding, accessibility, and any authentication for the local RPC.

**Verdict:** the React shell and chat/file/settings interaction patterns are reusable; the engineering dashboards are not. Budget a redesign, not a port.

---

## 17. Dead code, duplication and unnecessary architecture

### 17.1 Statically unreachable code with no runtime effect

| Cluster | Files | LOC | Nothing imports it because… |
|---|---:|---:|---|
| `auth/providers/*` (22 adapters) | 22 | 1,645 | The live path uses SDK clients in `main.py`, not these adapters |
| `auth/auth/*` (api_key/oauth/browser/cloud/local/refresh/session/provider) | 9 | 1,715 | Credential vault replaced auth modes |
| `core/security/*` (approvals, governance, sandbox, memory, analytics, orchestrator) | 7 | 4,063 | Never wired after the orchestrator refactor |
| `learning/*` minus `agent_metrics.py` | 14 | 6,209 | Engineering pattern extraction has no caller |
| `mcp/integrations/*` | 20 | 1,968 | Specialist/execution-graph glue never registered |
| `shared_task_board/{models,context_schemas,result_schemas,collaboration_orchestrator}.py` | 4 | 1,538 | Only `board.py`/`task.py` used by Mode B |
| **Total clearly dead** | **76** | **17,138** | — |

Plus dead facets: `auth/events/*`, `auth/ratelimiter.py`, `auth/circuit_breaker.py`, `auth/runtime/streaming.py`, `core/workers/python_worker.py`, `core/execution/experience_pipeline.py`. Union of the table and these facets: **~19,000 LOC across 84 files (measured)**.

Separately, the static graph marks **114 production modules / 22,147 LOC (20.6% of production LOC)** as unreachable from the declared entry points. That set is an *upper bound*, not a removal list: it includes unwired but protected security modules (`execution_sandbox.py` 1,008, `security_orchestrator.py` 699, `security_memory.py` 699, `execution_governance.py` 621, `approval_manager.py` 551) and test-only planning modules. The confidently removable subset is Group A in `AELVO_REMOVAL_MANIFEST.md`.

### 17.2 Duplicated implementations

| Concern | Implementations | Consequence |
|---|---|---|
| Provider catalogue | `core/registry/models.py` (22), `auth/config.py` (20) | Drift, contradictory defaults/models |
| Provider runtime | `main.AelvoAgent` SDK clients vs `core/provider_runtime.create_client` | Two client lifecycles; two timeout policies |
| Provider health | `auth/runtime/health.py`, `auth/monitoring/health.py`, `runtime_next/monitoring/health.py` | Three notions of health |
| Events | `runtime_next/models/events.py`, `auth/events/*`, `mcp/events/*`, `runtime_next/verification/events.py` | Four event vocabularies; only one is bridged to the web |
| Retry | SDK retries, `auth/runtime/retry.py` (unused), `provider_runtime` fallback breaker, `runtime_next/verification/retry_safety.py`, tool loop | No single policy; side effects can repeat |
| Orchestration | `orchestrator.py`, `pipeline.py`, `task_board_pipeline.py`, `shared_task_board/collaboration_orchestrator.py`, `runtime_next/plan/brain/*` | Five coordinators, none authoritative |
| Verification | `runtime_next/verification/*` (15 files), specialist `verify_output`, `mcp/verification/*`, `core/security/execution_sandbox.py` | Four verification notions |
| Security policy | `sandbox_core/policy.rs`, `core/security/execution_governance.py`, `runtime_next/governance/policy_engine.py`, `mcp/governance/*` | Four policy engines |
| Monitoring | `runtime_next/monitoring/*` (5 files), `auth/monitoring/*`, `learning/agent_metrics.py` | Duplicated metrics plumbing |
| Chat memory | `MemoryEngine` + Chroma, `MemorySearcher`, `core/rag/rag.py`, `LocalMemoryCollection` | Three retrieval implementations |

### 17.3 Artificial complexity and simulated capability

- **“Seven-phase pipeline, one LLM call.”** The pipeline's own docstring says “OPTIMIZED: one consolidated prompt per turn” (`pipeline.py:520-534`); phase results all share the same output. The 1,756 LOC of pipeline machinery produces prompt text and bookkeeping, not phased reasoning.
- **“Collaborative Mode B.”** No model call, static findings, `“simulated execution (no real command)”` (`task_board_pipeline.py:1133`). The blackboard/consensus/task-board stack (cognition + shared_task_board) is exercised as a simulation.
- **“Verification-driven recovery.”** Verification is `ast.parse`/`py_compile` and regexes; recovery re-dispatches nodes. It cannot detect a semantic failure.
- **“Learning.”** Pattern accumulation over dependency graphs, no production caller.
- **Fake success by default.** `NodeRunner.run_node` returns `{"status": "success", "output": f"Node {node.id} executed"}` when no handler/executor exists (`runner.py:20-31`). This is the mechanism behind the `medium` no-op and is a design defect independent of wiring.
- **Unused structured tool registry.** `core/execution/tool_registry.py` (641 LOC) has specs, retries, caching, categories — and no production consumer; the live registry is an untyped dict.
- **Deferred heavy imports** show the cost of the dependency stack: Chroma is lazily imported to hide ~2.5 s (`kernel.py:_load_chromadb`), Scrapy is lazily imported, and the CLI boot explicitly skips MCP/cognition/repo/LHP to reach a prompt in seconds (`cli/boot.py:1-20`).

### 17.4 Is the complexity accidental or essential?

Most of it is **accidental**: it comes from building a coding-verification laboratory and then layering a general assistant metaphor (specialists, consensus, blackboards, task boards) on top without changing the execution model. The genuinely essential complexity is small: a validated tool boundary, a durable run/event model, secure approvals, provider abstraction, and memory. That is the target shape in §28.

---

## 18. Complete subsystem classification matrix

Scores are **analyst judgement** on 0–5, informed by the evidence in §6–§17; they are not measurements. Coupling is inverted (5 = tightly coupled). TS difficulty is 5 = hardest to migrate faithfully.

| Subsystem | PA relevance | Maturity | Arch quality | Reusability | Security importance | Uniqueness | Coupling | Complexity | Maintenance | TS difficulty | Primary disposition |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Tool execution + jail | 5 | 4 | 3 | 5 | 5 | 4 | 4 | 3 | 3 | 2 | **EXTRACT / REDESIGN** |
| Rust sandbox | 5 | 3 | 3 | 4 | 5 | 4 | 3 | 4 | 4 | 3 | **KEEP / REDESIGN** |
| Security platform (`core/security`) | 5 | 3 | 4 | 4 | 5 | 3 | 2 | 4 | 3 | 2 | **EXTRACT** |
| Providers + vault | 4 | 3 | 2 | 4 | 3 | 2 | 4 | 4 | 4 | 3 | **REPLACE / EXTRACT** |
| Runtime engine (graph/events) | 4 | 2 | 3 | 4 | 3 | 3 | 3 | 3 | 3 | 3 | **EXTRACT** |
| Verification + recovery | 3 | 2 | 2 | 3 | 4 | 2 | 4 | 4 | 4 | 3 | **REDESIGN** |
| Memory | 5 | 3 | 2 | 3 | 4 | 3 | 4 | 4 | 4 | 3 | **REDESIGN / EXTRACT** |
| Learning | 1 | 1 | 2 | 1 | 1 | 1 | 3 | 3 | 4 | 3 | **REMOVE** |
| Cognition + planning | 4 | 2 | 2 | 3 | 2 | 2 | 4 | 4 | 4 | 4 | **EXTRACT / OPTIONAL** |
| Specialists | 2 | 2 | 2 | 2 | 2 | 1 | 4 | 3 | 4 | 2 | **CONSOLIDATE / REMOVE** |
| Repository intelligence | 1 | 3 | 3 | 2 | 1 | 2 | 4 | 4 | 4 | 5 | **OPTIONAL** |
| MCP platform | 5 | 2 | 3 | 3 | 4 | 3 | 3 | 4 | 4 | 3 | **REPLACE / EXTRACT** |
| CLI | 2 | 4 | 3 | 2 | 2 | 2 | 3 | 3 | 3 | 3 | **REDESIGN** |
| React frontend | 4 | 2 | 2 | 3 | 2 | 2 | 3 | 3 | 3 | 3 | **REDESIGN** |
| Web bridge/server | 3 | 2 | 2 | 2 | 4 | 1 | 2 | 3 | 4 | 2 | **REPLACE** |
| Config/constants | 4 | 3 | 2 | 4 | 2 | 1 | 3 | 1 | 1 | 1 | **EXTRACT** |
| Task board | 2 | 1 | 2 | 2 | 1 | 2 | 3 | 3 | 4 | 3 | **OPTIONAL** |
| Packaging/installer | 3 | 2 | 2 | 2 | 3 | 1 | 3 | 3 | 4 | 3 | **REPLACE** |

**Reading the matrix:** the assets that score high on relevance *and* reusability are security, tool contracts, memory, providers and MCP trust. The assets that score high on complexity but low on relevance (repo intelligence, learning, specialists, architect brain) are the reduction targets.

**How the scores were justified**

- **PA relevance:** driven by the capability list in the brief. OS/tool/security/memory score 5 because the future product cannot exist without them; repo intelligence and learning score 1 because nothing in the listed product capabilities needs them; specialists score 2 because a single assistant can absorb their prompts.
- **Maturity:** tools, CLI and the Rust jail score 3–4 because they are exercised and tested; the pipeline/consensus/task-board stack scores 1–2 because its central paths are simulated or unwired.
- **Architectural quality:** security primitives score 3–4 (small, explicit); orchestration scores 2 (five coordinators, fabricated success fallback, import cycles).
- **Reusability:** provider adapters, vault, tool contract, event/plan models score 4; repo intelligence and specialists score 1–2 because their contracts are coding-specific.
- **Security importance:** filesystem jail, policy, audit, approvals, credentials score 5; learning scores 1.
- **Uniqueness:** the path jail, audit schema and tolerant tool parser are unusual and non-trivial; provider shims, monitoring and task boards are commodity (1–2).
- **Coupling:** learning, specialists, repo intelligence and orchestration score 4 (many importers, cycles); config scores 3 but has almost no logic; sandbox scores 3 because it is invoked by path rather than imported.
- **Complexity:** verification/recovery, cognition/planning, MCP and memory score 4 (many interacting concepts); config scores 1.
- **Maintenance:** learning, repo intelligence, specialists and duplicated monitoring score 4 (high churn/low value); config scores 1.
- **TS migration difficulty:** repo intelligence scores 5 (Python `ast`), cognition/planning 4 (emergent abstractions), sandbox 3 (Rust sidecar rather than TS), config 1.

### 18.1 Disposition summary (all 446 inventoried source modules: 388 Python + 58 Rust/TS/JS)

| Disposition | Modules | Representative paths |
|---|---:|---|
| **EXTRACT** | 142 | `auth/adapters/*`, `auth/cred_storage.py`, `core/security/*`, `core/execution/tool_registry.py`, `runtime_next/models/*`, `runtime_next/events/*`, `memory/user_model.py`, `mcp/governance/*`, `repo_intelligence/parser.py` |
| **REDESIGN** | 85 | `core/orchestration/*`, `runtime_next/verification/*`, `core/filesystem/*`, `core/rag/*`, `web/src/*`, `cli/*` |
| **OPTIONAL** | 80 | `repo_intelligence/*`, `planning/*`, `runtime_next/plan/*`, `tools/*`, `mcp/{recovery,memory,events}` |
| **REMOVE** | 78 | `auth/providers/*`, `auth/auth/*`, `learning/*`, `mcp/integrations/*`, `core/workers/*`, `bin/*` |
| **REPLACE** | 27 | `mcp/{transport,client,capability,registry}`, `core/provider_runtime.py`, `web/server.py`, `web/web_bridge.py` |
| **CONSOLIDATE** | 20 | `auth/config.py`, `auth/runtime/*`, `specialists/*` |
| **KEEP** | 2 | `sandbox_core/src/fs_jail.rs`, `sandbox_core/src/audit.rs` |
| **INVESTIGATE** | 12 | `mcp/discovery/*`, `auth/__init__.py`, TS/JS build configs, the uncommitted `vitest.config.ts` |

Python-only counts (388 modules): EXTRACT 138, OPTIONAL 74, REMOVE 71, REDESIGN 51, REPLACE 27, CONSOLIDATE 20, INVESTIGATE 7; no Python module is classified KEEP. Per-module rationale and confidence are in `AELVO_MODULE_INVENTORY.json`; the disposition of an entire directory must not be read as uniform.

---

## 19. Exact proposed removal candidates (summary)

The detailed manifest — prerequisites, dependents, lost functionality, risk and deletion order — is in `AELVO_REMOVAL_MANIFEST.md`. This section is the index.

### Group A — High-confidence independent removals (no production dependents)

| Path | LOC | Why |
|---|---:|---|
| `auth/providers/` (22 files) | 1,645 | Zero importers; live path uses SDK clients |
| `auth/auth/` (9 files) | 1,715 | Zero importers; vault replaced these modes |
| `auth/events/` | 229 | Provider events never subscribed |
| `auth/ratelimiter.py` | 125 | Unreferenced |
| `auth/circuit_breaker.py` | 150 | Unreferenced; another breaker exists |
| `auth/runtime/streaming.py` | 247 | Unreferenced; adapters/streaming.py is used |
| `learning/` except `agent_metrics.py` (14 files) | 6,209 | No production caller; coding-specific |
| `mcp/integrations/` (20 files) | 1,968 | Statically unreachable coding glue |
| `core/workers/` | 210 | Unreachable |
| `core/execution/experience_pipeline.py` | 940 | No runtime consumer |
| `shared_task_board/{models,context_schemas,result_schemas,collaboration_orchestrator}.py` | 1,538 | Unreachable; Mode B uses board/task only |
| **Total Group A** | **~14,976** | — |

Risk: **low**. Prerequisite for `learning` removal: delete the `learning` import of `repo_intelligence.types` (or keep the types). Tests referencing removed modules must be removed with them (they test dead code).

### Group B — Coding-specific removals (if coding assistance is not retained)

| Path | LOC | Note |
|---|---:|---|
| `repo_intelligence/` | 12,914 | Coding-only; keep `parser/scanner/graph` only if an optional coding capability is planned |
| `specialists/` | 6,328 | Prompt-only roles; no real agents |
| `tools/code_tools.py`, `git_tools.py`, `diagram_tools.py` | 877 | Developer tools |
| `core/system_prompt.py` | 220 | JSON tool protocol for coding; keep as behavioural reference, not product copy |
| `runtime_next/plan/` | 6,948 | Architect/brain/calibration planning is engineering-plan oriented (12,043 with its tests) |
| **Total Group B** | **~27,300** | Overlaps Group E choices |

Risk: **medium-high** — orchestration imports specialists and plan types; removal requires the redesign in §21 first.

### Group C — Dependency-sensitive removals (after extraction)

`core/orchestration/orchestrator.py` (1,751), `pipeline.py` (1,756), `task_board_pipeline.py` (1,332), `main.py` (1,796), `cli/` (3,309), `web/web_bridge.py` (1,068), `web/server.py` (156), `core/provider_runtime.py` (898), `core/governance/kernel.py` (548). These are not “dead”: they are the current product shell. They can only be removed after their reusable parts are extracted and a native runtime exists. Risk: **high**.

### Group D — Redundant implementations (after consolidation)

`auth/config.py` (862, 1 file), `auth/runtime/` (2,742, 12 files), `auth/monitoring/` (786, 4 files), `auth/diagnostics/` (742, 6 files), `runtime_next/monitoring/` (1,791, 6 files), `mcp/capability/` (569, 7 files), `mcp/client/` (727, 6 files), `mcp/transport/` (626, 6 files), `mcp/registry/` (920, 5 files), `core/rag/` (1,279, 5 files), `core/execution/tool_registry.py` (641). Risk: **medium** — each has a live consumer or a replacement dependency.

### Group E — Optional capabilities (leave the core, may survive as extensions)

- Repository intelligence and coding tools (optional “coding mode”).
- Long-horizon planning, goal hierarchy, self-critique, debt forecasting.
- Cognition blackboard/consensus/strategy memory.
- Shared task board / Mode B.
- Architect plan brain/calibration.
- Scraping stack, MCP recovery/memory/events, provider diagnostics.

Risk: **low** to core if isolated behind interfaces; product value varies.

### Group F — Protected components (do not remove without explicit review)

| Component | Why protected |
|---|---|
| `sandbox_core/src/fs_jail.rs`, `audit.rs`, `resource.rs` | Core security primitives |
| `auth/cred_storage.py` | Credential security |
| `core/filesystem/automation.py` | Tool semantics and jail behaviour |
| `core/governance/kernel.py` (constraints/honesty/audit parts) | Governance semantics |
| `auth/adapters/*` | Provider normalisation |
| `runtime_next/models/{plan,events,node}.py` | Shared contracts |
| `runtime_next/events/bus.py` | Event infrastructure |
| `memory/user_model.py` | Personal preference behaviour |
| `core/execution/tool_registry.py` | Structured tool contract (unused but the right shape) |
| `config/settings.py` | Thresholds/timeouts |

---

## 20. Exact proposed retention candidates

| Retain (concept, ported) | Source | Port shape |
|---|---|---|
| Path containment + symlink handling | `sandbox_core/src/fs_jail.rs` | Rust service/library with tests; used by every file tool |
| Audit event schema | `sandbox_core/src/audit.rs` | Append-only audit store + OS event log |
| Resource limits | `sandbox_core/src/resource.rs` | Per-action process supervisor |
| Tool specifications/retry/cache | `core/execution/tool_registry.py` | Typed registry with Zod input/output schemas |
| File tool semantics | `core/filesystem/automation.py` | Typed tools: read/range/write/edit/list/find/search/tree |
| Tolerant JSON/tool parser | `core/orchestration/parser.py` | Port + schema validation + fuzz tests |
| Streaming filter | `core/orchestration/stream_filter.py` | Port to typed stream events |
| Session compaction | `core/orchestration/session_manager.py` | Port with token budget |
| Provider adapters | `auth/adapters/*` | Typed adapters over `@google/genai` / OpenAI-compatible |
| Credential vault | `auth/cred_storage.py` | Prefer OS keychain; keep encrypted fallback |
| Provider data | `core/registry/models.py` | One verified catalogue (remove unverified IDs) |
| Event bus + event models | `runtime_next/events/bus.py`, `models/events.py` | Durable queue for background tasks |
| Plan/node/edge contracts | `runtime_next/models/plan.py` | Port with cancellation/parallelism |
| Recovery classifier ideas | `runtime_next/recovery/*` | Port failure taxonomy for personal tasks |
| MCP trust + governance + verification | `mcp/registry/trust_manager.py`, `mcp/governance/*`, `mcp/verification/*` | Policy layer over official SDK |
| Approval lifecycle | `core/security/approval_manager.py` | Mandatory approval service |
| Security memory/analytics | `core/security/security_memory.py`, `security_analytics.py` | Governance telemetry |
| User model heuristics | `memory/user_model.py` | Explicit preferences + inference |
| Conflict resolution | `memory/forge_memory.py` | Fact supersession/validity |
| React shell + chat/files/settings | `web/src/*` | Redesigned desktop UI |
| Config constants | `config/settings.py` | Typed config module |

---

## 21. Exact extraction and consolidation candidates

### 21.1 Extraction (selected functions/classes, not whole subsystems)

| Extract | From | Into |
|---|---|---|
| `FsJail::{new,resolve_and_verify}`, inode/hardlink checks | `sandbox_core/src/fs_jail.rs` | `security/path-policy` (Rust) |
| `Auditor` schema + `emit_security_event` | `sandbox_core/src/audit.rs` | `security/audit` |
| `Limits`, `create_governor` | `sandbox_core/src/resource.rs` | `security/process-supervisor` |
| `ThreatDetector::{analyze_command,summarize_threats}` | `sandbox_core/src/threat_detection.rs` | `security/threat-policy` |
| `ToolSpec`, `ToolResult`, cache/retry logic | `core/execution/tool_registry.py` | `tools/registry` |
| `validate_action`, constraints, honesty checks | `core/governance/kernel.py` | `governance/constraints` |
| `parse_llm_output`, salvage extraction | `core/orchestration/parser.py` | `providers/tool-parser` |
| `TokenStreamFilter` | `core/orchestration/stream_filter.py` | `providers/streaming` |
| `SessionManager.maybe_summarize_session` | `core/orchestration/session_manager.py` | `sessions/compaction` |
| `MessageAdapter`, `ToolCallAdapter`, `StructuredOutputAdapter`, `StreamingAdapter` | `auth/adapters/*` | `providers/adapters` |
| `CredentialStore` encryption/metadata | `auth/cred_storage.py` | `secrets/vault` |
| `ExecutionPlan`, `ExecutionNode`, `ExecutionEdge`, retry policies | `runtime_next/models/plan.py` | `runtime/contracts` |
| `EventBus` + typed events | `runtime_next/events/*`, `runtime_next/models/events.py` | `runtime/events` |
| `RecoveryEngine` classification | `runtime_next/recovery/*` | `runtime/recovery` |
| `TrustManager` + `MCPGovernanceLayer` + verifiers | `mcp/{registry/trust_manager,governance,verification}` | `integrations/mcp-policy` |
| `ApprovalManager`, `ExecutionGovernance` | `core/security/*` | `governance/approvals` |
| `UserModelManager.extract_signals_from_history` | `memory/user_model.py` | `memory/preferences` |
| `ForgeMemory._resolve_conflict` | `memory/forge_memory.py` | `memory/facts` |
| `PythonASTParser`, `TypeScriptRegexParser`, scanner extension map | `repo_intelligence/{parser,scanner}.py` | optional `coding/parsing` |

### 21.2 Consolidation

| Consolidate | Into | Reason |
|---|---|---|
| `core/registry/models.py` + `auth/config.py` | One provider catalogue | Two sources disagree (20 vs 22) |
| `auth/runtime/*` + `provider_runtime.py` | One provider service | Duplicate registry/health/usage/fallback |
| `auth/monitoring/*` + `runtime_next/monitoring/*` + `learning/agent_metrics.py` | One metrics surface | Three metric collectors |
| `runtime_next/models/events.py` + `auth/events/*` + `mcp/events/*` + verification events | One typed event union | Four vocabularies |
| `auth/runtime/retry.py` + tool-loop retries + SDK retries + `retry_safety.py` | One policy with idempotency | Duplicate/uncontrolled retries |
| `runtime_next/governance/policy_engine.py` + `core/security/execution_governance.py` + `sandbox_core/policy.rs` + `mcp/governance/*` | One policy decision service | Four policy engines |
| `pipeline.py` + `task_board_pipeline.py` + `orchestrator.py` + `collaboration_orchestrator.py` | One run coordinator | Five coordinators, none authoritative |
| `core/rag/rag.py` + `MemorySearcher` + `LocalMemoryCollection` | One retrieval module over SQLite/FTS | Three implementations |
| `core/execution/tool_registry.py` + the live dict registry | One registry | Spec exists but unused |

---

## 22. External replacement candidates

| Existing | Proposed alternative | Simplification | Preserved | Lost | Integration | Security | Platform | Native deps |
|---|---|---|---|---|---|---|---|---|
| `google-generativeai` chat integration | **`@google/genai`** (official, current) | One SDK replaces deprecated client; enables Live API later | Chat, streaming, tools, structured output | None intentional; API differs | Low — adapter rewrite | Better (maintained) | All Node platforms | No |
| 22-provider runtime + auth modes | **`@google/genai` + OpenAI-compatible adapter (+ Anthropic)** | ~11k LOC → ~1.5k | Main providers, local runtimes | Niche providers (Azure/Bedrock/Vertex) until re-added | Low | Fewer credential paths | All | No |
| Hand-rolled MCP protocol (transports, handshake, capability) | **Official TypeScript MCP SDK** | ~6k LOC → ~1k + SDK | Protocol compliance, tools/resources/prompts | Bespoke recovery/registry format | Medium | Maintained protocol; keep trust layer | All | No |
| Chroma vector DB | **SQLite FTS5 + optional embeddings** | Removes model download, ~2.5s import, extra store | Retrieval, dedupe, decay | Dense-only semantics | Low-medium | Fewer services | All | No (FTS5 built in) |
| Custom JSON/SQLite persistence | **`node:sqlite`** (built-in) or `better-sqlite3` | One DB layer, transactions, migrations | All state | None | Low | ACID; no native build with `node:sqlite` | Node ≥22 | No (built-in) |
| Ad-hoc runtime validation | **Zod** | Typed contracts at every boundary | — | — | Low | Blocks malformed model/tool input | All | No |
| Python `logging` | **Pino** | Structured JSON logs, low overhead | Log files, levels | — | Low | Redaction support | All | No |
| aiohttp + websockets bridge | **Node `http` + `ws`** | One process, shared types | Static serving + WS | — | Medium | Add auth/token/origin checks | All | No |
| prompt_toolkit REPL | **Node readline / `@clack/prompts`** (optional) | Smaller dependency | Slash commands, history | Rich terminal styling parity | Medium | — | All | No |
| Python venv installer | **npm-only distribution** | Deletes Python bootstrap entirely | CLI launch | Python tool execution (unless user installs Python) | Low | Removes supply-chain surface | All | No |
| Custom React state/WS | **Typed shared contracts + Zustand/React Query** (optional) | One event schema | All views | — | Low | — | All | No |
| Rust one-shot process per action | **Long-lived Rust service (stdio JSON-RPC)** | Lower latency, session state | All sandbox actions | Simplicity of one-shot | Medium | Better audit continuity | Needs per-platform builds | Rust toolchain for source builds |

**Deliberately not recommended:** Electron is not in scope for this audit, but note that the existing React app can be hosted in a desktop shell later; adding it now would be premature. No ORM, no microservice framework, no message broker — the scale does not justify them.

---

## 23. Dependency impact analysis

“Blast radius” = number of production modules that transitively import the candidate (from `AELVO_DEPENDENCY_GRAPH.json`). Removal is safe only after the listed prerequisites.

| Candidate | Direct consumers | Transitive dependents | Tests affected | Prerequisite | Data impact |
|---|---|---:|---|---|---|
| `auth/providers/*` | none | 0 | `auth/tests/test_providers*` (if present) | none | none |
| `auth/auth/*` | none | 0 | `auth/tests` auth-mode tests | none | none (vault handles credentials) |
| `learning/*` (minus metrics) | none | 0 | `tests/test_learning.py`, `test_autonomous_learning.py`, `test_specialist_adapter.py` | keep `agent_metrics.py` | deletes learned-pattern DB tables if present (coding data only) |
| `core/security/*` | none | 0 | `tests/test_security_platform.py`, `test_security_guards.py`, `test_phase15_security_integration.py` | extract approvals/governance first | none (no production tables) |
| `mcp/integrations/*` | none | 0 | `tests/test_mcp.py` (indirect) | none | none |
| `core/workers/*` | none | 0 | `test_shutdown.py`, `test_security_worker_guards.py` | none | none |
| `shared_task_board/{models,context,result,collaboration}` | none | 0 | `test_shared_task_board.py`, `test_collaboration_*` | keep `board.py`, `task.py` until Mode B is retired | in-memory only |
| `repo_intelligence/*` | `main.py`, `cognitive/planner.py`, `cognitive/engine.py`, `specialists/architect.py`, `learning/*`, `mcp/integrations/repository_intelligence/*` | 9+ | `test_repo_intelligence.py` | extract `types.py` if cognition kept; remove learning first | repository index caches (rebuildable) |
| `specialists/*` | `orchestrator.py`, `pipeline.py`, `router.py`, `task_board_pipeline.py`, `context_builder.py`, `specialists/__init__`, `mcp/integrations/specialists/*`, `runtime_next/capability/registry.py` | 14+ | `test_specialists.py`, `test_hermes_context.py`, `test_orchestrator_mode_selection.py`, `test_*_collaboration.py` | replace orchestration + prompt assembly | memory entries written by `post_process` (coding data) |
| `core/orchestration/*` | `main.py`, `cli/*`, `web/*` | 6 (cycle) | most integration tests (`test_end_to_end_integration.py`, `test_task_board_pipeline.py`, `test_modes.py`, `test_tool_loop_failures.py`) | extract parser/stream/session/context; build new run engine | sessions table still readable |
| `main.py` | `cli/*`, `web/*` (lazy) | 6 (cycle) | `test_cli.py`, `test_main_startup.py`, `test_folder_activation.py` | native entry point must exist | per-folder `.aelvo` state must be migrated |
| `core/governance/kernel.py` | FS, tools, orchestrator, CLI, web | 8 | memory/constraint tests (`test_phase10_memory_integration.py`, `test_rag*`, `test_tool_execution.py`) | extract constraint/honesty logic; new store | **user memory DB** — must be migrated, not dropped |
| `core/provider_runtime.py` | `main.py`, `cli/boot.py`, `cli/providers.py` | 3 | `test_diagnostics_integration.py`, `test_live_models.py` | new provider service + vault | credential vault compatible |
| `web/web_bridge.py` | `web/server.py`, `main.py` | 6 (cycle) | `test_web_bridge_providers.py` | new authenticated bridge | none |
| `cli/` | `main.py` (cycle) | 6 | `test_cli.py`, `test_cli_entry.py`, `test_modes.py`, `test_picker*` | new CLI | none |
| `sandbox_core/*` | FS bridge (by path), not import | 0 | `test_fs_python_fallback.py`, sandbox verification tests | none | workspace backups/checkpoints |

### 23.1 What cannot be removed independently

- `runtime_next/models/plan.py` is imported by cognition, planning, orchestration, verification and recovery. It must be **replaced by a new shared contract**, not deleted.
- `cognition/types.py` is imported by memory, specialists, learning, planning and MCP collaborations. Extract the types before removing cognition.
- `core/governance/kernel.py` contains both the memory engine and constraint logic; split before migration.
- `main.py` doubles as the provider adapter, tool registry and boot script; split before any deletion.

### 23.2 Hidden dependency on Python for “analysis”

The repository scanner and parser use Python's `ast` for Python repositories. If AELVO must still analyse Python code after moving to TypeScript (a stated requirement in the earlier migration brief), this becomes a **capability-loss risk**, not a runtime dependency: Tree-sitter (with a Python grammar) or a Python parser library is required. Today there is no non-Python implementation.

---

## 24. Scenario A — Conservative transformation

**Intent:** preserve most behaviour, reduce only clearly dead/coding-only code, keep the existing execution model and specialists.

| Decision | Subsystems |
|---|---|
| **Retained** | Core kernel/FS/orchestration, runtime_next engine/plan/verification/recovery, providers, MCP, cognition, planning, specialists, repo intelligence, task board, web, CLI |
| **Removed** | Group A only (~15k LOC: dead auth layers, learning, MCP integrations, dead board modules, workers, experience pipeline) |
| **Redesigned** | `medium` tool wiring, Mode B simulation disclosure, web auth, packaging |
| **Replaced** | `google-generativeai` → `@google/genai` |
| **Optional** | Repository intelligence, coding tools, architect brain remain in-core |
| **Estimated Python retained** | ~92.6k LOC |
| **Estimated Python avoided** | ~15.0k LOC |
| **Estimated TypeScript (migrated logic only)** | ~85–95k LOC |
| **New product code (voice, OS, calendar, memory)** | Additional, unbudgeted |
| **Migration complexity** | **Very high** — essentially a line-by-line port of a 94k-line Python app, including dead-ish abstractions |
| **Maintenance burden** | High — five orchestrators, four policy engines, three retrievers remain |
| **Security** | Still no mandatory approvals; still unauthenticated web RPC unless explicitly fixed; command confinement unchanged |
| **Capability trade-offs** | Preserves coding workflows and specialist theatre; retains Chroma/Scrapy operational weight |
| **Dependency risks** | Chroma, Scrapy/Playwright, Python-only parsers, the Rust `.exe` path |
| **Future voice/OS fitness** | Poor — coding architecture remains the centre |

**Verdict:** lowest short-term behavioural risk, highest long-term cost. Not recommended unless the product must remain a coding agent.

---

## 25. Scenario B — Balanced transformation (recommended)

**Intent:** keep genuinely reusable infrastructure, remove engineering-specific complexity, replace custom frameworks where maintained libraries are superior, rebuild the execution model around personal tasks and security.

| Decision | Subsystems |
|---|---|
| **Retained (ported)** | Path jail/audit/resource, tool registry + file tool semantics, provider adapters + catalogue + vault, event bus + plan/event contracts, recovery taxonomy, MCP trust/governance/verification, approvals/governance, user model, config, React chat/files/settings shell |
| **Removed** | Group A + Group B + most of Groups C/D/E; retained total is ~26k (§27) |
| **Redesigned** | Runtime engine (cancellation, parallelism, durable runs), memory (SQLite personal schema), verification (outcome-based), orchestration (single coordinator), CLI (optional dev surface), frontend (voice-first) |
| **Replaced** | Gemini SDK, MCP SDK, Chroma → FTS5, aiohttp → Node http/ws, Python installer → npm |
| **Optional** | Coding mode (repo intelligence + code/git tools), long-horizon planning, MCP recovery, scraping |
| **Estimated Python retained for migration** | **~24–28k LOC** |
| **Estimated Python avoided** | **~80–84k LOC** |
| **Estimated TypeScript (migrated logic only)** | **~30–38k LOC** |
| **Migration complexity** | **Medium-high** — extract, then rewrite boundaries; no line-by-line port |
| **Maintenance burden** | Medium — one coordinator, one policy service, one memory store |
| **Security** | Mandatory approvals, authenticated local RPC, OS-level sandboxing roadmap, prompt-injection boundary |
| **Capability trade-offs** | Loses specialist theatre and coding-centric dashboards; coding becomes optional; consensus/task-board simulation dropped |
| **Dependency risks** | New Gemini/MCP SDK versions; Rust cross-platform builds; Electron later |
| **Future voice/OS fitness** | Good — event-driven, typed, local-first, security-first |

---

## 26. Scenario C — Aggressive transformation

**Intent:** smallest coherent personal-agent foundation; retain only security primitives, tool contracts, credential handling, memory heuristics and a few parsers; build the rest new.

| Decision | Subsystems |
|---|---|
| **Retained** | Rust `fs_jail`/`audit`/`resource` (concept), tool spec/result contract, file-tool semantics, tolerant JSON parser, credential encryption, user model, config constants, event/plan model ideas |
| **Removed** | All orchestration/specialists/cognition/planning/learning/repo intelligence/MCP custom protocol/task board/CLI/web bridge |
| **Redesigned** | Everything else as new services (voice, conversation, memory, OS control, security, scheduling, MCP via SDK) |
| **Replaced** | Gemini/MCP/SQLite/logging/validation per §22 |
| **Optional** | None in core; coding mode as a separate package |
| **Estimated Python retained** | **~3–5k LOC** (excluding Rust) |
| **Estimated Python avoided** | **~103–105k LOC** |
| **Estimated TypeScript** | **~12–18k LOC** migrated/ported logic + new product services |
| **Migration complexity** | **Low-medium** — mostly new construction with a small reference set |
| **Maintenance burden** | Lowest |
| **Security** | Best chance of a coherent capability/approval model; must rebuild auditing |
| **Capability trade-offs** | Drops coding assistance entirely unless rebuilt; drops long-horizon planning and multi-agent features |
| **Dependency risks** | New code has no behavioural safety net; requires strong tests |
| **Future voice/OS fitness** | Excellent — no legacy assumptions |

**Caveat:** “estimate of migrated logic” is not total TypeScript size. The new product needs voice, OS control, calendar/email, scheduling and personal memory, none of which exist in the repository. A realistic TypeScript build for the full future product is larger than any figure here; the scenarios compare *inherited* complexity, not final product size.

---

## 27. Quantitative LOC reduction estimates

| Measure | Scenario A | Scenario B | Scenario C |
|---|---:|---:|---:|
| Measured production Python | 107,599 | 107,599 | 107,599 |
| Estimated Python retained | ~92,600 | ~26,000 | ~4,000 |
| Estimated Python avoided | ~15,000 | ~81,600 | ~103,600 |
| Avoided share | 14% | 76% | 96% |
| Estimated TS for migrated logic | ~85–95k | ~30–38k | ~12–18k |
| Rust retained | 5,777 | ~3,500 (jail/audit/resource/policy) | ~2,200 (jail/audit/resource) |
| Existing tests usable as behavioural reference | 2,668 (most) | selected (~300–500) | small (~50–100) |
| New product code required | Large (on top) | Large (on top) | Large (on top) |

All figures except the measured 107,599 / 5,777 / 2,668 are **estimates**, derived by summing per-subsystem measured LOC for retained files and adding the extraction sets in §21. They should be re-baselined after the architect selects a scenario.

---

## 28. Proposed future architecture

This is a **proposal**, not an implementation. It is consistent with Scenario B and can be trimmed toward C.

### 28.1 Service map

```
┌────────────────────────── Electron main (Node) ──────────────────────────┐
│  window manager · global shortcut · tray · single-instance · auto-update │
│  secure IPC (contextIsolation, no nodeIntegration, typed channels)        │
└───────────────┬────────────────────────────────────────────┬──────────────┘
                │ IPC (typed, validated)                     │
┌───────────────▼───────────────┐              ┌─────────────▼──────────────┐
│  Renderer (React + TS)        │              │  Core daemon (Node)        │
│  voice-first conversation UI  │◀── WS/SSE ──▶│  lifecycle, orchestration  │
│  tasks, calendar, memory,     │              │  run engine, scheduler     │
│  approvals, settings, i18n    │              │  tool gateway, MCP client   │
└───────────────────────────────┘              └───┬───────┬──────────┬─────┘
                                                   │       │          │
                        ┌──────────────────────────▼┐  ┌───▼───────┐ ┌▼─────────────┐
                        │ Voice service             │  │ Memory    │ │ Security      │
                        │ Gemini Live session, VAD, │  │ SQLite +  │ │ policy,       │
                        │ barge-in, TTS, i18n       │  │ FTS5      │ │ approvals,    │
                        └───────────────────────────┘  └───────────┘ │ audit, secrets│
                                                                      └───┬───────────┘
                                                     ┌────────────────────▼──────────┐
                                                     │ Sandbox service (Rust)        │
                                                     │ path jail, process supervisor,│
                                                     │ resource limits, audit        │
                                                     └───────────────────────────────┘
```

### 28.2 Services, responsibilities and origin

| Service | Responsibility | Origin |
|---|---|---|
| **Provider gateway** | Gemini chat/embeddings; optional OpenAI-compatible; typed streaming | **Redesigned** from `main.py` + `provider_runtime.py`; adapters extracted from `auth/adapters/*`; new SDK `@google/genai` |
| **Voice session** | Gemini Live bidirectional audio, VAD, barge-in, EN/TE/HI | **New** (no existing voice code) |
| **Conversation** | Turn state, interruption, transcript, session compaction | **Extracted** (`session_manager.py`, `stream_filter.py`) + new |
| **Context builder** | System prompt, memory retrieval, workspace/OS context, token budget | **Redesigned** from `context_builder.py`, `pipeline.py` (one consolidated prompt, not seven phases) |
| **Memory** | Facts, preferences, commitments, projects, episodes; supersession; decay | **Redesigned** from `memory/*`; SQLite + FTS5; Chroma removed |
| **Run engine** | Durable runs, steps, cancellation, parallelism, retries, checkpoints | **Extracted** from `runtime_next/{models,engine,events,recovery}`; drop the bypassing fallback |
| **Tool gateway** | Typed tool registry, schema validation, permissions, timeouts, idempotency | **Extracted** from `core/execution/tool_registry.py` + live dict registry |
| **OS control** | App launch/focus, window/files, clipboard, input, screen capture | **New**, backed by Rust/Node native modules; **no existing implementation** |
| **Browser automation** | Navigate, extract, act, screenshot | **New** (Playwright) — existing `scraping/` is a headless research spider, not control |
| **Security governance** | Capability tokens, approval lifecycle, threat policy, redaction | **Extracted** from `core/security/*`, `core/governance/kernel.py`, `sandbox_core/{policy,threat_detection}` |
| **Audit** | Append-only local audit log, export, retention | **Extracted** from `sandbox_core/src/audit.rs` |
| **Scheduler** | Reminders, recurring workflows, background jobs, proactive triggers | **New** (no existing scheduler; `plan` is not a scheduler) |
| **Verification/recovery** | Outcome verification, rollback, failure taxonomy | **Redesigned** from `runtime_next/{verification,recovery}` (outcome-based, not `py_compile`) |
| **MCP client** | Servers, tools/resources/prompts, trust, governance | **Replaced** by official TS SDK; trust/governance **extracted** from `mcp/*` |
| **Desktop IPC** | Typed, authenticated channels between renderer, main, daemon | **Replaced** from `web/web_bridge.py` (currently unauthenticated) |
| **Productivity** | Tasks, projects, calendar, email, knowledge notes | **New**; only task-board *state machine* concepts are reusable |
| **Secrets** | OS keychain-first; encrypted fallback | **Extracted** from `auth/cred_storage.py` |
| **Config** | Typed settings, paths, thresholds | **Extracted** from `config/settings.py` |
| **Local API** | Authenticated loopback API for extensions | **Redesigned** from `web/server.py` |
| **Observability** | Structured logs, run traces, metrics | **New** (Pino + local store); replaces three monitoring stacks |
| **Packaging** | npm/Electron builder per platform; optional Rust sidecar | **Replaced** from `bin/install.js` + Python bootstrap |

### 28.3 Minimal data model (proposed)

`conversations`, `messages`, `runs`, `run_steps`, `tool_invocations`, `approvals`, `audit_log`, `facts` (subject/predicate/value/valid_from/valid_to/confidence/source), `preferences`, `commitments`, `tasks`, `projects`, `events`, `reminders`, `workflows`, `workflow_runs`, `mcp_servers`, `mcp_grants`, `secrets_metadata`. All local SQLite with WAL, migrations, and per-table retention. **No vector database is required** for the first version.

### 28.4 Key architectural rules

1. **One coordinator.** No specialist theatre; optional roles are prompt fragments, not runtime agents.
2. **Every side effect passes one gateway** with a declared capability; approvals are a service, not a convention.
3. **Tools are typed twice** — input and output — and validated at the boundary.
4. **Voice is a transport**, not a second brain: the same conversation/run engine serves text and audio.
5. **Memory is explicit** and user-inspectable; nothing silently learns from repository graphs.
6. **Local-first**: no cloud dependency except the model provider; all state on device.
7. **Fail visible**: no fabricated `success`; an unimplemented step is an error.
8. **Boring dependencies**: SDKs, SQLite, Zod, Pino; no custom protocol or orchestration framework.

---

## 29. Proposed removal sequence (not executed)

Each phase is independently reviewable and reversible via Git. No phase should start until the previous phase's tests pass and the independent architect approves.

| Phase | Action | Gate | Rollback |
|---|---|---|---|
| **R0** | Freeze the uncommitted TS scaffold as a separate branch/stash decision; commit or archive `AGENT_REPORT.md`; record baseline hashes | Tree clean or explicitly parked | — |
| **R1** | Remove Group A dead layers (`auth/providers`, `auth/auth`, `auth/events`, ratelimiter, breaker, unused streaming, `learning` minus metrics, `mcp/integrations`, `core/workers`, `experience_pipeline`, dead board modules) and their tests | Full suite remains at 2,646 passed / 15 known failures or better; no import errors | Revert commit |
| **R2** | Extract reusable primitives **without deleting the originals** (`tool_registry` specs, parser, stream filter, session compaction, adapters, vault, approvals, event/plan contracts, trust) into a `portable/` namespace with tests | New tests pass; originals untouched | Delete `portable/` |
| **R3** | Replace duplicate infrastructure behind the existing API (provider catalogue single-source, one health/metrics surface, one policy facade) | Existing behaviour unchanged | Revert |
| **R4** | Build the new run engine + tool gateway + security service in TypeScript against the extracted contracts; shadow-run representative turns | Differential tests: old vs new outputs for N scenarios | Feature flag off |
| **R5** | Migrate memory schema to SQLite with a one-way migration script and a read-only verifier | Row counts, sampled facts, preference round-trip | Keep old DB copy |
| **R6** | Switch entry points (CLI/web) to the new runtime; keep Python as a fallback command for one release | Same user-visible outcomes | Env flag |
| **R7** | Remove Group B/C/D modules only after their new replacements are proven; delete tests that only asserted dead behaviour | Suite green; no orphan imports | Revert |
| **R8** | Remove Python runtime packaging; ship Node/Electron; retain Rust sidecar | Install/launch on Windows/Linux/macOS | Prior release |

**Ordering constraints:** remove `learning` before `repo_intelligence`; extract `cognition/types.py` before removing cognition; split `core/governance/kernel.py` before touching memory; build the new bridge before deleting `web_bridge.py`; never delete `sandbox_core` while `core/filesystem/automation.py` still references the `.exe` path.

---

## 30. Proposed TypeScript migration sequence (not executed)

| Stage | Scope | Exit criterion |
|---|---|---|
| **M0 — Contracts** | Zod schemas for events, runs, tools, approvals, memory facts; shared package consumed by daemon and renderer | Schema tests; no `any` at boundaries |
| **M1 — Security primitives** | Path policy, audit, resource supervisor (Rust sidecar + TS client), secret storage via OS keychain | Jail parity tests against `fs_jail.rs` cases, including symlink/hardlink/ADS |
| **M2 — Provider gateway** | `@google/genai` chat + streaming; adapter interface; verified model catalogue; tolerant tool parser | Recorded-fixture tests; one live smoke test with the user's key |
| **M3 — Tool gateway + first tools** | File read/write/edit/list/search, shell (policy-gated), clipboard, launch app | Each tool has schema, permission, timeout, audit tests |
| **M4 — Run engine + scheduler** | Durable runs, cancellation, parallelism, checkpoints, reminders, background jobs | Crash/restart tests; cancellation test |
| **M5 — Memory** | SQLite schema, FTS5 retrieval, fact supersession, preference extraction, episode summaries | Migration test; retrieval quality fixture set |
| **M6 — Conversation + context** | Turn state, compaction, context budget, proactive triggers | Token-budget tests; interruption tests |
| **M7 — Voice** | Gemini Live session, audio pipeline, VAD/barge-in, EN/TE/HI | Live session test with device audio; latency measurement |
| **M8 — Desktop** | Electron shell, typed IPC, React voice-first UI, approvals UI, i18n | Packaged build on all three platforms; IPC auth test |
| **M9 — MCP** | Official SDK client, server management, trust + governance overlay | Connect to one known server; policy denial test |
| **M10 — Optional coding mode** | Repo indexing, code tools, diff/verify (separate package) | Only if the product retains coding assistance |

**Rules:** do not port module-by-module mechanically; port *behaviour with tests*. Do not carry over Chroma, the seven-phase pipeline, the specialist registry, the custom MCP protocol, or the unauthenticated bridge. Each stage must keep the previous stage's tests green.

---

## 31. Risks, uncertainties and blockers

| # | Risk | Severity | Evidence | Mitigation |
|---|---|---|---|---|
| 1 | Removing code without replacing behaviour (Mode B, recovery) loses only simulated capability — but users may believe it works today | High | §17.3, `task_board_pipeline.py:1133`, `runner.py:29-31` | Communicate that removal is of non-functional paths; keep tests as specification |
| 2 | Uncommitted TypeScript scaffold breaks packaging tests and creates ambiguity about “current” state | Medium | `test_npm_packaging.py` 3 failures; `package.json` 3.0.0 vs expected 2.4.5; ESM `require` at `bin/aelvo.js:21` | Architect must decide: commit, branch, or discard the scaffold **before** any migration |
| 3 | Python-only code intelligence (`ast`) cannot analyse Python after a TS move | Medium | `repo_intelligence/parser.py` uses `ast`; no Tree-sitter integration | Tree-sitter grammars, or drop coding mode |
| 4 | Google SDK/API drift; Live API is not exercised anywhere | High | `google.generativeai` deprecation warning at import; no Live code exists | Pin `@google/genai`; build a Live spike before committing to voice |
| 5 | Security boundary is weaker than the product requires | **Critical** | No production approvals; unauthenticated WS (`web_bridge.py:505-575`); command execution not confined; `.exe`-only sandbox | Treat §28 security service as a launch blocker, not a later phase |
| 6 | OS control, screen understanding, calendar, email, scheduling, wake-word do not exist | **Critical (capability gap)** | No matching modules or tools found | Budget as new construction, not migration |
| 7 | Voice latency, echo/barge-in and multilingual accuracy are unverified on target hardware | High | No audio path exists to test | Spike on Windows first; define latency budget (<800 ms turn start) |
| 8 | Rust sidecar cross-platform builds and code signing | Medium | Only Windows `.exe` path supported; `cargo` unavailable here | CI matrix with per-platform artifacts; fallback to Node policy engine |
| 9 | Memory data migration from Chroma/SQLite to a new schema | High | `MemoryEngine`, `ForgeMemory`, `MemorySearcher`; Chroma absent here so contents unverified | Export to JSONL first; verify counts and sampled semantics |
| 10 | Background/proactive execution reliability (duplicate runs, missed reminders, resume after sleep) | Medium | No scheduler exists; `EventBus` is in-memory (`runtime_next/events/bus.py`) | Durable SQLite queue with leases and idempotency keys |
| 11 | Test signal is weaker than the count suggests | Medium | 2,668 tests, but many assert mocks/internal calls; 15 fail at baseline; Mode B tests assert simulation | Add end-to-end tests for real side effects; don't use pass count as readiness |
| 12 | LOC/TS estimates are analytical, not measured | Medium | §27 methodology | Re-baseline after scenario selection |
| 13 | Unverified third-party/provider claims (Azure/Bedrock/Vertex, 22 providers) | Medium | §15; adapters dead; no native clients | Verify or drop from catalogue |

### 31.1 Environmental blockers (this audit)

- `cargo` not installed and `sandbox_core/target` absent → Rust cannot be compiled or tested here; all Rust findings are **static**.
- No live model calls were made; Gemini/Google behaviour is **unverified**. One OpenAI credential exists in the environment but was deliberately unused.
- `web/dist` and `web/node_modules` are absent → dashboard cannot be served or visually verified.
- `chromadb`, `scrapy`, `websockets`, `ruff`, `playwright` are missing from the audit venv → several baseline tests fail for environmental reasons.
- No microphone/audio device test was attempted; no macOS/Linux execution was possible (Windows host only).

---

## 32. Test execution evidence

All commands were run from the repository root with `./.venv/Scripts/python.exe` (Python 3.13.16, Node 26.13.0, Windows). No test modified tracked files.

| Suite | Command | Result |
|---|---|---|
| Main (`tests/`) | `pytest tests -q --tb=no --continue-on-collection-errors` | **2,022 passed, 14 failed, 7 skipped, 1 collection error** in 74.27 s |
| `auth/tests` | `pytest auth/tests -q` | 139 passed |
| `cognition/tests` | `pytest cognition/tests -q` | 95 passed |
| `runtime_next/tests` | `pytest runtime_next/tests -q` | 154 passed, 1 failed |
| `runtime_next/plan/tests` | `pytest runtime_next/plan/tests -q` | 236 passed |
| **Aggregate** | — | **2,646 passed, 15 failed, 7 skipped, 1 collection error** (baseline; the main-suite failure count moved from 13 to 14 between runs, indicating order/env sensitivity in at least one test) |

### 32.1 Exact baseline failures and causes

| Failing test | Cause | Classification |
|---|---|---|
| `test_forge.py::test_linter_returns_structured_violations` | `ruff` not installed in venv | Environment |
| `test_forge.py::test_formatter_changes_file` | `ruff` not installed | Environment |
| `test_forge.py::test_memory_write_and_retrieval_roundtrip` | `chromadb` not installed | Environment |
| `test_fs_python_fallback.py::TestFallbackFileOperations::test_python_exec` | `python` not on `PATH` (Windows Store stub); script not executed | Environment |
| `test_npm_packaging.py::test_package_json_exists_and_names_bin` | Uncommitted `package.json` version 3.0.0 vs expected 2.4.5, `bin` → `dist/` | **Uncommitted migration work** |
| `test_npm_packaging.py::test_launcher_resolves_python_and_sets_data_dir` | `ReferenceError: require is not defined in ES module scope` (`bin/aelvo.js:21`) | **Uncommitted migration work** |
| `test_npm_packaging.py::test_postinstall_script_registered` | `bin/install.js` no longer registered/expected shape | **Uncommitted migration work** |
| `test_phase14_monitoring_integration.py::test_engine_health_checks_run` | Monitoring integration assertion drift | Code/design |
| `test_phase14_monitoring_integration.py::test_engine_dashboard_snapshot` | Same | Code/design |
| `test_shutdown.py::test_check_tools_thread_based` | Thread-based shutdown assumption no longer holds | Code/design |
| `test_system_prompt_cache.py::TestLazyHeavyImports::test_kernel_defers_chromadb_to_first_use` | `chromadb` missing | Environment |
| `test_system_prompt_cache.py::TestLazyHeavyImports::test_consensus_extended_defers_chromadb` | `chromadb` missing | Environment |
| `test_system_prompt_cache.py::TestLazyHeavyImports::test_web_scraping_defers_scrapy` | `scrapy` missing | Environment |
| `test_system_prompt_cache.py::TestLazyHeavyImports::test_spider_rebasing_produces_valid_scrapy_spider` | `scrapy` missing | Environment |
| `runtime_next/tests/test_capability_registry.py::test_tool_detection` | Capability detection environment expectation | Environment |
| `tests/test_web_bridge_providers.py` (collection) | Imports `websockets`, which is not installed | Environment |

### 32.2 What the green tests do and do not prove

- They prove that many pure functions, schemas and mock-driven branches behave as asserted.
- They **do not** prove that the seven-phase pipeline reasons in phases (it makes one call), that Mode B executes work (it simulates), that verification catches semantic errors (it compiles), that specialists run (only `execute()` never called; prompts only), or that the web bridge is safe (no auth tests).
- `tests/test_verification_driven_recovery.py` and `tests/test_task_board_pipeline.py` pass while asserting simulated behaviour; a passing test is not evidence of product capability.

### 32.3 Isolated runtime probes

| Probe | Result |
|---|---|
| `python -m cli.aelvo --version` | 0.78 s, prints version |
| `--list-providers` | 22 provider IDs listed |
| One-shot boot without provider | 4.19 s to prompt, then graceful exit with no-provider message |
| Scripted `medium`-mode turn (isolated workspace) | 2 LLM calls, `status: success`, node `COMPLETED`, **`file_exists: false`** — tool never executed |

Full scripts: `audit_artifacts/analyze.py`, `audit_artifacts/build_inventory.py`, `audit_artifacts/probe_medium_mode.py`.

---

## 33. Independent architect decision checklist

Each item is a decision the auditor is **not** authorized to make. Evidence pointers are given.

**Scope and product**
1. Is coding assistance retained as an optional capability, or removed from the product entirely? (§9, §17.2)
2. Is multi-provider support a product requirement, or is Google Gemini the only first-class provider? (§15)
3. Which of the listed personal capabilities (calendar, email, screen understanding, OS control) are in v1? None exist today (§31 #6).
4. Is full offline/local operation required beyond the model provider? (§28.4)

**Architecture**
5. Accept Scenario A, B or C — or a hybrid? (§24–§27)
6. Should the future runtime be one Node daemon + Electron renderer, or an in-process Electron architecture? (§28.1)
7. Is a long-lived Rust security sidecar acceptable, or must it remain one-shot? (§22)
8. Should the CLI remain a first-class interface or become a developer tool? (§16, §18)
9. Is a durable run/scheduler model required in v1, or is in-memory enough for reminders? (§31 #10)

**Security**
10. Approve the capability/approval model before any OS-control work? (§12, §28.2)
11. Is the current path jail sufficient as the filesystem boundary, or is OS-level sandboxing (AppContainer/seccomp/sandbox-exec) required? (§12)
12. How are credentials stored per platform: OS keychain only, or keychain + encrypted fallback? (§22)
13. What is the audit retention and export policy? (§28.3)
14. Is the local API exposed only to the renderer, or to third-party extensions? (§28.2)

**Migration**
15. What happens to the uncommitted TypeScript scaffold: commit, branch, or discard? (§31 #2)
16. Is a shadow-run/differential period required before switching entry points? (§29 R4)
17. Which memory data must be migrated versus intentionally discarded? (§31 #9)
18. Are the 14 baseline failures fixed, accepted, or removed with their code? (§32.1)
19. Which tests become the behavioural specification for the port? (§32.2)
20. What is the acceptable boot latency and first-audio latency budget? (§31 #7)

**Governance**
21. Who signs off on Group F protected components? (§19)
22. What is the rollback plan per removal phase? (§29)
23. Is the earlier TypeScript migration’s `package.json`/`tsconfig`/`vitest` work to be preserved as reference? (Required by the brief: do not discard without a decision.)

---

## 34. Final evidence-backed recommendation

**Recommendation: Scenario B — Balanced transformation**, with an aggressive first slice.

**Why B, on evidence:**

1. A small set of assets is genuinely valuable and hard to rebuild: the path jail and audit primitives (`fs_jail.rs`, `audit.rs`), the structured tool contract (`tool_registry.py`), tolerant tool parsing, session compaction, provider adapters, the credential vault, the approval/governance semantics, the event/plan contracts, and the MCP trust layer. These are worth extracting (§20–§21).
2. Most of the codebase is either inert or coding-specific: ~19k LOC is in the dead/facet union and 22,147 LOC is statically unreachable; specialists are prompts; repo intelligence, learning, architect planning and cognition are engineering-oriented (§7, §17). Porting them would import ~80k LOC of complexity with no product value.
3. The current execution model cannot support the future product: the `medium` tool path silently no-ops, `high` makes one consolidated call, `max` simulates, there is no voice, no scheduler, no OS control and no authenticated bridge (§4, §17.3, §31). A line-by-line port would preserve these defects.
4. Established libraries replace large custom stacks without loss: `@google/genai`, the official MCP TS SDK, SQLite/FTS5 instead of Chroma, Zod, Pino, Playwright (§22).
5. The security requirements of a voice-first OS-level assistant are stricter than the current system, which has no production approval gate and an unauthenticated local WebSocket (§12). Security must be a launch blocker, not a migration afterthought.

**What to do first, in order:**

1. **Resolve repository state.** Decide the fate of the uncommitted TS scaffold and commit/branch it; record the baseline. No deletion before this.
2. **Prove the voice path.** A two-week Gemini Live spike on Windows: audio in/out, barge-in, Telugu/Hindi, measured latency. If it fails, the product plan changes before any migration.
3. **Build the security spine.** Capability model, approvals, audit, path/process policy, authenticated IPC. Extract `fs_jail`/`audit`/`resource` and the approval semantics.
4. **Extract the portable primitives** (Phase R2) with tests, leaving originals untouched.
5. **Build the new runtime** (run engine, tool gateway, provider gateway, memory, scheduler) behind a feature flag; shadow-run representative turns.
6. **Switch, then delete** (R6–R8) only after differential evidence.

**What not to carry forward:** the seven-phase pipeline, specialist registry, blackboard/consensus, task-board simulation, repository intelligence as a core subsystem, learning accumulators, Chroma, Scrapy, the custom MCP protocol, the unauthenticated web bridge, and the Python installer.

**Confidence:** high on the removal/retention classification of dead and coding-specific code (static import graph plus execution probes); medium on provider and frontend reuse (no live calls, no built frontend); low on voice, OS control and scheduling, which are new construction and unverified. Every recommendation above is traceable to a path and line in this report or in the JSON artifacts.

**This audit stops here.** No files were deleted, no production code was modified, no migration was started or continued, no Git history was altered, and no changes were pushed. The final architecture decision belongs to the independent architect.
