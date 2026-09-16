import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSql,
  extractCteNames,
  extractReferencedTables,
  extractJoinPairs,
} from "../src/sql.js";

// ─── normalizeSql ────────────────────────────────────────

test("normalizeSql collapses literals, whitespace, comments and punctuation", () => {
  assert.equal(
    normalizeSql("SELECT a, b FROM t WHERE x = 'foo' -- c\n"),
    normalizeSql("select a,b from t where x='bar'")
  );
});

test("normalizeSql strips block comments and normalizes numbers", () => {
  assert.equal(
    normalizeSql("select /* pick id */ id from t where id = 42"),
    "select id from t where id=?"
  );
  assert.equal(
    normalizeSql("select * from t limit 10"),
    normalizeSql("SELECT *\nFROM t\nLIMIT 200")
  );
});

test("normalizeSql is safe on empty and non-string input", () => {
  assert.equal(normalizeSql(null), "");
  assert.equal(normalizeSql(undefined), "");
  assert.equal(normalizeSql(""), "");
  assert.equal(normalizeSql(42), "");
  assert.equal(normalizeSql("))))("), "))))(");
});

// ─── extractCteNames ─────────────────────────────────────

test("extractCteNames finds every name in a WITH chain", () => {
  assert.deepEqual(
    extractCteNames("WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a"),
    new Set(["a", "b"])
  );
});

test("extractCteNames handles RECURSIVE, quoted names and column lists", () => {
  assert.deepEqual(
    extractCteNames('WITH RECURSIVE "Tree" AS (SELECT 1), `leaf` (id, parent) AS (SELECT 2) SELECT 1'),
    new Set(["tree", "leaf"])
  );
});

test("extractCteNames returns an empty set without a WITH clause or on garbage", () => {
  assert.equal(extractCteNames("SELECT * FROM orders").size, 0);
  assert.equal(extractCteNames("))))(").size, 0);
  assert.equal(extractCteNames(null).size, 0);
});

// ─── extractReferencedTables ─────────────────────────────

test("extractReferencedTables skips CTE names and function-call FROM", () => {
  assert.deepEqual(
    extractReferencedTables(
      "WITH c AS (SELECT * FROM users) SELECT EXTRACT(epoch FROM created_at) FROM c JOIN orders o ON 1=1"
    ),
    ["users", "orders"]
  );
});

test("extractReferencedTables takes the last dotted segment and reads subqueries", () => {
  assert.deepEqual(
    extractReferencedTables("SELECT * FROM public.orders o WHERE id IN (SELECT order_id FROM payments)"),
    ["orders", "payments"]
  );
});

test("extractReferencedTables ignores subquery aliases", () => {
  assert.deepEqual(extractReferencedTables("SELECT * FROM (SELECT 1) sub"), []);
});

test("extractReferencedTables unwraps quoted and multi-part identifiers", () => {
  assert.deepEqual(
    extractReferencedTables('SELECT * FROM "public"."Orders" o JOIN `analytics`.`Users` u ON 1=1'),
    ["orders", "users"]
  );
  assert.deepEqual(
    extractReferencedTables("SELECT * FROM `my-project.analytics.Events`"),
    ["events"]
  );
  assert.deepEqual(
    extractReferencedTables("SELECT * FROM my_project.analytics.events"),
    ["events"]
  );
});

test("extractReferencedTables neutralizes Metabase template tags", () => {
  assert.deepEqual(
    extractReferencedTables("SELECT * FROM orders WHERE x = {{snippet: pick from big_table}}"),
    ["orders"]
  );
});

test("extractReferencedTables handles comma joins and outer join variants", () => {
  assert.deepEqual(
    extractReferencedTables("SELECT * FROM a, b LEFT OUTER JOIN c ON 1=1 CROSS JOIN d"),
    ["a", "b", "c", "d"]
  );
  assert.deepEqual(
    extractReferencedTables("SELECT * FROM users u, orders o WHERE u.id = o.user_id"),
    ["users", "orders"]
  );
});

test("extractReferencedTables handles WITH RECURSIVE and a FROM on its own line", () => {
  assert.deepEqual(
    extractReferencedTables("WITH RECURSIVE tree AS (\n  SELECT id\n  FROM\n    nodes\n)\nSELECT * FROM tree"),
    ["nodes"]
  );
});

test("extractReferencedTables skips every FROM that belongs to a function call", () => {
  assert.deepEqual(
    extractReferencedTables(
      "SELECT SUBSTRING(name FROM 1 FOR 3), TRIM(BOTH ' ' FROM name), POSITION('a' IN name), OVERLAY(name PLACING 'x' FROM 2) FROM users"
    ),
    ["users"]
  );
  assert.deepEqual(extractReferencedTables("SELECT * FROM unnest(ARRAY[1,2]) AS x"), []);
});

test("extractReferencedTables returns unique names in first-seen order", () => {
  assert.deepEqual(
    extractReferencedTables("SELECT * FROM orders o JOIN ORDERS o2 ON 1=1 JOIN users u ON 1=1"),
    ["orders", "users"]
  );
});

test("extractReferencedTables is safe on garbage input", () => {
  assert.deepEqual(extractReferencedTables("))))("), []);
  assert.deepEqual(extractReferencedTables(""), []);
  assert.deepEqual(extractReferencedTables(null), []);
  assert.deepEqual(extractReferencedTables({ sql: "x" }), []);
});

// ─── extractJoinPairs ────────────────────────────────────

test("extractJoinPairs pairs every JOIN target with the FROM table", () => {
  assert.deepEqual(
    extractJoinPairs(
      "SELECT * FROM payments p JOIN orders o ON o.id=p.order_id JOIN users u ON u.id=o.user_id"
    ),
    [
      { from: "payments", to: "orders" },
      { from: "payments", to: "users" },
    ]
  );
});

test("extractJoinPairs pairs comma joins too", () => {
  assert.deepEqual(extractJoinPairs("SELECT * FROM a, b"), [{ from: "a", to: "b" }]);
});

test("extractJoinPairs skips CTE anchors and subquery anchors", () => {
  assert.deepEqual(
    extractJoinPairs("WITH c AS (SELECT * FROM users) SELECT * FROM c JOIN orders ON 1=1"),
    []
  );
  assert.deepEqual(extractJoinPairs("SELECT * FROM (SELECT 1) s JOIN orders o ON 1=1"), []);
});

test("extractJoinPairs uses the outermost FROM as the anchor", () => {
  assert.deepEqual(
    extractJoinPairs(
      "SELECT * FROM payments p JOIN orders o ON o.id = p.order_id AND o.id IN (SELECT id FROM refunds r JOIN chargebacks c ON 1=1)"
    ),
    [{ from: "payments", to: "orders" }]
  );
});

test("extractJoinPairs returns unique pairs and skips self-joins", () => {
  assert.deepEqual(
    extractJoinPairs("SELECT * FROM a JOIN b ON 1=1 JOIN b b2 ON 1=1"),
    [{ from: "a", to: "b" }]
  );
  assert.deepEqual(extractJoinPairs("SELECT * FROM users u JOIN users v ON u.id = v.parent_id"), []);
});

test("extractJoinPairs is safe on garbage and join-less input", () => {
  assert.deepEqual(extractJoinPairs("SELECT * FROM orders"), []);
  assert.deepEqual(extractJoinPairs("))))("), []);
  assert.deepEqual(extractJoinPairs(null), []);
});

test("normalizeSql keeps quoted identifiers distinct and blanks only single-quoted literals", () => {
  const a = normalizeSql('SELECT * FROM "public"."orders" WHERE status = \'paid\'');
  const b = normalizeSql('SELECT * FROM "public"."users" WHERE status = \'paid\'');
  assert.notEqual(a, b);
  assert.equal(a, "select * from public.orders where status='?'");
  assert.equal(normalizeSql("SELECT * FROM `db`.`orders`"), "select * from db.orders");
});
