#!/usr/bin/env node
/**
 * Deterministic query helper over the audit artifacts.
 *
 * The dependency graph is never loaded into an LLM context; this script is the
 * single interface used by removal batches and tracker generation.
 *
 * Usage:
 *   node scripts/transformation/query.mjs summary
 *   node scripts/transformation/query.mjs group A          # manifest group
 *   node scripts/transformation/query.mjs consumers <path> # reverse deps
 *   node scripts/transformation/query.mjs closure <path>   # transitive deps
 *   node scripts/transformation/query.mjs group-a-check    # safety gate
 *   node scripts/transformation/query.mjs stale            # inventory vs tree
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const inventory = JSON.parse(
  readFileSync(resolve(ROOT, "AELVO_MODULE_INVENTORY.json"), "utf8"),
);
const graph = JSON.parse(
  readFileSync(resolve(ROOT, "AELVO_DEPENDENCY_GRAPH.json"), "utf8"),
);

const modules = inventory.modules;
const byPath = new Map(modules.map((m) => [m.path, m]));

/** Group A candidate paths, mirrored from AELVO_REMOVAL_MANIFEST.md §3. */
const GROUP_A = [
  ...modules
    .filter((m) => m.path.startsWith("auth/providers/"))
    .map((m) => m.path),
  ...modules.filter((m) => m.path.startsWith("auth/auth/")).map((m) => m.path),
  ...modules.filter((m) => m.path.startsWith("auth/events/")).map((m) => m.path),
  "auth/ratelimiter.py",
  "auth/circuit_breaker.py",
  "auth/runtime/streaming.py",
  ...modules
    .filter(
      (m) =>
        m.path.startsWith("learning/") &&
        !m.path.endsWith("agent_metrics.py") &&
        !m.path.endsWith("__init__.py"),
    )
    .map((m) => m.path),
  ...modules.filter((m) => m.path.startsWith("mcp/integrations/")).map((m) => m.path),
  ...modules.filter((m) => m.path.startsWith("core/workers/")).map((m) => m.path),
  "core/execution/experience_pipeline.py",
  "shared_task_board/models.py",
  "shared_task_board/context_schemas.py",
  "shared_task_board/result_schemas.py",
  "shared_task_board/collaboration_orchestrator.py",
];

const groupSet = new Set(GROUP_A.filter((p) => byPath.has(p)));
const reverse = new Map();
for (const edge of graph.edges) {
  if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
  reverse.get(edge.to).add(edge.from);
}
const forward = new Map();
for (const edge of graph.edges) {
  if (!forward.has(edge.from)) forward.set(edge.from, new Set());
  forward.get(edge.from).add(edge.to);
}

function consumersOf(path) {
  return [...(reverse.get(path) ?? [])].sort();
}

function closureOf(path) {
  const seen = new Set();
  const queue = [path];
  while (queue.length) {
    const current = queue.shift();
    for (const next of forward.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].sort();
}

function summary() {
  const byDisposition = {};
  const byLanguage = {};
  let loc = 0;
  for (const m of modules) {
    byDisposition[m.recommended_disposition] =
      (byDisposition[m.recommended_disposition] ?? 0) + 1;
    byLanguage[m.language] = (byLanguage[m.language] ?? 0) + 1;
    loc += m.loc;
  }
  console.log(
    JSON.stringify({ total: modules.length, loc, byDisposition, byLanguage }, null, 2),
  );
}

function groupA() {
  const missing = GROUP_A.filter((p) => !byPath.has(p));
  const files = GROUP_A.filter((p) => byPath.has(p));
  const totalLoc = files.reduce((sum, p) => sum + (byPath.get(p)?.loc ?? 0), 0);
  console.log(JSON.stringify({ files: files.length, loc: totalLoc, missing }, null, 2));
}

/**
 * Safety gate before deletion: every Group A member must either have no
 * consumer outside the group, or have that consumer also inside the group.
 * Anything else is deferred.
 */
function groupACheck() {
  const externalConsumers = [];
  const dangling = [];
  for (const path of groupSet) {
    for (const consumer of consumersOf(path)) {
      if (!groupSet.has(consumer) && consumer !== path) {
        externalConsumers.push({ path, consumer });
      }
    }
  }
  for (const path of groupSet) {
    if (!existsSync(resolve(ROOT, path))) dangling.push(path);
  }
  console.log(
    JSON.stringify(
      {
        groupSize: groupSet.size,
        externalConsumers,
        missingFromDisk: dangling,
        safe: externalConsumers.length === 0,
      },
      null,
      2,
    ),
  );
}

function stale() {
  const missing = modules.filter((m) => !existsSync(resolve(ROOT, m.path))).map((m) => m.path);
  console.log(JSON.stringify({ missing, count: missing.length }, null, 2));
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case "summary":
    summary();
    break;
  case "group":
    if (arg !== "A") throw new Error("only group A is defined");
    groupA();
    break;
  case "consumers":
    console.log(JSON.stringify(consumersOf(arg), null, 2));
    break;
  case "closure":
    console.log(JSON.stringify(closureOf(arg), null, 2));
    break;
  case "group-a-check":
    groupACheck();
    break;
  case "stale":
    stale();
    break;
  default:
    console.error("unknown command");
    process.exit(2);
}
