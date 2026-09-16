import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { analyze } from "../src/analyze/index.js";
import { loadSnapshotFile } from "../src/snapshot.js";
import { renderReport } from "../src/report.js";

const fixturePath = fileURLToPath(new URL("./fixtures/snapshot.small.json", import.meta.url));
const NOW = new Date("2026-09-16T00:00:00Z");

const snapshot = await loadSnapshotFile(fixturePath);
const findings = analyze(snapshot, { now: NOW });
const report = renderReport(findings, { now: NOW });

/** A findings document with nothing in it, the shape a brand new instance produces. */
function emptyFindings() {
  return {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    instance: { url: null, siteName: null, version: null },
    summary: {
      totalCards: 0,
      activeCards: 0,
      archivedCards: 0,
      totalDashboards: 0,
      totalDatabases: 0,
      totalTables: 0,
      coreTables: 0,
      duplicateGroups: 0,
      duplicateCardsToArchive: 0,
      brokenCards: 0,
      staleCards90: 0,
      staleCards180: 0,
      anomalies: 0,
      healthScore: 100,
      healthGrade: "A",
    },
    health: { score: 100, grade: "A", verdict: "Solid foundation, polish only.", factors: [] },
    duplicates: [],
    broken: [],
    stale: [],
    anomalies: [],
    tables: [],
    dashboards: [],
    creators: [],
    actions: [],
    erdEdges: [],
  };
}

test("header names the instance, the version and the generated date", () => {
  const lines = report.split("\n");
  assert.equal(lines[0], "# Metabase health report: Acme");
  assert.equal(lines[1], "https://metabase.acme.test, Metabase v0.62.3, generated 2026-09-16");
  assert.equal(lines[2], "9 active questions, 3 dashboards, 1 database, 4 tables");
});

test("health section carries the grade, the score and the factor table", () => {
  assert.ok(
    report.includes(`## Health: ${findings.health.grade} (${findings.health.score}/100)`),
    "health heading repeats the grade and score from the findings",
  );
  assert.ok(report.includes(findings.health.verdict));
  assert.ok(report.includes("| Factor | Score | How to improve |"));
  for (const factor of findings.health.factors) {
    assert.ok(
      report.includes(`| ${factor.name} | ${factor.score}/${factor.maxScore} |`),
      `factor row for ${factor.name}`,
    );
  }
});

test("do this first lists the top actions with linked question ids", () => {
  assert.ok(report.includes("## Do this first"));
  assert.ok(report.includes("1. **Fix 1 question pointing at missing tables**"));
  assert.ok(report.includes("(questions: [6](https://metabase.acme.test/question/6))"));
  const numbered = report.split("\n").filter((l) => /^\d+\. \*\*/.test(l));
  assert.equal(numbered.length, 5, "at most five actions");
});

test("duplicates section counts groups and questions to archive", () => {
  assert.ok(report.includes("## Duplicates (2 groups, 2 questions to archive)"));
  assert.ok(
    report.includes("**Keep [Revenue by month](https://metabase.acme.test/question/1) (40 views, last used 2026-09-11)**"),
  );
  assert.ok(
    report.includes("- Archive [Revenue by month (copy)](https://metabase.acme.test/question/2) (3 views, last used 2026-02-28)"),
  );
  assert.ok(
    report.includes("- Archive [revenue_by_month_v2](https://metabase.acme.test/question/3) (1 view, last used never)"),
    "a card that was never used renders as never",
  );
  assert.ok(report.includes("- Review [Active Users](https://metabase.acme.test/question/5)"), "same-name groups say Review");
  assert.ok(report.includes(findings.duplicates[0].recommendation));
});

test("duplicates section prints a ready archive command for exact matches", () => {
  const lines = report.split("\n");
  assert.ok(lines.includes("npx metabase-audit archive --ids 2,3"));
  assert.equal(
    lines.filter((l) => l.startsWith("npx metabase-audit archive --ids")).length,
    1,
    "only the exact-sql group gets a command",
  );
});

test("broken section links the question in a table", () => {
  assert.ok(report.includes("## Broken questions (1)"));
  assert.ok(report.includes("| Question | Reason | Collection |"));
  assert.ok(report.includes("[Old orders report](https://metabase.acme.test/question/6)"));
  assert.ok(report.includes("References missing table: legacy_orders"));
  assert.ok(report.includes("Finance / Archive"));
});

test("stale section is capped and ordered oldest first", () => {
  assert.ok(report.includes("## Stale questions (3 not used in 90+ days)"));
  assert.ok(report.includes("| Question | Last used | Days | Views | Owner | Collection |"));
  const rows = report.split("\n").filter((l) => l.startsWith("| [") && l.includes("Bob Ray"));
  assert.ok(rows[0].includes("Payments by day"), "oldest question first");
  assert.ok(rows[0].includes("2025-08-12"));
  assert.ok(rows[0].includes("399"));

  const capped = renderReport(findings, { now: NOW, maxStaleRows: 1 });
  assert.ok(capped.includes("and 2 more, see .metalens/findings.json"));
  assert.ok(!capped.includes("Churn cohort"), "rows past the cap are not rendered");
  assert.ok(!report.includes("and 2 more, see"), "no cap line when everything fits");
});

test("dashboards table reports status per dashboard", () => {
  assert.ok(report.includes("## Dashboards (3)"));
  assert.ok(report.includes("| Dashboard | Status | Questions | Stale | Broken | Views | Last viewed | Owner |"));
  const ops = report.split("\n").find((l) => l.includes("[Ops]"));
  assert.ok(ops, "the Ops dashboard has a row");
  assert.ok(ops.includes("warning"), "Ops is mostly stale, so it is a warning");
  assert.ok(ops.includes("Bob Ray"));
  const legacy = report.split("\n").find((l) => l.includes("[Legacy]"));
  assert.ok(legacy.includes("broken"));
});

test("ownership table lists every creator", () => {
  assert.ok(report.includes("## Ownership"));
  assert.ok(report.includes("| Owner | Questions | Active | Stale |"));
  assert.ok(report.includes("| Bob Ray | 5 | 3 | 2 |"));
  assert.ok(report.includes("| Jane Doe | 4 | 3 | 1 |"));
});

test("core data model lists tables by usage with suggestions", () => {
  assert.ok(report.includes("## Core data model"));
  assert.ok(report.includes("| Table | Questions | Rows | Columns | Referenced by |"));
  assert.ok(report.includes("| public.orders | 5 | 120,000 | 14 | payments |"), "thousands separators come from fmtInt");
  assert.ok(report.includes("- **public.events**: Partition by ts (range partitioning on ts)"));
});

test("anomalies render as severity bullets", () => {
  assert.ok(report.includes("## Anomalies"));
  assert.ok(report.includes("- medium: 1 table has zero query references"));
  assert.ok(report.includes("- low: 1 question is not organized in any collection"));
});

test("footer explains the cleanup commands and where to go next", () => {
  assert.ok(report.includes("## How to act on this"));
  assert.ok(report.includes("npx metabase-audit archive --from duplicates"));
  assert.ok(report.includes("--apply"));
  assert.ok(report.includes("npx metabase-audit unarchive --undo"));
  assert.ok(report.includes("DATA-CONTEXT.md"));
  assert.ok(
    report.includes(
      "If the findings are clear but the decisions are not (who owns what, which definition is right), see the README section When the report is not enough.",
    ),
  );
});

test("sections appear in the documented order", () => {
  const order = [
    "# Metabase health report:",
    "## Health:",
    "## Do this first",
    "## Duplicates (",
    "## Broken questions (",
    "## Stale questions (",
    "## Dashboards (",
    "## Ownership",
    "## Core data model",
    "## Anomalies",
    "## How to act on this",
  ];
  let cursor = -1;
  for (const heading of order) {
    const at = report.indexOf(heading);
    assert.ok(at > cursor, `${heading} comes after the previous section`);
    cursor = at;
  }
});

test("every markdown table has a header separator row", () => {
  const lines = report.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("| ")) continue;
    const previous = lines[i - 1] ?? "";
    const next = lines[i + 1] ?? "";
    const isHeader = !previous.startsWith("|");
    if (isHeader) assert.match(next, /^\|( -{3} \|)+$/, `separator row under: ${line}`);
  }
});

test("style rules: no dashes, no undefined, no NaN, no bare null", () => {
  assert.ok(!report.includes("\u2014"), "no em dash");
  assert.ok(!report.includes("\u2013"), "no en dash");
  assert.ok(!report.includes("undefined"));
  assert.ok(!report.includes("NaN"));
  assert.ok(!/\bnull\b/.test(report), "no bare null");
  assert.ok(!report.includes("Invalid Date"));
});

test("an empty instance renders without throwing", () => {
  const empty = renderReport(emptyFindings(), { now: NOW });
  assert.ok(empty.includes("# Metabase health report: "));
  assert.ok(empty.includes("## Health: A (100/100)"));
  assert.ok(empty.includes("0 active questions, 0 dashboards, 0 databases, 0 tables"));
  assert.ok(empty.includes("No duplicate questions found."));
  assert.ok(empty.includes("## Broken questions (0)"));
  assert.ok(empty.includes("None found."));
  assert.ok(empty.includes("No owner information (the API key is not in the Administrators group)."));
  assert.ok(!empty.includes("undefined"));
  assert.ok(!empty.includes("NaN"));
  assert.ok(!empty.includes("\u2014"));
});

test("singular counts read correctly", () => {
  const one = emptyFindings();
  one.summary = { ...one.summary, activeCards: 1, totalDashboards: 1, totalDatabases: 1, totalTables: 1 };
  const rendered = renderReport(one, { now: NOW });
  assert.ok(rendered.includes("1 active question, 1 dashboard, 1 database, 1 table"));
});

test("pipes inside names are escaped so tables do not break", () => {
  const weird = emptyFindings();
  weird.summary = { ...weird.summary, brokenCards: 1 };
  weird.broken = [
    {
      id: 9,
      name: "Revenue | EU",
      url: "https://metabase.acme.test/question/9",
      kind: "error",
      reason: "Query returns an error",
      missingTables: [],
      collectionPath: null,
    },
  ];
  const rendered = renderReport(weird, { now: NOW });
  assert.ok(rendered.includes("[Revenue \\| EU](https://metabase.acme.test/question/9)"));
});

test("a question without a name falls back to its id", () => {
  const unnamed = emptyFindings();
  unnamed.summary = { ...unnamed.summary, brokenCards: 1 };
  unnamed.broken = [
    {
      id: 42,
      name: null,
      url: "https://metabase.acme.test/question/42",
      kind: "error",
      reason: "Query returns an error",
      missingTables: [],
      collectionPath: null,
    },
  ];
  const rendered = renderReport(unnamed, { now: NOW });
  assert.ok(rendered.includes("[Question 42](https://metabase.acme.test/question/42)"));
});

test("an action with many questions links five and counts the rest", () => {
  const many = emptyFindings();
  many.instance = { url: "https://metabase.acme.test", siteName: "Acme", version: "v0.62.3" };
  many.actions = [
    {
      priority: "high",
      title: "Archive 8 exact duplicate queries",
      description: "Three groups of identical queries.",
      impact: "Search returns one answer per metric.",
      cardIds: [1, 2, 3, 4, 5, 6, 7, 8],
    },
  ];
  const rendered = renderReport(many, { now: NOW });
  assert.ok(rendered.includes("[5](https://metabase.acme.test/question/5), and 3 more)"));
  assert.ok(!rendered.includes("question/6)"), "ids past the fifth are counted, not listed");
});

test("factor cells read as sentences, never as double periods", () => {
  const graded = emptyFindings();
  graded.health = {
    score: 70,
    grade: "B",
    verdict: "Cleanup project, not a crisis.",
    factors: [
      {
        name: "Content freshness",
        score: 20,
        maxScore: 35,
        description: "3 of 9 questions are stale or unused (33%)",
        howToImprove: "Archive questions not accessed in 90+ days.",
      },
    ],
  };
  const rendered = renderReport(graded, { now: NOW });
  assert.ok(
    rendered.includes("| Content freshness | 20/35 | 3 of 9 questions are stale or unused (33%). Archive questions not accessed in 90+ days. |"),
  );
  assert.ok(!rendered.includes(".."), "no double periods");
});
