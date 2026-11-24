"use strict";
/**
 * Runtime environment lifecycle: keying, reuse, atomic build, repair,
 * legacy adoption, incomplete-install detection and pruning.
 *
 * A fake `createVenv`/`installDeps`/`verify` is injected, so the state machine
 * is exercised without touching the network or a real pip.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runtime = require("../../bin/lib/runtime");
const { createUi } = require("../../bin/lib/ui");

const PLATFORM = "linux";
const LOCK_HASH = "a".repeat(64);
const PKG_VERSION = "2.5.0";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aelvo-runtime-"));
}

function quietUi() {
  return createUi({
    env: { AELVO_QUIET: "1" },
    stream: { write() {} },
  });
}

/** Fake venv creation: lays down a plausible interpreter path. */
function makeCreateVenv({ withPython = true } = {}) {
  const calls = [];
  const fn = (python, envDir) => {
    calls.push({ python, envDir });
    fs.mkdirSync(envDir, { recursive: true });
    if (withPython) {
      const pyPath = runtime.venvPythonPath(envDir, PLATFORM);
      fs.mkdirSync(path.dirname(pyPath), { recursive: true });
      fs.writeFileSync(pyPath, "#!/bin/sh\n");
    }
  };
  fn.calls = calls;
  return fn;
}

function makeInstallDeps() {
  const calls = [];
  const fn = (pythonPath, requirementsPath) => {
    calls.push({ pythonPath, requirementsPath });
  };
  fn.calls = calls;
  return fn;
}

function baseOptions(overrides = {}) {
  const root = overrides.root || tmpRoot();
  const pkgRoot = overrides.pkgRoot || tmpRoot();
  return {
    pkgRoot,
    pkgVersion: PKG_VERSION,
    python: { command: "python3", args: [], version: { major: 3, minor: 13, patch: 1 }, source: "test" },
    entries: [],
    requirementsPath: path.join(pkgRoot, "requirements-cli.txt"),
    lockHash: LOCK_HASH,
    env: { AELVO_RUNTIME_DIR: root, AELVO_QUIET: "1" },
    ui: quietUi(),
    platform: PLATFORM,
    root,
    verify: () => ({ ok: true }),
    createVenv: makeCreateVenv(),
    installDeps: makeInstallDeps(),
    ...overrides,
  };
}

function seedEnv(root, key, state, { withPython = true } = {}) {
  const dir = path.join(root, key);
  fs.mkdirSync(dir, { recursive: true });
  if (withPython) {
    const pyPath = runtime.venvPythonPath(dir, PLATFORM);
    fs.mkdirSync(path.dirname(pyPath), { recursive: true });
    fs.writeFileSync(pyPath, "#!/bin/sh\n");
  }
  if (state) runtime.writeState(dir, state);
  return dir;
}

test("runtimeKey is stable across patch releases and pinned inputs", () => {
  const base = {
    pkgVersion: "2.4.6",
    python: { version: { major: 3, minor: 13, patch: 1 } },
    platform: "linux",
    arch: "x64",
    lockHash: LOCK_HASH,
  };
  const patchBump = runtime.runtimeKey({ ...base, pkgVersion: "2.5.0" });
  assert.equal(runtime.runtimeKey(base), patchBump, "patch/minor bumps must reuse the env");

  assert.notEqual(
    runtime.runtimeKey(base),
    runtime.runtimeKey({ ...base, pkgVersion: "3.0.0" }),
    "a major bump must not reuse the env"
  );
  assert.notEqual(
    runtime.runtimeKey(base),
    runtime.runtimeKey({ ...base, lockHash: "b".repeat(64) }),
    "a dependency change must not reuse the env"
  );
  assert.notEqual(
    runtime.runtimeKey(base),
    runtime.runtimeKey({ ...base, python: { version: { major: 3, minor: 12, patch: 9 } } })
  );
});

test("stateMatches only trusts a ready state for the same key and deps", () => {
  const ready = { state: "ready", key: "k1", deps_hash: "h1" };
  assert.equal(runtime.stateMatches(ready, "k1", "h1"), true);
  assert.equal(runtime.stateMatches(ready, "k2", "h1"), false);
  assert.equal(runtime.stateMatches(ready, "k1", "h2"), false);
  assert.equal(runtime.stateMatches({ ...ready, state: "installing" }, "k1", "h1"), false);
  assert.equal(runtime.stateMatches(null, "k1", "h1"), false);
});

test("ensureRuntime builds, verifies and records a ready environment", () => {
  const createVenv = makeCreateVenv();
  const installDeps = makeInstallDeps();
  const opts = baseOptions({ createVenv, installDeps });

  const result = runtime.ensureRuntime(opts);

  assert.equal(result.reused, false);
  assert.ok(fs.existsSync(result.dir));
  assert.ok(fs.existsSync(result.pythonPath));
  assert.equal(result.pythonPath, path.join(result.dir, "bin", "python"));
  assert.equal(createVenv.calls.length, 1);
  assert.equal(installDeps.calls.length, 1);
  assert.equal(installDeps.calls[0].requirementsPath, opts.requirementsPath);

  const state = runtime.readState(result.dir);
  assert.equal(state.state, "ready");
  assert.equal(state.key, result.key);
  assert.equal(state.deps_hash, LOCK_HASH);
  assert.equal(state.python_version, "3.13.1");
  assert.equal(state.pkg_version, PKG_VERSION);

  // No temp build directories are left behind.
  const leftovers = fs.readdirSync(opts.root).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("ensureRuntime reuses a healthy environment without reinstalling", () => {
  const createVenv = makeCreateVenv();
  const installDeps = makeInstallDeps();
  const first = runtime.ensureRuntime(baseOptions({ createVenv, installDeps }));
  assert.equal(createVenv.calls.length, 1);

  const verifyCalls = [];
  const second = runtime.ensureRuntime(
    baseOptions({
      createVenv,
      installDeps,
      root: path.dirname(first.dir),
      verify: (dir) => {
        verifyCalls.push(dir);
        return { ok: true };
      },
    })
  );

  assert.equal(second.reused, true);
  assert.equal(second.dir, first.dir);
  assert.equal(createVenv.calls.length, 1, "must not rebuild a healthy environment");
  assert.equal(installDeps.calls.length, 1);
  assert.deepEqual(verifyCalls, [], "a freshly verified env must not be re-verified");
});

test("an unhealthy environment is repaired without breaking the install", () => {
  const key = runtime.runtimeKey({
    pkgVersion: PKG_VERSION,
    python: { version: { major: 3, minor: 13, patch: 1 } },
    platform: PLATFORM,
    arch: process.arch,
    lockHash: LOCK_HASH,
  });
  const root = tmpRoot();
  const staleDir = seedEnv(
    root,
    key,
    {
      state: "ready",
      key,
      deps_hash: LOCK_HASH,
      created_at: 1,
      verified_at: 0, // force re-verification
      python_version: "3.13.1",
      pkg_version: "2.4.0",
    }
  );

  const createVenv = makeCreateVenv();
  const result = runtime.ensureRuntime(
    baseOptions({
      root,
      createVenv,
      // The old env fails, the freshly built one passes.
      verify: (dir) => ({ ok: dir.includes(".tmp-") }),
    })
  );

  assert.equal(result.reused, false);
  assert.equal(result.repaired, true);
  assert.equal(createVenv.calls.length, 1);
  assert.equal(runtime.readState(result.dir).state, "ready");
  assert.notEqual(result.dir, staleDir);
  assert.ok(fs.existsSync(result.pythonPath));
});

test("a failed verification keeps the previous environment intact", () => {
  const key = runtime.runtimeKey({
    pkgVersion: PKG_VERSION,
    python: { version: { major: 3, minor: 13, patch: 1 } },
    platform: PLATFORM,
    arch: process.arch,
    lockHash: LOCK_HASH,
  });
  const root = tmpRoot();
  const oldDir = seedEnv(root, key, {
    state: "ready",
    key,
    deps_hash: LOCK_HASH,
    created_at: 1,
    verified_at: 0,
  });
  const before = fs.readFileSync(path.join(oldDir, runtime.STATE_FILE), "utf8");

  assert.throws(
    () =>
      runtime.ensureRuntime(
        baseOptions({
          root,
          verify: () => ({
            ok: false,
            missing: ["rich"],
            mismatched: [],
            unimportable: [],
            entry_missing: false,
          }),
        })
      ),
    (err) => {
      assert.equal(err.code, "AELVO_VERIFY_FAILED");
      assert.match(err.message, /missing: rich/);
      return true;
    }
  );

  // Nothing was destroyed and no temp build remains.
  assert.ok(fs.existsSync(oldDir));
  assert.equal(fs.readFileSync(path.join(oldDir, runtime.STATE_FILE), "utf8"), before);
  const leftovers = fs.readdirSync(root).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("a venv created without a Python executable is rejected", () => {
  const createVenv = makeCreateVenv({ withPython: false });
  assert.throws(
    () => runtime.ensureRuntime(baseOptions({ createVenv })),
    (err) => {
      assert.equal(err.code, "AELVO_VENV_INCOMPLETE");
      return true;
    }
  );
});

test("a failed pip install leaves no environment marked ready", () => {
  const opts = baseOptions({
    installDeps: () => {
      const err = new Error("Dependency installation failed");
      err.code = "AELVO_PIP_FAILED";
      throw err;
    },
  });
  assert.throws(() => runtime.ensureRuntime(opts), /Dependency installation failed/);
  const dirs = fs.readdirSync(opts.root).filter((name) => !name.startsWith("."));
  assert.deepEqual(dirs, [], "no half-built environment may be left behind");
});

test("a healthy legacy .venv inside the package is reused", () => {
  const pkgRoot = tmpRoot();
  const legacyDir = path.join(pkgRoot, ".venv");
  const legacyPython = runtime.venvPythonPath(legacyDir, PLATFORM);
  fs.mkdirSync(path.dirname(legacyPython), { recursive: true });
  fs.writeFileSync(legacyPython, "#!/bin/sh\n");

  const createVenv = makeCreateVenv();
  const result = runtime.ensureRuntime(
    baseOptions({ pkgRoot, createVenv, verify: () => ({ ok: true }) })
  );

  assert.equal(result.legacy, true);
  assert.equal(result.dir, legacyDir);
  assert.equal(result.pythonPath, legacyPython);
  assert.equal(createVenv.calls.length, 0, "must not rebuild when the legacy env is healthy");
});

test("an unusable legacy .venv is replaced by a persistent environment", () => {
  const pkgRoot = tmpRoot();
  const legacyDir = path.join(pkgRoot, ".venv");
  fs.mkdirSync(path.join(legacyDir, "bin"), { recursive: true });
  fs.writeFileSync(runtime.venvPythonPath(legacyDir, PLATFORM), "#!/bin/sh\n");

  const result = runtime.ensureRuntime(
    baseOptions({
      pkgRoot,
      verify: (dir) => ({ ok: !dir.includes(".venv") }),
    })
  );

  assert.equal(result.legacy, false);
  assert.ok(result.dir.includes("runtimes") || result.dir.includes("aelvo-runtime"));
  assert.ok(fs.existsSync(result.pythonPath));
});

test("scanRuntimes finds ready envs for the current dependency set only", () => {
  const root = tmpRoot();
  const keyA = "py313-linux-x64-v2-aaaaaaaaaaaa";
  const keyB = "py313-linux-x64-v2-bbbbbbbbbbbb";
  const keyC = "py312-linux-x64-v2-aaaaaaaaaaaa";
  seedEnv(root, keyA, {
    state: "ready",
    key: keyA,
    deps_hash: LOCK_HASH,
    verified_at: 100,
  });
  seedEnv(root, keyB, {
    state: "ready",
    key: keyB,
    deps_hash: "c".repeat(64), // different deps
    verified_at: 500,
  });
  seedEnv(root, keyC, {
    state: "ready",
    key: keyC,
    deps_hash: LOCK_HASH, // same deps, different Python key
    verified_at: 900,
  });

  const found = runtime.scanRuntimes({
    root,
    pkgVersion: PKG_VERSION,
    lockHash: LOCK_HASH,
    platform: PLATFORM,
  });

  assert.equal(found.length, 1);
  assert.equal(found[0].key, keyA);
});

test("scanRuntimes ignores environments whose interpreter vanished", () => {
  const root = tmpRoot();
  const key = "py313-linux-x64-v2-aaaaaaaaaaaa";
  seedEnv(
    root,
    key,
    { state: "ready", key, deps_hash: LOCK_HASH, verified_at: 1 },
    { withPython: false }
  );
  assert.deepEqual(
    runtime.scanRuntimes({ root, pkgVersion: PKG_VERSION, lockHash: LOCK_HASH, platform: PLATFORM }),
    []
  );
});

test("findHealthyRuntime trusts a fresh state file but re-verifies a stale one", () => {
  const root = tmpRoot();
  const key = "py313-linux-x64-v2-aaaaaaaaaaaa";
  seedEnv(root, key, {
    state: "ready",
    key,
    deps_hash: LOCK_HASH,
    verified_at: Date.now(),
  });

  const freshCalls = [];
  const fresh = runtime.findHealthyRuntime({
    root,
    key,
    lockHash: LOCK_HASH,
    platform: PLATFORM,
    verify: (dir) => {
      freshCalls.push(dir);
      return { ok: true };
    },
  });
  assert.equal(fresh.cached, true);
  assert.deepEqual(freshCalls, []);

  const staleDir = seedEnv(root, key, {
    state: "ready",
    key,
    deps_hash: LOCK_HASH,
    verified_at: 0,
  });
  let called = 0;
  const stale = runtime.findHealthyRuntime({
    root,
    key,
    lockHash: LOCK_HASH,
    platform: PLATFORM,
    verify: () => {
      called += 1;
      return { ok: true };
    },
  });
  assert.equal(called, 1);
  assert.equal(stale.cached, false);
  assert.ok(runtime.readState(staleDir).verified_at > 0, "re-verification refreshes the timestamp");
});

test("cleanupObsolete prunes old environments but keeps the active key", () => {
  const root = tmpRoot();
  const keep = "py313-linux-x64-v2-aaaaaaaaaaaa";
  const old = "py312-linux-x64-v2-aaaaaaaaaaaa";
  seedEnv(root, keep, { state: "ready", key: keep, deps_hash: LOCK_HASH, created_at: 1 });
  seedEnv(root, old, { state: "ready", key: old, deps_hash: "d".repeat(64), created_at: 1 });

  const removed = runtime.cleanupObsolete(root, {
    keepKey: keep,
    maxAgeMs: 1000,
    now: () => Date.now(),
  });

  assert.deepEqual(removed, [old]);
  assert.ok(fs.existsSync(path.join(root, keep)));
  assert.equal(fs.existsSync(path.join(root, old)), false);
});

test("pruneTemps removes abandoned temp builds", () => {
  const root = tmpRoot();
  const tmp = path.join(root, `py313-linux-x64-v2-aaaaaaaaaaaa.tmp-1234`);
  fs.mkdirSync(tmp, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(tmp, old, old);

  const removed = runtime.pruneTemps(root);
  assert.deepEqual(removed, [path.basename(tmp)]);
  assert.equal(fs.existsSync(tmp), false);
});
