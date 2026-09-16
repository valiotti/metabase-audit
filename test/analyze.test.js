import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { analyze } from "../src/analyze/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/snapshot.small.json", import.meta.url));
const snapshot = JSON.parse(readFileSync(fixturePath, "utf8"));
const NOW = new Date("2026-09-16T00:00:00Z");

const findings = analyze(snapshot, { now: NOW });

function byId(list, id) {
  return list.find((x) => x.id === id);
}

test("summary counts non-sample cards, tables and databases", () => {
  const s = findings.summary;
  assert.equal(s.activeCards, 9);
  assert.equal(s.archivedCards, 1);
  assert.equal(s.totalCards, 10, "9 active + 1 archived, sample DB and sample-user cards excluded");
  assert.equal(s.totalDashboards, 3);
  assert.equal(s.totalDatabases, 1);
  assert.equal(s.totalTables, 4);
  assert.equal(s.coreTables, 3);
});

test("findings carry the instance block and a generatedAt stamp", () => {
  assert.equal(findings.schemaVersion, 1);
  assert.equal(findings.generatedAt, NOW.toISOString());
  assert.deepEqual(findings.instance, {
    url: "https://metabase.acme.test",
    siteName: "Acme",
    version: "v0.62.3",
  });
});

test("duplicates: one exact-sql group and one same-name group", () => {
  assert.equal(findings.duplicates.length, 2);

  const [exact, sameName] = findings.duplicates;
  assert.equal(exact.kind, "exact-sql");
  assert.equal(exact.similarity, 1);
  assert.equal(exact.databaseId, 2);
  assert.equal(exact.keep.id, 1);
  assert.deepEqual(exact.archive.map((c) => c.id), [2, 3]);
  assert.equal(exact.keep.url, "https://metabase.acme.test/question/1");
  assert.match(exact.recommendation, /Revenue by month/);

  assert.equal(sameName.kind, "same-name");
  assert.equal(sameName.similarity, 0.8);
  assert.equal(sameName.keep.id, 4, "highest view count wins the keep slot");
  assert.deepEqual(sameName.archive.map((c) => c.id), [5]);

  assert.equal(findings.summary.duplicateGroups, 2);
  assert.equal(findings.summary.duplicateCardsToArchive, 2, "only exact-sql archives count");
});

test("broken: only the card pointing at a dropped table", () => {
  assert.equal(findings.broken.length, 1);
  const [b] = findings.broken;
  assert.equal(b.id, 6);
  assert.equal(b.kind, "missing-table");
  assert.deepEqual(b.missingTables, ["legacy_orders"]);
  assert.equal(b.reason, "References missing table: legacy_orders");
  assert.equal(b.collectionPath, "Finance / Archive");
  assert.equal(b.url, "https://metabase.acme.test/question/6");
  assert.equal(findings.summary.brokenCards, 1);
  assert.equal(byId(findings.broken, 7), undefined, "CTE + EXTRACT(... FROM ...) is not a missing table");
  assert.equal(byId(findings.broken, 9), undefined, "archived cards are not broken");
  assert.equal(byId(findings.broken, 8), undefined, "stale cards are not broken");
});

test("stale: oldest first, nulls excluded", () => {
  assert.deepEqual(findings.stale.map((c) => c.id), [8, 2, 7]);
  assert.equal(findings.summary.staleCards90, 3);
  assert.equal(findings.summary.staleCards180, 2);
  const oldest = findings.stale[0];
  assert.equal(oldest.daysSinceUse, 399);
  assert.equal(oldest.creatorName, "Bob Ray");
  assert.equal(oldest.collectionPath, "Finance");
  assert.equal(byId(findings.stale, 3), undefined, "null lastUsedAt is unknown usage, not stale");
});

test("anomalies: unused table, stale queries, undocumented, orphans", () => {
  const byType = Object.fromEntries(findings.anomalies.map((a) => [a.type, a]));
  assert.equal(byType.unused_table.count, 1);
  assert.equal(byType.unused_table.entity, "events");
  assert.equal(byType.unused_table.severity, "medium");
  assert.equal(byType.stale_query.count, 2);
  assert.equal(byType.stale_query.severity, "low");
  assert.equal(byType.naming.count, 5);
  assert.equal(byType.naming.message, "5 of 9 active questions have no description");
  assert.equal(byType.orphan.count, 1);
  assert.equal(findings.summary.anomalies, findings.anomalies.length);
});

test("dashboards: status per card health, sorted by views", () => {
  assert.deepEqual(findings.dashboards.map((d) => d.name), ["Exec", "Ops", "Legacy"]);
  const [exec, ops, legacy] = findings.dashboards;
  assert.equal(exec.status, "healthy");
  assert.equal(exec.cardCount, 2);
  assert.equal(exec.creatorName, "Jane Doe");
  assert.equal(exec.url, "https://metabase.acme.test/dashboard/20");
  assert.equal(ops.status, "warning");
  assert.equal(ops.staleCardCount, 3);
  assert.equal(ops.cardCount, 3);
  assert.equal(legacy.status, "broken");
  assert.equal(legacy.brokenCardCount, 1);
  assert.equal(findings.dashboards.find((d) => d.name === "E-commerce Insights"), undefined);
});

test("creators: per-author totals split into active and stale", () => {
  const jane = findings.creators.find((c) => c.name === "Jane Doe");
  const bob = findings.creators.find((c) => c.name === "Bob Ray");
  assert.equal(jane.totalCards, 4);
  assert.equal(jane.staleCards, 1);
  assert.equal(jane.activeCards, 3);
  assert.equal(bob.totalCards, 5);
  assert.equal(bob.staleCards, 2);
  assert.equal(bob.activeCards, 3);
  assert.equal(findings.creators.find((c) => c.name === "Sample User"), undefined);
  assert.deepEqual(
    findings.creators.map((c) => c.totalCards),
    [...findings.creators.map((c) => c.totalCards)].sort((a, b) => b - a),
  );
});

test("erdEdges: joins across the warehouse", () => {
  const has = (from, to) => findings.erdEdges.some((e) => e.from === from && e.to === to && e.count >= 1);
  assert.ok(has("orders", "users"), "orders → users");
  assert.ok(has("payments", "orders"), "payments → orders");
  assert.ok(
    !findings.erdEdges.some((e) => e.from === "legacy_orders" || e.to === "legacy_orders"),
    "edges only reference tables that exist",
  );
});

test("tables: usage ranking, FK back-references and suggestions", () => {
  assert.equal(findings.tables.length, 4);
  assert.equal(findings.tables[0].name, "orders", "usage tie broken by name");
  const orders = findings.tables.find((t) => t.name === "orders");
  const users = findings.tables.find((t) => t.name === "users");
  const events = findings.tables.find((t) => t.name === "events");
  assert.equal(orders.usageCount, 5);
  assert.equal(users.usageCount, 5);
  assert.equal(events.usageCount, 0);
  assert.equal(orders.database, "Warehouse");
  assert.equal(orders.engine, "postgres");
  assert.equal(orders.schema, "public");
  assert.equal(orders.columnCount, 14);
  assert.ok(orders.referencedBy.includes("payments"));
  assert.ok(users.referencedBy.includes("orders"));
  assert.ok(events.suggestions.some((s) => s.includes("5.0M rows")));
  assert.ok(orders.suggestions.some((s) => s.includes("created_at")));
});

test("actions: highest-leverage first, with card ids to act on", () => {
  assert.equal(findings.actions[0].priority, "high");
  assert.ok(findings.actions[0].cardIds.includes(6));
  assert.ok(
    findings.actions.some((a) => a.cardIds.length === 2 && a.cardIds[0] === 2 && a.cardIds[1] === 3),
    "an action archives the exact duplicates 2 and 3",
  );
  const priorities = findings.actions.map((a) => a.priority);
  const rank = { high: 0, medium: 1, low: 2 };
  assert.deepEqual(priorities, [...priorities].sort((a, b) => rank[a] - rank[b]));
  for (const a of findings.actions) assert.ok(Array.isArray(a.cardIds));
});

test("health: factors add up to 100 and carry a verdict", () => {
  const { health } = findings;
  assert.equal(health.factors.reduce((s, f) => s + f.maxScore, 0), 100);
  assert.ok(health.score >= 0 && health.score <= 100);
  assert.ok(health.score < 90, "the fixture instance is not pristine");
  assert.ok(["A", "B+", "B", "C+", "C", "D", "F"].includes(health.grade));
  assert.equal(typeof health.verdict, "string");
  assert.ok(health.verdict.length > 0);
  assert.equal(findings.summary.healthScore, health.score);
  assert.equal(findings.summary.healthGrade, health.grade);
  for (const f of health.factors) {
    assert.ok(f.score >= 0 && f.score <= f.maxScore, `${f.name} in range`);
    assert.equal(typeof f.description, "string");
    assert.equal(typeof f.howToImprove, "string");
  }
});

test("card breakdowns by type and database", () => {
  const types = Object.fromEntries(findings.cardsByType.map((r) => [r.type, r.count]));
  assert.equal(types.native, 7);
  assert.equal(types.query, 2);
  assert.deepEqual(findings.cardsByDatabase, [{ database: "Warehouse", count: 9 }]);
});

test("the findings object is plain JSON with no undefined anywhere", () => {
  const json = JSON.stringify(findings);
  assert.ok(!json.includes("undefined"), "no undefined leaked into the payload");
  assert.deepEqual(JSON.parse(json), findings, "round-trips through JSON unchanged");
  const expectedKeys = [
    "schemaVersion", "generatedAt", "instance", "summary", "health", "duplicates", "broken",
    "stale", "anomalies", "tables", "dashboards", "creators", "actions", "erdEdges",
    "cardsByType", "cardsByDatabase",
  ];
  assert.deepEqual(Object.keys(findings).sort(), [...expectedKeys].sort());
});

test("analyze defaults now to the current clock", () => {
  const before = Date.now();
  const live = analyze(snapshot);
  const stamp = new Date(live.generatedAt).getTime();
  assert.ok(stamp >= before - 1000 && stamp <= Date.now() + 1000);
});

test("analyze survives an empty snapshot", () => {
  const empty = analyze({ instance: { url: "https://x.test/" }, databases: [], tables: [], cards: [], dashboards: [], collections: [], users: [] }, { now: NOW });
  assert.equal(empty.summary.totalCards, 0);
  assert.equal(empty.duplicates.length, 0);
  assert.equal(empty.actions.length, 0);
  assert.ok(!JSON.stringify(empty).includes("undefined"));
});
