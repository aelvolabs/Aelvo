"use strict";
/**
 * Integration checks against a REAL interpreter and a REAL launcher process.
 *
 * These skip themselves (with a visible reason) when no prepared interpreter is
 * available, so they never report a false pass on a machine without Python.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const deps = require("../../bin/lib/deps");
const launcher = require("../../bin/aelvo");

const REPO_ROOT = path.join(__dirname, "..", "..");

/** Interpreter with AELVO's CLI deps installed, or null. */
function projectPython() {
  if (process.env.AELVO_TEST_PYTHON) return process.env.AELVO_TEST_PYTHON;
  const candidates = [
    path.join(REPO_ROOT, ".venv", "Scripts", "python.exe"),
    path.join(REPO_ROOT, ".venv", "bin", "python"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const PYTHON = projectPython();

test("dependency verification passes against the prepared interpreter", (t) => {
  if (!PYTHON) {
    t.skip("no prepared interpreter (set AELVO_TEST_PYTHON to run this)");
    return;
  }
  const requirements = deps.readRequirements(deps.requirementsPath(REPO_ROOT));
  const result = deps.verifyEnvironment({
    pythonPath: PYTHON,
    entries: requirements.entries,
    env: {
      ...process.env,
      PYTHONPATH: REPO_ROOT + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ""),
    },
  });
  assert.equal(result.ok, true, deps.describeFailure(result));
});

test("the launcher forwards args and preserves the working directory", (t) => {
  if (!PYTHON) {
    t.skip("no prepared interpreter (set AELVO_TEST_PYTHON to run this)");
    return;
  }
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "aelvo-cwd-"));
  const env = {
    ...process.env,
    AELVO_SKIP_BOOTSTRAP: "1",
    AELVO_PYTHON: PYTHON,
    AELVO_QUIET: "1",
    PYTHONPATH: REPO_ROOT,
  };
  delete env.AELVO_DATA_DIR;

  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "aelvo.js"), "--version"], {
    cwd: workdir,
    env,
    encoding: "utf8",
    timeout: 180000,
  });

  const combined = `${res.stdout || ""}${res.stderr || ""}`;
  assert.equal(res.status, 0, combined);
  assert.doesNotMatch(combined, /Traceback|ImportError/);
});

test("spawnOptionsFor keeps the caller's cwd and the prepared env", () => {
  const launch = { command: "python", args: ["-m", "cli"], env: { PYTHONPATH: "/pkg" } };
  const options = launcher.spawnOptionsFor(launch, () => "/some/user/folder");
  assert.equal(options.cwd, "/some/user/folder");
  assert.equal(options.env.PYTHONPATH, "/pkg");
  assert.equal(options.stdio, "inherit");
});

test("the CLI exits non-zero for an unusable folder argument", (t) => {
  if (!PYTHON) {
    t.skip("no prepared interpreter (set AELVO_TEST_PYTHON to run this)");
    return;
  }
  const env = {
    ...process.env,
    AELVO_SKIP_BOOTSTRAP: "1",
    AELVO_PYTHON: PYTHON,
    AELVO_QUIET: "1",
    PYTHONPATH: REPO_ROOT,
  };
  const res = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "bin", "aelvo.js"), "--definitely-not-a-flag"],
    { cwd: os.tmpdir(), env, encoding: "utf8", timeout: 180000 }
  );
  assert.notEqual(res.status, 0, "an unknown flag must not exit 0");
});
