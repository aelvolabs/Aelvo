"use strict";
/** Launcher decisions for the Node runtime. */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const launcher = require("../../bin/aelvo");

const PKG = { name: "aelvo", version: "3.0.0" };

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
    env: {},
    ui: quietUi(),
    pkgRoot: path.join(os.tmpdir(), "aelvo-fake-pkg"),
    platform: "linux",
    args: ["fix", "the bug"],
    ...overrides,
  };
}

test("buildChildEnv sets a stable data dir", () => {
  const env = launcher.buildChildEnv("/opt/aelvo", { PATH: "/bin" });
  assert.equal(env.AELVO_DATA_DIR, path.join(os.homedir(), ".aelvo"));
  assert.equal(env.PATH, "/bin");
});

test("buildChildEnv respects an existing data dir", () => {
  const env = launcher.buildChildEnv("/opt/aelvo", { AELVO_DATA_DIR: "/custom/data" });
  assert.equal(env.AELVO_DATA_DIR, "/custom/data");
});

test("buildChildArgs forwards user arguments", () => {
  assert.deepEqual(launcher.buildChildArgs([], ["--version"]), ["--version"]);
  assert.deepEqual(launcher.buildChildArgs(["--flag"], ["a", "b"]), ["--flag", "a", "b"]);
});

test("resolveLaunch returns a Node command for the runtime entry point", () => {
  const launch = launcher.resolveLaunch(baseOptions({}));
  assert.equal(launch.command, process.execPath);
  assert.ok(launch.args.includes("fix"));
  assert.ok(launch.args.includes("the bug"));
  assert.equal(launch.source, "node");
});

test("spawnOptionsFor keeps the caller's cwd and the prepared env", () => {
  const launch = { command: process.execPath, args: ["entry.js"], env: { AELVO_DATA_DIR: "/data" } };
  const options = launcher.spawnOptionsFor(launch, () => "/some/user/folder");
  assert.equal(options.cwd, "/some/user/folder");
  assert.equal(options.env.AELVO_DATA_DIR, "/data");
  assert.equal(options.stdio, "inherit");
});
