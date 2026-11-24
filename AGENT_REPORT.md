# AELVO — Codebase Report & Live Verification

**Date:** 2026-11-10
**Version:** 2.4.6 (`package.json`), commit `50af665`
**Scope:** read the codebase, describe how it works, then actually boot and run it.

---

## 1. Verdict

| Question | Answer |
|---|---|
| Is the project real, coherent code? | **Yes.** ~120k lines of Python + a React/TS web UI (~4.6k lines). |
| Does it boot? | **Yes.** CLI boots, scaffolds state, prints a banner, exits cleanly. |
| Are the tools functional? | **Yes.** 36 registered tools; 12 exercised live, all behaved correctly. |
| Does the agent loop run? | **Partly.** The loop, parser, and circuit breaker work; a wiring bug makes tool calls silently no-op in the default light path (see F1). |
| Can I confirm an end-to-end LLM turn? | **No.** No API key and no local model server on this machine. |

The system is a genuine multi-layer agent platform. It is also **not currently runnable end-to-end on this machine** for two independent reasons: no LLM credential, and no built web bundle.

---

## 2. What the project is

A folder-scoped autonomous coding agent. `Aelvo` opens a folder, jails all file operations to it, stores per-folder state in a hidden `.aelvo/` directory, and loops: **model emits JSON tool calls → kernel validates → sandbox executes → result fed back → repeat until `respond`**.

Three surfaces:

| Surface | Entry point |
|---|---|
| Terminal CLI | `python -m cli` (lean boot) or `python main.py` (full boot) |
| Web dashboard | `python main.py --web` → `web/server.py` (aiohttp + WebSocket bridge, serves `web/dist`) |
| npm wrapper | `bin/aelvo.js` → `package.json` `bin` (`aelvo`, `Aelvo`) |

### Layers

```
main.py                 boot, AelvoAgent (multi-provider LLM adapter), tool registry
cli/                    lean boot (boot.py), REPL (app.py), slash commands, effort modes
core/
  governance/kernel.py  AelvoKernel: constraints, validation, audit "episodes", circuit breaker
  execution/            command grammar, tool registry, experience pipeline
  filesystem/           jail + automation (read/write/edit/bash/python/scaffold)
  orchestration/        Orchestrator, RuntimePipeline, parser, task-board pipeline
  provider_runtime.py   22 providers, message normalization, fallback router + breaker
  system_prompt.py      the JSON tool protocol (FORMAT 1/2/3) incl. chat-only variant
  rag/, registry/, security/, scraping/, workers/
runtime_next/           execution graph, node runner, checkpointing, monitoring (100 files)
mcp/                    MCP platform: registry, discovery, verification, recovery (92 files)
cognition/ specialists/ planning/ learning/ repo_intelligence/ shared_task_board/
sandbox_core/           Rust sandbox (path policy, command allowlist)
web/                    React 19 + Vite dashboard, aiohttp server, WS bridge
```

### Turn flow (`core/orchestration/orchestrator.py`)

`execute_turn(agent, input, mode=...)` — four effort modes, persisted per folder in `.aelvo/mode`:

- **`low`** — one direct call, chat-only system prompt, no tools.
- **`medium`** — one direct call, full prompt, then `_execute_tool_loop` (tools on demand).
- **`high`** (default) — full consolidated pipeline `HERMES → ARCHITECT → ORACLE → FORGE → SENTINEL → TERMINUS → HERALD`.
- **`max`** — collaborative task-board Mode B (decompose, consensus, verify, recover).

`_execute_tool_loop` parses the model output into `tool_calls` or `kernel_command`, caps at `MAX_STEPS=30`, and stops after `MAX_CONSECUTIVE_FAILURES=3`. An empty `respond` renders the actual tool results instead of a blank answer. `core/governance/kernel.py:execute_turn` is the stricter legacy path: validate → check constraints → execute with a 90s timeout → honesty-check tool output against locked constraints → append an audit episode.

### Safety model

- Filesystem jailed to the workspace; traversal attempts rejected (`core/filesystem/automation.py`).
- Every tool call must carry a `rationale`; the prompt makes it mandatory.
- Rust sandbox with a command allowlist (`sandbox_core/src/policy.rs`).
- Tool output must match locked constraints or it is a "honesty violation" (`kernel.py`).
- Circuit breaker after 3 session failures.

---

## 3. What I ran

Interpreter: `.venv/Scripts/python.exe` (Python 3.13.16). Node 26.13.0.

### a) CLI boot

```
python -m cli --version
python -m cli --list-providers
python -m cli -w .tmp_agent_test --ask "create a file hello.py that prints hello"
```

- Banner, folder resolution, `.aelvo/` scaffolding: **works**.
- 22 providers listed with credential status: **works**.
- One-shot run with no key: **fails gracefully** — "No LLM provider is configured… set a provider + API key", exit code 0, no traceback. Nothing was written.

### b) Tool layer (no LLM involved)

Booted the real backend via `cli.boot.boot_backend()` and called the registry directly. **36 tools registered.**

| Result | Tool |
|---|---|
| success | `write_file`, `read_file`, `read_file_range`, `edit_file`, `grep_file`, `list_files`, `find_files`, `search_code`, `project_tree`, `bash_exec`, `save_constraint` |
| success | `search_memory` — vector hit returned (`TEST_TAG` → score 1.97) |
| correct rejection | `read_file("../../etc/passwd")` → "Path traversal detected" |
| **error** | `python_exec` → exit 9009 (see F2) |

Verified on disk: the edited file really contained `print('hello edited')`.

### c) Agent loop with a scripted model

Subclassed `AelvoAgent` and replaced `_call_llm` with a canned two-step script (tool call → `respond`), then called `Orchestrator.execute_turn`:

- **`low`**: 1 model call, tool JSON correctly suppressed → "tools are disabled in low mode". Correct by design.
- **`medium`**: 2 model calls, reported `status: success`, log said `Node … pending -> completed (Tool executed successfully)` — **but no file was written** (F1).
- **`medium` after wiring `orch.runtime_runner._tool_executor = orch._graph_tool_executor`**: file written, content correct. This isolates the cause exactly.

### d) Tests

```
python -m pytest tests/test_cli.py -q     →  90 passed in 16.22s
```
`pytest` was not installed in the venv; I installed `pytest` + `pytest-asyncio` to run this file. I did not run the full `tests/` suite.

### e) Not run

- **Web UI**: `web/node_modules` is absent (no bundle, `web/dist` missing) and `uvicorn` is not in the venv, so the dashboard could not be served. `aiohttp 3.14.5` is present.
- **`high` / `max` modes**: these call the LLM for HERMES analysis and specialist phases before any tool runs, so a scripted agent cannot stand in for them.

---

## 4. Findings

### F1 — BLOCKER: tool calls silently succeed without executing in `medium` mode

`core/orchestration/orchestrator.py:161` constructs `NodeRunner(None)`. The executor is wired only in the pipeline path (`:878`) and the forced-route path (`:1115`) — **not** in `_execute_direct_turn` (`:960`), which is the fast path for `low`/`medium`.

`_execute_tool_loop` (`:1408`) then dispatches every tool through `runtime_runner.run_node`. In `runtime_next/engine/runner.py:20-32`, when `_tool_executor` is `None` the node falls through to:

```python
return {"status": "success", "output": f"Node {node.id} executed"}
```

The loop sees `status == "success"`, transitions the node to `COMPLETED`, prints a ✓, and the model is told the tool worked. Verified: the agent reported "Created agent_medium.py", the log said the node completed, and the file did not exist.

Impact: `medium` is the "chat + tools" mode users are told to switch to, so tool use there is a silent no-op. Fix: wire `_tool_executor` in `_execute_direct_turn` (or in `Orchestrator.__init__`), and make `NodeRunner`'s fallback return `status: "error"` for an unhandled `TOOL_CALL` instead of a fake success.

### F2 — `python_exec` assumes `python` is on `PATH`

`core/filesystem/automation.py:846` builds `f"python {rel_script}"`. On this machine `python` resolves to the Windows Store stub, so every `python_exec` fails with exit 9009 even though a working interpreter is running the agent. Use `sys.executable` instead.

### F3 — No credential, no run

With no `.env` and an empty vault, `detect_provider` returns nothing and the CLI boots with `agent=None`. The UX is good (clear message, exit 0), but nothing agentic can happen until a provider is configured. Local runtimes are offered (`ollama`, `lm_studio`, `llama_cpp`, `vllm`) but no local server was running here.

### F4 — Web UI needs a build before it can be served

`main.py --web` serves `web/dist`, which is not committed and cannot be produced without `npm install` in `web/`. `uvicorn` is also missing from the venv. The dashboard is therefore not reachable from a clean checkout without a build step.

---

## 5. Honest limits of this verification

- **No real LLM was contacted.** Everything above is boot, tool, loop, and failure-path verification with a scripted model. Model-dependent behaviour (prompt adherence, JSON validity, `high`/`max` pipeline) is unverified.
- **Rust sandbox** (`sandbox_core/`) was not compiled or exercise-tested; tools ran through the Python fallback path.
- **MCP subsystem** (92 files) was not exercised — it is web-boot only and the CLI passes `mcp_cli=None`.
- Only `tests/test_cli.py` was executed, not the full suite.

---

## 6. Suggested next steps

1. Fix F1 (wire the executor + fail loudly on unhandled tool calls) — it is a silent-correctness bug.
2. Fix F2 (`sys.executable`).
3. Configure one real provider key and run a genuine `high`-mode task to validate the pipeline and prompt protocol.
4. Run the full `tests/` suite in CI with dev dependencies pinned.
