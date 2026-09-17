/**
 * The published example is a fixture with an audience: the README quotes it and
 * the landing page shows it. These tests keep it honest. They run the generator
 * into a temporary folder, so `examples/` on disk is never touched.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateExample } from "../scripts/make-example.mjs";
import { loadSnapshotFile } from "../src/snapshot.js";

/** Characters and words that must never reach a generated file. */
const FORBIDDEN = ["—", "–", "undefined", "NaN"];

async function generateInto(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const result = await generateExample({ outDir: dir });
  return { dir, ...result };
}

test("the example generator writes a full audit into the directory it is given", async () => {
  const { dir, findings, paths } = await generateInto("metalens-example-");
  try {
    const snapshot = await loadSnapshotFile(path.join(dir, "snapshot.json"));
    assert.equal(snapshot.instance.siteName, "Northwind Outdoors");
    assert.ok(snapshot.cards.length > 100, "the example needs a realistic number of questions");
    assert.ok(snapshot.tables.length > 25, "the example needs a realistic warehouse");

    // Every file the README points at, and nothing left over from the run.
    for (const file of ["snapshot.json", "findings.json", "METALENS-REPORT.md", "DATA-CONTEXT.md"]) {
      const info = await stat(path.join(dir, file));
      assert.ok(info.size > 0, `${file} should not be empty`);
    }
    await assert.rejects(stat(path.join(dir, ".metalens-tmp")), "the working folder should be removed");

    const written = JSON.parse(await readFile(path.join(dir, "findings.json"), "utf8"));
    assert.equal(written.summary.healthScore, findings.summary.healthScore);
    assert.equal(paths.report, path.join(dir, "METALENS-REPORT.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the example carries the findings the report is meant to demonstrate", async () => {
  const { dir, findings } = await generateInto("metalens-example-");
  try {
    const exact = findings.duplicates.filter((g) => g.kind === "exact-sql");
    const sameName = findings.duplicates.filter((g) => g.kind === "same-name");
    assert.equal(exact.length, 7);
    assert.equal(sameName.length, 5);
    assert.equal(findings.broken.length, 4);

    // A C grade: bad enough to be worth cleaning up, not a broken instance.
    assert.ok(
      findings.summary.healthScore >= 30 && findings.summary.healthScore <= 55,
      `health score ${findings.summary.healthScore} is outside the 30 to 55 band`,
    );

    // The four dashboard states the report renders differently.
    const statuses = new Set(findings.dashboards.map((d) => d.status));
    assert.deepEqual([...statuses].sort(), ["broken", "healthy", "unknown", "warning"]);

    // Ownership is the section people scroll to, so it has to be populated.
    assert.equal(findings.creators.length, 11);
    assert.ok(findings.stale.length > 50, "the stale table should be long enough to be capped");
    assert.ok(findings.actions.length >= 5, "the do-this-first list should be full");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the generated Markdown is clean prose", async () => {
  const { dir } = await generateInto("metalens-example-");
  try {
    for (const file of ["METALENS-REPORT.md", "DATA-CONTEXT.md"]) {
      const text = await readFile(path.join(dir, file), "utf8");
      for (const needle of FORBIDDEN) {
        assert.ok(!text.includes(needle), `${file} contains ${JSON.stringify(needle)}`);
      }
      assert.ok(text.endsWith("\n"), `${file} should end with a newline`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("regenerating the example produces byte-identical files", async () => {
  const first = await generateInto("metalens-example-a-");
  const second = await generateInto("metalens-example-b-");
  try {
    for (const file of ["snapshot.json", "findings.json", "METALENS-REPORT.md", "DATA-CONTEXT.md"]) {
      const a = await readFile(path.join(first.dir, file), "utf8");
      const b = await readFile(path.join(second.dir, file), "utf8");
      assert.equal(a, b, `${file} is not deterministic`);
    }
  } finally {
    await rm(first.dir, { recursive: true, force: true });
    await rm(second.dir, { recursive: true, force: true });
  }
});
