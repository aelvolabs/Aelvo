"use strict";
/** Cross-process install lock: exclusivity, stale reclaim, timeout. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const lock = require("../../bin/lib/lock");

function tmpLockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aelvo-lock-"));
  return path.join(dir, ".lock-test");
}

test("acquire creates an exclusive lock and release removes it", () => {
  const lockPath = tmpLockPath();
  const held = lock.acquire(lockPath);
  const info = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(info.pid, process.pid);
  assert.ok(info.token);

  held.release();
  assert.equal(fs.existsSync(lockPath), false);
  // Releasing twice must be a no-op, not a crash.
  held.release();
});

test("a stale lock from a dead process is reclaimed", () => {
  const lockPath = tmpLockPath();
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, token: "dead", at: Date.now(), host: os.hostname() })
  );
  const held = lock.acquire(lockPath, { waitMs: 0 });
  held.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("an ancient lock is reclaimed even if its pid looks alive", () => {
  const lockPath = tmpLockPath();
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      token: "old",
      at: Date.now() - lock.DEFAULT_STALE_MS - 1000,
      host: os.hostname(),
    })
  );
  const held = lock.acquire(lockPath, { waitMs: 0 });
  assert.ok(held);
  held.release();
});

test("a live holder is waited on, then the wait times out with guidance", () => {
  const lockPath = tmpLockPath();
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, token: "live", at: Date.now(), host: os.hostname() })
  );

  let clock = Date.now();
  assert.throws(
    () =>
      lock.acquire(lockPath, {
        waitMs: 1000,
        sleep: () => {
          clock += 400;
        },
        now: () => clock,
      }),
    (err) => {
      assert.equal(err.code, "AELVO_LOCK_TIMEOUT");
      assert.match(err.message, /Another AELVO install is already running/);
      assert.match(err.message, /delete/);
      return true;
    }
  );
});

test("withLock releases even when the body throws", () => {
  const lockPath = tmpLockPath();
  assert.throws(() =>
    lock.withLock(lockPath, () => {
      throw new Error("boom");
    })
  );
  assert.equal(fs.existsSync(lockPath), false);
});

test("isStale treats an unparseable lock file as stale", () => {
  assert.equal(lock.isStale(null, 1000), true);
  assert.equal(lock.isStale({ pid: process.pid, at: Date.now() }, 1000), false);
});
