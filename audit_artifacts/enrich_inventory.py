"""Read-only enrichment of AELVO_MODULE_INVENTORY.json.

Replaces placeholder descriptions with factual symbol listings derived from the
source file itself. Does not touch production code, dispositions or confidence.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INV = ROOT / "AELVO_MODULE_INVENTORY.json"

PY_PLACEHOLDERS = ("(no module docstring)",)
OTHER_PLACEHOLDER = "(source file; no module-level docstring extraction for this language)"

TS_PATTERNS = [
    r"^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)",
    r"^\s*export\s+(?:default\s+)?class\s+(\w+)",
    r"^\s*export\s+(?:const|let|interface|type|enum)\s+(\w+)",
    r"^\s*(?:async\s+)?function\s+(\w+)",
    r"^\s*class\s+(\w+)",
    r"^\s*(?:const|function)\s+(\w+)\s*=",
]
RS_PATTERNS = [
    r"^\s*pub\s+(?:async\s+)?fn\s+(\w+)",
    r"^\s*pub\s+struct\s+(\w+)",
    r"^\s*pub\s+enum\s+(\w+)",
    r"^\s*impl(?:<[^>]*>)?\s+(\w+)",
    r"^\s*fn\s+(\w+)",
]


def py_symbols(path: Path) -> list[str]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:
        return []
    names: list[str] = []
    for node in tree.body:
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            names.append(node.name)
    return names


def regex_symbols(path: Path, patterns: list[str]) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    seen: list[str] = []
    for line in text.splitlines():
        for pat in patterns:
            m = re.match(pat, line)
            if m and m.group(1) not in seen and not m.group(1).startswith("_"):
                seen.append(m.group(1))
    return seen


def main() -> None:
    data = json.loads(INV.read_text(encoding="utf-8"))
    modules = data["modules"]
    enriched = 0
    no_symbols = 0
    for mod in modules:
        path = Path(mod["path"])
        if not path.exists():
            continue
        mod.setdefault("effective_loc", mod.get("loc"))
        desc = str(mod.get("description", ""))
        placeholder = desc in PY_PLACEHOLDERS or desc == OTHER_PLACEHOLDER or desc.startswith("(")
        if not placeholder:
            mod.setdefault("description_source", "module docstring")
            continue
        lang = mod.get("language")
        if lang == "Python":
            names = py_symbols(path)
        elif lang in ("TypeScript", "TypeScript React", "JavaScript"):
            names = regex_symbols(path, TS_PATTERNS)
        elif lang == "Rust":
            names = regex_symbols(path, RS_PATTERNS)
        else:
            names = []
        names = names[:8]
        if names:
            scope = f"{mod.get('subsystem', 'unknown')} module"
            mod["description"] = f"{scope}; defines {', '.join(names)}. No module docstring."
            mod["description_source"] = "derived from top-level symbols (no docstring)"
            enriched += 1
        else:
            mod["description"] = (
                f"{mod.get('subsystem', 'unknown')} module; no top-level symbols detected. "
                "No module docstring."
            )
            mod["description_source"] = "path/subsystem only (no docstring or symbols)"
            no_symbols += 1
            enriched += 1
    INV.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"enriched {enriched} entries ({no_symbols} without top-level symbols)")


if __name__ == "__main__":
    main()
