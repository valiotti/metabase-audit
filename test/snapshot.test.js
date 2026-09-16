import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSnapshot,
  extractCardSql,
  isSampleDatabase,
  saveSnapshot,
  loadSnapshot,
  loadSnapshotFile,
} from "../src/snapshot.js";
import { SAMPLE_USER_ID } from "../src/analyze/constants.js";

const NOW = new Date("2026-09-16T10:00:00.000Z");

/** Walks a value and fails if any property is `undefined`. */
function assertNoUndefined(value, where = "$") {
  if (value === undefined) assert.fail(`undefined at ${where}`);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${where}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${where}.${k}`);
  }
}

const DATABASES = [
  { id: 1, name: "Sample Database", engine: "h2" },
  { id: 2, name: "Warehouse", engine: "postgres" },
];

const DB_METADATA = {
  1: {
    tables: [
      { id: 90, name: "PRODUCTS", schema: "PUBLIC", display_name: "Products", description: null, rows: 200, fields: [] },
    ],
  },
  2: {
    tables: [
      {
        id: 10,
        name: "orders",
        schema: "public",
        display_name: "Orders",
        description: "One row per order",
        rows: 120000,
        fields: [
          { id: 100, name: "id", base_type: "type/Integer", semantic_type: "type/PK", fk_target_field_id: null },
          { id: 101, name: "user_id", base_type: "type/Integer", semantic_type: "type/FK", fk_target_field_id: 110 },
        ],
      },
      {
        id: 11,
        name: "users",
        schema: "public",
        display_name: "Users",
        rows: 15000,
        fields: [{ id: 110, name: "id", base_type: "type/Integer", semantic_type: "type/PK" }],
      },
    ],
  },
};

const CARDS = [
  {
    id: 1,
    name: "Revenue by month",
    description: "Monthly gross revenue",
    type: "question",
    query_type: "native",
    display: "line",
    database_id: 2,
    dataset_query: { type: "native", database: 2, native: { query: "SELECT 1" } },
    collection_id: 5,
    creator_id: 3,
    created_at: "2025-01-10T09:00:00Z",
    updated_at: "2026-06-01T09:00:00Z",
    last_used_at: "2026-09-11T08:00:00Z",
    view_count: 40,
    archived: false,
  },
  {
    id: 2,
    name: "Active users",
    description: null,
    query_type: "query",
    display: "scalar",
    database_id: 2,
    dataset_query: { type: "query", database: 2, query: { "source-table": 11 } },
    collection_id: 6,
    creator_id: 4,
    created_at: "2025-02-01T09:00:00Z",
    updated_at: "2026-01-01T09:00:00Z",
    last_used_at: null,
    view_count: 4,
    archived: false,
  },
  {
    id: 3,
    name: "Sample card",
    database_id: 1,
    query_type: "native",
    dataset_query: { type: "native", database: 1, native: { query: "SELECT * FROM PRODUCTS" } },
    collection_id: null,
    creator_id: 3,
    created_at: "2024-01-01T09:00:00Z",
    updated_at: "2024-01-01T09:00:00Z",
    last_used_at: "2026-09-15T08:00:00Z",
    view_count: 100,
    archived: false,
  },
  {
    id: 4,
    name: "Sample User card",
    database_id: 2,
    query_type: "native",
    dataset_query: { type: "native", database: 2, native: { query: "SELECT * FROM orders" } },
    collection_id: null,
    creator_id: SAMPLE_USER_ID,
    created_at: "2024-01-01T09:00:00Z",
    updated_at: "2024-01-01T09:00:00Z",
    last_used_at: "2026-09-15T08:00:00Z",
    view_count: 50,
    archived: false,
  },
];

const DASHBOARDS = [
  {
    id: 20,
    name: "Exec",
    description: "Weekly exec view",
    collection_id: 5,
    creator_id: 3,
    archived: false,
    view_count: 50,
    created_at: "2025-01-15T09:00:00Z",
    updated_at: "2026-06-01T09:00:00Z",
    last_viewed_at: "2026-09-14T08:00:00Z",
  },
  {
    id: 21,
    name: "Ops",
    description: null,
    collection_id: 5,
    creator_id: 4,
    archived: false,
    view_count: 12,
    created_at: "2025-03-15T09:00:00Z",
    updated_at: "2025-03-15T09:00:00Z",
    last_used_at: "2026-03-01T08:00:00Z",
  },
  {
    id: 22,
    name: "Retired",
    collection_id: 6,
    creator_id: 4,
    archived: true,
    view_count: 999,
    created_at: "2024-01-01T09:00:00Z",
    updated_at: "2024-01-01T09:00:00Z",
  },
  {
    id: 23,
    name: "E-commerce Insights",
    collection_id: null,
    creator_id: SAMPLE_USER_ID,
    archived: false,
    view_count: 0,
    created_at: "2024-01-01T09:00:00Z",
    updated_at: "2024-01-01T09:00:00Z",
  },
];

const DASHBOARD_DETAILS = {
  20: { ...DASHBOARDS[0], dashcards: [{ card_id: 1, card: { id: 1, name: "Revenue by month" } }, { card_id: null }, { card_id: 2 }] },
  // Legacy Metabase shape: ordered_cards instead of dashcards.
  21: { ...DASHBOARDS[1], ordered_cards: [{ card_id: 2 }] },
  23: { ...DASHBOARDS[3], dashcards: [{ card_id: 4 }] },
};

const COLLECTIONS = [
  { id: "root", name: "Our analytics", location: "/" },
  { id: 5, name: "Finance", location: "/", archived: false },
  { id: 6, name: "Archive", location: "/5/", archived: false },
];

const USERS = [
  { id: 3, common_name: "Jane Doe", first_name: "Jane", last_name: "Doe", email: "jane@acme.test", is_active: true },
  { id: 4, first_name: "Bob", last_name: "Ray", email: "bob@acme.test" },
  { id: 9, email: null },
  { id: SAMPLE_USER_ID, common_name: "Sample User", email: "sample@metabase.test", is_active: false },
];

/** Plain stub of the client interface; any method can be overridden per test. */
function makeClient(overrides = {}) {
  return {
    async getInstanceInfo() {
      return { siteName: "Acme", version: "v0.62.3" };
    },
    async getDatabases() {
      return structuredClone(DATABASES);
    },
    async getDatabaseMetadata(dbId) {
      return structuredClone(DB_METADATA[dbId] || { tables: [] });
    },
    async getAllTables() {
      return [
        { id: 10, db_id: 2, name: "orders", schema: "public", display_name: "Orders" },
        { id: 11, db_id: 2, name: "users", schema: "public", display_name: "Users", row_count: 15000 },
        { id: 90, db_id: 1, name: "PRODUCTS", schema: "PUBLIC" },
      ];
    },
    async getAllCards() {
      return structuredClone(CARDS);
    },
    async getCollections() {
      return structuredClone(COLLECTIONS);
    },
    async getAllUsers() {
      return structuredClone(USERS);
    },
    async getAllDashboards() {
      return structuredClone(DASHBOARDS);
    },
    async getDashboard(id) {
      const detail = DASHBOARD_DETAILS[id];
      if (!detail) throw new Error(`no dashboard ${id}`);
      return structuredClone(detail);
    },
    async getActivity() {
      return [];
    },
    async compileToNative() {
      return null;
    },
    ...overrides,
  };
}

function build(overrides = {}, options = {}) {
  return buildSnapshot(makeClient(overrides), {
    url: "https://metabase.acme.test",
    now: NOW,
    ...options,
  });
}

// ─── extractCardSql ──────────────────────────────────────────────────────────

test("extractCardSql reads legacy native SQL", () => {
  assert.deepEqual(extractCardSql({ type: "native", native: { query: "SELECT 1" } }), {
    sql: "SELECT 1",
    queryType: "native",
    sourceTableId: null,
  });
});

test("extractCardSql reads MBQL v2 native stage", () => {
  const dq = { lib_type: "mbql/query", stages: [{ "lib/type": "mbql.stage/native", native: "SELECT 2" }] };
  assert.deepEqual(extractCardSql(dq), { sql: "SELECT 2", queryType: "native", sourceTableId: null });
});

test("extractCardSql reads MBQL v2 native stage given as an object", () => {
  const dq = { stages: [{ "lib/type": "mbql.stage/native", native: { query: "SELECT 3" } }] };
  assert.equal(extractCardSql(dq).sql, "SELECT 3");
  assert.equal(extractCardSql(dq).queryType, "native");
});

test("extractCardSql reads legacy structured source-table", () => {
  assert.deepEqual(extractCardSql({ type: "query", query: { "source-table": 11 } }), {
    sql: null,
    queryType: "query",
    sourceTableId: 11,
  });
});

test("extractCardSql reads MBQL v2 structured stage", () => {
  const dq = { "lib/type": "mbql/query", stages: [{ "lib/type": "mbql.stage/mbql", "source-table": 11 }] };
  assert.deepEqual(extractCardSql(dq), { sql: null, queryType: "query", sourceTableId: 11 });
});

test("extractCardSql ignores card__ source tables", () => {
  assert.equal(extractCardSql({ type: "query", query: { "source-table": "card__810" } }).sourceTableId, null);
  const v2 = { stages: [{ "lib/type": "mbql.stage/mbql", "source-table": "card__810" }] };
  assert.equal(extractCardSql(v2).sourceTableId, null);
});

test("extractCardSql returns unknown for empty or missing dataset_query", () => {
  assert.deepEqual(extractCardSql(undefined), { sql: null, queryType: "unknown", sourceTableId: null });
  assert.deepEqual(extractCardSql({}), { sql: null, queryType: "unknown", sourceTableId: null });
});

test("extractCardSql prefers the card's own query_type hint", () => {
  assert.equal(extractCardSql({ native: { query: "" } }, "native").queryType, "native");
  assert.equal(extractCardSql({}, "query").queryType, "query");
  // A bogus hint never wins over structure it contradicts being absent.
  assert.equal(extractCardSql({}, "weird").queryType, "unknown");
});

// ─── isSampleDatabase ────────────────────────────────────────────────────────

test("isSampleDatabase flags the built-in H2 sample database", () => {
  assert.equal(isSampleDatabase({ engine: "h2", name: "Sample Database" }), true);
  assert.equal(isSampleDatabase({ engine: "H2", name: "sample database" }), true);
  assert.equal(isSampleDatabase({ engine: "postgres", name: "Sample Warehouse" }), false);
  assert.equal(isSampleDatabase({ engine: "h2", name: "Internal H2" }), false);
  assert.equal(isSampleDatabase({ engine: "postgres", name: "Prod", is_sample: true }), true);
  assert.equal(isSampleDatabase(null), false);
});

// ─── buildSnapshot ───────────────────────────────────────────────────────────

test("buildSnapshot produces the documented shape with no undefined values", async () => {
  const snapshot = await build();

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.generatedAt, NOW.toISOString());
  assert.deepEqual(snapshot.instance, {
    url: "https://metabase.acme.test",
    siteName: "Acme",
    version: "v0.62.3",
  });
  assert.deepEqual(Object.keys(snapshot), [
    "schemaVersion",
    "generatedAt",
    "instance",
    "databases",
    "tables",
    "cards",
    "dashboards",
    "collections",
    "users",
    "meta",
  ]);
  assertNoUndefined(snapshot);

  assert.deepEqual(snapshot.databases, [
    { id: 1, name: "Sample Database", engine: "h2", isSample: true },
    { id: 2, name: "Warehouse", engine: "postgres", isSample: false },
  ]);

  // Tables of sample databases are kept (analyzers filter via databases[].isSample).
  assert.deepEqual(snapshot.tables.map((t) => t.id).sort((a, b) => a - b), [10, 11, 90]);
  const orders = snapshot.tables.find((t) => t.id === 10);
  assert.deepEqual(orders, {
    id: 10,
    dbId: 2,
    schema: "public",
    name: "orders",
    displayName: "Orders",
    description: "One row per order",
    rowCount: 120000,
    fields: [
      { id: 100, name: "id", baseType: "type/Integer", semanticType: "type/PK", fkTargetFieldId: null },
      { id: 101, name: "user_id", baseType: "type/Integer", semanticType: "type/FK", fkTargetFieldId: 110 },
    ],
  });
  // Missing semantic_type / fk_target_field_id become null, never undefined.
  const usersTable = snapshot.tables.find((t) => t.id === 11);
  assert.deepEqual(usersTable.fields[0].fkTargetFieldId, null);

  const card = snapshot.cards.find((c) => c.id === 1);
  assert.deepEqual(card, {
    id: 1,
    name: "Revenue by month",
    description: "Monthly gross revenue",
    type: "question",
    queryType: "native",
    display: "line",
    databaseId: 2,
    sourceTableId: null,
    sql: "SELECT 1",
    sqlSource: "native",
    collectionId: 5,
    creatorId: 3,
    createdAt: "2025-01-10T09:00:00.000Z",
    updatedAt: "2026-06-01T09:00:00.000Z",
    lastUsedAt: "2026-09-11T08:00:00.000Z",
    viewCount: 40,
    archived: false,
    hasError: false,
  });

  const gui = snapshot.cards.find((c) => c.id === 2);
  assert.equal(gui.queryType, "query");
  assert.equal(gui.sql, null);
  assert.equal(gui.sqlSource, null);
  assert.equal(gui.sourceTableId, 11);
  assert.equal(gui.type, "question"); // defaulted, the stub card has no `type`

  assert.deepEqual(snapshot.users, [
    { id: 3, name: "Jane Doe", email: "jane@acme.test", isActive: true },
    { id: 4, name: "Bob Ray", email: "bob@acme.test", isActive: true },
    { id: 9, name: "User 9", email: null, isActive: true },
    { id: SAMPLE_USER_ID, name: "Sample User", email: "sample@metabase.test", isActive: false },
  ]);

  assert.deepEqual(snapshot.meta, {
    dashboardDetailsFetched: 2,
    dashboardDetailsCap: 300,
    usersFetched: true,
    compiledCards: 0,
    activityBackfill: false,
    warnings: [],
  });
});

test("buildSnapshot drops sample database cards and Sample User content", async () => {
  const snapshot = await build();

  assert.deepEqual(snapshot.cards.map((c) => c.id), [1, 2]);
  assert.equal(snapshot.cards.find((c) => c.id === 3), undefined, "card on the sample DB is dropped");
  assert.equal(snapshot.cards.find((c) => c.id === 4), undefined, "Sample User card is dropped");

  assert.deepEqual(snapshot.dashboards.map((d) => d.id), [20, 21, 22]);
  assert.equal(snapshot.dashboards.find((d) => d.id === 23), undefined, "Sample User dashboard is dropped");
});

test("buildSnapshot maps dashboards, including legacy ordered_cards", async () => {
  const snapshot = await build();

  const exec = snapshot.dashboards.find((d) => d.id === 20);
  assert.deepEqual(exec, {
    id: 20,
    name: "Exec",
    description: "Weekly exec view",
    collectionId: 5,
    creatorId: 3,
    createdAt: "2025-01-15T09:00:00.000Z",
    updatedAt: "2026-06-01T09:00:00.000Z",
    lastViewedAt: "2026-09-14T08:00:00.000Z",
    viewCount: 50,
    archived: false,
    cardIds: [1, 2],
  });

  const ops = snapshot.dashboards.find((d) => d.id === 21);
  assert.deepEqual(ops.cardIds, [2], "legacy ordered_cards are read");
  assert.equal(ops.lastViewedAt, "2026-03-01T08:00:00.000Z", "falls back to last_used_at");

  // Archived dashboards stay in the snapshot but no detail call is made for them.
  const retired = snapshot.dashboards.find((d) => d.id === 22);
  assert.deepEqual(retired.cardIds, []);
  assert.equal(retired.archived, true);
  assert.equal(retired.lastViewedAt, null);
});

test("buildSnapshot caps dashboard detail fetches, most viewed first", async () => {
  const fetched = [];
  const snapshot = await build(
    {
      async getDashboard(id) {
        fetched.push(id);
        return structuredClone(DASHBOARD_DETAILS[id] || { id, dashcards: [] });
      },
    },
    { dashboardDetailsCap: 1 },
  );

  assert.deepEqual(fetched, [20], "only the most viewed non-archived dashboard is fetched");
  assert.equal(snapshot.meta.dashboardDetailsFetched, 1);
  assert.equal(snapshot.meta.dashboardDetailsCap, 1);
  assert.deepEqual(snapshot.dashboards.find((d) => d.id === 21).cardIds, [], "uncapped dashboards keep empty cardIds");
});

test("buildSnapshot warns and keeps going when a dashboard detail fails", async () => {
  const snapshot = await build({
    async getDashboard(id) {
      if (id === 21) throw new Error("boom");
      return structuredClone(DASHBOARD_DETAILS[id]);
    },
  });

  assert.deepEqual(snapshot.dashboards.find((d) => d.id === 21).cardIds, []);
  assert.equal(snapshot.meta.dashboardDetailsFetched, 1);
  assert.equal(snapshot.meta.warnings.length, 1);
  assert.match(snapshot.meta.warnings[0], /dashboard 21/i);
});

test("buildSnapshot computes collection paths from location", async () => {
  const snapshot = await build();

  assert.deepEqual(snapshot.collections, [
    { id: 5, name: "Finance", parentId: null, path: "Finance", archived: false },
    { id: 6, name: "Archive", parentId: 5, path: "Finance / Archive", archived: false },
  ]);
});

test("buildSnapshot handles deep and orphaned collection locations", async () => {
  const snapshot = await build({
    async getCollections() {
      return [
        { id: 5, name: "Finance", location: "/" },
        { id: 6, name: "Archive", location: "/5/" },
        { id: 7, name: "Deep", location: "/5/6/", archived: true },
        { id: 8, name: "Orphan", location: "/404/" },
      ];
    },
  });

  const byId = Object.fromEntries(snapshot.collections.map((c) => [c.id, c]));
  assert.equal(byId[7].path, "Finance / Archive / Deep");
  assert.equal(byId[7].parentId, 6);
  assert.equal(byId[7].archived, true);
  assert.equal(byId[8].path, "Orphan", "unknown ancestors are skipped in the path");
  assert.equal(byId[8].parentId, 404);
});

test("buildSnapshot sets usersFetched=false when the user list is empty", async () => {
  const snapshot = await build({
    async getAllUsers() {
      return [];
    },
  });

  assert.deepEqual(snapshot.users, []);
  assert.equal(snapshot.meta.usersFetched, false);
  assert.deepEqual(snapshot.meta.warnings, []);
});

test("buildSnapshot survives a 403 from the user list", async () => {
  const snapshot = await build({
    async getAllUsers() {
      throw new Error("403 Forbidden");
    },
  });

  assert.deepEqual(snapshot.users, []);
  assert.equal(snapshot.meta.usersFetched, false);
  assert.equal(snapshot.meta.warnings.length, 1);
  assert.match(snapshot.meta.warnings[0], /users/i);
});

test("buildSnapshot falls back to getAllTables when database metadata fails", async () => {
  const snapshot = await build({
    async getDatabaseMetadata(dbId) {
      if (dbId === 2) throw new Error("500 Internal Server Error");
      return structuredClone(DB_METADATA[dbId]);
    },
  });

  const warehouseTables = snapshot.tables.filter((t) => t.dbId === 2);
  assert.deepEqual(warehouseTables.map((t) => t.id), [10, 11]);
  assert.deepEqual(warehouseTables[0].fields, []);
  assert.equal(warehouseTables[0].rowCount, null);
  assert.equal(warehouseTables[1].rowCount, 15000, "row_count is used when the list row carries it");
  assert.equal(snapshot.tables.filter((t) => t.dbId === 1).length, 1, "sample DB metadata still came from the API");
  assert.equal(snapshot.meta.warnings.length, 1);
  assert.match(snapshot.meta.warnings[0], /Warehouse/);
});

test("buildSnapshot backfills lastUsedAt from the activity feed", async () => {
  const snapshot = await build({
    async getAllCards() {
      return structuredClone(CARDS).map((c) => ({ ...c, last_used_at: null }));
    },
    async getActivity() {
      return [
        { topic: "card-read", model: "card", model_id: 1, timestamp: "2026-05-01T00:00:00Z" },
        { topic: "card-read", model: "card", model_id: 1, timestamp: "2026-07-02T00:00:00Z" },
        { topic: "card-read", model: "card", model_id: 2, timestamp: "2026-06-01T00:00:00Z" },
        { topic: "dashboard-read", model: "dashboard", model_id: 1, timestamp: "2026-09-01T00:00:00Z" },
        { topic: "card-read", model: "card", model_id: 999, timestamp: "2026-09-01T00:00:00Z" },
        { topic: "card-read", model: "card", model_id: 1, timestamp: "not a date" },
      ];
    },
  });

  assert.equal(snapshot.cards.find((c) => c.id === 1).lastUsedAt, "2026-07-02T00:00:00.000Z");
  assert.equal(snapshot.cards.find((c) => c.id === 2).lastUsedAt, "2026-06-01T00:00:00.000Z");
  assert.equal(snapshot.meta.activityBackfill, true);
});

test("buildSnapshot skips the activity feed when most cards already have timestamps", async () => {
  let called = false;
  const snapshot = await build({
    async getActivity() {
      called = true;
      return [{ topic: "card-read", model: "card", model_id: 2, timestamp: "2026-06-01T00:00:00Z" }];
    },
  });

  assert.equal(called, false, "one null out of two cards is not more than 50%");
  assert.equal(snapshot.meta.activityBackfill, false);
  assert.equal(snapshot.cards.find((c) => c.id === 2).lastUsedAt, null);
});

test("buildSnapshot never overwrites a real lastUsedAt with activity data", async () => {
  const snapshot = await build({
    async getAllCards() {
      const cards = structuredClone(CARDS);
      cards[0].last_used_at = "2026-09-11T08:00:00Z"; // card 1 keeps its timestamp
      cards[1].last_used_at = null;
      // A third live card with no timestamp pushes the null share past 50%.
      cards.push({ ...cards[1], id: 5, name: "Another GUI card", last_used_at: null });
      return cards;
    },
    async getActivity() {
      return [
        { topic: "card-read", model: "card", model_id: 1, timestamp: "2020-01-01T00:00:00Z" },
        { topic: "card-read", model: "card", model_id: 2, timestamp: "2026-06-01T00:00:00Z" },
      ];
    },
  });

  assert.equal(snapshot.cards.find((c) => c.id === 1).lastUsedAt, "2026-09-11T08:00:00.000Z");
  assert.equal(snapshot.cards.find((c) => c.id === 2).lastUsedAt, "2026-06-01T00:00:00.000Z");
});

test("buildSnapshot compiles GUI cards when compile is on", async () => {
  const asked = [];
  const snapshot = await build(
    {
      async compileToNative(datasetQuery) {
        asked.push(datasetQuery);
        return "SELECT id FROM users";
      },
    },
    { compile: true },
  );

  const gui = snapshot.cards.find((c) => c.id === 2);
  assert.equal(gui.sql, "SELECT id FROM users");
  assert.equal(gui.sqlSource, "compiled");
  assert.equal(snapshot.meta.compiledCards, 1);
  assert.deepEqual(snapshot.meta.warnings, []);
  assert.deepEqual(asked, [{ type: "query", database: 2, query: { "source-table": 11 } }]);
  assert.equal(snapshot.cards.find((c) => c.id === 1).sqlSource, "native", "native cards are left alone");
  // dataset_query is a build-time detail, it must not leak into the file.
  assert.equal("dataset_query" in gui, false);
  assert.equal("datasetQuery" in gui, false);
});

test("buildSnapshot records a warning when a GUI card cannot be compiled", async () => {
  const snapshot = await build(
    {
      async compileToNative() {
        return null;
      },
    },
    { compile: true },
  );

  const gui = snapshot.cards.find((c) => c.id === 2);
  assert.equal(gui.sql, null);
  assert.equal(gui.sqlSource, null);
  assert.equal(snapshot.meta.compiledCards, 0);
  assert.deepEqual(snapshot.meta.warnings, ["Could not compile card 2 (Active users)"]);
});

test("buildSnapshot treats a compile exception as a failure, not a crash", async () => {
  const snapshot = await build(
    {
      async compileToNative() {
        throw new Error("timeout");
      },
    },
    { compile: true },
  );

  assert.equal(snapshot.cards.find((c) => c.id === 2).sql, null);
  assert.equal(snapshot.meta.compiledCards, 0);
  assert.equal(snapshot.meta.warnings.length, 1);
});

test("buildSnapshot does not call compileToNative unless asked", async () => {
  let called = false;
  const snapshot = await build({
    async compileToNative() {
      called = true;
      return "SELECT 1";
    },
  });

  assert.equal(called, false);
  assert.equal(snapshot.meta.compiledCards, 0);
});

test("buildSnapshot reports progress phases in order", async () => {
  const phases = [];
  await build({}, {
    compile: true,
    onProgress({ phase, done, total }) {
      assert.equal(typeof done, "number");
      assert.equal(typeof total, "number");
      if (phases[phases.length - 1] !== phase) phases.push(phase);
    },
  });

  assert.deepEqual(phases, [
    "instance",
    "databases",
    "tables",
    "cards",
    "collections",
    "users",
    "dashboards",
    "compile",
  ]);
});

test("buildSnapshot survives an onProgress callback that throws", async () => {
  const snapshot = await build({}, {
    onProgress() {
      throw new Error("bad listener");
    },
  });

  assert.equal(snapshot.cards.length, 2);
});

test("buildSnapshot keeps going when instance info is unavailable", async () => {
  const snapshot = await build({
    async getInstanceInfo() {
      throw new Error("401 Unauthorized");
    },
  });

  assert.deepEqual(snapshot.instance, { url: "https://metabase.acme.test", siteName: null, version: null });
  assert.equal(snapshot.meta.warnings.length, 1);
});

test("buildSnapshot defaults to an empty instance url and the standard cap", async () => {
  const snapshot = await buildSnapshot(makeClient(), { now: NOW });

  assert.equal(snapshot.instance.url, "");
  assert.equal(snapshot.meta.dashboardDetailsCap, 300);
});

// ─── saveSnapshot / loadSnapshot ─────────────────────────────────────────────

test("saveSnapshot and loadSnapshot round-trip through a directory", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "metalens-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const snapshot = await build();
  const file = await saveSnapshot(snapshot, path.join(dir, "nested", ".metalens"));

  assert.equal(file, path.join(dir, "nested", ".metalens", "snapshot.json"));
  const raw = await readFile(file, "utf8");
  assert.ok(raw.endsWith("}\n"), "file ends with a newline");
  assert.ok(raw.includes('\n  "schemaVersion": 1'), "written as pretty JSON");

  const loaded = await loadSnapshot(path.join(dir, "nested", ".metalens"));
  assert.deepEqual(loaded, snapshot);

  const direct = await loadSnapshotFile(file);
  assert.deepEqual(direct, snapshot);
});

test("loadSnapshot explains a missing file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "metalens-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => loadSnapshot(dir), /snapshot/i);
  await assert.rejects(() => loadSnapshot(dir), new RegExp(path.join(dir, "snapshot.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("loadSnapshot rejects an unsupported schemaVersion", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "metalens-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "snapshot.json"), JSON.stringify({ schemaVersion: 99 }), "utf8");
  await assert.rejects(() => loadSnapshot(dir), /schemaVersion/i);

  await writeFile(path.join(dir, "snapshot.json"), "{not json", "utf8");
  await assert.rejects(() => loadSnapshot(dir), /JSON/i);
});

test("loadSnapshotFile reads the checked-in fixture", async () => {
  const fixture = fileURLToPath(new URL("fixtures/snapshot.small.json", import.meta.url));
  const snapshot = await loadSnapshotFile(fixture);

  assert.equal(snapshot.schemaVersion, 1);
  assert.ok(snapshot.cards.length > 0);
});
