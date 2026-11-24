#!/usr/bin/env node
/**
 * aelvo.js — the `aelvo` / `Aelvo` command launcher.
 *
 * `npm install -g aelvo` puts this on PATH. Running `Aelvo` opens the *current
 * working directory*; `Aelvo <folder>` opens any folder.
 *
 * Startup path (fast → slow), never installing Python:
 *   1. A verified runtime environment for this dependency set already exists
 *      → launch it immediately (state file only, no interpreter probe).
 *   2. A runtime exists but looks unhealthy → re-verify, then repair if needed.
 *   3. Nothing usable → run the installer (progress on stderr), then launch.
 *
 * The child always runs with cwd = the user's shell directory and with
 * AELVO_DATA_DIR + PYTHONPATH set, so relative folder arguments keep resolving
 * against where the user actually typed the command.
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const deps = require("./lib/deps");
const runtime = require("./lib/runtime");
const { createUi } = require("./lib/ui");
const { detectPython, formatVersion } = require("./lib/python");

const PKG_ROOT = path.join(__dirname, "..");

function readPackageJson(pkgRoot) {
  return JSON.parse(fs.readFileSync(path.join(pkgRoot || PKG_ROOT, "package.json"), "utf8"));
}

/** Everything the Python child needs, without mutating the parent env. */
function buildChildEnv(pkgRoot, env) {
  const base = env || process.env;
  const childEnv = { ...base };
  if (!childEnv.AELVO_DATA_DIR) {
    childEnv.AELVO_DATA_DIR = path.join(os.homedir(), ".aelvo");
  }
  childEnv.PYTHONPATH = pkgRoot + (base.PYTHONPATH ? path.delimiter + base.PYTHONPATH : "");
  return childEnv;
}

/** `aelvo <args>` → `python -m cli <args>` (plus any interpreter prefix args). */
function buildChildArgs(prefixArgs, userArgs) {
  return (prefixArgs || []).concat(["-m", "cli"], userArgs || []);
}

function verificationTtl(env) {
  return runtime.verificationTtlMs(env);
}

/**
 * Decide how to launch the CLI.
 * @returns {{command:string, args:string[], env:object, source:string, key?:string}}
 */
function resolveLaunch(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const ui = opts.ui || createUi({ env });
  const pkgRoot = opts.pkgRoot || PKG_ROOT;
  const userArgs = opts.args || [];
  const platform = opts.platform || process.platform;
  const childEnv = buildChildEnv(pkgRoot, env);

  // Escape hatch for CI / power users: run an already-prepared interpreter.
  if (env.AELVO_SKIP_BOOTSTRAP === "1") {
    const python = (opts.detectPython || detectPython)({ env, platform });
    ui.info(`AELVO_SKIP_BOOTSTRAP=1 — using ${python.source} (Python ${formatVersion(python.version)}).`);
    return {
      command: python.command,
      args: buildChildArgs(python.args, userArgs),
      env: childEnv,
      source: "system",
    };
  }

  const pkg = opts.pkg || readPackageJson(pkgRoot);
  const requirements =
    opts.requirements || deps.readRequirements(deps.requirementsPath(pkgRoot));
  const lockHash = deps.lockHash(requirements.entries);
  const scan = (opts.scanRuntimes || runtime.scanRuntimes)({
    pkgVersion: pkg.version,
    lockHash,
    env,
    platform,
    root: opts.root,
  });

  if (scan.length) {
    const candidate = scan[0];
    const verify =
      opts.verify ||
      ((envDir) => {
        const result = deps.verifyEnvironment({
          pythonPath: runtime.venvPythonPath(envDir, platform),
          entries: requirements.entries,
          env: childEnv,
        });
        if (result.ok) {
          try {
            const state = runtime.readState(envDir) || {};
            runtime.writeState(envDir, { ...state, verified_at: Date.now() });
          } catch (err) {
            /* best effort */
          }
        }
        return result;
      });

    const fresh =
      env.AELVO_FORCE_VERIFY !== "1" &&
      runtime.isVerificationFresh(candidate.state, verificationTtl(env), Date.now());

    if (fresh || verify(candidate.dir).ok) {
      return {
        command: candidate.pythonPath,
        args: buildChildArgs([], userArgs),
        env: childEnv,
        source: "runtime",
        key: candidate.key,
      };
    }
    ui.warn(
      "The installed AELVO environment is unhealthy — repairing it before launch."
    );
  }

  // Nothing usable: build/repair, then launch what we just validated.
  const runInstall = opts.install || require("./install").runInstall;
  const installed = runInstall({
    pkgRoot,
    env,
    ui,
    pkg,
    requirements,
    detectPython: opts.detectPython,
  });
  if (installed && installed.pythonPath) {
    return {
      command: installed.pythonPath,
      args: buildChildArgs([], userArgs),
      env: childEnv,
      source: installed.reused ? "runtime-reused" : "runtime-installed",
      key: installed.key,
    };
  }
  const error = new Error(
    "AELVO could not prepare a Python environment. See the messages above, " +
      "then run `npm rebuild aelvo`."
  );
  error.code = "AELVO_SETUP_FAILED";
  throw error;
}

/**
 * Spawn options for the CLI child. `cwd` is deliberately the user's shell
 * directory (never the package root) so relative folder arguments resolve the
 * way the user typed them.
 */
function spawnOptionsFor(launch, cwdProvider) {
  const cwd = (cwdProvider || (() => process.cwd()))();
  return { cwd, env: launch.env, stdio: "inherit" };
}

function main(argv) {
  const args = argv || process.argv.slice(2);
  const ui = createUi({});

  let launch;
  try {
    launch = resolveLaunch({ args, ui });
  } catch (err) {
    ui.error(err && err.message ? err.message : String(err));
    if (err && err.code === "AELVO_NO_PYTHON") {
      ui.error("Install Python 3.10+ and make sure it is on PATH.");
    }
    return 1;
  }

  const child = spawn(launch.command, launch.args, spawnOptionsFor(launch));

  child.on("error", (err) => {
    ui.error(`Failed to start Python: ${err.message}`);
    ui.error(
      "Install Python 3.10+ and ensure it is on PATH, then run `npm rebuild aelvo`."
    );
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exitCode = code == null ? 0 : code;
    }
  });

  return null; // asynchronous: the child drives the exit code
}

if (require.main === module) {
  const result = main();
  if (typeof result === "number") process.exit(result);
}

module.exports = {
  buildChildArgs,
  buildChildEnv,
  main,
  readPackageJson,
  resolveLaunch,
  spawnOptionsFor,
};
