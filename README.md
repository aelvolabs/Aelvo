# AELVO 3.0

**A local-first, governed personal runtime.**

AELVO is a Node/TypeScript runtime that runs tasks through one authoritative
coordinator. Every tool call passes through a governed executor: policy is
decided by code, not by the model, privileged actions require a single-use,
digest-bound user approval, and a tool only counts as successful when its
effect has been verified by reading state back.

## Requirements

- Node.js 24 or newer (`node:sqlite`, built-in type stripping).
- A Google Gemini API key for live model calls. Without one, the runtime fails
  loudly with `PROVIDER_NOT_CONFIGURED` — there is no simulated fallback.

## Install

```bash
npm install -g aelvo
aelvo doctor
```

From a checkout:

```bash
npm install
npm run build
node dist/cli/entry.js doctor
```

## Configure

```bash
export GEMINI_API_KEY=...     # or GOOGLE_API_KEY
export AELVO_MODEL=gemini-2.5-flash
export AELVO_WORKSPACE=/path/to/folder   # default: current directory
export AELVO_DATA_DIR=~/.aelvo           # default
```

The model identifier is never hardcoded. Credentials are stored through the OS
backend (DPAPI on Windows, Keychain on macOS, `secret-tool` on Linux); there is
no plaintext fallback.

## Use

```bash
aelvo doctor                 # verify the environment, honestly (exit 1 on failure)
aelvo config                 # resolved paths and policy
aelvo run "summarize notes.md"   # one governed run
aelvo chat                   # interactive loop
aelvo plan --materialize "1. step one
2. step two"   # durable, dependent tasks
aelvo serve                  # authenticated local WebSocket bridge
aelvo memory remember "..."  # durable memory with provenance
aelvo task list              # durable task queue
aelvo mcp status             # MCP servers and their tools
```

Exit codes: `0` success, `1` runtime failure, `2` usage error, `3` approval
required.

## What is governed

| Boundary | Behaviour |
|---|---|
| Tool execution | Only through the governed executor; Zod-validated input; evidence required |
| Permissions | Decided by the security policy service; the model cannot grant itself access |
| Privileged actions | Pause for approval; approvals are single-use, digest-bound and die on restart |
| Process execution | Fails closed when the native Rust sandbox is unavailable |
| Secret files | `.env*`, `id_rsa`, `*.pem`, `*.key`, `.npmrc`, `.git-credentials` are denied to every tool |
| Paths | Workspace-contained with symlink-aware canonicalisation |
| Remote UI | Loopback only, origin allowlist, auth-first handshake, payload cap, rate limit |
| Provider | Google Gemini through the provider gateway; no mock in production |

## Architecture

```
src/app.ts                     composition root
src/cli/entry.ts               CLI
src/runtime/coordinator/       single authoritative run loop
src/runtime/execution/graph.ts dependency graph, lifecycle, retries, conditions
src/runtime/recovery/          failure classification and retry safety
src/tools/                     registry, filesystem tools, governed executor
src/security/                  policy, paths, approvals, audit, credentials, sandbox
src/memory/                    durable memory with provenance and supersession
src/tasks/, src/scheduler/     durable task queue and schedules
src/intelligence/providers/    provider gateway (Google, unconfigured, mock for tests)
src/mcp/                       official MCP SDK manager
src/runtime/bridge/            authenticated local bridge
web/                           React/Vite shell (bridge consumer)
sandbox_core/                  Rust security primitives
```

## Tests

```bash
npm test              # Vitest suites in tests/ts
npm run test:install  # Node installer/launcher tests
npm run verify        # typecheck + build + unit tests
```

Tests use the scripted mock provider; live provider calls require a real key.

## Status and limits

The Python production runtime from AELVO 2.x has been retired. The 3.0 runtime
is TypeScript. Some acceptance evidence cannot be produced on every host:

- Live model verification requires a provider key.
- The Rust sandbox must be compiled (`cargo build --release` in `sandbox_core`)
  before process execution is available; until then it fails closed.
- macOS/Linux credential backends are implemented but only the Windows DPAPI
  path has been exercised here.

The legacy Python implementation is retained locally in `archive/`, which is
Git-ignored and excluded from the TypeScript build, tests and npm package. It is
a reference for further ports, not part of the running application.

See `AELVO_PORT_MAPPING.json` for every archived module's disposition and
`AELVO_TRANSFORMATION_REPORT.md` for the honest gate-by-gate result.
