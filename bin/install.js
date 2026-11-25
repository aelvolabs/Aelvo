#!/usr/bin/env node
/**
 * install.js — postinstall / repair entry point for the Node-only runtime.
 *
 * The 3.0 runtime ships prebuilt JavaScript and has no native/Python
 * environment to prepare. This script only ensures the launcher scripts are
 * executable on POSIX systems and validates that the runtime entry point exists.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const PKG_ROOT = path.join(__dirname, "..");

function readPackageJson(pkgRoot) {
  return JSON.parse(fs.readFileSync(path.join(pkgRoot || PKG_ROOT, "package.json"), "utf8"));
}

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

function main(argv) {
  const args = argv || process.argv.slice(2);
  const root = PKG_ROOT;

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: node bin/install.js [--verify]\n");
    return 0;
  }

  ensureExecBits(root);

  if (args.includes("--verify")) {
    const entry = path.join(root, "dist", "cli", "entry.js");
    if (!fs.existsSync(entry)) {
      process.stderr.write("AELVO runtime entry point is missing. Run `npm run build`.\n");
      return 1;
    }
    process.stdout.write("AELVO runtime OK.\n");
    return 0;
  }

  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { ensureExecBits, main, readPackageJson };
