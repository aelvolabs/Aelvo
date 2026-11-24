#!/usr/bin/env python3
"""Build AELVO_MODULE_INVENTORY.json and AELVO_DEPENDENCY_GRAPH.json.

Reads the measured metrics + static import graph, extracts module docstrings
and symbol counts, applies an explicit path->disposition rule table, and
writes the deliverables. Analysis only; no production file is touched.
"""
from __future__ import annotations

import ast
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT

metrics = json.loads((ROOT / "audit_artifacts" / "metrics.json").read_text(encoding="utf-8"))
graph = json.loads((ROOT / "audit_artifacts" / "internal_graph.json").read_text(encoding="utf-8"))

# ── explicit disposition rules (first match wins) ─────────────────────────
# (prefix, disposition, coding_specific 0-5, personal_relevance 0-5, rationale)
RULES: list[tuple[str, str, int, int, str]] = [
    # root / packaging
    ("main.py", "REDESIGN", 3, 3, "Python entry point + universal LLM adapter; replaced by native runtime, but its tool-loop/mode semantics are the behavioural reference."),
    ("bin/", "REMOVE", 5, 0, "Node launchers exist only to install/start the Python runtime."),
    ("config/", "EXTRACT", 1, 4, "Threshold constants are reusable; module-level path globals are a design flaw."),
    ("requirements", "REMOVE", 1, 0, "Python dependency manifests; irrelevant to a TypeScript runtime."),
    ("pytest.ini", "OPTIONAL", 2, 1, "Python test runner config; needed only while legacy tests remain."),
    ("ruff.toml", "OPTIONAL", 2, 1, "Python lint config; legacy only."),
    (".githooks/", "INVESTIGATE", 2, 1, "Git hook; low impact, not inspected in depth."),
    # auth
    ("auth/providers/", "REMOVE", 3, 1, "22 per-provider adapters with zero production importers; the live path uses core/provider_runtime SDK factories."),
    ("auth/auth/oauth.py", "EXTRACT", 2, 4, "OAuth flow could seed Google account linking, but is currently unreferenced."),
    ("auth/auth/browser.py", "EXTRACT", 1, 3, "Browser-based auth helper, unreferenced; possibly useful for provider setup."),
    ("auth/auth/refresh.py", "EXTRACT", 1, 3, "Token refresh logic, unreferenced."),
    ("auth/auth/", "REMOVE", 2, 1, "Parallel auth-mode layer with no production importer."),
    ("auth/events/", "REMOVE", 2, 1, "Provider event models not consumed by the runtime."),
    ("auth/ratelimiter.py", "REMOVE", 2, 1, "Unreferenced limiter; live HTTP path relies on SDK/timeout policy."),
    ("auth/circuit_breaker.py", "REMOVE", 3, 1, "Unreferenced; runtime has its own breaker in provider_runtime/auth.runtime.fallback."),
    ("auth/runtime/streaming.py", "REMOVE", 3, 1, "Unreferenced; streaming normalisation lives in auth/adapters/streaming.py."),
    ("auth/adapters/", "EXTRACT", 2, 4, "Message/tool-call/structured-output normalisation is genuinely used and is the reusable core of the provider layer."),
    ("auth/cred_storage.py", "EXTRACT", 1, 4, "Encrypted SQLite credential vault with PBKDF2; directly reusable for personal secrets."),
    ("auth/config.py", "CONSOLIDATE", 2, 3, "20-provider catalogue duplicates core/registry/models.py (22 providers): two sources of truth."),
    ("auth/types.py", "EXTRACT", 1, 4, "Provider/credential/capability domain types; useful for a clean provider contract."),
    ("auth/monitoring/", "EXTRACT", 2, 3, "Health/degradation metrics; reusable patterns, but overlaps runtime monitoring."),
    ("auth/runtime/", "CONSOLIDATE", 2, 3, "Registry/health/usage/fallback/diagnostics are used by core.provider_runtime but overlap runtime_next monitoring and are in-memory only."),
    ("auth/diagnostics/", "EXTRACT", 2, 2, "Doctor/comparison/capability inspection; useful CLI diagnostics, optional."),
    # security
    ("core/security/", "EXTRACT", 2, 5, "Approval manager, execution governance, sandbox policy, security memory and analytics are substantial and security-relevant, but have zero production importers today."),
    # learning / cognition / planning
    ("learning/agent_metrics.py", "EXTRACT", 2, 3, "Live per-specialist metrics tracker subscribed to the event bus."),
    ("learning/", "REMOVE", 4, 1, "Pattern-extraction from dependency-graph deltas: engineering-specific, 6.6k LOC, only agent_metrics is wired."),
    ("cognition/", "EXTRACT", 3, 3, "Blackboard, consensus, planning and trust primitives; multi-agent/coding framing, but several algorithms transfer to personal task coordination."),
    ("planning/", "EXTRACT", 4, 2, "Goal hierarchy, multi-session continuity, self-critique and debt forecasting; coding-oriented vocabulary, continuity idea transfers."),
    ("shared_task_board/", "EXTRACT", 4, 2, "Task lifecycle/state machine and collaboration orchestration; only board/task used by Mode B."),
    # runtime_next
    ("runtime_next/engine/", "EXTRACT", 3, 4, "Graph model + sequential topological executor; no cancellation/parallelism, but the node/state/edge contract is reusable."),
    ("runtime_next/models/", "EXTRACT", 2, 4, "Pydantic plan/event/node models; strong candidate to port as shared contracts."),
    ("runtime_next/events/", "EXTRACT", 2, 4, "Typed async event bus with JSONL replay; directly reusable concept."),
    ("runtime_next/capability/", "EXTRACT", 2, 3, "Capability detection/registry; optional for a smaller product."),
    ("runtime_next/monitoring/", "EXTRACT", 2, 3, "Metrics/alerts/health/dashboard; reusable but overlaps auth monitoring."),
    ("runtime_next/recovery/", "EXTRACT", 3, 3, "Failure classification/retry/recovery; reusable ideas, tightly bound to coding-failure taxonomy."),
    ("runtime_next/verification/", "REDESIGN", 4, 3, "Verification types and pipeline are real but shallow (ast.parse/py_compile); a personal assistant needs different checks."),
    ("runtime_next/governance/", "EXTRACT", 2, 4, "Policy engine/recovery hooks; security-relevant governance patterns."),
    ("runtime_next/security/", "EXTRACT", 4, 3, "Scanner/integrity/policy audit; coding-security oriented."),
    ("runtime_next/plan/", "OPTIONAL", 5, 2, "Architect plan builder/calibration/brain: 12k LOC strongly oriented to engineering plans; optional."),
    ("runtime_next/__init__.py", "OPTIONAL", 2, 2, "Package exports."),
    # repo intelligence
    ("repo_intelligence/parser.py", "EXTRACT", 4, 2, "Python AST + TypeScript regex parser; the parsing/indexing concept transfers, language scope is narrow."),
    ("repo_intelligence/scanner", "EXTRACT", 4, 2, "File discovery/indexing foundation."),
    ("repo_intelligence/", "OPTIONAL", 5, 1, "Coding-centric repository analysis (symbols, call graphs, drift, architecture, refactor risk); not core to a personal assistant."),
    # mcp
    ("mcp/integrations/", "REMOVE", 5, 1, "Specialist/execution-graph/repo-intelligence glue, all statically unreachable."),
    ("mcp/governance/", "EXTRACT", 2, 4, "Allowlist, permission model, restriction engine and audit log: the reusable MCP security core."),
    ("mcp/registry/trust_manager.py", "EXTRACT", 1, 5, "Five-level trust model with human-ack rules; valuable for third-party integrations."),
    ("mcp/registry/", "REPLACE", 2, 4, "Registry/health/models are re-implementable on the official MCP TS SDK; data model is a useful reference."),
    ("mcp/transport/", "REPLACE", 2, 3, "Hand-rolled stdio/HTTP/WS JSON-RPC transports; official SDK provides maintained transports."),
    ("mcp/client/", "REPLACE", 2, 3, "Handshake/negotiation/session/timeout; official SDK covers the protocol."),
    ("mcp/capability/", "REPLACE", 2, 3, "Capability catalogues duplicate SDK discovery results."),
    ("mcp/execution/", "REDESIGN", 2, 3, "Execution engine + #mcp command CLI; useful governance hook points, but not integrated with model tool-calling."),
    ("mcp/verification/", "EXTRACT", 2, 4, "Schema/size/timeout/content-safety/trust verifiers: reusable policy ideas for untrusted tool output."),
    ("mcp/recovery/", "OPTIONAL", 2, 2, "Reconnect/failover/isolation; largely subsumed by SDK + simple retry."),
    ("mcp/memory/", "OPTIONAL", 3, 2, "Reliability/routing memory for MCP servers; optional."),
    ("mcp/events/", "OPTIONAL", 2, 2, "MCP event schemas/publisher."),
    ("mcp/__init__.py", "REPLACE", 2, 3, "Package facade over the above."),
    # specialists / orchestration
    ("specialists/hermes.py", "EXTRACT", 4, 2, "Intent/risk/complexity heuristics + user model; useful as compact heuristics, not as an agent."),
    ("specialists/", "CONSOLIDATE", 5, 1, "Seven specialist classes are prompt builders + keyword scoring + post-process memory writes; 'high' mode runs one consolidated LLM call, so the multi-agent structure is presentation, not execution."),
    ("core/orchestration/parser.py", "EXTRACT", 1, 4, "Tolerant JSON/tool-call parser; directly reusable."),
    ("core/orchestration/stream_filter.py", "EXTRACT", 1, 4, "Suppresses tool JSON from streamed prose; reusable streaming UX logic."),
    ("core/orchestration/session_manager.py", "EXTRACT", 2, 3, "Session summarisation cadence."),
    ("core/orchestration/context_builder.py", "EXTRACT", 2, 3, "Shared-context assembly; needs a non-coding equivalent."),
    ("core/orchestration/", "REDESIGN", 4, 2, "Orchestrator + consolidated pipeline + Mode B task board: coding/verification ceremony with a known silent-tool bug."),
    ("core/governance/", "EXTRACT", 2, 4, "Constraints, honesty checks, audit episodes, circuit breaker; strong governance ideas, fused with a Chroma-backed MemoryEngine."),
    ("core/filesystem/", "EXTRACT", 4, 3, "Path-jail + atomic file tools + Rust sandbox bridge; the tool semantics are the reference, the Python fallback command policy is weak."),
    ("core/execution/tool_registry.py", "EXTRACT", 2, 4, "Structured tool spec/retry/cache registry; no runtime consumer (the live registry is an ad-hoc dict)."),
    ("core/execution/commands.py", "EXTRACT", 3, 2, "Kernel #commands (lock/checkpoint/restore) tied to coding workspace anchors."),
    ("core/execution/experience_pipeline.py", "REMOVE", 5, 1, "Engineering experience/pattern pipeline, no runtime consumer."),
    ("core/execution/sandbox_session.py", "EXTRACT", 3, 3, "Bounded sandbox session wrapper; review before reuse."),
    ("core/execution/", "OPTIONAL", 3, 2, "Tool execution helpers beyond the registry; overlaps."),
    ("core/rag/", "REDESIGN", 2, 4, "Hybrid dense/lexical retrieval over Chroma with local fallback; a simpler SQLite/FTS memory is likely superior for personal facts."),
    ("core/scraping/", "OPTIONAL", 3, 2, "Scrapy/Playwright scraping with fallbacks; useful optional research capability, heavy deps."),
    ("core/workers/", "REMOVE", 4, 1, "Unreachable specialist worker wrapper."),
    ("core/provider_runtime.py", "REPLACE", 2, 4, "22-provider bootstrap with in-memory health/usage/fallback; official SDK adapters + a small registry are simpler."),
    ("core/registry/", "EXTRACT", 1, 4, "Curated provider/model catalogue + capability helpers; good data source, single-source-of-truth candidate."),
    ("core/system_prompt.py", "REDESIGN", 5, 1, "Coding-agent JSON tool protocol prompt; the protocol (FORMAT 1/2/3) is the reference, the prompt itself is engineering-specific."),
    ("core/startup.py", "EXTRACT", 1, 3, "Credential detection/vault migration helpers."),
    ("core/__init__.py", "OPTIONAL", 1, 1, "Package marker."),
    # tools / memory
    ("tools/code_tools.py", "OPTIONAL", 5, 1, "Lint/format/typecheck/test/symbol tools for coding workflows."),
    ("tools/git_tools.py", "OPTIONAL", 5, 1, "Git state/commit/PR/merge tools."),
    ("tools/security_tools.py", "EXTRACT", 3, 3, "Secret/vulnerability scanning patterns; reusable for broader safety scanning."),
    ("tools/research_tools.py", "EXTRACT", 2, 3, "Query decomposition/source ranking/wiki entry; partially generic research helpers."),
    ("tools/diagram_tools.py", "OPTIONAL", 4, 1, "Mermaid diagram generation: coding/documentation specific."),
    ("tools/", "OPTIONAL", 4, 2, "Tool catalogue; only a subset is general-purpose."),
    ("memory/user_model.py", "EXTRACT", 1, 5, "Heuristic preference profiling persisted as memory entries; directly relevant to a personal assistant."),
    ("memory/forge_memory.py", "EXTRACT", 4, 2, "Typed coding-pattern memory with conflict resolution; concept transfers, categories do not."),
    ("memory/", "REDESIGN", 3, 3, "Memory types and helpers; storage should be redesigned around personal facts/commitments."),
    # web / cli / sandbox
    ("web/src/", "REDESIGN", 3, 4, "React dashboard components (chat, tasks, agents, knowledge, files, providers); several views are engineering-centric, chat/files/settings are reusable after redesign."),
    ("web/web_bridge.py", "REPLACE", 2, 3, "WebSocket JSON protocol; unauthenticated privileged endpoints (fs_read/fs_set_workspace/provider keys)."),
    ("web/server.py", "REPLACE", 2, 3, "aiohttp static server + bridge bootstrap."),
    ("web/__init__.py", "REMOVE", 2, 0, "Python package marker for the web server."),
    ("cli/providers.py", "EXTRACT", 2, 3, "Provider selection/credential persistence UX; reusable interaction design."),
    ("cli/live_models.py", "EXTRACT", 1, 3, "Live model listing with caching and filtering."),
    ("cli/", "REDESIGN", 3, 2, "Coding-agent REPL and slash commands; a future CLI should be an optional developer interface."),
    ("sandbox_core/src/policy.rs", "REDESIGN", 2, 5, "Command allow/block/injection policy; allowlist includes shells/interpreters, so it cannot confine commands."),
    ("sandbox_core/src/fs_jail.rs", "KEEP", 1, 5, "Canonicalising path jail with symlink/inode/hardlink checks; strongest existing security asset (needs independent review)."),
    ("sandbox_core/src/threat_detection.rs", "EXTRACT", 2, 4, "Threat classification/severity scoring; reusable ideas."),
    ("sandbox_core/src/workspace_intelligence.rs", "EXTRACT", 3, 2, "Workspace zones/deny lists/protected files; coding-workspace specific."),
    ("sandbox_core/src/process.rs", "REDESIGN", 2, 4, "Process execution with timeout/output cap/resource governor; no filesystem confinement for children."),
    ("sandbox_core/src/audit.rs", "KEEP", 1, 5, "Structured security audit logging."),
    ("sandbox_core/src/checkpoint.rs", "EXTRACT", 3, 3, "Workspace checkpoints for writes; useful for rollback but workspace-bound."),
    ("sandbox_core/src/resource.rs", "EXTRACT", 2, 4, "Resource governor (CPU/memory/process/handle limits)."),
    ("sandbox_core/src/main.rs", "REDESIGN", 2, 4, "JSON-over-stdin request/response contract; usable, but one-shot process per action is costly."),
    ("sandbox_core/", "KEEP", 2, 5, "Rust sandbox is the best candidate for a native security foundation, with significant gaps to close."),
    # tests / docs
    ("tests/", "OPTIONAL", 4, 2, "Python test corpus: valuable behavioural reference for a migration, not part of the product."),
    ("docs/", "OPTIONAL", 2, 1, "Documentation."),
]

# ordered longest-prefix match
RULES.sort(key=lambda r: -len(r[0]))


def classify(path: str) -> tuple[str, int, int, str]:
    for prefix, disp, coding, rel, why in RULES:
        if path == prefix or path.startswith(prefix):
            return disp, coding, rel, why
    return "INVESTIGATE", 3, 3, "No explicit rule; requires module-level review."


# ── symbol/docstring extraction per production module ────────────────────
desc: dict[str, dict] = {}
for path in [s["path"] for s in metrics["largest_modules"]]:
    pass

prod_py = []
for p in ROOT.rglob("*.py"):
    rel = p.relative_to(ROOT).as_posix()
    if any(part in {".git", ".venv", "__pycache__", "node_modules", "backups", "workspace", ".aelvo_runtime", ".freebuff", "audit_artifacts", "dist", "target", "tests"} for part in p.parts):
        continue
    prod_py.append(rel)

for rel in prod_py:
    try:
        tree = ast.parse((ROOT / rel).read_text(encoding="utf-8", errors="replace"))
        doc = ast.get_docstring(tree) or ""
        first = doc.strip().splitlines()[0].strip() if doc.strip() else ""
        desc[rel] = {
            "description": first[:240] or "(no module docstring)",
            "description_source": "module docstring" if first else "none",
            "classes": sum(isinstance(n, ast.ClassDef) for n in ast.walk(tree)),
            "functions": sum(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) for n in ast.walk(tree)),
        }
    except Exception as exc:  # noqa: BLE001
        desc[rel] = {"description": f"(parse failed: {exc})", "description_source": "error", "classes": 0, "functions": 0}

# build lookup from measured stats
stat_by_path = {}
for p in ROOT.rglob("*.py"):
    rel = p.relative_to(ROOT).as_posix()
    if rel in desc:
        stat_by_path[rel] = p

loc_by_path: dict[str, int] = {}
eff_by_path: dict[str, int] = {}
for rel in desc:
    try:
        lines = (ROOT / rel).read_text(encoding="utf-8", errors="replace").splitlines()
        loc_by_path[rel] = len(lines)
        eff_by_path[rel] = sum(1 for ln in lines if ln.strip() and not ln.strip().startswith("#"))
    except OSError:
        loc_by_path[rel] = eff_by_path[rel] = 0

in_deg: Counter[str] = Counter()
out_deg: Counter[str] = Counter()
dep_map: dict[str, set[str]] = {}
consumer_map: dict[str, set[str]] = {}
for e in graph["edges"]:
    in_deg[e["to"]] += e["count"]
    out_deg[e["from"]] += e["count"]
    dep_map.setdefault(e["from"], set()).add(e["to"])
    consumer_map.setdefault(e["to"], set()).add(e["from"])

unreachable = {n["id"] for n in graph["nodes"] if n["unreachable_from_entry"]}

# coding-specific lexicon → adjusts the rule baseline with an evidence line
CODING_TERMS = ("code", "repo", "git", "lint", "merge", "commit", "refactor", "symbol",
                "dependency", "architect", "forge", "test", "scaffold", "mermaid", "typescript",
                "python", "workspace", "specialist", "verification", "sandbox")
PERSONAL_TERMS = ("memory", "user", "preference", "voice", "calendar", "task", "goal",
                  "schedul", "notification", "personal", "credential", "trust", "approval")

inventory = []
for rel, d in sorted(desc.items()):
    disp, coding, rel_score, why = classify(rel)
    text = f"{rel} {d['description']}".lower()
    coding_hits = [t for t in CODING_TERMS if t in text]
    personal_hits = [t for t in PERSONAL_TERMS if t in text]
    if coding_hits and disp not in ("REMOVE", "OPTIONAL"):
        coding = min(5, coding + 1)
    if personal_hits:
        rel_score = min(5, rel_score + 1)
    reachable = rel not in unreachable
    inventory.append({
        "path": rel,
        "language": "Python",
        "loc": loc_by_path[rel],
        "effective_loc": eff_by_path[rel],
        "subsystem": rel.split("/")[0] if "/" in rel else "(root)",
        "description": d["description"],
        "description_source": d["description_source"],
        "symbols": {"classes": d["classes"], "functions": d["functions"]},
        "runtime_reachability": {
            "static_import_reachable_from_entry": reachable,
            "in_degree": in_deg.get(rel, 0),
            "out_degree": out_deg.get(rel, 0),
            "caveat": "Static imports only; dynamic registration/globals are not represented.",
        },
        "direct_dependencies": sorted(dep_map.get(rel, [])),
        "consumers": sorted(consumer_map.get(rel, [])),
        "coding_specific_score_0_5": coding,
        "personal_assistant_relevance_0_5": rel_score,
        "recommended_disposition": disp,
        "confidence": "high" if disp in ("KEEP", "REMOVE") and not reachable else "medium",
        "rationale": why,
        "evidence": {
            "coding_terms": coding_hits[:8],
            "personal_terms": personal_hits[:8],
            "static_unreachable": not reachable,
        },
    })

# ── inventory: non-Python source (frontend, Rust, packaging) ─────────────
extra = []
for p in sorted(ROOT.rglob("*")):
    rel = p.relative_to(ROOT).as_posix()
    if not p.is_file() or p.suffix not in {".tsx", ".ts", ".js", ".rs"}:
        continue
    if any(part in {"node_modules", ".venv", "dist", "target", "backups", "audit_artifacts"} for part in p.parts):
        continue
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    disp, coding, rel_score, why = classify(rel)
    extra.append({
        "path": rel,
        "language": {".tsx": "TypeScript React", ".ts": "TypeScript", ".js": "JavaScript", ".rs": "Rust"}[p.suffix],
        "loc": len(lines),
        "subsystem": rel.split("/")[0] if "/" in rel else "(root)",
        "description": "(source file; no module-level docstring extraction for this language)",
        "symbols": {"classes": None, "functions": None},
        "runtime_reachability": {"static_import_reachable_from_entry": None, "in_degree": None, "out_degree": None,
                                 "caveat": "Not part of the Python import graph."},
        "direct_dependencies": [],
        "consumers": [],
        "coding_specific_score_0_5": coding,
        "personal_assistant_relevance_0_5": rel_score,
        "recommended_disposition": disp,
        "confidence": "medium",
        "rationale": why,
        "evidence": {"source": "extension-based classification"},
    })

inv = {
    "generated_for_revision": metrics["revision"],
    "method": {
        "inventory_scope": "All Python files outside excluded dirs; plus .ts/.tsx/.js/.rs sources.",
        "loc": "Physical lines (blank and comment lines included).",
        "reachability": "BFS over Python ast import edges from main.py, cli/__main__.py, cli/app.py, web/server.py, cli/boot.py. Dynamic registration is not modelled.",
        "disposition": "Explicit path-prefix rule table in audit_artifacts/build_inventory.py; rationale and confidence recorded per entry.",
        "descriptions": "First module docstring line (Python) — declared, not verified behaviour.",
    },
    "counts": {
        "python_production_files": len(inventory),
        "python_production_loc": sum(i["loc"] for i in inventory),
        "other_source_files": len(extra),
        "by_disposition_python": dict(Counter(i["recommended_disposition"] for i in inventory)),
        "statically_unreachable_python": sum(1 for i in inventory if not i["runtime_reachability"]["static_import_reachable_from_entry"]),
    },
    "modules": inventory + extra,
}
(OUT / "AELVO_MODULE_INVENTORY.json").write_text(json.dumps(inv, indent=2), encoding="utf-8")

# ── final dependency graph artifact ──────────────────────────────────────
final_graph = {
    "generated_for_revision": metrics["revision"],
    "method": graph["method"],
    "summary": {
        "nodes": graph["node_count"],
        "edges": graph["edge_count"],
        "python_production_files": len(inventory),
        "cycles": len(graph["strongly_connected_components"]),
        "statically_unreachable_from_entry": len(unreachable),
    },
    "entry_points": graph.get("entry_points_found", []),
    "nodes": [
        {
            **n,
            "loc": loc_by_path.get(n["id"], 0),
            "disposition": next((i["recommended_disposition"] for i in inventory if i["path"] == n["id"]), "INVESTIGATE"),
            "in_degree": in_deg.get(n["id"], 0),
        }
        for n in graph["nodes"]
    ],
    "edges": graph["edges"],
    "cycles": graph["strongly_connected_components"],
    "unreachable_modules": sorted(unreachable),
    "runtime_wiring_not_in_import_graph": [
        {"from": "main.py", "to": "mcp.*", "type": "object_construction", "confidence": "verified",
         "evidence": "main.py:52-64 imports, main.py:1512-1555 instantiates registry/connection/execution/CLI"},
        {"from": "specialists/__init__.py", "to": "specialists.*", "type": "eager_instance_registry", "confidence": "verified",
         "evidence": "specialists/__init__.py instantiates all seven specialists at import time"},
        {"from": "core/orchestration/orchestrator.py", "to": "runtime_next.engine.runner.NodeRunner", "type": "dependency_injection", "confidence": "verified",
         "evidence": "orchestrator.py:161 NodeRunner(None); executor injected only at :878 and :1115"},
        {"from": "cli/commands.py", "to": "runtime_next/plan", "type": "dynamic___import__", "confidence": "verified",
         "evidence": "cli/commands.py:429 __import__(mod_name)"},
        {"from": "core/orchestration/orchestrator.py", "to": "memory_engine.tools", "type": "dict_registry", "confidence": "verified",
         "evidence": "tool names dispatched via memory_engine.tools[name]['fn']"},
    ],
    "blast_radius": metrics.get("blast_radius", {}),
}
(OUT / "AELVO_DEPENDENCY_GRAPH.json").write_text(json.dumps(final_graph, indent=2), encoding="utf-8")

print(json.dumps(inv["counts"], indent=2))
print("graph nodes/edges:", final_graph["summary"]["nodes"], final_graph["summary"]["edges"])
