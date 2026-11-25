"use strict";
/** Integration checks against the Node launcher. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const launcher = require("../../bin/aelvo");

const REPO_ROOT = path.join(__dirname, "..", "..");

test("the launcher forwards args and preserves the working directory", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "aelvo-cwd-"));
  const env = { ...process.env, AELVO_QUIET: "1" };
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
  const launch = { command: process.execPath, args: ["entry.js"], env: { AELVO_DATA_DIR: "/data" } };
  const options = launcher.spawnOptionsFor(launch, () => "/some/user/folder");
  assert.equal(options.cwd, "/some/user/folder");
  assert.equal(options.env.AELVO_DATA_DIR, "/data");
  assert.equal(options.stdio, "inherit");
});
