# AELVO Removal and Archival Log

**Executed:** 2026-11-24
**Baseline:** `main` @ `50af66544df0eed935ea4b0119303d7f78d26ce4`
**Preservation:** branch `arch-transformation` @ `c4320fe`, tag `pre-transformation-checkpoint`
**Archive:** `archive/` (Git-ignored, local reference only)

## Correction to the earlier removal

The earlier transformation deleted the Python tree. That was corrected: every
Python source, Python test, audit script, requirements file and Python-specific
configuration was reconstructed from the baseline Git objects into `archive/`
with its original relative path. Nothing is permanently lost, and the archive is
not part of the active application or the published package.

## Archive integrity

| Measure | Result |
|---|---:|
| Archived files | 501 |
| Archived `.py` files | 495 |
| Archived production modules | 388 |
| Archived production LOC | 107,599 |
| Archived Python physical LOC | 154,563 |
| Total archived bytes | 6,079,449 |
| Missing files | 0 |
| SHA-256 mismatches | 0 |

`AELVO_ARCHIVE_MANIFEST.json` records every original path, archived path, byte
size and SHA-256 digest. Verification was run after extraction by re-hashing all
501 files; every digest matched.

## What moved into the archive

| Path | Contents |
|---|---|
| `archive/main.py` | legacy application entry point |
| `archive/auth/` | credential storage, provider adapters, legacy provider runtime |
| `archive/cli/` | Python CLI/REPL |
| `archive/cognition/` | specialist cognition modules |
| `archive/config/` | legacy settings |
| `archive/core/` | execution, filesystem, governance, orchestration, RAG, registry, security, workers |
| `archive/learning/` | legacy learning modules |
| `archive/mcp/` | custom MCP protocol, registry, transport, governance, recovery and coding integrations |
| `archive/memory/` | user model and legacy memory implementations |
| `archive/planning/` | planning, goal hierarchy, forecasting and critique pipelines |
| `archive/repo_intelligence/` | repository/code intelligence |
| `archive/runtime_next/` | execution graph, plan, verification, recovery, monitoring, security |
| `archive/shared_task_board/` | coding task-board state machines |
| `archive/specialists/` | seven-specialist implementations |
| `archive/tools/` | legacy code/git/diagram/research/security tools |
| `archive/web/` | Python web server and bridge |
| `archive/tests/` | Python test suite (103 files / 45,444 LOC) |
| `archive/requirements*.txt`, `pytest.ini`, `ruff.toml`, `aelvo.bat` | Python development/runtime configuration |
| `archive/audit_artifacts/` | Python audit helpers |

## What was removed from the active tree

The 505 tracked files are absent from the active tree (Git shows them as
deletions): 501 archived Python-related files plus 4 Python audit helpers. They
now live only in the ignored archive. The active tree contains:

- `src/` — TypeScript runtime
- `web/` — React/Vite shell
- `sandbox_core/` — Rust security primitives
- `tests/ts/` and `tests/install/` — Node test suites

The old Python bootstrap library (`bin/lib/{deps,python,runtime,lock,ui}.js`) was
also removed; `bin/aelvo.js` and `bin/install.js` are now Node-only.

## Exclusion verification

| Surface | Result |
|---|---|
| Git | `/archive/` in `.gitignore`; `git check-ignore archive/main.py` matches |
| TypeScript build | `archive` in `tsconfig.json` exclude; include is `src/**/*.ts` |
| Vitest | include is `tests/ts/**/*.test.ts`; `archive/**` explicitly excluded |
| npm package | `files` whitelist plus `.npmignore`; `npm pack --dry-run` has no archive entries |
| Python runtime | 0 active `.py` files; no Python launcher or requirements |

## Validation

- Archive re-hash: 0 mismatches, 0 missing.
- `npm run typecheck`: exit 0.
- `npm test`: 46/46 passing.
- `npm run test:install`: 7/7 passing.
- `npm pack --dry-run`: 93 files, 110.6 kB, JavaScript-only payload.

The archive is retained as the authoritative source reference for the remaining
`BLOCKED` mappings in `AELVO_PORT_MAPPING.json`.
