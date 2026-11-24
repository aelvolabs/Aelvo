#!/usr/bin/env node
/**
 * install.js — npm postinstall / repair entry point.
 *
 * Responsibilities:
 *   1. Make bin/* executable on POSIX (npm does not always keep the mode bit).
 *   2. Find and validate a Python interpreter (never installs Python).
 *   3. Ensure a verified, persistent virtual environment for this AELVO +
 *      dependency set, building a replacement only when none is healthy.
 *
 * Exit codes: 0 = environment ready (or deliberately skipped), 1 = setup
 * failed. A failed setup is reported loudly — never silently "succeeded".
 *
 *   node bin/install.js              # install / repair (postinstall default)
 *   node bin/install.js --verify     # verify only, exit 1 if unhealthy
 *   node bin/install.js --cleanup    # prune obsolete runtime environments
 */

"use strict";

const fs = require("fs");
const path = require("path");

const deps = require("./lib/deps");
const runtime = require("./lib/runtime");
const { createUi } = require("./lib/ui");
const { detectPython, formatVersion } = require("./lib/python");

const PKG_ROOT = path.join(__dirname, "..");

function readPackageJson(pkgRoot) {
  return JSON.parse(fs.readFileSync(path.join(pkgRoot || PKG_ROOT, "package.json"), "utf8"));
}

/** npm can drop the execute bit when unpacking; `aelvo` then fails on zsh. */
function ensureExecBits(pkgRoot) {
  if (process.platform === "win32") return;
  for (const file of ["aelvo.js", "install.js"]) {
    try {
      fs.chmodSync(path.join(pkgRoot || PKG_ROOT, "bin", file), 0o755);
    } catch (err) {
      /* best effort */
    }
  }
}

/**
 * Full setup. Throws on any failure so the caller controls the exit code.
 *
 * @returns {{dir:string, pythonPath:string, reused:boolean, key:string}}
 */
function runInstall(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const pkgRoot = opts.pkgRoot || PKG_ROOT;
  const ui = opts.ui || createUi({ env });

  ensureExecBits(pkgRoot);

  if (env.AELVO_SKIP_BOOTSTRAP === "1") {
    ui.info("AELVO_SKIP_BOOTSTRAP=1 — skipping environment setup.");
    return { skipped: true };
  }

  const pkg = opts.pkg || readPackageJson(pkgRoot);
  const requirements = opts.requirements || deps.readRequirements(deps.requirementsPath(pkgRoot));
  const lockHash = deps.lockHash(requirements.entries);

  ui.step("Detecting Python...");
  const python = (opts.detectPython || detectPython)({ env });

  ui.step("Checking Python compatibility...");
  ui.info(`Using ${python.source} — Python ${formatVersion(python.version)} (supported: 3.10–3.13)`);
  if (python.warning) ui.warn(python.warning);

  const result = runtime.ensureRuntime({
    pkgRoot,
    pkgVersion: pkg.version,
    python,
    entries: requirements.entries,
    requirementsPath: requirements.path,
    lockHash,
    env,
    ui,
  });

  ui.step("Preparing AELVO...");
  if (result.reused) {
    ui.success(`Environment verified (${result.key || path.basename(result.dir)}).`);
  } else {
    ui.success("Environment installed.");
  }

  try {
    runtime.cleanupObsolete(runtime.runtimeRoot(env), { keepKey: result.key });
  } catch (err) {
    /* cleanup is opportunistic */
  }

  ui.success("Aelvo ready. Run `Aelvo` from any folder, or `Aelvo <folder>` to open one.");
  return result;
}

function main(argv) {
  const args = argv || process.argv.slice(2);
  const ui = createUi({});

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: node bin/install.js [--verify | --cleanup]\n\n" +
        "  --verify   check that the Python environment is healthy, then exit\n" +
        "  --cleanup  remove obsolete AELVO runtime environments\n"
    );
    return 0;
  }

  try {
    if (args.includes("--cleanup")) {
      const removed = runtime.cleanupObsolete(runtime.runtimeRoot(process.env), {});
      ui.info(
        removed.length
          ? `Removed ${removed.length} obsolete environment(s): ${removed.join(", ")}`
          : "No obsolete environments to remove."
      );
      return 0;
    }

    if (args.includes("--verify")) {
      const pkg = readPackageJson(PKG_ROOT);
      const requirements = deps.readRequirements(deps.requirementsPath(PKG_ROOT));
      const lockHash = deps.lockHash(requirements.entries);
      const found = runtime.scanRuntimes({
        pkgVersion: pkg.version,
        lockHash,
        env: process.env,
      });
      if (!found.length) {
        ui.error("No AELVO Python environment found. Run `npm rebuild aelvo`.");
        return 1;
      }
      const { verifyEnvironment, describeFailure } = deps;
      const result = verifyEnvironment({
        pythonPath: found[0].pythonPath,
        entries: requirements.entries,
        env: {
          ...process.env,
          PYTHONPATH: PKG_ROOT + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ""),
        },
      });
      if (!result.ok) {
        ui.error(`Environment is unhealthy: ${describeFailure(result)}`);
        ui.error("Run `npm rebuild aelvo` to repair it.");
        return 1;
      }
      ui.success(`Environment OK (${found[0].key}).`);
      return 0;
    }

    runInstall({});
    return 0;
  } catch (err) {
    ui.error(err && err.message ? err.message : String(err));
    ui.error("AELVO was not set up. Fix the problem above, then run `npm rebuild aelvo`.");
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { ensureExecBits, main, readPackageJson, runInstall };
