"use strict";
/** Launcher decisions: environment, argument forwarding, repair path. */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const launcher = require("../../bin/aelvo");
const { parseRequirements } = require("../../bin/lib/deps");

const PKG = { name: "aelvo", version: "2.5.0" };
const REQS = parseRequirements("rich==15.0.0\npydantic==2.14.3");

function quietUi() {
  return {
    step() {},
    info() {},
    success() {},
    warn() {},
    error() {},
    log() {},
  };
}

function baseOptions(overrides = {}) {
  return {
    pkg: PKG,
    requirements: REQS,
    env: {},
    ui: quietUi(),
    pkgRoot: path.join(os.tmpdir(), "aelvo-fake-pkg"),
    platform: "linux",
    args: ["fix", "the bug"],
    ...overrides,
  };
}

test("buildChildEnv sets a stable data dir and prepends PYTHONPATH", () => {
  const env = launcher.buildChildEnv("/opt/aelvo", { PATH: "/bin" });
  assert.equal(env.AELVO_DATA_DIR, path.join(os.homedir(), ".aelvo"));
  assert.equal(env.PYTHONPATH, "/opt/aelvo");
  assert.equal(env.PATH, "/bin");
});

test("buildChildEnv respects an existing data dir and PYTHONPATH", () => {
  const env = launcher.buildChildEnv("/opt/aelvo", {
    AELVO_DATA_DIR: "/custom/data",
    PYTHONPATH: "/existing",
  });
  assert.equal(env.AELVO_DATA_DIR, "/custom/data");
  assert.equal(env.PYTHONPATH, `/opt/aelvo${path.delimiter}/existing`);
});

test("buildChildArgs forwards user arguments after `-m cli`", () => {
  assert.deepEqual(launcher.buildChildArgs([], ["--version"]), ["-m", "cli", "--version"]);
  assert.deepEqual(launcher.buildChildArgs(["-3"], ["a", "b"]), ["-3", "-m", "cli", "a", "b"]);
});

test("AELVO_SKIP_BOOTSTRAP uses a validated interpreter and never installs", () => {
  let installCalls = 0;
  const launch = launcher.resolveLaunch(
    baseOptions({
      env: { AELVO_SKIP_BOOTSTRAP: "1" },
      scanRuntimes: () => {
        throw new Error("scan must not run when bootstrap is skipped");
      },
      detectPython: () => ({
        command: "py",
        args: ["-3"],
        version: { major: 3, minor: 13, patch: 0 },
        source: "py -3",
      }),
      install: () => {
        installCalls += 1;
        return {};
      },
    })
  );
  assert.equal(launch.source, "system");
  assert.equal(launch.command, "py");
  assert.deepEqual(launch.args, ["-3", "-m", "cli", "fix", "the bug"]);
  assert.equal(installCalls, 0);
});

test("a fresh runtime launches instantly without a verification subprocess", () => {
  let verifyCalls = 0;
  const launch = launcher.resolveLaunch(
    baseOptions({
      scanRuntimes: () => [
        {
          dir: "/r/py313-linux-x64-v2-aaaaaaaaaaaa",
          key: "py313-linux-x64-v2-aaaaaaaaaaaa",
          pythonPath: "/r/env/bin/python",
          state: {
            state: "ready",
            key: "py313-linux-x64-v2-aaaaaaaaaaaa",
            deps_hash: "x",
            verified_at: Date.now(),
          },
        },
      ],
      verify: () => {
        verifyCalls += 1;
        return { ok: true };
      },
    })
  );
  assert.equal(launch.source, "runtime");
  assert.equal(launch.command, "/r/env/bin/python");
  assert.deepEqual(launch.args, ["-m", "cli", "fix", "the bug"]);
  assert.equal(verifyCalls, 0, "cached verification must be used");
});

test("a stale runtime is re-verified before launching", () => {
  let verified = null;
  const launch = launcher.resolveLaunch(
    baseOptions({
      scanRuntimes: () => [
        {
          dir: "/r/env",
          key: "k",
          pythonPath: "/r/env/bin/python",
          state: { state: "ready", key: "k", deps_hash: "x", verified_at: 0 },
        },
      ],
      verify: (dir) => {
        verified = dir;
        return { ok: true };
      },
    })
  );
  assert.equal(verified, "/r/env");
  assert.equal(launch.command, "/r/env/bin/python");
});

test("an unhealthy runtime triggers install and launches the repaired env", () => {
  let installOptions = null;
  const launch = launcher.resolveLaunch(
    baseOptions({
      scanRuntimes: () => [
        {
          dir: "/r/env",
          key: "k",
          pythonPath: "/r/env/bin/python",
          state: { state: "ready", key: "k", deps_hash: "x", verified_at: 0 },
        },
      ],
      verify: () => ({ ok: false, missing: ["rich"] }),
      install: (options) => {
        installOptions = options;
        return { pythonPath: "/r/env/bin/python", key: "k", reused: false };
      },
    })
  );
  assert.ok(installOptions, "install must be invoked for an unhealthy env");
  assert.equal(installOptions.pkgRoot, path.join(os.tmpdir(), "aelvo-fake-pkg"));
  assert.equal(launch.source, "runtime-installed");
  assert.equal(launch.command, "/r/env/bin/python");
});

test("with no runtime at all the installer runs before launch", () => {
  let called = 0;
  const launch = launcher.resolveLaunch(
    baseOptions({
      scanRuntimes: () => [],
      install: () => {
        called += 1;
        return { pythonPath: "/new/env/bin/python", key: "new", reused: true };
      },
    })
  );
  assert.equal(called, 1);
  assert.equal(launch.source, "runtime-reused");
  assert.deepEqual(launch.args, ["-m", "cli", "fix", "the bug"]);
});

test("a setup that produces no environment fails loudly", () => {
  assert.throws(
    () =>
      launcher.resolveLaunch(
        baseOptions({
          scanRuntimes: () => [],
          install: () => ({ skipped: true }),
        })
      ),
    (err) => {
      assert.equal(err.code, "AELVO_SETUP_FAILED");
      assert.match(err.message, /npm rebuild aelvo/);
      return true;
    }
  );
});
