# AELVO — Proposed Removal Manifest

**Status:** proposal only. Nothing in this document has been executed. It is input to an independent architect's decision, not an approved plan.

**Baseline:** `main` @ `50af66544df0eed935ea4b0119303d7f78d26ce4`, 66 commits, dirty working tree. Production Python measured at 388 files / 107,599 physical LOC; tests 103 files / 45,444 LOC; Rust 5,777 LOC; React/TS 4,613 LOC.

**Companion documents:** `AELVO_ARCHITECTURE_AUDIT.md` (full evidence), `AELVO_MODULE_INVENTORY.json` (per-module disposition), `AELVO_DEPENDENCY_GRAPH.json` (edges, cycles, unreachable set, blast radius).

---

## 1. How this manifest was built

1. Enumerated every `.py`, `.ts`, `.tsx`, `.rs`, `.js` file outside vendored/build/cache directories.
2. Built an AST import graph over production Python (377 nodes, 1,077 edges), computed SCCs and reachability from declared entry points (`main.py`, `cli/`, `web/server.py`), and cross-checked against runtime wiring.
3. Read each candidate's actual call sites; "no importer" was treated as a finding, not proof of deadness, and dynamically loaded modules were excluded from automatic removal.
4. Reproduced the `medium`-mode no-op in an isolated workspace (`audit_artifacts/probe_medium_mode.py`) to separate "unwired" from "broken".
5. Assigned risk from blast radius, test coupling, persisted-data impact, and whether a replacement already exists.

**Confidence scale:** High = static graph + execution evidence agree; Medium = static evidence, no execution; Low = inferred, needs a spike.

**Risk scale:** Low = isolated, no persistence, no user-visible capability; Medium = a live path or shared contract is affected, replacement exists; High = removal changes user-visible behaviour or persisted data; Critical = security boundary.

**Important:** a directory-level entry is not a claim that every file in it is removable. Per-file dispositions are in `AELVO_MODULE_INVENTORY.json`; exceptions are called out below.

---

## 2. Summary

| Group | Meaning | Candidates | Measured LOC | Risk | Earliest phase |
|---|---|---|---:|---|---|
| **A** | High-confidence independent removals (no production dependents) | 77 files | 14,976 | Low | R1 |
| **B** | Coding-specific removals (if coding is not a retained capability) | ~65 files | ~27,300 | Medium–High | R7 |
| **C** | Dependency-sensitive removals (need extraction/redesign first) | 8 module groups | ~12,600 | High | R7 |
| **D** | Redundant implementations (after consolidation/replacement) | ~50 files | ~20,200 | Medium | R3–R7 |
| **E** | Optional capabilities (leave core, may survive as extensions) | ~115 files | ~34,600 gross | Low to core | R7 |
| **F** | Protected components (no removal without explicit review) | ~20 files | ~7,700 | Critical | — |

Group totals overlap: E contains B, and D overlaps C. Do not add the column.

---

## 3. Group A — High-confidence independent removals

These have no production importer. Removal deletes capability that is not reachable today; the only real loss is the option to revive it.

**A1. `auth/providers/` — 22 provider adapters — 1,645 LOC — Risk: Low — Sequence: R1.1**

- Files (all under `auth/providers/`): `__init__.py`, `anthropic.py`, `azure.py`, `base.py`, `bedrock.py`, `cohere.py`, `deepseek.py`, `fireworks.py`, `google.py`, `groq.py`, `huggingface.py`, `llamacpp.py`, `lm_studio.py`, `mistral.py`, `ollama.py`, `openai.py`, `openrouter.py`, `perplexity.py`, `together.py`, `vertex.py`, `vllm.py`, `xai.py`.
- Direct dependents: none. The live runtime builds SDK clients in `main.py` and `core/provider_runtime.py`.
- Transitive impact: 0 modules.
- Prerequisites: none. Tests that import these adapters must be removed or retargeted to the live provider path.
- Functionality lost: a per-provider class abstraction that is not used by the product; the providers themselves remain available through `auth/adapters/*` and the live clients.
- Replacement: `auth/adapters/*` (used) plus a small typed adapter interface in the new provider gateway.
- Note: `azure.py`, `bedrock.py`, `vertex.py` are dead *and* incomplete (no deployment/base-url mapping, no native SDK), so removal also removes false capability.

**A2. `auth/auth/` — 9 legacy auth modules — 1,715 LOC — Risk: Low — Sequence: R1.2**

- Files (all under `auth/auth/`): `__init__.py`, `api_key.py`, `browser.py`, `cloud.py`, `local.py`, `oauth.py`, `provider.py`, `refresh.py`, `session.py`.
- Dependents: none. `main.py` uses `CredentialStore` (`auth/cred_storage.py`) and provider SDK keys directly.
- Prerequisites: confirm no external user relies on OAuth/browser login; the live product only supports API keys.
- Lost: OAuth/browser sign-in and cloud credential discovery (`boto3`, `vertexai` imports only exist here).
- Replacement: OS keychain + API keys; OAuth can return later if a provider requires it.
- Data: no production tables; no migration needed.

**A3. `auth/events/` — 2 files — 229 LOC — Risk: Low — Sequence: R1.3**

- Files (all under `auth/events/`): `__init__.py`, `provider_events.py`.
- Dependents: none. Provider health is polled/derived elsewhere.
- Lost: an unused event vocabulary for provider state changes.

**A4. `auth/ratelimiter.py` — 125 LOC — Risk: Low — Sequence: R1.3.** No importers. Replacement: per-provider limiter in the new gateway (not needed for a single-user assistant initially).

**A5. `auth/circuit_breaker.py` — 150 LOC — Risk: Low — Sequence: R1.3.** No importers; `core/provider_runtime.py` has its own fallback/breaker logic.

**A6. `auth/runtime/streaming.py` — 247 LOC — Risk: Low — Sequence: R1.3.** No importers; the used streaming path is `auth/adapters/streaming.py` + `core/orchestration/stream_filter.py`.

**A7. `learning/` except `agent_metrics.py` — 14 files — 6,209 LOC — Risk: Low — Sequence: R1.4**

- Files (all under `learning/`): `__init__.py`, `accumulator.py`, `analytics.py`, `classifier.py`, `collaboration_accumulator.py`, `confidence.py`, `consensus_memory.py`, `delta.py`, `engine.py`, `knowledge_graph.py`, `specialist_adapter.py`, `specialist_effectiveness.py`, `subgraph.py`, `types.py`.
- Dependents: none in production. `learning/agent_metrics.py` is imported by the web bridge and must stay (or move to `runtime_next/monitoring`).
- Prerequisite: `learning/types.py` imports `repo_intelligence.types`; if repo intelligence is removed later, this link disappears with it. Remove learning **before** repo intelligence to break that edge.
- Lost: dependency-pattern accumulation, specialist effectiveness scoring, consensus memory, confidence calibration for coding tasks. No runtime behaviour changes.
- Replacement: none required for the personal assistant; explicit preference memory covers user adaptation.
- Tests to delete with it: `tests/test_learning.py`, `tests/test_autonomous_learning.py`, `tests/test_specialist_adapter.py`, plus learning-specific cases in cognition tests.

**A8. `mcp/integrations/` — 20 files — 1,968 LOC — Risk: Low — Sequence: R1.5**

- Subtrees: `execution_graph/` (3 files), `long_horizon_planning/` (2), `repository_intelligence/` (2), `specialists/` (13).
- Dependents: none; these modules import orchestration/specialists, never the reverse.
- Lost: MCP bindings for coding specialists and execution graphs — none registered at runtime.
- Prerequisite: none. Remove before specialists so the specialist removal has fewer importers.

**A9. `core/workers/` — 2 files — 210 LOC — Risk: Low — Sequence: R1.6.** `python_worker.py` is unreferenced; shutdown tests refer to thread helpers elsewhere.

**A10. `core/execution/experience_pipeline.py` — 940 LOC — Risk: Low — Sequence: R1.6.** No runtime consumer; an engineering “experience” pipeline.

**A11. `shared_task_board/{models,context_schemas,result_schemas,collaboration_orchestrator}.py` — 1,538 LOC — Risk: Low — Sequence: R1.7**

- Dependents: none. `shared_task_board/board.py`, `task.py`, `state_machine.py`, `__init__.py` remain for Mode B until Mode B itself is retired.
- Lost: an unused collaboration orchestrator and schemas. Mode B does not import them.
- Prerequisite: verify `shared_task_board/__init__.py` exports don't pull them eagerly (it does export some names; trim exports in the same commit or keep the package import working).

**Group A total: 77 files, 14,976 LOC. Expected test impact: ~120–180 tests removed or retargeted; production behaviour unchanged.**

---

## 4. Group B — Coding-specific removals

These are the software-engineering core. They are removable only if the product does not retain a coding capability, and only after the new runtime no longer imports them.

**B1. `repo_intelligence/` — 12,914 LOC — Risk: High — Sequence: R7.1**

- Direct dependents: `main.py`, `cognition/planner.py`, `cognition/engine.py`, `specialists/architect.py`, `specialists/oracle.py`, `learning/*` (removed in A7), `mcp/integrations/repository_intelligence/*` (removed in A8), `tools/*` (index/search), `web` knowledge endpoints.
- Transitive: 9+ modules; part of the `main.py` cycle.
- Prerequisites: (a) remove learning and `mcp/integrations`; (b) if cognition/planning survive, extract `repo_intelligence/types.py` and the scanner/parser interfaces they use; (c) remove the web knowledge views.
- Lost: repository indexing, AST/regex parsing, dependency/call graphs, code health, risk/drift/impact analysis, repository memory.
- Transferable subset if an optional coding mode is kept: `scanner.py` (language map), `parser.py` (tolerant AST), `graph.py` (generic node/edge builder), `types.py`. Roughly 1,500–2,500 LOC.
- Replacement: Tree-sitter + a much smaller index if coding returns; otherwise nothing.
- Note: this is the single largest subsystem and has no role in voice, OS control, scheduling, memory or personal productivity.

**B2. `specialists/` — 6,328 LOC — Risk: High — Sequence: R7.2**

- Files (all under `specialists/`) include `hermes.py`, `architect.py`, `oracle.py`, `forge.py`, `sentinel.py`, `terminus.py`, `herald.py`, plus `registry.py`, `base.py`, `context.py`, `router.py`.
- Direct dependents: `core/orchestration/orchestrator.py`, `pipeline.py`, `router.py`, `task_board_pipeline.py`, `context_builder.py`, `specialists/__init__.py`, `runtime_next/capability/registry.py`, removed `mcp/integrations`.
- Prerequisites: new coordinator + prompt assembly; remove specialist references from runtime capability registry and web agent views.
- Lost: seven prompt-only personas, per-specialist tool allowlists, post-processing that writes specialist memory. **No specialist `execute()` is called on the high path** (§11), so no executed capability is lost.
- Replacement: one system prompt + optional prompt fragments selected by intent; no agent objects.
- Data: specialist memory entries are coding data; migrate only if the architect wants historical continuity (not recommended).

**B3. `tools/{code_tools,git_tools,diagram_tools}.py` — 877 LOC — Risk: Medium — Sequence: R7.3**

- Dependents: `tools/__init__.py` registration, `main.py` tool wiring, tests.
- Prerequisites: new tool registry; keep `research_tools.py`/`security_tools.py` dispositions separate (optional).
- Lost: run tests/lint/format, git operations, diagram generation.
- Replacement: optional coding extension, or none.

**B4. `core/system_prompt.py` — 220 LOC — Risk: Low — Sequence: R7.4.** The coding JSON tool protocol prompt. Keep as a behavioural reference for the new prompt; do not ship as product copy.

**B5. `runtime_next/plan/` — 6,948 LOC production (12,043 with tests) — Risk: High — Sequence: R7.5**

- Files: `architect.py`, `architect_types.py`, `builder.py`, `calibration.py`, `intelligence.py`, `allocator.py`, `brain/*` (19 files).
- Direct dependents: `runtime_next/engine/*` (plan execution), `orchestration/pipeline.py`, `cli`, tests (5,095 LOC).
- Prerequisites: extract `ExecutionPlan`/node/edge/parallel-group contracts (`runtime_next/models/plan.py`) and the general scheduler semantics; then remove architect/brain/calibration.
- Lost: architectural plan synthesis, calibration, debt/risk forecasting, self-critique planning. None is used for personal tasks.
- Replacement: a task/step planner in the new runtime (LLM tool-calling + explicit step list).

**Group B total: ~27,300 production LOC (plus ~5,100 test LOC).**

**Deletion-order caution:** B1 and B2 sit inside the `main.py` import cycle. Attempting either before the new coordinator exists will break the CLI, web server and most integration tests at once. B5 must follow the extraction in R2.

---

## 5. Group C — Dependency-sensitive removals

These modules are live today. They cannot be deleted until their reusable parts are extracted (§21 of the audit) and a replacement path exists. Each entry lists the extraction that must land first.

| ID | Path | LOC | Direct dependents | Extraction prerequisite | Lost functionality | Replacement | Risk | Sequence |
|---|---|---:|---|---|---|---|---|---|
| C1 | `core/orchestration/orchestrator.py` | 1,751 | `main.py`, `cli/*`, `web/*` | Tool-loop semantics, mode selection, node runner, direct-turn path | Mode routing (`low`/`medium`/`high`/`max`), conversation turn loop, session persistence, tool dispatch | New `RunCoordinator` + tool gateway | High | R7.6 |
| C2 | `core/orchestration/pipeline.py` | 1,756 | `orchestrator.py`, `main.py` | Context construction, per-phase attribution metadata, single-call prompt assembly | Seven-phase bookkeeping, consolidated prompt, domain reminders | `ContextBuilder` + one provider call | High | R7.7 |
| C3 | `core/orchestration/task_board_pipeline.py` | 1,332 | `web/web_bridge.py`, `cli/*` | Task state machine semantics, progress events | Mode B (simulated execution), task-board flows | Personal task/workflow service | High | R7.8 |
| C4 | `main.py` | 1,796 | `cli/*`, `web/server.py` (cycle) | Provider client construction, tool registration, boot sequence, per-folder state | In-process `AelvoAgent`, one-shot `-p` mode, `.aelvo` workspace bootstrap | Node daemon + provider gateway | High | R7.9 |
| C5 | `cli/` (all) | 3,309 | `main.py` (cycle) | Slash-command semantics, provider picker, boot fast-path | Interactive REPL, `--list-providers`, `--version`, one-shot mode, workspace selection | Optional dev CLI over local API | High | R7.10 |
| C6 | `web/web_bridge.py`, `web/server.py` | 1,224 | `main.py`, `web/web_bridge.py` handlers | Event envelope mapping, FS handlers (reuse semantics only) | Dashboard RPC, provider key management, file browser API | Authenticated Electron IPC / local API | High | R7.11 |
| C7 | `core/provider_runtime.py` | 898 | `main.py`, `cli/boot.py`, `cli/providers.py` | Registry, health, usage, fallback/breaker ideas | Client lifecycle, fallback chain, usage accounting | Provider gateway over `@google/genai` + adapters | High | R7.12 |
| C8 | `core/governance/kernel.py` | 548 | FS, tools, orchestrator, CLI, web | Constraint/honesty checks; memory engine must be split out first | Constraints, honesty guard, audit hook, RAG + memory engine | `governance/constraints` + `memory` service | High | R7.13 |

**C-group total: ~12,600 LOC.**

**Critical data note:** C8 owns the memory engine (`core/governance/kernel.py` instantiates RAG and memory). Deleting it without migrating the SQLite/Chroma contents destroys the only personal data the system persists. Export and verify first.

**Critical contract note:** `runtime_next/models/plan.py` (316 LOC) and `runtime_next/models/events.py` are imported across C1–C4. They are **not** removal candidates; they are extraction candidates (Group F).

---

## 6. Group D — Redundant implementations

Remove only after the surviving implementation is consolidated and the old surface has no callers.

| ID | Path | LOC | Redundancy | Consolidation target | Prerequisite | Risk | Sequence |
|---|---|---:|---|---|---|---|---|
| D1 | `auth/config.py` | 862 | Second provider catalogue (20 vs 22) | One catalogue from `core/registry/models.py` after verification | Reconcile model IDs and defaults | Medium | R3.1 |
| D2 | `auth/runtime/*` (minus `streaming.py`) | 2,495 | Registry, health, usage, fallback, retry, session, tool-call adaptation duplicated by `provider_runtime` and `main.py` | Provider gateway | C7 replacement exists | Medium | R7.14 |
| D3 | `auth/monitoring/*` (786) + `runtime_next/monitoring/*` (1,791) | 2,577 | Three metric/health collectors | One observability module | Metrics surface agreed | Medium | R3.2 |
| D4 | `auth/diagnostics/*` | 742 | Doctor/health/comparison reports | Optional `doctor` command only | CLI decision | Low | R7.15 |
| D5 | `mcp/capability/*` (569), `mcp/client/*` (727), `mcp/transport/*` (626), `mcp/registry/*` minus `trust_manager.py` (761) | 2,683 | Reimplements MCP protocol and connection management | Official TypeScript MCP SDK | SDK spike passes | Medium | R9 |
| D6 | `core/rag/*` | 1,279 | Third retrieval implementation | SQLite FTS5 in memory service | Memory migration | Medium | R5.3 |
| D7 | `core/execution/tool_registry.py` | 641 | Structured registry never wired; live registry is a dict | New tool gateway (port the contract, not the file) | Tool gateway built | Low | R4.2 |
| D8 | `runtime_next/verification/*` | 5,227 | Four verification notions (compile/AST/regex/specialist) | Outcome verification + explicit checks | New verification design | Medium | R7.16 |
| D9 | `runtime_next/security/*` | 2,419 | Duplicate policy engine | Security service | Policy merge | Medium | R7.17 |
| D10 | `mcp/governance/*` (724) + `mcp/verification/*` (524) | 1,248 | Two policy/verification layers inside MCP | `integrations/mcp-policy` overlay | Trust manager extracted | Low | R9.2 |

**D-group total: ~20,200 LOC** (some files also appear in C or F; do not double-count when scheduling).

---

## 7. Group E — Optional capabilities

These should leave the core architecture but may survive as separately loaded extensions. Removing them from core is low risk **if** the interfaces are cut first.

| Capability | Paths | LOC | Why optional | Extraction boundary |
|---|---|---:|---|---|
| Coding mode | `repo_intelligence/` (12,914), `tools/{code,git,diagram}_tools.py` (877) | 13,791 | No role in voice/OS/personal productivity | `coding` package + explicit tool namespace |
| Long-horizon planning | `planning/` (4,191), `runtime_next/plan/` (6,948) | 11,139 | Engineering plan synthesis; personal tasks need a simpler planner | `planning` extension over the run engine |
| Multi-agent cognition | `cognition/` (6,574) | 6,574 | Blackboard/consensus/strategy memory are unexercised outside tests | Optional research extension |
| Task-board collaboration | `shared_task_board/{board,task,state_machine}.py` (1,123) | 1,123 | Mode B is simulated; personal tasks are simpler | Workflow state machine in core |
| MCP extras | `mcp/recovery/` (456), `mcp/memory/` (739), `mcp/events/` (488) | 1,683 | Not required by the protocol; governance/trust is what matters | Optional MCP plugins |
| Web research spider | `core/scraping/web_scraping.py` | ~300 | Browser automation will be a new Playwright tool | Optional research tool |
| Provider diagnostics | `auth/diagnostics/*` | 742 | Developer convenience | Optional CLI command |

**E gross total: ~34,600 LOC** (overlaps Group B; the coding mode and planning entries are counted there).

---

## 8. Group F — Protected components

No removal without explicit security/data review. These carry the only durable value or the only security guarantees in the repository.

| Path | LOC | Why protected | Review owner |
|---|---:|---|---|
| `sandbox_core/src/fs_jail.rs` | 1,340 | Only real path containment (symlink/hardlink/ADS handling) | Security |
| `sandbox_core/src/audit.rs` | 475 | Audit schema/emission | Security |
| `sandbox_core/src/resource.rs` | 476 | Resource governor | Security |
| `sandbox_core/src/policy.rs` | 484 | Command allow/deny policy (needs redesign, not deletion) | Security |
| `sandbox_core/src/threat_detection.rs` | 676 | Threat scoring | Security |
| `auth/cred_storage.py` | 614 | Credential encryption/metadata | Security |
| `core/filesystem/automation.py` | 864 | File-tool semantics, fallback behaviour, jail invocation | Runtime |
| `core/governance/kernel.py` | 548 | Constraints/honesty/audit + memory ownership | Runtime + data |
| `auth/adapters/*` | 675 | Provider normalisation | Providers |
| `runtime_next/models/plan.py` | 316 | Shared plan contract | Runtime |
| `runtime_next/models/events.py` + `runtime_next/events/*` | 149 | Event contract | Runtime |
| `core/execution/tool_registry.py` | 641 | Correct tool-contract shape (unused) | Tools |
| `memory/user_model.py` | 300 | Personal preference semantics | Product |
| `config/settings.py` | 131 | Thresholds/timeouts | Runtime |

**F total: ~7,700 LOC. None of these is a removal candidate in any scenario; each is a port/extraction candidate.**

---

## 9. Recommended deletion sequence

No step may run until the previous step's gate is green and the independent architect has approved the phase.

| Step | Delete | Gate | Expected effect |
|---|---|---|---|
| R1.1 | `auth/providers/` | No import errors; auth tests retargeted | −1,645 |
| R1.2 | `auth/auth/` | API-key login still works | −1,715 |
| R1.3 | `auth/events/`, `auth/ratelimiter.py`, `auth/circuit_breaker.py`, `auth/runtime/streaming.py` | Provider calls unaffected | −751 |
| R1.4 | `learning/` minus `agent_metrics.py` | Web metrics import intact | −6,209 |
| R1.5 | `mcp/integrations/` | MCP server path unaffected | −1,968 |
| R1.6 | `core/workers/`, `core/execution/experience_pipeline.py` | Shutdown/FS tests pass | −1,150 |
| R1.7 | Dead `shared_task_board` modules | Mode B imports intact (trim `__init__` exports) | −1,538 |
| R1.8 | Tests that only cover removed modules | Suite green at baseline or better | — |
| R2 | **Extract, do not delete** portable primitives | New tests pass; originals untouched | 0 |
| R3 | Consolidate provider catalogue/metrics behind existing APIs | Behavioural parity | 0 |
| R4 | Build new runtime/gateway/security behind a flag | Differential tests | 0 |
| R5 | Migrate memory data | Counts + sampled semantics verified | 0 |
| R6 | Switch entry points | Same user-visible outcomes | 0 |
| R7 | Remove Group B/C/D after replacements are proven | Full suite + smoke on all platforms | −40,000 to −50,000 |
| R8 | Remove Python runtime packaging | Node/Electron install and launch | — |
| R9 | Replace custom MCP protocol with SDK | One server connected; denial test | −2,683 |

**Hard ordering constraints**

1. A7 (`learning`) before B1 (`repo_intelligence`) — learning imports repo types.
2. A8 (`mcp/integrations`) before B2 (`specialists`) — it imports them.
3. A11 (dead board modules) before C3 (Mode B pipeline) — Mode B must still import `board.py`/`task.py`.
4. C8 memory split before any deletion touching `core/governance/kernel.py`.
5. New authenticated bridge before C6 deletion.
6. `sandbox_core` must remain (and its `.exe` path must be replaced, not deleted) until the new security service ships.

---

## 10. Validation checklist for this manifest

- [x] Every candidate has an exact path and measured LOC.
- [x] Every Group A candidate was checked for production importers (AST graph + grep).
- [x] Every Group C candidate lists its extraction prerequisite.
- [x] Persisted-data impact is called out (C8 memory, B2 specialist memory, R5 migration).
- [x] Security-critical assets are in Group F, not in any removal group.
- [x] Totals are labelled measured vs summed; overlaps are disclosed.
- [x] No deletion, rewrite, configuration change or Git operation was performed.

**End of manifest. This is a proposal for independent architectural review.**

