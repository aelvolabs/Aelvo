"use strict";
/**
 * Python detection + version validation.
 * Subprocess calls are mocked through the injectable `runner`, so these tests
 * are fast and never depend on the machine's real interpreter.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyVersion,
  compareVersions,
  detectPython,
  formatVersion,
  parseVersion,
} = require("../../bin/lib/python");

/** Build a fake runner from a { "cmd args": {status, stdout, stderr} } table. */
function fakeRunner(table) {
  const calls = [];
  const runner = (command, args) => {
    const key = [command].concat(args || []).join(" ");
    calls.push(key);
    const entry = table[key];
    if (!entry) return { status: 1, stdout: "", stderr: "", error: { code: "ENOENT" } };
    return {
      status: entry.status == null ? 0 : entry.status,
      stdout: entry.stdout || "",
      stderr: entry.stderr || "",
      error: entry.error || null,
    };
  };
  runner.calls = calls;
  return runner;
}

test("parseVersion reads stdout and stderr forms", () => {
  assert.deepEqual(parseVersion("Python 3.13.16"), { major: 3, minor: 13, patch: 16 });
  assert.deepEqual(parseVersion("Python 3.10.0\n"), { major: 3, minor: 10, patch: 0 });
  assert.deepEqual(parseVersion("garbage\nPython 3.12.4"), { major: 3, minor: 12, patch: 4 });
  assert.equal(parseVersion("Python was not found; run without arguments"), null);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion(null), null);
});

test("compareVersions orders correctly", () => {
  assert.ok(compareVersions({ major: 3, minor: 9, patch: 0 }, { major: 3, minor: 10, patch: 0 }) < 0);
  assert.ok(compareVersions({ major: 3, minor: 13, patch: 2 }, { major: 3, minor: 13, patch: 1 }) > 0);
  assert.equal(
    compareVersions({ major: 3, minor: 11, patch: 5 }, { major: 3, minor: 11, patch: 5 }),
    0
  );
});

test("classifyVersion enforces the supported window", () => {
  assert.equal(classifyVersion({ major: 3, minor: 9, patch: 18 }).supported, false);
  assert.equal(classifyVersion({ major: 3, minor: 10, patch: 0 }).supported, true);
  assert.equal(classifyVersion({ major: 3, minor: 13, patch: 9 }).supported, true);

  const tooNew = classifyVersion({ major: 3, minor: 14, patch: 0 });
  assert.equal(tooNew.supported, false);
  assert.match(tooNew.reason, /newer than the tested range/);

  const overridden = classifyVersion({ major: 3, minor: 14, patch: 0 }, {
    AELVO_ALLOW_UNSUPPORTED_PYTHON: "1",
  });
  assert.equal(overridden.supported, true);
  assert.equal(overridden.warned, true);

  assert.equal(classifyVersion(null).supported, false);
});

test("formatVersion renders a readable version", () => {
  assert.equal(formatVersion({ major: 3, minor: 12, patch: 1 }), "3.12.1");
  assert.equal(formatVersion(null), "unknown");
});

test("detectPython prefers AELVO_PYTHON", () => {
  const runner = fakeRunner({
    "custom/python --version": { stdout: "Python 3.12.2" },
    "python3 --version": { stdout: "Python 3.13.1" },
  });
  const python = detectPython({
    env: { AELVO_PYTHON: "custom/python" },
    platform: "linux",
    runner,
  });
  assert.equal(python.command, "custom/python");
  assert.deepEqual(python.version, { major: 3, minor: 12, patch: 2 });
  assert.equal(python.source, "AELVO_PYTHON");
});

test("detectPython skips Python 2 and falls through to the next candidate", () => {
  const runner = fakeRunner({
    "python3 --version": { stdout: "Python 2.7.18" },
    "python --version": { stdout: "Python 3.11.4" },
  });
  const python = detectPython({ env: {}, platform: "linux", runner });
  assert.equal(python.command, "python");
  assert.deepEqual(python.version, { major: 3, minor: 11, patch: 4 });
});

test("detectPython ignores a shim that does not report a version", () => {
  const runner = fakeRunner({
    "python --version": { stdout: "Python was not found; run without arguments to install from the Microsoft Store" },
    "py -3 --version": { stdout: "Python 3.13.0" },
  });
  const python = detectPython({ env: {}, platform: "win32", runner });
  assert.equal(python.command, "py");
  assert.deepEqual(python.version, { major: 3, minor: 13, patch: 0 });
});

test("detectPython reports every rejected candidate when nothing works", () => {
  const runner = fakeRunner({});
  assert.throws(
    () => detectPython({ env: {}, platform: "linux", runner }),
    (err) => {
      assert.equal(err.code, "AELVO_NO_PYTHON");
      assert.match(err.message, /Python 3\.10/);
      assert.match(err.message, /never installs Python/);
      assert.ok(err.rejected.length >= 2);
      return true;
    }
  );
});

test("detectPython rejects an unsupported-only machine with an actionable message", () => {
  const runner = fakeRunner({
    "python3 --version": { stdout: "Python 3.8.10" },
    "python --version": { stdout: "Python 3.8.10" },
  });
  assert.throws(
    () => detectPython({ env: {}, platform: "linux", runner }),
    (err) => {
      assert.match(err.message, /Python 3\.8\.10 is too old/);
      return true;
    }
  );
});
