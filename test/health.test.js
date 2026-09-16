import test from "node:test";
import assert from "node:assert/strict";

import { analyze } from "../src/analyze/index.js";

const NOW = new Date("2026-09-16T00:00:00Z");
const FRESH = "2026-09-14T08:00:00.000Z";

function card(id, extra = {}) {
  return {
    id,
    name: `Question ${id}`,
    description: `What question ${id} measures`,
    type: "question",
    queryType: "native",
    display: "table",
    databaseId: 2,
    sourceTableId: null,
    sql: `SELECT count(*) AS bucket_${id} FROM orders WHERE status = 'open'`,
    sqlSource: "native",
    collectionId: 5,
    creatorId: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: FRESH,
    viewCount: 10 + id,
    archived: false,
    hasError: false,
    ...extra,
  };
}

function snapshotOf({ cards = [], dashboards = [], tables = [] } = {}) {
  return {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    instance: { url: "https://mb.test", siteName: "Test", version: "v0.62.0" },
    databases: [{ id: 2, name: "Warehouse", engine: "postgres", isSample: false }],
    tables,
    cards,
    dashboards,
    collections: [{ id: 5, name: "Analytics", parentId: null, path: "Analytics", archived: false }],
    users: [{ id: 3, name: "Ann Lee", email: "ann@test", isActive: true }],
    meta: {},
  };
}

const ORDERS_TABLE = {
  id: 10,
  dbId: 2,
  schema: "public",
  name: "orders",
  displayName: "Orders",
  description: null,
  rowCount: 1000,
  fields: [
    { id: 100, name: "id", baseType: "type/Integer", semanticType: "type/PK", fkTargetFieldId: null },
    { id: 101, name: "status", baseType: "type/Text", semanticType: "type/Category", fkTargetFieldId: null },
    { id: 102, name: "amount", baseType: "type/Decimal", semanticType: null, fkTargetFieldId: null },
  ],
};

test("a clean instance scores 100 and grades A", () => {
  const snapshot = snapshotOf({
    tables: [ORDERS_TABLE],
    cards: [1, 2, 3, 4, 5].map((id) => card(id)),
    dashboards: [
      {
        id: 20,
        name: "Overview",
        description: "Everything at a glance",
        collectionId: 5,
        creatorId: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastViewedAt: FRESH,
        viewCount: 30,
        archived: false,
        cardIds: [1, 2],
      },
    ],
  });

  const { health, summary, anomalies, duplicates, broken, stale } = analyze(snapshot, { now: NOW });
  assert.deepEqual({ anomalies: anomalies.length, duplicates: duplicates.length, broken: broken.length, stale: stale.length },
    { anomalies: 0, duplicates: 0, broken: 0, stale: 0 });
  assert.equal(health.score, 100);
  assert.equal(health.grade, "A");
  assert.equal(summary.healthScore, 100);
  assert.equal(health.factors.length, 4);
  assert.deepEqual(health.factors.map((f) => f.name), [
    "Content freshness", "No duplicates", "Documentation & organization", "Dashboard reliability",
  ]);
  assert.deepEqual(health.factors.map((f) => f.maxScore), [35, 25, 20, 20]);
  assert.equal(health.verdict, "Solid foundation, polish only.");
});

test("an empty instance scores 100 with a single explanatory factor", () => {
  const { health, summary } = analyze(snapshotOf(), { now: NOW });
  assert.equal(health.score, 100);
  assert.equal(health.grade, "A");
  assert.equal(health.factors.length, 1);
  assert.equal(health.factors[0].maxScore, 100);
  assert.equal(health.factors[0].score, 100);
  assert.ok(health.factors[0].description.length > 0);
  assert.equal(summary.totalCards, 0);
  assert.equal(summary.totalDashboards, 0);
});

test("dashboards with zero saved questions read as a reusability gap", () => {
  const snapshot = snapshotOf({
    dashboards: [
      {
        id: 20,
        name: "Ad-hoc board",
        description: null,
        collectionId: 5,
        creatorId: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastViewedAt: FRESH,
        viewCount: 5,
        archived: false,
        cardIds: [],
      },
    ],
  });

  const { health, dashboards } = analyze(snapshot, { now: NOW });
  assert.equal(dashboards.length, 1);
  assert.equal(dashboards[0].status, "unknown");
  assert.deepEqual(health.factors.map((f) => f.name), ["Reusable knowledge", "Dashboard reliability"]);
  assert.deepEqual(health.factors.map((f) => f.maxScore), [60, 40]);
  assert.equal(health.factors[0].score, 0);
  assert.equal(health.score, 40);
  assert.equal(health.grade, "C+");
});
