#!/usr/bin/env python3
"""Read-only static analyser for the AELVO architecture audit.

Produces audit_artifacts/metrics.json and audit_artifacts/internal_graph.json.
It never writes to, imports from, or executes the analysed project.
"""
from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "audit_artifacts"

EXCLUDED_DIRS = {
    ".git", ".venv", "node_modules", "__pycache__", "backups", "workspace",
    ".aelvo_runtime", ".freebuff", ".pytest_cache", "dist", "target",
    "audit_artifacts", ".github",
}
EXCLUDED_SUFFIX = {".db", ".tsbuildinfo", ".lock", ".npmrc"}
TOP_DIRS = {
    "auth", "cli", "cognition", "config", "core", "learning", "mcp", "memory",
    "planning", "repo_intelligence", "runtime_next", "shared_task_board",
    "specialists", "tools", "web", "tests",
}
ENTRY_POINTS = ["main.py", "cli/__main__.py", "cli/app.py", "web/server.py", "cli/boot.py"]
CODE_EXT = {".py", ".ts", ".tsx", ".js", ".jsx", ".rs"}

COMMENT_RE = {
    ".py": re.compile(r"^\s*#"),
    ".rs": re.compile(r"^\s*//"),
    ".ts": re.compile(r"^\s*//"),
    ".tsx": re.compile(r"^\s*//"),
    ".js": re.compile(r"^\s*//"),
    ".jsx": re.compile(r"^\s*//"),
}


def is_test(path: Path) -> bool:
    parts = {p.lower() for p in path.parts}
    name = path.name.lower()
    return (
        "tests" in parts
        or "test" in parts
        or name.startswith("test_")
        or name.endswith("_test.py")
        or ".test." in name
        or ".spec." in name
    )


def subsystem_of(rel: str) -> str:
    first = rel.split("/")[0]
    if "/" not in rel:
        return "(root)"
    if first in TOP_DIRS:
        return first
    if first == "sandbox_core":
        return "sandbox_core"
    if first == "bin":
        return "bin"
    return first


def walk() -> list[Path]:
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS and not d.startswith(".")]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix.lower() in EXCLUDED_SUFFIX and p.suffix != ".lock":
                continue
            files.append(p)
    return files


def line_stats(path: Path) -> dict[str, int]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"total": 0, "blank": 0, "comment": 0, "effective": 0}
    lines = text.splitlines()
    blank = 0
    comment = 0
    pat = COMMENT_RE.get(path.suffix.lower())
    for line in lines:
        if not line.strip():
            blank += 1
        elif pat and pat.match(line):
            comment += 1
    return {
        "total": len(lines),
        "blank": blank,
        "comment": comment,
        "effective": len(lines) - blank - comment,
    }


def module_name(rel: str) -> str | None:
    if not rel.endswith(".py"):
        return None
    mod = rel[:-3].replace("/", ".")
    if mod.endswith(".__init__"):
        mod = mod[: -len(".__init__")]
    return mod


def resolve_import(root_mod: str, mod_names: set[str]) -> str | None:
    """Longest module prefix that exists in the project."""
    if root_mod in mod_names:
        return root_mod
    parts = root_mod.split(".")
    for i in range(len(parts) - 1, 0, -1):
        cand = ".".join(parts[:i])
        if cand in mod_names:
            return cand
    return None


class FuncVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.classes: list[dict] = []
        self.functions: list[tuple[str, ast.AST]] = []
        self._stack: list[str] = []

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.classes.append({
            "name": node.name,
            "line": node.lineno,
            "methods": sum(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) for n in node.body),
            "bases": [ast.unparse(b) for b in node.bases][:4],
        })
        self._stack.append(node.name)
        self.generic_visit(node)
        self._stack.pop()

    def _visit_func(self, node: ast.AST) -> None:
        name = getattr(node, "name", "?")
        qual = ".".join(self._stack + [name])
        self.functions.append((qual, node))
        self._stack.append(name)
        self.generic_visit(node)
        self._stack.pop()

    visit_FunctionDef = _visit_func  # type: ignore[assignment]
    visit_AsyncFunctionDef = _visit_func  # type: ignore[assignment]


def normalise_body(node: ast.AST) -> str:
    body = getattr(node, "body", [])
    dumped = [ast.dump(stmt) for stmt in body]
    raw = "|".join(dumped)
    return hashlib.sha256(raw.encode()).hexdigest()


def main() -> int:
    OUT.mkdir(exist_ok=True)
    files = walk()
    stats: list[dict] = []
    py_mods: dict[str, str] = {}
    parse_errors: list[dict] = []

    for p in files:
        rel = p.relative_to(ROOT).as_posix()
        if p.suffix.lower() not in CODE_EXT and p.suffix.lower() not in {".json", ".md", ".yml", ".toml", ".txt", ".ini"}:
            continue
        entry = {
            "path": rel,
            "ext": p.suffix.lower(),
            "test": is_test(p),
            "subsystem": subsystem_of(rel),
            **line_stats(p),
            "bytes": p.stat().st_size,
        }
        stats.append(entry)
        m = module_name(rel)
        if m:
            py_mods[m] = rel

    mod_names = set(py_mods)

    py_files = [p for p in files if p.suffix == ".py" and not is_test(p.relative_to(ROOT))]
    test_py = [p for p in files if p.suffix == ".py" and is_test(p.relative_to(ROOT))]

    imports: list[dict] = []
    classes: list[dict] = []
    functions: list[dict] = []
    dup_groups: dict[str, list[dict]] = {}
    markers: dict[str, dict[str, int]] = {}

    MARKER_PATTERNS = {
        "subprocess": r"\bsubprocess\.(run|Popen|call|check_output|check_call)",
        "shell_true": r"shell\s*=\s*True",
        "os_system": r"\bos\.system\(",
        "requests": r"\brequests\.(get|post|put|delete|Session)",
        "httpx": r"\bhttpx\.",
        "aiohttp": r"\baiohttp\.",
        "websockets": r"\bwebsockets\.",
        "sqlite": r"sqlite3\.connect",
        "threading": r"\bthreading\.",
        "chromadb": r"\bchromadb\b",
        "scrapy": r"\bscrapy\b",
        "asyncio_task": r"asyncio\.(create_task|gather)",
        "global_stmt": r"^\s*global\s+\w+",
        "llm_call": r"(chat\.completions\.create|messages\.create|generate_content)",
    }

    for p in py_files:
        rel = p.relative_to(ROOT).as_posix()
        mod = module_name(rel) or rel
        try:
            src = p.read_text(encoding="utf-8", errors="replace")
            tree = ast.parse(src)
        except Exception as exc:  # noqa: BLE001 - report, never crash the audit
            parse_errors.append({"path": rel, "error": f"{type(exc).__name__}: {exc}"})
            continue

        found: dict[str, int] = {}
        for marker, pat in MARKER_PATTERNS.items():
            hits = re.findall(pat, src, re.MULTILINE)
            if hits:
                found[marker] = len(hits)
        markers[rel] = found

        vis = FuncVisitor()
        vis.visit(tree)
        for c in vis.classes:
            classes.append({"path": rel, **c})
        for qual, node in vis.functions:
            body_len = len(getattr(node, "body", []))
            functions.append({
                "path": rel,
                "qualname": qual,
                "line": getattr(node, "lineno", 0),
                "lines": (getattr(node, "end_lineno", getattr(node, "lineno", 0)) or 0) - (getattr(node, "lineno", 0) or 0) + 1,
                "body_statements": body_len,
                "async": isinstance(node, ast.AsyncFunctionDef),
            })
            if body_len >= 8:
                h = normalise_body(node)
                dup_groups.setdefault(h, []).append({"path": rel, "qualname": qual, "line": node.lineno, "stmts": body_len})

        for node in ast.walk(tree):
            root_mod: str | None = None
            kind = None
            if isinstance(node, ast.Import):
                for alias in node.names:
                    target = resolve_import(alias.name, mod_names)
                    if target:
                        imports.append({"from": mod, "from_path": rel, "to": target, "to_path": py_mods[target],
                                        "type": "import", "line": node.lineno, "raw": f"import {alias.name}"})
                continue
            if isinstance(node, ast.ImportFrom):
                if node.level:
                    # Relative import: resolve against this module's package.
                    # For pkg/__init__.py the package is the module itself;
                    # for pkg/mod.py it is the parent package.
                    is_init = rel.endswith("__init__.py")
                    package = mod if is_init else (mod.rsplit(".", 1)[0] if "." in mod else "")
                    for _ in range(node.level - 1):
                        package = package.rsplit(".", 1)[0] if "." in package else ""
                    base = f"{package}.{node.module}" if (package and node.module) else (node.module or package)
                    raw = "." * node.level + (node.module or "")
                else:
                    base = node.module or ""
                    raw = node.module or ""
                if not base:
                    continue
                target = resolve_import(base, mod_names)
                if target:
                    imported = [a.name for a in node.names]
                    imports.append({"from": mod, "from_path": rel, "to": target, "to_path": py_mods[target],
                                    "type": "from", "line": node.lineno, "raw": f"from {raw} import {', '.join(imported)}",
                                    "names": imported})
                # ``from . import registry`` — the imported name may be a submodule.
                if node.level and node.module is None:
                    for alias in node.names:
                        sub = f"{base}.{alias.name}" if base else alias.name
                        sub_target = resolve_import(sub, mod_names)
                        if sub_target and sub_target != target:
                            imports.append({"from": mod, "from_path": rel, "to": sub_target, "to_path": py_mods[sub_target],
                                            "type": "from-submodule", "line": node.lineno,
                                            "raw": f"from {raw} import {alias.name}", "names": [alias.name]})
                continue
            # dynamic __import__ / importlib
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "__import__":
                if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    target = resolve_import(node.args[0].value, mod_names)
                    if target:
                        imports.append({"from": mod, "from_path": rel, "to": target, "to_path": py_mods[target],
                                        "type": "dynamic", "line": node.lineno, "raw": f"__import__({node.args[0].value!r})"})

    # ---- graph metrics ----
    nodes = sorted({i["from_path"] for i in imports} | {i["to_path"] for i in imports})
    edges = {}
    for i in imports:
        key = (i["from_path"], i["to_path"])
        edges.setdefault(key, {"from": key[0], "to": key[1], "count": 0, "lines": [], "types": set()})
        edges[key]["count"] += 1
        edges[key]["lines"].append(i["line"])
        edges[key]["types"].add(i["type"])

    adj: dict[str, set[str]] = {n: set() for n in nodes}
    radj: dict[str, set[str]] = {n: set() for n in nodes}
    for a, b in edges:
        adj.setdefault(a, set()).add(b)
        radj.setdefault(b, set()).add(a)

    # Tarjan SCC (iterative)
    index_counter = [0]
    stack: list[str] = []
    on_stack: set[str] = set()
    indexes: dict[str, int] = {}
    low: dict[str, int] = {}
    sccs: list[list[str]] = []

    def strongconnect(v: str) -> None:
        work = [(v, iter(sorted(adj.get(v, set()))))]
        indexes[v] = low[v] = index_counter[0]
        index_counter[0] += 1
        stack.append(v)
        on_stack.add(v)
        while work:
            node, it = work[-1]
            advanced = False
            for w in it:
                if w not in indexes:
                    indexes[w] = low[w] = index_counter[0]
                    index_counter[0] += 1
                    stack.append(w)
                    on_stack.add(w)
                    work.append((w, iter(sorted(adj.get(w, set())))))
                    advanced = True
                    break
                if w in on_stack:
                    low[node] = min(low[node], indexes[w])
            if advanced:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == indexes[node]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.append(w)
                    if w == node:
                        break
                sccs.append(sorted(comp))

    for v in sorted(nodes):
        if v not in indexes:
            strongconnect(v)

    cycles = [c for c in sccs if len(c) > 1]
    # self-imports
    self_loops = [{"path": a, "count": e["count"]} for (a, b), e in edges.items() if a == b]

    # reachability from entry points
    reachable: set[str] = set()
    for ep in ENTRY_POINTS:
        if ep not in adj:
            continue
        queue = [ep]
        seen = {ep}
        while queue:
            cur = queue.pop()
            for nxt in adj.get(cur, set()):
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        reachable |= seen

    all_py_paths = {py_mods[m] for m in mod_names}
    unreachable = sorted(all_py_paths - reachable)

    # reverse reachability for blast radius
    def dependents(path: str) -> set[str]:
        seen: set[str] = set()
        queue = [path]
        while queue:
            cur = queue.pop()
            for parent in radj.get(cur, set()):
                if parent not in seen:
                    seen.add(parent)
                    queue.append(parent)
        return seen

    blast = {p: sorted(dependents(p)) for p in all_py_paths}

    duplicates = [
        {"hash": h[:12], "count": len(v), "locations": v}
        for h, v in dup_groups.items() if len({x["path"] for x in v}) > 1
    ]
    duplicates.sort(key=lambda d: (-d["count"], d["hash"]))

    # per-subsystem rollup
    rollup: dict[str, dict] = {}
    for s in stats:
        r = rollup.setdefault(s["subsystem"], {"files": 0, "code_files": 0, "test_files": 0,
                                               "total": 0, "blank": 0, "comment": 0, "effective": 0})
        r["files"] += 1
        if s["ext"] in CODE_EXT:
            r["code_files"] += 1
            if s["test"]:
                r["test_files"] += 1
            r["total"] += s["total"]
            r["blank"] += s["blank"]
            r["comment"] += s["comment"]
            r["effective"] += s["effective"]

    metrics = {
        "root": str(ROOT),
        "revision": os.popen("git rev-parse HEAD").read().strip(),  # read-only
        "file_count_scanned": len(files),
        "code_file_count": sum(1 for s in stats if s["ext"] in CODE_EXT),
        "python_prod_files": len(py_files),
        "python_test_files": len(test_py),
        "python_prod_loc": sum(line_stats(p)["total"] for p in py_files),
        "python_test_loc": sum(line_stats(p)["total"] for p in test_py),
        "totals_by_ext": {},
        "subsystems": rollup,
        "classes": classes,
        "functions_count": len(functions),
        "classes_count": len(classes),
        "async_functions_count": sum(1 for f in functions if f["async"]),
        "largest_modules": sorted(stats, key=lambda s: -s["total"])[:30],
        "largest_functions": sorted(functions, key=lambda f: -f["lines"])[:25],
        "parse_errors": parse_errors,
        "markers": markers,
        "duplicate_function_groups": duplicates[:60],
        "duplicate_group_count": len(duplicates),
        "graph": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "cycle_count": len(cycles),
            "cycles": cycles[:40],
            "self_loops": self_loops,
            "reachable_from_entries": len(reachable),
            "unreachable_prod_modules": unreachable,
            "entry_points_found": [e for e in ENTRY_POINTS if e in adj],
        },
        "blast_radius": {k: v for k, v in blast.items() if len(v) >= 3},
    }
    for s in stats:
        if s["ext"] in CODE_EXT:
            cur = metrics["totals_by_ext"].setdefault(s["ext"], {"files": 0, "total": 0, "effective": 0, "test_files": 0})
            cur["files"] += 1
            cur["total"] += s["total"]
            cur["effective"] += s["effective"]
            if s["test"]:
                cur["test_files"] += 1

    (OUT / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    graph = {
        "generated_for_revision": metrics["revision"],
        "method": "Python ast Import/ImportFrom/__import__ resolution to longest existing module prefix; runtime registration is NOT represented",
        "node_count": len(nodes),
        "edge_count": len(edges),
        "nodes": [{"id": n, "subsystem": subsystem_of(n), "unreachable_from_entry": n in unreachable} for n in nodes],
        "edges": [
            {"from": e["from"], "to": e["to"], "count": e["count"], "lines": sorted(set(e["lines"])), "types": sorted(e["types"])}
            for e in edges.values()
        ],
        "strongly_connected_components": cycles,
    }
    (OUT / "internal_graph.json").write_text(json.dumps(graph, indent=2), encoding="utf-8")

    print(json.dumps({
        "prod_py_files": len(py_files),
        "prod_loc": metrics["python_prod_loc"],
        "test_py_files": len(test_py),
        "test_loc": metrics["python_test_loc"],
        "classes": len(classes),
        "functions": len(functions),
        "graph_nodes": len(nodes),
        "graph_edges": len(edges),
        "cycles": len(cycles),
        "unreachable": len(unreachable),
        "dup_groups": len(duplicates),
        "parse_errors": len(parse_errors),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
