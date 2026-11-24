"use strict";
/** Requirements parsing, lock hashing, and the one-shot dependency check. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const deps = require("../../bin/lib/deps");

const SAMPLE = `
# comment
pydantic==2.14.3
python-dotenv==1.2.4
PyYAML==6.0.3
rich>=15.0.0   # trailing comment
typing-extensions==4.16.0
`;

test("parseRequirements handles pins, ranges, comments and blanks", () => {
  const entries = deps.parseRequirements(SAMPLE);
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, [
    "pydantic",
    "python-dotenv",
    "PyYAML",
    "rich",
    "typing-extensions",
  ]);
  assert.equal(entries[0].pinnedVersion, "2.14.3");
  assert.equal(entries[3].pinnedVersion, null);
  assert.equal(entries[3].spec, ">=15.0.0");
});

test("parseRequirements maps distribution names to importable modules", () => {
  const entries = deps.parseRequirements(SAMPLE);
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry.module]));
  assert.equal(byName["python-dotenv"], "dotenv");
  assert.equal(byName.PyYAML, "yaml");
  assert.equal(byName["typing-extensions"], "typing_extensions");
  assert.equal(byName.pydantic, "pydantic");
  assert.equal(deps.moduleFor("google-generativeai"), "google.generativeai");
});

test("lockHash ignores comments/whitespace/order but tracks pins", () => {
  const base = deps.parseRequirements(SAMPLE);
  const reordered = deps.parseRequirements(
    "# different comment\nrich>=15.0.0\npydantic==2.14.3\npython-dotenv==1.2.4\n" +
      "PyYAML==6.0.3\ntyping-extensions==4.16.0\n"
  );
  assert.equal(deps.lockHash(base), deps.lockHash(reordered));

  const bumped = deps.parseRequirements(SAMPLE.replace("pydantic==2.14.3", "pydantic==2.14.4"));
  assert.notEqual(deps.lockHash(base), deps.lockHash(bumped));
});

test("readRequirements fails loudly on a missing file", () => {
  assert.throws(
    () => deps.readRequirements(path.join(os.tmpdir(), "definitely-missing-aelvo-req.txt")),
    (err) => {
      assert.equal(err.code, "AELVO_NO_REQUIREMENTS");
      return true;
    }
  );
});

test("verifyEnvironment returns ok for a successful check", () => {
  const runner = () => ({
    status: 0,
    stdout: JSON.stringify({
      ok: true,
      missing: [],
      mismatched: [],
      unimportable: [],
      entry_missing: false,
    }),
    stderr: "",
  });
  const result = deps.verifyEnvironment({
    pythonPath: "python",
    entries: deps.parseRequirements(SAMPLE),
    runner,
  });
  assert.equal(result.ok, true);
});

test("verifyEnvironment surfaces missing packages", () => {
  const runner = () => ({
    status: 1,
    stdout: JSON.stringify({
      ok: false,
      missing: ["rich"],
      mismatched: [{ name: "pydantic", want: "2.14.3", have: "2.0.0" }],
      unimportable: ["yaml"],
      entry_missing: true,
    }),
    stderr: "",
  });
  const result = deps.verifyEnvironment({
    pythonPath: "python",
    entries: deps.parseRequirements(SAMPLE),
    runner,
  });
  assert.equal(result.ok, false);
  const message = deps.describeFailure(result);
  assert.match(message, /missing: rich/);
  assert.match(message, /pydantic 2\.0\.0 \(want 2\.14\.3\)/);
  assert.match(message, /not importable: yaml/);
  assert.match(message, /entry point/);
});

test("verifyEnvironment reports a broken interpreter instead of throwing", () => {
  const runner = () => ({ status: -1, stdout: "", stderr: "", error: { code: "ENOENT" } });
  const result = deps.verifyEnvironment({
    pythonPath: "/nonexistent/python",
    entries: deps.parseRequirements(SAMPLE),
    runner,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not run/);
});

test("the real requirements-cli.txt is fully pinned", () => {
  const file = path.join(__dirname, "..", "..", "requirements-cli.txt");
  const parsed = deps.readRequirements(file);
  const unpinned = parsed.entries.filter(
    (entry) => !entry.option && !entry.pinnedVersion
  );
  assert.deepEqual(
    unpinned.map((entry) => entry.name),
    [],
    "every CLI dependency must be pinned to an exact version"
  );
  assert.ok(fs.existsSync(file));
});
