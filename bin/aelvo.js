#!/usr/bin/env node
/**
 * aelvo.js — launcher for the AELVO 3.0 TypeScript runtime.
 *
 * The production runtime is Node-only: this launcher simply starts the built
 * CLI entry point (`dist/cli/entry.js`) with the user's arguments, preserving
 * the caller's working directory. During development the launcher falls back to
 * the TypeScript source executed via Node's experimental type stripping.
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PKG_ROOT = path.join(__dirname, "..");

function readPackageJson(pkgRoot) {
  return JSON.parse(fs.readFileSync(path.join(pkgRoot || PKG_ROOT, "package.json"), "utf8"));
}

function entrySpec(pkgRoot) {
  const distEntry = path.join(pkgRoot || PKG_ROOT, "dist", "cli", "entry.js");
  if (fs.existsSync(distEntry)) {
    return { path: distEntry, prefix: [] };
  }
  return {
    path: path.join(pkgRoot || PKG_ROOT, "src", "cli", "entry.ts"),
    prefix: ["--experimental-strip-types"],
  };
}

function buildChildEnv(pkgRoot, env) {
  const base = env || process.env;
  const childEnv = { ...base };
  if (!childEnv.AELVO_DATA_DIR) {
    childEnv.AELVO_DATA_DIR = path.join(os.homedir(), ".aelvo");
  }
  return childEnv;
}

function buildChildArgs(prefixArgs, userArgs) {
  return (prefixArgs || []).concat(userArgs || []);
}

function resolveLaunch(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const ui = opts.ui || { info() {}, warn() {}, error() {}, step() {}, success() {}, log() {} };
  const pkgRoot = opts.pkgRoot || PKG_ROOT;
  const userArgs = opts.args || [];
  const spec = entrySpec(pkgRoot);
  const childEnv = buildChildEnv(pkgRoot, env);

  if (env.AELVO_SKIP_BOOTSTRAP === "1") {
    ui.info && ui.info("Launching AELVO runtime.");
  }

  return {
    command: process.execPath,
    args: buildChildArgs(spec.prefix, [spec.path].concat(userArgs)),
    env: childEnv,
    source: "node",
  };
}

function spawnOptionsFor(launch, cwdProvider) {
  const cwd = (cwdProvider || (() => process.cwd()))();
  return { cwd, env: launch.env, stdio: "inherit" };
}

function main(argv) {
  const args = argv || process.argv.slice(2);
  const ui = { error(message) { process.stderr.write(`${message}\n`); } };

  let launch;
  try {
    launch = resolveLaunch({ args, ui });
  } catch (err) {
    ui.error(err && err.message ? err.message : String(err));
    return 1;
  }

  const child = spawn(launch.command, launch.args, spawnOptionsFor(launch));
  child.on("error", (err) => {
    ui.error(`Failed to start AELVO: ${err.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exitCode = code == null ? 0 : code;
    }
  });
  return null;
}

if (require.main === module) {
  const result = main();
  if (typeof result === "number") process.exit(result);
}

module.exports = {
  buildChildArgs,
  buildChildEnv,
  entrySpec,
  main,
  readPackageJson,
  resolveLaunch,
  spawnOptionsFor,
};
