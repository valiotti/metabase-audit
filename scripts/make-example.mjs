#!/usr/bin/env node
/**
 * Builds the published example: `examples/snapshot.json`, `examples/findings.json`,
 * `examples/METALENS-REPORT.md` and `examples/DATA-CONTEXT.md`.
 *
 * The instance is invented. "Northwind Outdoors" is a subscription e-commerce
 * company that has been running Metabase for four years: a warehouse with dbt
 * marts on top, nine analysts of varying discipline, two service accounts, a
 * pile of copied queries and a few dashboards nobody has opened since last year.
 * Everything here is written by hand or derived from a seeded PRNG, so two runs
 * produce byte-identical files and the example can be committed and diffed.
 *
 * Nothing about the pipeline is faked: the generator writes a snapshot in the
 * real contract and then calls the real `runScan`, so the report you read in
 * `examples/` is the report the tool produces, not a mock-up of one.
 *
 *   node scripts/make-example.mjs [--out examples]
 */

import { copyFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runScan } from "../src/scan.js";
import { saveSnapshot, SNAPSHOT_FILENAME } from "../src/snapshot.js";
import { FINDINGS_FILENAME } from "../src/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Frozen clock. Every date in the example is measured back from this instant. */
const NOW = new Date("2026-09-16T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const SEED = 20260916;

const INSTANCE = {
  url: "https://metabase.northwind-outdoors.example",
  siteName: "Northwind Outdoors",
  version: "v0.55.8",
};

const WAREHOUSE_DB = 1;
const SAMPLE_DB = 2;
const SAMPLE_USER_ID = 13371338;

// ───────────────────────────── deterministic randomness ─────────────────────

/** mulberry32: small, fast, and identical on every Node version. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intBetween(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** ISO timestamp `days` before the frozen clock, at a plausible working hour. */
function stampDaysAgo(rng, days) {
  const at = new Date(NOW.getTime() - days * DAY_MS);
  at.setUTCHours(intBetween(rng, 7, 19), intBetween(rng, 0, 59), intBetween(rng, 0, 59), 0);
  return at.toISOString();
}

// ───────────────────────────── warehouse schema ─────────────────────────────

/**
 * `[column, base type, semantic type, foreign key target]`. Types are written
 * without the `type/` prefix Metabase puts on the wire; it is added on build.
 * Only the five relationships Metabase was actually told about carry a target,
 * which is what a real instance looks like: the rest are `*_id` columns the
 * analyzer has to infer.
 */
const TABLE_DEFS = [
  {
    schema: "public",
    name: "orders",
    display: "Orders",
    rows: 1284000,
    description: "One row per storefront order, subscription box shipments included.",
    fields: [
      ["id", "BigInteger", "PK"],
      ["order_number", "Text", null],
      ["customer_id", "Integer", "FK", "customers.id"],
      ["status", "Text", "Category"],
      ["channel", "Text", "Category"],
      ["store_region", "Text", "Category"],
      ["currency", "Text", "Category"],
      ["subtotal_amount", "Decimal", null],
      ["discount_amount", "Decimal", null],
      ["shipping_amount", "Decimal", null],
      ["tax_amount", "Decimal", null],
      ["total_amount", "Decimal", null],
      ["coupon_code", "Text", null],
      ["is_gift", "Boolean", "Category"],
      ["placed_at", "DateTime", "CreationTimestamp"],
      ["shipped_at", "DateTime", null],
      ["cancelled_at", "DateTime", null],
      ["updated_at", "DateTime", null],
    ],
  },
  {
    schema: "public",
    name: "order_items",
    display: "Order Items",
    rows: 3942000,
    description: "Line items. One row per product on an order.",
    fields: [
      ["id", "BigInteger", "PK"],
      ["order_id", "BigInteger", "FK", "orders.id"],
      ["product_id", "Integer", "FK", "products.id"],
      ["quantity", "Integer", "Quantity"],
      ["unit_price", "Decimal", null],
      ["discount_amount", "Decimal", null],
      ["line_total", "Decimal", null],
      ["created_at", "DateTime", "CreationTimestamp"],
    ],
  },
  {
    schema: "public",
    name: "customers",
    display: "Customers",
    rows: 412000,
    description: "Registered customers. Guests are written here on their first order.",
    fields: [
      ["id", "Integer", "PK"],
      ["email", "Text", "Email"],
      ["first_name", "Text", "Name"],
      ["last_name", "Text", "Name"],
      ["signup_source", "Text", "Category"],
      ["country", "Text", "Country"],
      ["state", "Text", "State"],
      ["postal_code", "Text", "ZipCode"],
      ["marketing_opt_in", "Boolean", "Category"],
      ["first_order_at", "DateTime", null],
      ["created_at", "DateTime", "CreationTimestamp"],
      ["updated_at", "DateTime", null],
    ],
  },
  {
    schema: "public",
    name: "subscriptions",
    display: "Subscriptions",
    rows: 96500,
    description: "The seasonal gear box. One row per subscription, current state only.",
    fields: [
      ["id", "Integer", "PK"],
      ["customer_id", "Integer", "FK", "customers.id"],
      ["plan_code", "Text", "Category"],
      ["status", "Text", "Category"],
      ["billing_interval", "Text", "Category"],
      ["mrr_amount", "Decimal", null],
      ["started_at", "DateTime", "CreationTimestamp"],
      ["trial_ends_at", "DateTime", null],
      ["current_period_end", "DateTime", null],
      ["cancelled_at", "DateTime", null],
      ["cancellation_reason", "Text", "Category"],
    ],
  },
  {
    schema: "public",
    name: "subscription_events",
    display: "Subscription Events",
    rows: 1118000,
    description: "Append only log of plan changes, pauses, cancellations and reactivations.",
    fields: [
      ["id", "BigInteger", "PK"],
      ["subscription_id", "Integer", null],
      ["customer_id", "Integer", null],
      ["event_type", "Text", "Category"],
      ["from_plan", "Text", "Category"],
      ["to_plan", "Text", "Category"],
      ["mrr_delta", "Decimal", null],
      ["occurred_at", "DateTime", "CreationTimestamp"],
    ],
  },
  {
    schema: "public",
    name: "payments",
    display: "Payments",
    rows: 1310000,
    description: "Authorisations and captures from the two payment processors.",
    fields: [
      ["id", "BigInteger", "PK"],
      ["order_id", "BigInteger", "FK", "orders.id"],
      ["customer_id", "Integer", null],
      ["amount", "Decimal", null],
      ["currency", "Text", "Category"],
      ["method", "Text", "Category"],
      ["processor", "Text", "Category"],
      ["status", "Text", "Category"],
      ["failure_code", "Text", "Category"],
      ["captured_at", "DateTime", null],
      ["created_at", "DateTime", "CreationTimestamp"],
    ],
  },
  {
    schema: "public",
    name: "refunds",
    display: "Refunds",
    rows: 41800,
    description: null,
    fields: [
      ["id", "Integer", "PK"],
      ["payment_id", "BigInteger", null],
      ["order_id", "BigInteger", null],
      ["amount", "Decimal", null],
      ["reason", "Text", "Category"],
      ["refunded_at", "DateTime", null],
      ["created_at", "DateTime", "CreationTimestamp"],
    ],
  },
  {
    schema: "public",
    name: "products",
    display: "Products",
    rows: 4300,
    description: "Catalogue, one row per sellable SKU.",
    fields: [
      ["id", "Integer", "PK"],
      ["sku", "Text", null],
      ["title", "Text", "Title"],
      ["category", "Text", "Category"],
      ["subcategory", "Text", "Category"],
      ["brand", "Text", "Category"],
      ["unit_cost", "Decimal", null],
      ["list_price", "Decimal", null],
      ["is_active", "Boolean", "Category"],
      ["launched_at", "DateTime", null],
      ["created_at", "DateTime", "CreationTimestamp"],
    ],
  },
  {
    schema: "public",
    name: "inventory",
    display: "Inventory",
    rows: 68400,
    description: "Stock position per SKU per warehouse, refreshed every 15 minutes.",
    fields: [
      ["id", "Integer", "PK"],
      ["product_id", "Integer", null],
      ["warehouse_code", "Text", "Category"],
      ["on_hand", "Integer", "Quantity"],
      ["reserved", "Integer", "Quantity"],
      ["reorder_point", "Integer", "Quantity"],
      ["updated_at", "DateTime", null],
    ],
  },
  {
    schema: "public",
    name: "shipments",
    display: "Shipments",
    rows: 1190000,
    description: null,
    fields: [
      ["id", "BigInteger", "PK"],
      ["order_id", "BigInteger", "FK", "orders.id"],
      ["carrier", "Text", "Category"],
      ["service_level", "Text", "Category"],
      ["tracking_number", "Text", null],
      ["warehouse_code", "Text", "Category"],
      ["cost_amount", "Decimal", null],
      ["shipped_at", "DateTime", null],
      ["delivered_at", "DateTime", null],
      ["promised_at", "DateTime", null],
    ],
  },
  {
    schema: "public",
    name: "sessions",
    display: "Sessions",
    rows: 12400000,
    description: "Web and app sessions from the tracking pipeline.",
    fields: [
      ["id", "BigInteger", "PK"],
      ["customer_id", "Integer", null],
      ["anonymous_id", "Text", null],
      ["device_type", "Text", "Category"],
      ["browser", "Text", "Category"],
      ["utm_source", "Text", "Category"],
      ["utm_medium", "Text", "Category"],
      ["utm_campaign", "Text", "Category"],
      ["landing_path", "Text", null],
      ["started_at", "DateTime", "CreationTimestamp"],
      ["ended_at", "DateTime", null],
    ],
  },
  {
    schema: "public",
    name: "events",
    display: "Events",
    rows: 48000000,
    description: "Raw product analytics stream. Partitioned by day, queried rarely.",
    fields: [
      ["id", "BigInteger", "PK"],
      ["session_id", "BigInteger", null],
      ["customer_id", "Integer", null],
      ["event_name", "Text", "Category"],
      ["page_path", "Text", null],
      ["properties", "Text", null],
      ["occurred_at", "DateTime", "CreationTimestamp"],
    ],
  },
  {
    schema: "public",
    name: "campaigns",
    display: "Campaigns",
    rows: 1240,
    description: null,
    fields: [
      ["id", "Integer", "PK"],
      ["name", "Text", "Title"],
      ["channel", "Text", "Category"],
      ["platform", "Text", "Category"],
      ["objective", "Text", "Category"],
      ["budget_amount", "Decimal", null],
      ["started_at", "DateTime", null],
      ["ended_at", "DateTime", null],
    ],
  },
  {
    schema: "public",
    name: "ad_spend",
    display: "Ad Spend",
    rows: 214000,
    description: "Daily spend per campaign, loaded from the ad platforms every morning.",
    fields: [
      ["id", "BigInteger", "PK"],
      ["campaign_id", "Integer", null],
      ["channel", "Text", "Category"],
      ["platform", "Text", "Category"],
      ["spend_date", "Date", null],
      ["impressions", "BigInteger", "Quantity"],
      ["clicks", "Integer", "Quantity"],
      ["spend_amount", "Decimal", null],
      ["currency", "Text", "Category"],
    ],
  },
  {
    schema: "public",
    name: "support_tickets",
    display: "Support Tickets",
    rows: 158000,
    description: "Helpdesk export, synced hourly.",
    fields: [
      ["id", "Integer", "PK"],
      ["customer_id", "Integer", null],
      ["order_id", "BigInteger", null],
      ["subject", "Text", "Title"],
      ["category", "Text", "Category"],
      ["priority", "Text", "Category"],
      ["status", "Text", "Category"],
      ["assigned_to", "Text", "Category"],
      ["opened_at", "DateTime", "CreationTimestamp"],
      ["first_response_at", "DateTime", null],
      ["resolved_at", "DateTime", null],
      ["reopened_count", "Integer", "Quantity"],
    ],
  },
  {
    schema: "public",
    name: "nps_responses",
    display: "NPS Responses",
    rows: 24600,
    description: null,
    fields: [
      ["id", "Integer", "PK"],
      ["customer_id", "Integer", null],
      ["score", "Integer", "Score"],
      ["comment", "Text", "Description"],
      ["survey_channel", "Text", "Category"],
      ["responded_at", "DateTime", "CreationTimestamp"],
    ],
  },
  {
    schema: "public",
    name: "orders_backup_2023",
    display: "Orders Backup 2023",
    rows: 812000,
    description: "Snapshot taken before the 2024 replatform. Nobody has dropped it.",
    fields: [
      ["id", "BigInteger", "PK"],
      ["customer_id", "Integer", null],
      ["status", "Text", "Category"],
      ["total_amount", "Decimal", null],
      ["placed_at", "DateTime", null],
    ],
  },
  {
    schema: "public",
    name: "tmp_cohort_export",
    display: "Tmp Cohort Export",
    rows: 34900,
    description: null,
    fields: [
      ["customer_id", "Integer", null],
      ["cohort_month", "Date", null],
      ["orders_count", "Integer", "Quantity"],
      ["revenue", "Decimal", null],
    ],
  },
  {
    schema: "public",
    name: "events_legacy",
    display: "Events Legacy",
    rows: 9600000,
    description: null,
    fields: [
      ["id", "BigInteger", "PK"],
      ["user_id", "Integer", null],
      ["name", "Text", "Category"],
      ["ts", "DateTime", null],
    ],
  },
  {
    schema: "public",
    name: "customers_old",
    display: "Customers Old",
    rows: 288000,
    description: null,
    fields: [
      ["id", "Integer", "PK"],
      ["email", "Text", "Email"],
      ["name", "Text", "Name"],
      ["created_at", "DateTime", null],
    ],
  },
  {
    schema: "public",
    name: "zz_test",
    display: "Zz Test",
    rows: 1200,
    description: null,
    fields: [
      ["id", "Integer", "PK"],
      ["note", "Text", null],
      ["created_at", "DateTime", null],
    ],
  },
  {
    schema: "dbt_marts",
    name: "fct_orders",
    display: "Fct Orders",
    rows: 1284000,
    description: "Order grain fact table. The one the finance team reconciles against.",
    fields: [
      ["order_id", "BigInteger", "PK"],
      ["customer_id", "Integer", null],
      ["order_date", "Date", null],
      ["channel", "Text", "Category"],
      ["store_region", "Text", "Category"],
      ["product_category", "Text", "Category"],
      ["items_count", "Integer", "Quantity"],
      ["gross_revenue", "Decimal", null],
      ["discount_amount", "Decimal", null],
      ["net_revenue", "Decimal", null],
      ["is_first_order", "Boolean", "Category"],
    ],
  },
  {
    schema: "dbt_marts",
    name: "fct_revenue_daily",
    display: "Fct Revenue Daily",
    rows: 14600,
    description: "Revenue by day and channel. Renamed from fct_revenue in March 2026.",
    fields: [
      ["revenue_date", "Date", null],
      ["channel", "Text", "Category"],
      ["orders_count", "Integer", "Quantity"],
      ["gross_revenue", "Decimal", null],
      ["discount_amount", "Decimal", null],
      ["refund_amount", "Decimal", null],
      ["net_revenue", "Decimal", null],
    ],
  },
  {
    schema: "dbt_marts",
    name: "fct_subscription_mrr",
    display: "Fct Subscription Mrr",
    rows: 1158000,
    description: "One row per subscription per month, with the MRR recognised that month.",
    fields: [
      ["subscription_id", "Integer", null],
      ["customer_id", "Integer", null],
      ["month_start", "Date", null],
      ["plan_code", "Text", "Category"],
      ["billing_interval", "Text", "Category"],
      ["mrr_amount", "Decimal", null],
      ["is_active", "Boolean", "Category"],
    ],
  },
  {
    schema: "dbt_marts",
    name: "dim_customers",
    display: "Dim Customers",
    rows: 412000,
    description: "Customer dimension with lifetime aggregates.",
    fields: [
      ["customer_id", "Integer", "PK"],
      ["email", "Text", "Email"],
      ["country", "Text", "Country"],
      ["signup_source", "Text", "Category"],
      ["first_order_date", "Date", null],
      ["lifetime_orders", "Integer", "Quantity"],
      ["lifetime_revenue", "Decimal", null],
      ["current_plan", "Text", "Category"],
      ["is_subscriber", "Boolean", "Category"],
    ],
  },
  {
    schema: "dbt_marts",
    name: "dim_products",
    display: "Dim Products",
    rows: 4300,
    description: null,
    fields: [
      ["product_id", "Integer", "PK"],
      ["sku", "Text", null],
      ["title", "Text", "Title"],
      ["category", "Text", "Category"],
      ["subcategory", "Text", "Category"],
      ["brand", "Text", "Category"],
      ["unit_cost", "Decimal", null],
      ["list_price", "Decimal", null],
      ["is_active", "Boolean", "Category"],
    ],
  },
  {
    schema: "dbt_marts",
    name: "dim_dates",
    display: "Dim Dates",
    rows: 3653,
    description: "Calendar helper, 2020 to 2029.",
    fields: [
      ["date_day", "Date", null],
      ["day_of_week", "Text", "Category"],
      ["week_start", "Date", null],
      ["month_start", "Date", null],
      ["quarter", "Text", "Category"],
      ["year", "Integer", null],
      ["is_holiday", "Boolean", "Category"],
    ],
  },
  {
    schema: "dbt_marts",
    name: "int_subscription_periods",
    display: "Int Subscription Periods",
    rows: 341000,
    description: "Intermediate model: one row per billed period per subscription.",
    fields: [
      ["subscription_id", "Integer", null],
      ["period_index", "Integer", null],
      ["period_start", "Date", null],
      ["period_end", "Date", null],
      ["plan_code", "Text", "Category"],
      ["mrr_amount", "Decimal", null],
      ["was_renewed", "Boolean", "Category"],
    ],
  },
];

const SAMPLE_TABLE_DEF = {
  schema: "PUBLIC",
  name: "PRODUCTS",
  display: "Products",
  rows: 200,
  description: null,
  fields: [
    ["ID", "BigInteger", "PK"],
    ["EAN", "Text", null],
    ["TITLE", "Text", "Title"],
    ["CATEGORY", "Text", "Category"],
    ["VENDOR", "Text", "Company"],
    ["PRICE", "Float", null],
    ["CREATED_AT", "DateTime", "CreationTimestamp"],
  ],
};

/** Assigns ids, expands the short type names and wires the declared foreign keys. */
function buildTables() {
  let tableId = 200;
  let fieldId = 3000;
  const tables = [];
  const fieldIdByRef = new Map();
  const tableIdByName = new Map();

  const add = (def, dbId) => {
    const id = ++tableId;
    tableIdByName.set(def.name, id);
    const fields = def.fields.map(([name, baseType, semanticType]) => {
      const fid = ++fieldId;
      fieldIdByRef.set(`${def.name}.${name}`, fid);
      return {
        id: fid,
        name,
        baseType: `type/${baseType}`,
        semanticType: semanticType ? `type/${semanticType}` : null,
        fkTargetFieldId: null,
      };
    });
    tables.push({
      id,
      dbId,
      schema: def.schema,
      name: def.name,
      displayName: def.display,
      description: def.description ?? null,
      rowCount: def.rows,
      fields,
    });
  };

  for (const def of TABLE_DEFS) add(def, WAREHOUSE_DB);
  add(SAMPLE_TABLE_DEF, SAMPLE_DB);

  // Second pass: the targets exist now.
  for (const def of TABLE_DEFS) {
    for (const [name, , , fkRef] of def.fields) {
      if (!fkRef) continue;
      const target = fieldIdByRef.get(fkRef);
      if (!target) throw new Error(`make-example: unknown fk target ${fkRef}`);
      const table = tables.find((t) => t.name === def.name);
      table.fields.find((f) => f.name === name).fkTargetFieldId = target;
    }
  }

  return { tables, tableIdByName };
}

// ───────────────────────────── people and collections ───────────────────────

const USERS = [
  { id: 3, name: "Dana Whitfield", email: "dana.whitfield@northwind-outdoors.example", isActive: true },
  { id: 4, name: "Marcus Oyelaran", email: "marcus.oyelaran@northwind-outdoors.example", isActive: true },
  { id: 5, name: "Priya Natarajan", email: "priya.natarajan@northwind-outdoors.example", isActive: true },
  { id: 6, name: "Ellis Barbour", email: "ellis.barbour@northwind-outdoors.example", isActive: false },
  { id: 7, name: "Rosa Villalobos", email: "rosa.villalobos@northwind-outdoors.example", isActive: true },
  { id: 8, name: "Henrik Solberg", email: "henrik.solberg@northwind-outdoors.example", isActive: true },
  { id: 9, name: "Jamie Okonkwo", email: "jamie.okonkwo@northwind-outdoors.example", isActive: true },
  { id: 10, name: "Nadia Ferraro", email: "nadia.ferraro@northwind-outdoors.example", isActive: true },
  { id: 11, name: "Grant Ishikawa", email: "grant.ishikawa@northwind-outdoors.example", isActive: true },
  // Resolved one by one after /api/user came back without them: these two are
  // the service accounts behind the dbt job and the weekly digest script.
  { id: 41, name: "API key user 41", email: "api-key-41@api-key.invalid", isActive: true },
  { id: 57, name: "API key user 57", email: "api-key-57@api-key.invalid", isActive: true },
  { id: SAMPLE_USER_ID, name: "Sample User", email: "sample@metabase.example", isActive: false },
];

const DANA = 3;
const MARCUS = 4;
const PRIYA = 5;
const ELLIS = 6;
const ROSA = 7;
const HENRIK = 8;
const JAMIE = 9;
const NADIA = 10;
const GRANT = 11;
const BOT_DBT = 41;
const BOT_DIGEST = 57;

/** `[id, name, parent id, path]`. Parents come first so paths read in order. */
const COLLECTIONS = [
  [2, "Finance", null, "Finance"],
  [3, "Archive", 2, "Finance / Archive"],
  [4, "Growth", null, "Growth"],
  [5, "Experiments", 4, "Growth / Experiments"],
  [6, "Ops", null, "Ops"],
  [7, "Support", null, "Support"],
  [8, "Board", null, "Board"],
  [9, "Data Team", null, "Data Team"],
  [10, "Scratch", 9, "Data Team / Scratch"],
  [11, "Personal", null, "Personal"],
  [12, "Priya Natarajan", 11, "Personal / Priya Natarajan"],
];

const COLLECTION_ID_BY_PATH = new Map(COLLECTIONS.map(([id, , , p]) => [p, id]));

/** Who saves things in which folder, when a question does not name an author. */
const DEFAULT_OWNER = {
  Finance: ROSA,
  "Finance / Archive": ROSA,
  Growth: MARCUS,
  "Growth / Experiments": ELLIS,
  Ops: HENRIK,
  Support: JAMIE,
  Board: DANA,
  "Data Team / Scratch": PRIYA,
  "Personal / Priya Natarajan": PRIYA,
};

// ───────────────────────────── the question library ─────────────────────────

/**
 * Usage bands. `cold` and `dead` are what the audit calls stale; `unknown` is a
 * question Metabase has no timestamp for (it predates `last_used_at`), and
 * `ghost` is one nobody has ever opened.
 */
const USAGE_BANDS = {
  hot: { used: [1, 27], views: [45, 380], age: [40, 900] },
  warm: { used: [31, 86], views: [9, 70], age: [70, 1050] },
  cold: { used: [96, 176], views: [2, 34], age: [210, 1200] },
  dead: { used: [190, 690], views: [0, 16], age: [420, 1440] },
  unknown: { used: null, views: [1, 9], age: [520, 1430] },
  ghost: { used: null, views: [0, 0], age: [160, 900] },
};

function nat(def) {
  return { ...def, queryType: "native" };
}

function gui(def) {
  return { ...def, queryType: "query" };
}

/*
 * Exact duplicate families. Same query, copied and lightly edited: reindented,
 * commented, pointed at a different start date, run through the formatter. The
 * normalizer collapses all of that, which is the point.
 */
const DUP_NET_REVENUE_A = `SELECT
  date_trunc('day', o.placed_at) AS order_day,
  count(DISTINCT o.id) AS orders,
  sum(o.total_amount) AS gross_revenue,
  sum(o.total_amount - o.discount_amount) AS net_revenue
FROM orders o
WHERE o.status NOT IN ('cancelled', 'fraud')
  AND o.placed_at >= '2026-06-18'
GROUP BY 1
ORDER BY 1 DESC`;

const DUP_NET_REVENUE_B = `-- copied from Dana, keep in sync with the Finance version
select date_trunc('day', o.placed_at) as order_day,
       count(distinct o.id) as orders,
       sum(o.total_amount) as gross_revenue,
       sum(o.total_amount - o.discount_amount) as net_revenue
  from orders o
 where o.status not in ('cancelled', 'fraud')
   and o.placed_at >= '2026-01-01'
 group by 1
 order by 1 desc`;

const DUP_NET_REVENUE_C = `/* standup version, same numbers as Finance runs on Monday */
SELECT DATE_TRUNC('day', o.placed_at) AS order_day, COUNT(DISTINCT o.id) AS orders, SUM(o.total_amount) AS gross_revenue, SUM(o.total_amount - o.discount_amount) AS net_revenue
FROM orders o
WHERE o.status NOT IN ('cancelled', 'fraud') AND o.placed_at >= '2025-01-01'
GROUP BY 1
ORDER BY 1 DESC`;

const DUP_REFUND_RATE_A = `WITH refunded AS (
  SELECT oi.product_id, sum(r.amount) AS refunded_amount
  FROM refunds r
  JOIN orders o ON o.id = r.order_id
  JOIN order_items oi ON oi.order_id = o.id
  WHERE r.refunded_at >= current_date - interval '30 days'
  GROUP BY 1
)
SELECT p.category,
       sum(oi.line_total) AS sold_amount,
       coalesce(sum(refunded.refunded_amount), 0) AS refunded_amount,
       round(100.0 * coalesce(sum(refunded.refunded_amount), 0) / nullif(sum(oi.line_total), 0), 2) AS refund_rate_pct
FROM order_items oi
JOIN products p ON p.id = oi.product_id
LEFT JOIN refunded ON refunded.product_id = oi.product_id
WHERE oi.created_at >= current_date - interval '30 days'
GROUP BY 1
ORDER BY 4 DESC`;

const DUP_REFUND_RATE_B = `with refunded as (select oi.product_id, sum(r.amount) as refunded_amount
from refunds r
join orders o on o.id = r.order_id
join order_items oi on oi.order_id = o.id
where r.refunded_at >= current_date - interval '90 days'
group by 1)
select p.category, sum(oi.line_total) as sold_amount, coalesce(sum(refunded.refunded_amount), 0) as refunded_amount,
round(100.0 * coalesce(sum(refunded.refunded_amount), 0) / nullif(sum(oi.line_total), 0), 2) as refund_rate_pct
from order_items oi
join products p on p.id = oi.product_id
left join refunded on refunded.product_id = oi.product_id
where oi.created_at >= current_date - interval '90 days'
group by 1
order by 4 desc`;

const DUP_NEW_SUBS_A = `SELECT date_trunc('week', s.started_at) AS week_start,
       s.plan_code,
       count(*) AS new_subscribers,
       sum(s.mrr_amount) AS new_mrr
FROM subscriptions s
WHERE s.started_at >= '2025-01-01'
  AND s.status <> 'trialing'
GROUP BY 1, 2
ORDER BY 1 DESC, 4 DESC`;

const DUP_NEW_SUBS_B = `SELECT
    date_trunc('week', s.started_at) AS week_start,
    s.plan_code,
    count(*) AS new_subscribers,
    sum(s.mrr_amount) AS new_mrr
FROM subscriptions s
WHERE s.started_at >= '2026-01-01' AND s.status <> 'trialing'
GROUP BY 1, 2
ORDER BY 1 DESC, 4 DESC`;

const DUP_NEW_SUBS_C = `-- for the growth review, do not edit
select date_trunc('week', s.started_at) as week_start, s.plan_code, count(*) as new_subscribers, sum(s.mrr_amount) as new_mrr
from subscriptions s
where s.started_at >= '2024-06-01' and s.status <> 'trialing'
group by 1, 2
order by 1 desc, 4 desc`;

const DUP_NEW_SUBS_D = `SELECT date_trunc('week', s.started_at) AS week_start, s.plan_code, count(*) AS new_subscribers, sum(s.mrr_amount) AS new_mrr
FROM subscriptions s
WHERE s.started_at >= '2023-01-01'
  AND s.status <> 'trialing'
GROUP BY 1, 2
ORDER BY 1 DESC, 4 DESC`;

const DUP_TICKETS_PER_1K_A = `WITH monthly_tickets AS (
  SELECT date_trunc('month', t.opened_at) AS month, count(*) AS tickets
  FROM support_tickets t
  GROUP BY 1
), monthly_orders AS (
  SELECT date_trunc('month', o.placed_at) AS month, count(*) AS orders
  FROM orders o
  GROUP BY 1
)
SELECT monthly_tickets.month,
       monthly_tickets.tickets,
       monthly_orders.orders,
       round(1000.0 * monthly_tickets.tickets / nullif(monthly_orders.orders, 0), 1) AS tickets_per_1k_orders
FROM monthly_tickets
JOIN monthly_orders ON monthly_orders.month = monthly_tickets.month
ORDER BY 1 DESC`;

const DUP_TICKETS_PER_1K_B = `with monthly_tickets as (
    select date_trunc('month', t.opened_at) as month, count(*) as tickets
    from support_tickets t
    group by 1
),
monthly_orders as (
    select date_trunc('month', o.placed_at) as month, count(*) as orders
    from orders o
    group by 1
)
select monthly_tickets.month, monthly_tickets.tickets, monthly_orders.orders,
       round(1000.0 * monthly_tickets.tickets / nullif(monthly_orders.orders, 0), 1) as tickets_per_1k_orders
from monthly_tickets
join monthly_orders on monthly_orders.month = monthly_tickets.month
order by 1 desc`;

const DUP_TOP_PRODUCTS_A = `SELECT p.sku,
       p.title,
       p.category,
       sum(oi.quantity) AS units,
       sum(oi.line_total) AS revenue
FROM order_items oi
JOIN products p ON p.id = oi.product_id
JOIN orders o ON o.id = oi.order_id
WHERE o.placed_at >= current_date - interval '90 days'
  AND o.status NOT IN ('cancelled', 'fraud')
GROUP BY 1, 2, 3
ORDER BY 4 DESC
LIMIT 50`;

const DUP_TOP_PRODUCTS_B = `select p.sku, p.title, p.category, sum(oi.quantity) as units, sum(oi.line_total) as revenue
from order_items oi
join products p on p.id = oi.product_id
join orders o on o.id = oi.order_id
where o.placed_at >= current_date - interval '30 days' and o.status not in ('cancelled', 'fraud')
group by 1, 2, 3
order by 4 desc
limit 25`;

const DUP_TOP_PRODUCTS_C = `-- merchandising asked for this one, same as the ops version
SELECT
  p.sku, p.title, p.category,
  sum(oi.quantity) AS units,
  sum(oi.line_total) AS revenue
FROM order_items oi
  JOIN products p ON p.id = oi.product_id
  JOIN orders o ON o.id = oi.order_id
WHERE o.placed_at >= current_date - interval '180 days'
  AND o.status NOT IN ('cancelled', 'fraud')
GROUP BY 1, 2, 3
ORDER BY 4 DESC
LIMIT 100`;

const DUP_CAC_A = `WITH spend AS (
  SELECT a.channel, date_trunc('month', a.spend_date) AS month, sum(a.spend_amount) AS spend
  FROM ad_spend a
  GROUP BY 1, 2
), acquired AS (
  SELECT c.signup_source AS channel, date_trunc('month', c.created_at) AS month, count(*) AS customers
  FROM customers c
  WHERE c.first_order_at IS NOT NULL
  GROUP BY 1, 2
)
SELECT spend.month,
       spend.channel,
       spend.spend,
       acquired.customers,
       round(spend.spend / nullif(acquired.customers, 0), 2) AS cac
FROM spend
LEFT JOIN acquired ON acquired.channel = spend.channel AND acquired.month = spend.month
ORDER BY 1 DESC, 3 DESC`;

const DUP_CAC_B = `with spend as (
  select a.channel, date_trunc('month', a.spend_date) as month, sum(a.spend_amount) as spend
  from ad_spend a group by 1, 2
), acquired as (
  select c.signup_source as channel, date_trunc('month', c.created_at) as month, count(*) as customers
  from customers c where c.first_order_at is not null group by 1, 2
)
select spend.month, spend.channel, spend.spend, acquired.customers,
       round(spend.spend / nullif(acquired.customers, 0), 2) as cac
from spend
left join acquired on acquired.channel = spend.channel and acquired.month = spend.month
order by 1 desc, 3 desc`;

const DUP_CONVERSION_A = `SELECT s.device_type,
       count(DISTINCT s.id) AS sessions,
       count(DISTINCT o.id) AS orders,
       round(100.0 * count(DISTINCT o.id) / nullif(count(DISTINCT s.id), 0), 2) AS conversion_pct
FROM sessions s
LEFT JOIN orders o
  ON o.customer_id = s.customer_id
 AND o.placed_at BETWEEN s.started_at AND s.started_at + interval '1 day'
WHERE s.started_at >= '2026-07-01'
GROUP BY 1
ORDER BY 2 DESC`;

const DUP_CONVERSION_B = `/* rebuilt after the tracking fix, numbers match the growth version */
SELECT s.device_type, count(DISTINCT s.id) AS sessions, count(DISTINCT o.id) AS orders,
  round(100.0 * count(DISTINCT o.id) / nullif(count(DISTINCT s.id), 0), 2) AS conversion_pct
FROM sessions s
LEFT JOIN orders o ON o.customer_id = s.customer_id AND o.placed_at BETWEEN s.started_at AND s.started_at + interval '1 day'
WHERE s.started_at >= '2026-04-01'
GROUP BY 1
ORDER BY 2 DESC`;

/**
 * The question library. `k` is a stable key so dashboards can name their cards;
 * `t` is the usage band; `c` the collection path (null means the question sits
 * loose in "Our analytics"); `u` overrides the collection's default owner.
 */
const CARD_DEFS = [
  // ── exact duplicate group 1: the daily revenue query, copied three ways ───
  nat({
    k: "net_rev_day",
    born: 1160,
    n: "Net revenue by day, last 90 days",
    d: "Gross and net revenue per day, cancellations and fraud excluded. The number Finance reports.",
    c: "Finance",
    u: ROSA,
    t: "hot",
    v: 2380,
    display: "line",
    sql: DUP_NET_REVENUE_A,
  }),
  nat({
    k: "net_rev_day_copy",
    born: 760,
    n: "Net revenue by day (copy)",
    d: null,
    c: "Growth",
    u: MARCUS,
    t: "warm",
    display: "line",
    sql: DUP_NET_REVENUE_B,
  }),
  nat({
    k: "net_rev_day_standup",
    born: 520,
    n: "Daily revenue for standup",
    d: null,
    c: "Ops",
    u: HENRIK,
    t: "cold",
    display: "table",
    sql: DUP_NET_REVENUE_C,
  }),

  // ── exact duplicate group 2 ───────────────────────────────────────────────
  nat({
    k: "refund_rate",
    born: 950,
    n: "Refund rate by product category, trailing 30d",
    d: "Refunded amount over sold amount per category. Merchandising reviews this every Thursday.",
    c: "Finance",
    u: ROSA,
    t: "hot",
    v: 1120,
    display: "bar",
    sql: DUP_REFUND_RATE_A,
  }),
  nat({
    k: "refund_rate_archive",
    born: 720,
    n: "Refund rate by category (2025 version)",
    d: null,
    c: "Finance / Archive",
    u: NADIA,
    t: "dead",
    display: "bar",
    sql: DUP_REFUND_RATE_B,
  }),

  // ── exact duplicate group 3: four copies of the weekly signup query ───────
  nat({
    k: "new_subs_weekly",
    born: 1010,
    n: "New subscribers by plan (weekly)",
    d: "New paid subscriptions and the MRR they bring, by plan and week.",
    c: "Growth",
    u: MARCUS,
    t: "hot",
    v: 860,
    display: "bar",
    sql: DUP_NEW_SUBS_A,
  }),
  nat({
    k: "new_subs_weekly_copy",
    born: 690,
    n: "New subscribers by plan (copy)",
    d: null,
    c: "Growth / Experiments",
    u: ELLIS,
    t: "cold",
    display: "bar",
    sql: DUP_NEW_SUBS_B,
  }),
  nat({
    k: "new_subs_weekly_v2",
    born: 750,
    n: "new_subscribers_by_plan_v2",
    d: null,
    c: "Data Team / Scratch",
    u: PRIYA,
    t: "dead",
    display: "table",
    sql: DUP_NEW_SUBS_C,
  }),
  nat({
    k: "new_subs_weekly_loose",
    born: 470,
    n: "Copy of New subscribers by plan",
    d: null,
    c: null,
    u: NADIA,
    t: "unknown",
    display: "bar",
    sql: DUP_NEW_SUBS_D,
  }),

  // ── exact duplicate group 4 ───────────────────────────────────────────────
  nat({
    k: "tickets_per_1k",
    born: 900,
    n: "Support tickets per 1k orders",
    d: "Contact rate. Support uses it to argue for headcount, Ops uses it to argue about packaging.",
    c: "Support",
    u: JAMIE,
    t: "hot",
    v: 410,
    display: "line",
    sql: DUP_TICKETS_PER_1K_A,
  }),
  nat({
    k: "tickets_per_1k_ops",
    born: 505,
    n: "Contact rate per 1k orders (Ops)",
    d: null,
    c: "Ops",
    u: HENRIK,
    t: "warm",
    display: "line",
    sql: DUP_TICKETS_PER_1K_B,
  }),

  // ── exact duplicate group 5 ───────────────────────────────────────────────
  nat({
    k: "top_products",
    born: 940,
    n: "Top products by units sold, last 90 days",
    d: "Units and revenue per SKU. Feeds the restock conversation.",
    c: "Ops",
    u: HENRIK,
    t: "warm",
    v: 240,
    display: "table",
    sql: DUP_TOP_PRODUCTS_A,
  }),
  nat({
    k: "top_products_30d",
    born: 600,
    n: "Best sellers, last 30 days",
    d: null,
    c: "Growth",
    u: ELLIS,
    t: "cold",
    display: "table",
    sql: DUP_TOP_PRODUCTS_B,
  }),
  nat({
    k: "top_products_merch",
    born: 730,
    n: "Top SKUs for merchandising",
    d: null,
    c: null,
    u: NADIA,
    t: "dead",
    display: "table",
    sql: DUP_TOP_PRODUCTS_C,
  }),

  // ── exact duplicate group 6 ───────────────────────────────────────────────
  nat({
    k: "cac_by_channel",
    born: 880,
    n: "Ad spend vs new customers by channel",
    d: "Monthly spend against acquired customers, with blended CAC per channel.",
    c: "Growth",
    u: ELLIS,
    t: "cold",
    v: 190,
    display: "table",
    sql: DUP_CAC_A,
  }),
  nat({
    k: "cac_by_channel_copy",
    born: 760,
    n: "CAC by channel (working copy)",
    d: null,
    c: "Growth / Experiments",
    u: MARCUS,
    t: "dead",
    display: "table",
    sql: DUP_CAC_B,
  }),

  // ── exact duplicate group 7 ───────────────────────────────────────────────
  nat({
    k: "session_conversion",
    born: 830,
    n: "Session to order conversion by device",
    d: "Sessions that turned into an order within a day, split by device.",
    c: "Growth",
    u: MARCUS,
    t: "warm",
    v: 205,
    display: "bar",
    sql: DUP_CONVERSION_A,
  }),
  nat({
    k: "session_conversion_rebuilt",
    born: 390,
    n: "Device conversion (rebuilt after tracking fix)",
    d: null,
    c: "Data Team / Scratch",
    u: PRIYA,
    t: "cold",
    display: "bar",
    sql: DUP_CONVERSION_B,
  }),

  // ── same name, different query: MRR ───────────────────────────────────────
  nat({
    k: "mrr_board",
    n: "MRR",
    d: "Monthly recurring revenue from the subscription mart. The board number.",
    c: "Board",
    u: DANA,
    t: "hot",
    v: 1640,
    display: "smartscalar",
    sql: `SELECT m.month_start,
       sum(m.mrr_amount) AS mrr
FROM dbt_marts.fct_subscription_mrr m
WHERE m.is_active
  AND m.month_start >= date '2024-01-01'
GROUP BY 1
ORDER BY 1`,
  }),
  nat({
    k: "mrr_finance",
    n: "MRR",
    d: "Same metric read straight off the subscriptions table. Finance prefers this one at close.",
    c: "Finance",
    u: ROSA,
    t: "warm",
    v: 96,
    display: "scalar",
    sql: `SELECT sum(s.mrr_amount) AS mrr,
       count(*) AS active_subscriptions
FROM subscriptions s
WHERE s.status IN ('active', 'past_due')`,
  }),
  nat({
    k: "mrr_scratch",
    n: "MRR",
    d: null,
    c: "Data Team / Scratch",
    u: PRIYA,
    t: "dead",
    display: "line",
    sql: `SELECT date_trunc('month', e.occurred_at) AS month,
       sum(sum(e.mrr_delta)) OVER (ORDER BY date_trunc('month', e.occurred_at)) AS running_mrr
FROM subscription_events e
GROUP BY 1
ORDER BY 1`,
  }),

  // ── same name: Active Subscribers ─────────────────────────────────────────
  nat({
    k: "active_subs_sql",
    n: "Active Subscribers",
    d: "Paying subscribers, trials excluded.",
    c: "Board",
    u: DANA,
    t: "hot",
    v: 540,
    display: "scalar",
    sql: `SELECT count(*) AS active_subscribers
FROM subscriptions s
WHERE s.status = 'active'
  AND s.trial_ends_at < now()`,
  }),
  gui({
    k: "active_subs_gui",
    n: "Active Subscribers",
    d: null,
    c: "Growth",
    u: NADIA,
    t: "warm",
    display: "scalar",
    src: "subscriptions",
  }),

  // ── same name: Weekly Revenue ─────────────────────────────────────────────
  nat({
    k: "weekly_revenue_mart",
    n: "Weekly Revenue",
    d: "Net revenue by ISO week from the daily revenue mart.",
    c: "Finance",
    u: ROSA,
    t: "hot",
    v: 940,
    display: "bar",
    sql: `SELECT date_trunc('week', r.revenue_date) AS week_start,
       sum(r.gross_revenue) AS gross_revenue,
       sum(r.refund_amount) AS refunds,
       sum(r.net_revenue) AS net_revenue
FROM dbt_marts.fct_revenue_daily r
WHERE r.revenue_date >= current_date - interval '26 weeks'
GROUP BY 1
ORDER BY 1`,
  }),
  nat({
    k: "weekly_revenue_orders",
    n: "Weekly Revenue",
    d: null,
    c: "Ops",
    u: HENRIK,
    t: "cold",
    display: "line",
    sql: `SELECT date_trunc('week', o.placed_at) AS week_start,
       sum(o.total_amount) AS revenue
FROM orders o
WHERE o.placed_at >= current_date - interval '1 year'
GROUP BY 1
ORDER BY 1`,
  }),
  gui({
    k: "weekly_revenue_gui",
    n: "Weekly Revenue",
    d: null,
    c: "Growth / Experiments",
    u: ELLIS,
    t: "dead",
    display: "bar",
    src: "fct_orders",
  }),

  // ── same name: Churn Rate ─────────────────────────────────────────────────
  nat({
    k: "churn_rate_sub",
    n: "Churn Rate",
    d: "Cancelled subscriptions over active ones at the start of the month.",
    c: "Board",
    u: DANA,
    t: "warm",
    v: 430,
    display: "line",
    sql: `WITH monthly AS (
  SELECT date_trunc('month', s.cancelled_at) AS month,
         count(*) FILTER (WHERE s.cancelled_at IS NOT NULL) AS cancelled,
         count(*) AS total
  FROM subscriptions s
  GROUP BY 1
)
SELECT month,
       cancelled,
       total,
       round(100.0 * cancelled / nullif(total, 0), 2) AS churn_pct
FROM monthly
WHERE month IS NOT NULL
ORDER BY 1 DESC`,
  }),
  nat({
    k: "churn_rate_events",
    n: "Churn rate",
    d: null,
    c: "Growth",
    u: MARCUS,
    t: "cold",
    display: "line",
    sql: `SELECT date_trunc('month', e.occurred_at) AS month,
       count(*) FILTER (WHERE e.event_type = 'cancelled') AS cancellations,
       count(*) FILTER (WHERE e.event_type = 'reactivated') AS reactivations
FROM subscription_events e
WHERE e.occurred_at >= '2025-01-01'
GROUP BY 1
ORDER BY 1 DESC`,
  }),

  // ── same name: Orders by Channel, two query builder questions ─────────────
  gui({
    k: "orders_by_channel_raw",
    n: "Orders by Channel",
    d: null,
    c: "Ops",
    u: HENRIK,
    t: "warm",
    display: "pie",
    src: "orders",
  }),
  gui({
    k: "orders_by_channel_mart",
    n: "Orders by channel",
    d: "Order counts per acquisition channel from the order fact table.",
    c: "Growth",
    u: MARCUS,
    t: "hot",
    display: "bar",
    src: "fct_orders",
  }),

  // ── broken: tables that were dropped or renamed ───────────────────────────
  nat({
    k: "broken_2022_close",
    n: "Revenue by month (2022 close)",
    d: "Kept for the 2022 audit trail.",
    c: "Finance / Archive",
    u: ROSA,
    t: "dead",
    display: "table",
    sql: `SELECT date_trunc('month', placed_at) AS month,
       sum(total_amount) AS revenue
FROM orders_2022
GROUP BY 1
ORDER BY 1`,
  }),
  nat({
    k: "broken_legacy_subs",
    n: "Subscriptions imported from the old billing system",
    d: null,
    c: "Data Team / Scratch",
    u: PRIYA,
    t: "dead",
    display: "table",
    sql: `SELECT ls.customer_id,
       ls.plan_name,
       ls.started_at,
       c.email
FROM legacy_subscriptions ls
JOIN customers c ON c.id = ls.customer_id
WHERE ls.migrated_at IS NULL`,
  }),
  nat({
    k: "broken_mart_rename",
    n: "Daily net revenue (mart)",
    d: "Board version of the daily revenue line.",
    c: "Board",
    u: GRANT,
    t: "cold",
    display: "line",
    sql: `SELECT r.revenue_date,
       r.channel,
       r.net_revenue
FROM dbt_marts.fct_revenue r
WHERE r.revenue_date >= current_date - interval '90 days'
ORDER BY 1 DESC`,
  }),
  nat({
    k: "broken_ltv_mart",
    n: "Support tickets by customer tier",
    d: "Ticket volume split by lifetime value tier.",
    c: "Support",
    u: JAMIE,
    t: "cold",
    display: "bar",
    sql: `SELECT ltv.tier,
       count(t.id) AS tickets,
       round(avg(t.reopened_count), 2) AS avg_reopens
FROM support_tickets t
JOIN customer_ltv_mart ltv ON ltv.customer_id = t.customer_id
WHERE t.opened_at >= current_date - interval '180 days'
GROUP BY 1
ORDER BY 2 DESC`,
  }),

  // ── syntax that looks broken to a naive parser and is not ─────────────────
  nat({
    k: "trap_distinct_from",
    n: "Order volume excluding gifts, weekly",
    d: "Gift orders are billed differently, so they are left out of the volume line.",
    c: "Ops",
    u: HENRIK,
    t: "hot",
    display: "bar",
    sql: `SELECT date_trunc('week', o.placed_at) AS week_start,
       count(*) AS orders,
       sum(o.total_amount) AS revenue
FROM orders o
WHERE o.is_gift IS DISTINCT FROM TRUE
  AND o.status NOT IN ('cancelled', 'fraud')
GROUP BY 1
ORDER BY 1 DESC`,
  }),
  nat({
    k: "trap_extract_epoch",
    n: "Time to first response, minutes",
    d: "Median and 90th percentile of the wait before a customer hears back.",
    c: "Support",
    u: JAMIE,
    t: "warm",
    display: "table",
    sql: `SELECT t.priority,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM t.first_response_at - t.opened_at) / 60)) AS p50_minutes,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM t.first_response_at - t.opened_at) / 60)) AS p90_minutes,
       count(*) AS tickets
FROM support_tickets t
WHERE t.first_response_at IS NOT NULL
  AND t.opened_at >= current_date - interval '90 days'
GROUP BY 1
ORDER BY 3 DESC`,
  }),
  nat({
    k: "trap_generate_series",
    n: "Orders per day with empty days filled in",
    d: null,
    c: null,
    u: HENRIK,
    t: "cold",
    display: "line",
    sql: `SELECT day::date AS order_day,
       coalesce(count(o.id), 0) AS orders
FROM generate_series (date '2026-06-01', date '2026-09-15', interval '1 day') AS day
LEFT JOIN orders o ON o.placed_at::date = day::date
GROUP BY 1
ORDER BY 1`,
  }),
  nat({
    k: "trap_cte_periods",
    n: "Renewal rate by billing period",
    d: "How many subscriptions survive each renewal, by period index.",
    c: "Growth",
    u: MARCUS,
    t: "warm",
    display: "bar",
    sql: `WITH periods AS (
  SELECT p.subscription_id,
         p.period_index,
         p.was_renewed
  FROM dbt_marts.int_subscription_periods p
  WHERE p.period_start >= date '2025-01-01'
)
SELECT periods.period_index,
       count(*) AS periods_started,
       count(*) FILTER (WHERE periods.was_renewed) AS renewed,
       round(100.0 * count(*) FILTER (WHERE periods.was_renewed) / nullif(count(*), 0), 1) AS renewal_pct
FROM periods
JOIN subscriptions s ON s.id = periods.subscription_id
GROUP BY 1
ORDER BY 1`,
  }),
  nat({
    k: "trap_quoted_alias",
    n: "Trial share of new revenue",
    d: null,
    c: "Finance",
    u: ROSA,
    t: "cold",
    display: "table",
    sql: `SELECT date_trunc('month', s.started_at) AS month,
       sum(s.mrr_amount) FILTER (WHERE s.trial_ends_at IS NOT NULL) AS "Revenue from Trials",
       sum(s.mrr_amount) AS "Revenue from All Plans"
FROM subscriptions s
WHERE s.started_at >= '2025-07-01'
GROUP BY 1
ORDER BY 1 DESC`,
  }),

  // ── quoting variants that must stay separate questions ────────────────────
  nat({
    k: "rows_loaded_orders",
    n: "Rows loaded today, orders",
    d: null,
    c: "Data Team / Scratch",
    u: BOT_DBT,
    t: "hot",
    display: "scalar",
    sql: `SELECT count(*) AS rows_loaded
FROM "public"."orders"
WHERE updated_at >= current_date`,
  }),
  nat({
    k: "rows_loaded_customers",
    n: "Rows loaded today, customers",
    d: null,
    c: "Data Team / Scratch",
    u: BOT_DBT,
    t: "hot",
    display: "scalar",
    sql: `SELECT count(*) AS rows_loaded
FROM "public"."customers"
WHERE updated_at >= current_date`,
  }),
  nat({
    k: "order_count_schema_qualified",
    n: "Daily order count (schema qualified)",
    d: null,
    c: "Data Team / Scratch",
    u: PRIYA,
    t: "unknown",
    display: "line",
    sql: `SELECT date_trunc('day', placed_at) AS order_day, count(*) AS orders
FROM "public"."orders"
GROUP BY 1
ORDER BY 1 DESC`,
  }),
  nat({
    k: "order_count_plain",
    n: "Daily order count",
    d: null,
    c: null,
    u: HENRIK,
    t: "warm",
    display: "line",
    sql: `SELECT date_trunc('day', placed_at) AS order_day, count(*) AS orders
FROM orders
GROUP BY 1
ORDER BY 1 DESC`,
  }),

  // ── finance ───────────────────────────────────────────────────────────────
  nat({
    k: "gross_margin",
    n: "Gross margin by month",
    d: "Revenue less product cost, from line items and the product catalogue.",
    c: "Finance",
    u: ROSA,
    t: "warm",
    display: "line",
    sql: `SELECT date_trunc('month', o.placed_at) AS month,
       sum(oi.line_total) AS revenue,
       sum(oi.quantity * p.unit_cost) AS product_cost,
       round(100.0 * (sum(oi.line_total) - sum(oi.quantity * p.unit_cost)) / nullif(sum(oi.line_total), 0), 1) AS margin_pct
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN products p ON p.id = oi.product_id
WHERE o.status NOT IN ('cancelled', 'fraud')
  AND o.placed_at >= '2025-01-01'
GROUP BY 1
ORDER BY 1`,
  }),
  nat({
    k: "net_rev_channel",
    n: "Net revenue by channel, month to date",
    d: "Channel split for the current month, straight from the daily revenue mart.",
    c: "Finance",
    u: ROSA,
    t: "hot",
    display: "bar",
    sql: `SELECT r.channel,
       sum(r.gross_revenue) AS gross_revenue,
       sum(r.refund_amount) AS refunds,
       sum(r.net_revenue) AS net_revenue
FROM dbt_marts.fct_revenue_daily r
WHERE r.revenue_date >= date_trunc('month', current_date)
GROUP BY 1
ORDER BY 4 DESC`,
  }),
  nat({
    k: "refunds_by_reason",
    n: "Refunds issued by reason, last 12 months",
    d: null,
    c: "Finance",
    u: ROSA,
    t: "warm",
    display: "bar",
    sql: `SELECT date_trunc('month', r.refunded_at) AS month,
       r.reason,
       count(*) AS refunds,
       sum(r.amount) AS refunded_amount
FROM refunds r
WHERE r.refunded_at >= current_date - interval '12 months'
GROUP BY 1, 2
ORDER BY 1 DESC, 4 DESC`,
  }),
  nat({
    k: "payment_failures",
    n: "Payment failures by processor",
    d: "Declines and errors per processor, with the failure codes behind them.",
    c: "Finance",
    u: ROSA,
    t: "cold",
    display: "table",
    sql: `SELECT p.processor,
       p.failure_code,
       count(*) AS failures,
       sum(p.amount) AS amount_at_risk
FROM payments p
WHERE p.status = 'failed'
  AND p.created_at >= current_date - interval '60 days'
GROUP BY 1, 2
ORDER BY 3 DESC`,
  }),
  nat({
    k: "deferred_rev",
    n: "Deferred revenue from annual plans",
    d: null,
    c: "Finance",
    u: NADIA,
    t: "dead",
    display: "table",
    sql: `SELECT s.plan_code,
       count(*) AS annual_subscriptions,
       sum(s.mrr_amount * 12) AS billed_amount,
       sum(s.mrr_amount * extract(month FROM age(s.current_period_end, current_date))) AS deferred_amount
FROM subscriptions s
WHERE s.billing_interval = 'annual'
  AND s.status = 'active'
GROUP BY 1
ORDER BY 3 DESC`,
  }),
  nat({
    k: "aov",
    n: "Average order value by month",
    d: "AOV on completed orders. Subscription boxes are counted as orders.",
    c: "Finance",
    u: ROSA,
    t: "hot",
    display: "line",
    sql: `SELECT date_trunc('month', o.placed_at) AS month,
       count(*) AS orders,
       round(avg(o.total_amount), 2) AS aov,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY o.total_amount), 2) AS median_order
FROM orders o
WHERE o.status NOT IN ('cancelled', 'fraud')
  AND o.placed_at >= '2024-01-01'
GROUP BY 1
ORDER BY 1`,
  }),
  nat({
    k: "cash_vs_recognized",
    n: "Revenue recognized vs cash collected",
    d: null,
    c: "Finance",
    u: GRANT,
    t: "cold",
    display: "line",
    sql: `WITH recognized AS (
  SELECT date_trunc('month', r.revenue_date) AS month, sum(r.net_revenue) AS recognized
  FROM dbt_marts.fct_revenue_daily r
  GROUP BY 1
), collected AS (
  SELECT date_trunc('month', p.captured_at) AS month, sum(p.amount) AS collected
  FROM payments p
  WHERE p.status = 'captured'
  GROUP BY 1
)
SELECT recognized.month, recognized.recognized, collected.collected,
       recognized.recognized - collected.collected AS gap
FROM recognized
JOIN collected ON collected.month = recognized.month
ORDER BY 1 DESC`,
  }),
  nat({
    k: "tax_state",
    n: "Tax collected by state, quarterly",
    d: "Filing support. Do not change the rounding without asking Finance.",
    c: "Finance",
    u: ROSA,
    t: "cold",
    display: "table",
    sql: `SELECT date_trunc('quarter', o.placed_at) AS quarter,
       c.state,
       sum(o.tax_amount) AS tax_collected,
       count(*) AS orders
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.country = 'US'
  AND o.status NOT IN ('cancelled', 'fraud')
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC`,
  }),
  nat({
    k: "discount_leak",
    n: "Discount leakage by coupon code",
    d: "Which codes are still live and what they cost per order.",
    c: "Finance",
    u: ROSA,
    t: "cold",
    display: "table",
    sql: `SELECT o.coupon_code,
       count(*) AS orders,
       sum(o.discount_amount) AS discount_given,
       round(avg(o.discount_amount / nullif(o.subtotal_amount, 0)) * 100, 1) AS avg_discount_pct
FROM orders o
WHERE o.coupon_code IS NOT NULL
  AND o.placed_at >= current_date - interval '180 days'
GROUP BY 1
HAVING count(*) > 25
ORDER BY 3 DESC`,
  }),
  nat({
    k: "rev_region",
    n: "Revenue by store region, trailing 12 months",
    d: "Where the revenue comes from. Regions follow the warehouse map, not the shipping address.",
    c: "Finance",
    u: ROSA,
    t: "warm",
    display: "map",
    sql: `SELECT f.store_region,
       sum(f.net_revenue) AS net_revenue,
       count(*) AS orders
FROM dbt_marts.fct_orders f
WHERE f.order_date >= current_date - interval '12 months'
GROUP BY 1
ORDER BY 2 DESC`,
  }),

  // ── growth ────────────────────────────────────────────────────────────────
  nat({
    k: "new_customers",
    n: "New customers by acquisition source (monthly)",
    d: "First order counts as acquisition. Matches the CAC model.",
    c: "Growth",
    u: MARCUS,
    t: "hot",
    display: "bar",
    sql: `SELECT date_trunc('month', c.first_order_at) AS month,
       c.signup_source,
       count(*) AS new_customers
FROM customers c
WHERE c.first_order_at >= '2025-01-01'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC`,
  }),
  nat({
    k: "paid_organic",
    n: "Paid vs organic revenue split",
    d: "Paid covers search, social and display. Everything else counts as organic.",
    c: "Growth",
    u: MARCUS,
    t: "cold",
    display: "area",
    sql: `SELECT date_trunc('week', f.order_date) AS week_start,
       CASE WHEN f.channel IN ('paid_search', 'paid_social', 'display') THEN 'paid' ELSE 'organic' END AS bucket,
       sum(f.net_revenue) AS net_revenue
FROM dbt_marts.fct_orders f
WHERE f.order_date >= current_date - interval '6 months'
GROUP BY 1, 2
ORDER BY 1 DESC`,
  }),
  nat({
    k: "cac_payback",
    n: "CAC payback by cohort month",
    d: "Months of gross margin needed to earn back acquisition cost.",
    c: "Growth",
    u: ELLIS,
    t: "dead",
    display: "table",
    sql: `WITH cohort AS (
  SELECT date_trunc('month', c.first_order_at) AS cohort_month,
         count(*) AS customers,
         sum(d.lifetime_revenue) AS revenue
  FROM customers c
  JOIN dbt_marts.dim_customers d ON d.customer_id = c.id
  WHERE c.first_order_at >= '2024-01-01'
  GROUP BY 1
), spend AS (
  SELECT date_trunc('month', a.spend_date) AS cohort_month, sum(a.spend_amount) AS spend
  FROM ad_spend a
  GROUP BY 1
)
SELECT cohort.cohort_month,
       cohort.customers,
       round(spend.spend / nullif(cohort.customers, 0), 2) AS cac,
       round(cohort.revenue / nullif(cohort.customers, 0), 2) AS revenue_per_customer
FROM cohort
JOIN spend ON spend.cohort_month = cohort.cohort_month
ORDER BY 1 DESC`,
  }),
  nat({
    k: "campaign_perf",
    n: "Campaign performance, last 28 days",
    d: "Spend, clicks and click through rate per campaign for the last four weeks.",
    c: "Growth",
    u: ELLIS,
    t: "dead",
    display: "table",
    sql: `SELECT c.name,
       c.platform,
       sum(a.impressions) AS impressions,
       sum(a.clicks) AS clicks,
       sum(a.spend_amount) AS spend,
       round(100.0 * sum(a.clicks) / nullif(sum(a.impressions), 0), 2) AS ctr_pct
FROM ad_spend a
JOIN campaigns c ON c.id = a.campaign_id
WHERE a.spend_date >= current_date - interval '28 days'
GROUP BY 1, 2
ORDER BY 5 DESC`,
  }),
  nat({
    k: "landing_conv",
    n: "Landing page to signup conversion",
    d: "Sessions that ended in a new account, by the page the visitor landed on.",
    c: "Growth",
    u: MARCUS,
    t: "warm",
    display: "table",
    sql: `SELECT s.landing_path,
       count(DISTINCT s.id) AS sessions,
       count(DISTINCT c.id) AS signups,
       round(100.0 * count(DISTINCT c.id) / nullif(count(DISTINCT s.id), 0), 2) AS signup_pct
FROM sessions s
LEFT JOIN customers c ON c.id = s.customer_id AND c.created_at::date = s.started_at::date
WHERE s.started_at >= current_date - interval '30 days'
GROUP BY 1
HAVING count(DISTINCT s.id) > 500
ORDER BY 4 DESC`,
  }),
  nat({
    k: "email_capture",
    n: "Email capture rate by device",
    d: null,
    c: "Growth / Experiments",
    u: ELLIS,
    t: "dead",
    display: "bar",
    sql: `SELECT s.device_type,
       count(DISTINCT s.id) AS sessions,
       count(DISTINCT e.session_id) FILTER (WHERE e.event_name = 'email_captured') AS captures
FROM sessions s
LEFT JOIN events e ON e.session_id = s.id
WHERE s.started_at >= current_date - interval '45 days'
GROUP BY 1
ORDER BY 2 DESC`,
  }),
  nat({
    k: "trial_to_paid",
    n: "Trial to paid conversion by plan",
    d: "Share of trials that billed at least once, by plan.",
    c: "Growth",
    u: MARCUS,
    t: "hot",
    display: "bar",
    sql: `SELECT s.plan_code,
       count(*) AS trials,
       count(*) FILTER (WHERE s.status IN ('active', 'past_due')) AS converted,
       round(100.0 * count(*) FILTER (WHERE s.status IN ('active', 'past_due')) / nullif(count(*), 0), 1) AS conversion_pct
FROM subscriptions s
WHERE s.trial_ends_at IS NOT NULL
  AND s.trial_ends_at < current_date
  AND s.started_at >= '2025-06-01'
GROUP BY 1
ORDER BY 4 DESC`,
  }),
  nat({
    k: "repeat_purchase",
    n: "Repeat purchase rate within 60 days",
    d: null,
    c: "Growth",
    u: PRIYA,
    t: "dead",
    display: "line",
    sql: `WITH first_orders AS (
  SELECT o.customer_id, min(o.placed_at) AS first_at
  FROM orders o
  WHERE o.status NOT IN ('cancelled', 'fraud')
  GROUP BY 1
)
SELECT date_trunc('month', first_orders.first_at) AS cohort_month,
       count(*) AS customers,
       count(*) FILTER (WHERE o.placed_at <= first_orders.first_at + interval '60 days' AND o.placed_at > first_orders.first_at) AS repeated
FROM first_orders
JOIN orders o ON o.customer_id = first_orders.customer_id
GROUP BY 1
ORDER BY 1 DESC`,
  }),
  nat({
    k: "first_order_value",
    n: "First order value by acquisition source",
    d: null,
    c: "Growth / Experiments",
    u: ELLIS,
    t: "cold",
    display: "bar",
    sql: `SELECT d.signup_source,
       count(*) AS customers,
       round(avg(f.gross_revenue), 2) AS avg_first_order
FROM dbt_marts.fct_orders f
JOIN dbt_marts.dim_customers d ON d.customer_id = f.customer_id
WHERE f.is_first_order
GROUP BY 1
ORDER BY 3 DESC`,
  }),
  nat({
    k: "ad_efficiency",
    n: "Ad spend efficiency by platform",
    d: null,
    c: "Growth",
    u: ELLIS,
    t: "dead",
    display: "table",
    sql: `SELECT a.platform,
       sum(a.spend_amount) AS spend,
       sum(a.clicks) AS clicks,
       round(sum(a.spend_amount) / nullif(sum(a.clicks), 0), 2) AS cost_per_click
FROM ad_spend a
WHERE a.spend_date >= current_date - interval '90 days'
GROUP BY 1
ORDER BY 2 DESC`,
  }),

  // ── subscriptions ─────────────────────────────────────────────────────────
  nat({
    k: "mrr_movement",
    n: "MRR movement (new, expansion, churn)",
    d: "The waterfall behind the MRR line. Expansion counts plan upgrades only.",
    c: "Growth",
    u: MARCUS,
    t: "dead",
    display: "bar",
    sql: `SELECT date_trunc('month', e.occurred_at) AS month,
       sum(e.mrr_delta) FILTER (WHERE e.event_type = 'created') AS new_mrr,
       sum(e.mrr_delta) FILTER (WHERE e.event_type = 'upgraded') AS expansion_mrr,
       sum(e.mrr_delta) FILTER (WHERE e.event_type IN ('downgraded', 'cancelled')) AS churned_mrr
FROM subscription_events e
WHERE e.occurred_at >= '2025-01-01'
GROUP BY 1
ORDER BY 1 DESC`,
  }),
  nat({
    k: "churned_mrr",
    n: "Churned MRR by plan, last 6 months",
    d: null,
    c: "Growth",
    u: MARCUS,
    t: "dead",
    display: "bar",
    sql: `SELECT e.from_plan,
       date_trunc('month', e.occurred_at) AS month,
       sum(abs(e.mrr_delta)) AS churned_mrr
FROM subscription_events e
WHERE e.event_type = 'cancelled'
  AND e.occurred_at >= current_date - interval '6 months'
GROUP BY 1, 2
ORDER BY 2 DESC, 3 DESC`,
  }),
  nat({
    k: "plan_mix",
    n: "Plan mix over time",
    d: "Subscriptions and MRR per plan, month by month.",
    c: "Growth",
    u: MARCUS,
    t: "cold",
    display: "area",
    sql: `SELECT m.month_start,
       m.plan_code,
       count(DISTINCT m.subscription_id) AS subscriptions,
       sum(m.mrr_amount) AS mrr
FROM dbt_marts.fct_subscription_mrr m
WHERE m.is_active
GROUP BY 1, 2
ORDER BY 1 DESC, 4 DESC`,
  }),
  nat({
    k: "active_by_interval",
    n: "Active subscriptions by billing interval",
    d: "Monthly against annual, in subscriptions and in MRR.",
    c: "Growth",
    u: NADIA,
    t: "warm",
    display: "pie",
    sql: `SELECT s.billing_interval,
       count(*) AS subscriptions,
       sum(s.mrr_amount) AS mrr
FROM subscriptions s
WHERE s.status = 'active'
GROUP BY 1
ORDER BY 2 DESC`,
  }),
  nat({
    k: "trial_starts",
    n: "Trial starts by week",
    d: "Trials opened per week. The conversion question sits next to it.",
    c: "Growth",
    u: ELLIS,
    t: "cold",
    display: "line",
    sql: `SELECT date_trunc('week', s.started_at) AS week_start,
       count(*) AS trials_started
FROM subscriptions s
WHERE s.trial_ends_at IS NOT NULL
  AND s.started_at >= current_date - interval '1 year'
GROUP BY 1
ORDER BY 1 DESC`,
  }),
  nat({
    k: "reactivations",
    n: "Reactivations per month",
    d: null,
    c: "Growth",
    u: MARCUS,
    t: "dead",
    display: "line",
    sql: `SELECT date_trunc('month', e.occurred_at) AS month,
       count(*) AS reactivations,
       sum(e.mrr_delta) AS recovered_mrr
FROM subscription_events e
WHERE e.event_type = 'reactivated'
GROUP BY 1
ORDER BY 1 DESC`,
  }),

  // ── operations ────────────────────────────────────────────────────────────
  nat({
    k: "same_day_ship",
    n: "Orders shipped same day, by warehouse",
    d: "Share of orders that leave the building the day they are placed.",
    c: "Ops",
    u: HENRIK,
    t: "hot",
    display: "bar",
    sql: `SELECT s.warehouse_code,
       count(*) AS shipments,
       count(*) FILTER (WHERE s.shipped_at::date = o.placed_at::date) AS same_day,
       round(100.0 * count(*) FILTER (WHERE s.shipped_at::date = o.placed_at::date) / nullif(count(*), 0), 1) AS same_day_pct
FROM shipments s
JOIN orders o ON o.id = s.order_id
WHERE s.shipped_at >= current_date - interval '30 days'
GROUP BY 1
ORDER BY 4 DESC`,
  }),
  nat({
    k: "late_deliveries",
    n: "Late deliveries by carrier",
    d: "Deliveries that arrived after the promised date, by carrier and service level.",
    c: "Ops",
    u: HENRIK,
    t: "hot",
    display: "table",
    sql: `SELECT s.carrier,
       s.service_level,
       count(*) AS deliveries,
       count(*) FILTER (WHERE s.delivered_at > s.promised_at) AS late,
       round(100.0 * count(*) FILTER (WHERE s.delivered_at > s.promised_at) / nullif(count(*), 0), 1) AS late_pct
FROM shipments s
WHERE s.delivered_at IS NOT NULL
  AND s.shipped_at >= current_date - interval '60 days'
GROUP BY 1, 2
ORDER BY 5 DESC`,
  }),
  nat({
    k: "lead_time",
    n: "Fulfillment lead time, p50 and p90",
    d: null,
    c: "Ops",
    u: HENRIK,
    t: "warm",
    display: "table",
    sql: `SELECT s.warehouse_code,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM s.shipped_at - o.placed_at) / 3600), 1) AS p50_hours,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM s.shipped_at - o.placed_at) / 3600), 1) AS p90_hours
FROM shipments s
JOIN orders o ON o.id = s.order_id
WHERE s.shipped_at >= current_date - interval '90 days'
GROUP BY 1
ORDER BY 3 DESC`,
  }),
  nat({
    k: "inventory_reorder",
    n: "Inventory below reorder point",
    d: "Anything at or under its reorder point, worst first. Checked every morning.",
    c: "Ops",
    u: HENRIK,
    t: "hot",
    display: "table",
    sql: `SELECT p.sku,
       p.title,
       i.warehouse_code,
       i.on_hand,
       i.reserved,
       i.reorder_point,
       i.on_hand - i.reserved AS available
FROM inventory i
JOIN products p ON p.id = i.product_id
WHERE i.on_hand - i.reserved <= i.reorder_point
  AND p.is_active
ORDER BY 7`,
  }),
  nat({
    k: "stockouts",
    n: "Stockouts by product category",
    d: "SKUs with nothing on hand, grouped by category.",
    c: "Ops",
    u: HENRIK,
    t: "warm",
    display: "bar",
    sql: `SELECT p.category,
       count(*) FILTER (WHERE i.on_hand = 0) AS stocked_out_skus,
       count(*) AS skus
FROM inventory i
JOIN products p ON p.id = i.product_id
WHERE p.is_active
GROUP BY 1
ORDER BY 2 DESC`,
  }),
  nat({
    k: "backorder",
    n: "Backordered units by week",
    d: null,
    c: "Ops",
    u: HENRIK,
    t: "cold",
    display: "line",
    sql: `SELECT date_trunc('week', o.placed_at) AS week_start,
       sum(oi.quantity) AS backordered_units
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN inventory i ON i.product_id = oi.product_id
WHERE i.on_hand < oi.quantity
  AND o.status = 'awaiting_stock'
GROUP BY 1
ORDER BY 1 DESC`,
  }),
  nat({
    k: "ship_cost",
    n: "Shipping cost per order by service level",
    d: "What each service level costs us per shipment, last 90 days.",
    c: "Ops",
    u: HENRIK,
    t: "warm",
    display: "bar",
    sql: `SELECT s.service_level,
       count(*) AS shipments,
       round(avg(s.cost_amount), 2) AS avg_cost,
       round(sum(s.cost_amount), 2) AS total_cost
FROM shipments s
WHERE s.shipped_at >= current_date - interval '90 days'
GROUP BY 1
ORDER BY 4 DESC`,
  }),

  // ── support ───────────────────────────────────────────────────────────────
  nat({
    k: "tickets_weekly",
    n: "Tickets by category, weekly",
    d: "Volume per category. Shipping questions spike whenever a carrier misses a promise.",
    c: "Support",
    u: JAMIE,
    t: "hot",
    display: "area",
    sql: `SELECT date_trunc('week', t.opened_at) AS week_start,
       t.category,
       count(*) AS tickets
FROM support_tickets t
WHERE t.opened_at >= current_date - interval '16 weeks'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC`,
  }),
  nat({
    k: "backlog",
    n: "Ticket backlog by day",
    d: "Open and resolved tickets per day. Used in the Monday support standup.",
    c: "Support",
    u: JAMIE,
    t: "hot",
    display: "line",
    sql: `SELECT date_trunc('day', t.opened_at) AS day,
       count(*) FILTER (WHERE t.status IN ('open', 'pending')) AS open_tickets,
       count(*) FILTER (WHERE t.resolved_at IS NOT NULL) AS resolved_tickets
FROM support_tickets t
WHERE t.opened_at >= current_date - interval '45 days'
GROUP BY 1
ORDER BY 1 DESC`,
  }),
  nat({
    k: "tickets_per_agent",
    n: "Tickets per agent, last 30 days",
    d: "Volume and average time to resolve per agent.",
    c: "Support",
    u: JAMIE,
    t: "warm",
    display: "row",
    sql: `SELECT t.assigned_to,
       count(*) AS tickets,
       count(*) FILTER (WHERE t.resolved_at IS NOT NULL) AS resolved,
       round(avg(EXTRACT(epoch FROM t.resolved_at - t.opened_at) / 3600), 1) AS avg_hours_to_resolve
FROM support_tickets t
WHERE t.opened_at >= current_date - interval '30 days'
GROUP BY 1
ORDER BY 2 DESC`,
  }),
  nat({
    k: "reopened",
    n: "Reopened tickets share",
    d: null,
    c: "Support",
    u: JAMIE,
    t: "cold",
    display: "line",
    sql: `SELECT date_trunc('month', t.opened_at) AS month,
       count(*) AS tickets,
       count(*) FILTER (WHERE t.reopened_count > 0) AS reopened,
       round(100.0 * count(*) FILTER (WHERE t.reopened_count > 0) / nullif(count(*), 0), 1) AS reopened_pct
FROM support_tickets t
WHERE t.opened_at >= '2025-01-01'
GROUP BY 1
ORDER BY 1 DESC`,
  }),

  // ── product and behaviour ─────────────────────────────────────────────────
  nat({
    k: "sessions_device_week",
    n: "Sessions by device and week",
    d: "Session counts by device, twelve weeks back.",
    c: "Growth",
    u: PRIYA,
    t: "warm",
    display: "area",
    sql: `SELECT date_trunc('week', s.started_at) AS week_start,
       s.device_type,
       count(*) AS sessions
FROM sessions s
WHERE s.started_at >= current_date - interval '12 weeks'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC`,
  }),
  nat({
    k: "cart_dropoff",
    n: "Add to cart to checkout drop-off",
    d: "Where the funnel loses people between the cart and the payment step.",
    c: "Growth / Experiments",
    u: PRIYA,
    t: "warm",
    display: "funnel",
    sql: `SELECT e.event_name,
       count(DISTINCT e.session_id) AS sessions
FROM events e
WHERE e.event_name IN ('product_viewed', 'add_to_cart', 'checkout_started', 'payment_submitted')
  AND e.occurred_at >= current_date - interval '14 days'
GROUP BY 1
ORDER BY 2 DESC`,
  }),
  nat({
    k: "search_purchase",
    n: "Search to purchase rate",
    d: null,
    c: "Growth / Experiments",
    u: PRIYA,
    t: "dead",
    display: "scalar",
    sql: `SELECT count(DISTINCT e.session_id) FILTER (WHERE e.event_name = 'search_performed') AS searched,
       count(DISTINCT e.session_id) FILTER (WHERE e.event_name = 'order_completed') AS purchased
FROM events e
WHERE e.occurred_at >= current_date - interval '30 days'`,
  }),
  nat({
    k: "event_volume",
    n: "Event volume by name, last 7 days",
    d: null,
    c: "Data Team / Scratch",
    u: PRIYA,
    t: "cold",
    display: "row",
    sql: `SELECT e.event_name,
       count(*) AS events,
       count(DISTINCT e.session_id) AS sessions
FROM events e
WHERE e.occurred_at >= current_date - interval '7 days'
GROUP BY 1
ORDER BY 2 DESC
LIMIT 30`,
  }),

  // ── exec and company wide ─────────────────────────────────────────────────
  nat({
    k: "north_star",
    n: "Weekly active subscribers",
    d: "The north star: subscribers who received or opened a box in the week.",
    c: "Board",
    u: DANA,
    t: "hot",
    v: 1180,
    display: "line",
    sql: `SELECT date_trunc('week', o.placed_at) AS week_start,
       count(DISTINCT s.customer_id) AS active_subscribers
FROM subscriptions s
JOIN orders o ON o.customer_id = s.customer_id
WHERE s.status = 'active'
  AND o.placed_at >= current_date - interval '26 weeks'
GROUP BY 1
ORDER BY 1 DESC`,
  }),
  nat({
    k: "run_rate",
    n: "Revenue run rate",
    d: "Trailing 90 days annualised. The number that goes in the board deck.",
    c: "Board",
    u: DANA,
    t: "hot",
    v: 720,
    display: "scalar",
    sql: `SELECT round(sum(r.net_revenue) * 4, 2) AS annualised_run_rate
FROM dbt_marts.fct_revenue_daily r
WHERE r.revenue_date >= current_date - interval '90 days'`,
  }),
  nat({
    k: "nps_month",
    n: "NPS by month",
    d: "Promoters minus detractors, per month. Responses come from the post delivery survey.",
    c: "Board",
    u: NADIA,
    t: "warm",
    display: "line",
    sql: `SELECT date_trunc('month', n.responded_at) AS month,
       count(*) AS responses,
       round(100.0 * (count(*) FILTER (WHERE n.score >= 9) - count(*) FILTER (WHERE n.score <= 6)) / nullif(count(*), 0), 1) AS nps
FROM nps_responses n
WHERE n.responded_at >= '2025-01-01'
GROUP BY 1
ORDER BY 1 DESC`,
  }),
  nat({
    k: "nps_detractors",
    n: "NPS detractor comments, last 30 days",
    d: null,
    c: "Board",
    u: NADIA,
    t: "dead",
    display: "table",
    sql: `SELECT n.responded_at,
       n.score,
       n.survey_channel,
       n.comment
FROM nps_responses n
WHERE n.score <= 6
  AND n.comment IS NOT NULL
  AND n.responded_at >= current_date - interval '30 days'
ORDER BY 1 DESC`,
  }),
  nat({
    k: "customers_country",
    n: "Customers by country and state",
    d: null,
    c: "Board",
    u: GRANT,
    t: "cold",
    display: "map",
    sql: `SELECT c.country,
       c.state,
       count(*) AS customers,
       count(*) FILTER (WHERE c.first_order_at IS NOT NULL) AS buyers
FROM customers c
GROUP BY 1, 2
ORDER BY 3 DESC`,
  }),
  nat({
    k: "cohort_retention",
    n: "Cohort retention by signup month",
    d: "Classic triangle. Month 0 is the signup month.",
    c: "Data Team / Scratch",
    u: PRIYA,
    t: "dead",
    display: "table",
    sql: `WITH cohorts AS (
  SELECT c.id AS customer_id,
         date_trunc('month', c.created_at) AS cohort_month
  FROM customers c
  WHERE c.created_at >= '2024-01-01'
)
SELECT cohorts.cohort_month,
       extract(month FROM age(o.placed_at, cohorts.cohort_month)) AS months_since_signup,
       count(DISTINCT o.customer_id) AS customers
FROM cohorts
JOIN orders o ON o.customer_id = cohorts.customer_id
GROUP BY 1, 2
ORDER BY 1 DESC, 2`,
  }),
  nat({
    k: "orders_per_customer",
    n: "Orders per customer distribution",
    d: null,
    c: "Data Team / Scratch",
    u: PRIYA,
    t: "dead",
    display: "bar",
    sql: `SELECT d.lifetime_orders,
       count(*) AS customers
FROM dbt_marts.dim_customers d
WHERE d.lifetime_orders > 0
GROUP BY 1
ORDER BY 1`,
  }),

  // ── service accounts ──────────────────────────────────────────────────────
  nat({
    k: "dbt_freshness",
    n: "Mart freshness check",
    d: "Latest date present in each mart. The dbt job opens this after every run.",
    c: "Data Team / Scratch",
    u: BOT_DBT,
    t: "hot",
    display: "table",
    sql: `SELECT 'fct_revenue_daily' AS model, max(r.revenue_date)::text AS latest
FROM dbt_marts.fct_revenue_daily r
UNION ALL
SELECT 'fct_orders', max(f.order_date)::text
FROM dbt_marts.fct_orders f
UNION ALL
SELECT 'fct_subscription_mrr', max(m.month_start)::text
FROM dbt_marts.fct_subscription_mrr m`,
  }),
  nat({
    k: "dbt_row_deltas",
    n: "Row count delta, orders vs fct_orders",
    d: null,
    c: "Data Team / Scratch",
    u: BOT_DBT,
    t: "warm",
    display: "table",
    sql: `SELECT (SELECT count(*) FROM orders) AS source_rows,
       (SELECT count(*) FROM dbt_marts.fct_orders) AS mart_rows,
       (SELECT count(*) FROM orders) - (SELECT count(*) FROM dbt_marts.fct_orders) AS delta`,
  }),
  nat({
    k: "digest_weekly_numbers",
    n: "Weekly digest numbers",
    d: "Feeds the Monday email. Do not rename, the script looks it up by name.",
    c: null,
    u: BOT_DIGEST,
    t: "hot",
    display: "table",
    sql: `SELECT sum(r.net_revenue) AS net_revenue,
       sum(r.orders_count) AS orders,
       (SELECT count(*) FROM subscriptions s WHERE s.status = 'active') AS active_subscriptions
FROM dbt_marts.fct_revenue_daily r
WHERE r.revenue_date >= current_date - interval '7 days'`,
  }),

  // ── models ────────────────────────────────────────────────────────────────
  nat({
    k: "model_customer_360",
    n: "Customer 360",
    d: "Curated model: one row per customer with orders, subscription state and support history.",
    c: "Data Team",
    u: DANA,
    t: "warm",
    type: "model",
    display: "table",
    sql: `SELECT d.customer_id,
       d.email,
       d.country,
       d.lifetime_orders,
       d.lifetime_revenue,
       d.current_plan,
       count(t.id) AS support_tickets
FROM dbt_marts.dim_customers d
LEFT JOIN support_tickets t ON t.customer_id = d.customer_id
GROUP BY 1, 2, 3, 4, 5, 6`,
  }),
  nat({
    k: "model_order_lines",
    n: "Order lines with product attributes",
    d: "Curated model: line items joined to the product dimension, for ad hoc analysis.",
    c: "Data Team",
    u: MARCUS,
    t: "warm",
    type: "model",
    display: "table",
    sql: `SELECT oi.id AS order_item_id,
       oi.order_id,
       o.placed_at,
       o.channel,
       p.category,
       p.brand,
       oi.quantity,
       oi.line_total
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN dbt_marts.dim_products p ON p.product_id = oi.product_id`,
  }),

  // ── loose questions nobody filed ──────────────────────────────────────────
  nat({
    k: "loose_sku_check",
    n: "SKU spot check for the Tuesday call",
    d: null,
    c: null,
    u: NADIA,
    t: "unknown",
    display: "table",
    sql: `SELECT p.sku, p.title, p.list_price, i.on_hand
FROM products p
JOIN inventory i ON i.product_id = p.id
WHERE p.sku IN ('NW-TENT-2P', 'NW-BAG-45L', 'NW-STOVE-TI')`,
  }),
  nat({
    k: "loose_duplicate_emails",
    n: "Duplicate customer emails",
    d: null,
    c: null,
    u: DANA,
    t: "ghost",
    display: "table",
    sql: `SELECT lower(c.email) AS email, count(*) AS accounts
FROM customers c
GROUP BY 1
HAVING count(*) > 1
ORDER BY 2 DESC`,
  }),

  // ── archived, kept out of the audit but present in the instance ───────────
  nat({
    k: "arch_2023_kpi",
    n: "2023 KPI sheet (superseded)",
    d: null,
    c: "Finance / Archive",
    u: ROSA,
    t: "dead",
    archived: true,
    display: "table",
    sql: `SELECT date_trunc('month', placed_at) AS month, count(*) AS orders, sum(total_amount) AS revenue
FROM orders
WHERE placed_at BETWEEN '2023-01-01' AND '2023-12-31'
GROUP BY 1
ORDER BY 1`,
  }),
  nat({
    k: "arch_black_friday",
    n: "Black Friday 2024 hourly sales",
    d: null,
    c: "Finance / Archive",
    u: MARCUS,
    t: "dead",
    archived: true,
    display: "line",
    sql: `SELECT date_trunc('hour', o.placed_at) AS hour, count(*) AS orders, sum(o.total_amount) AS revenue
FROM orders o
WHERE o.placed_at BETWEEN '2024-11-29' AND '2024-12-02'
GROUP BY 1
ORDER BY 1`,
  }),
  gui({
    k: "arch_old_funnel",
    n: "Old signup funnel",
    d: null,
    c: "Growth / Experiments",
    u: ELLIS,
    t: "dead",
    archived: true,
    display: "funnel",
    src: "sessions",
  }),
  nat({
    k: "arch_test_query",
    n: "test query please ignore",
    d: null,
    c: "Data Team / Scratch",
    u: PRIYA,
    t: "dead",
    archived: true,
    display: "table",
    sql: `SELECT * FROM zz_test LIMIT 10`,
  }),

  // ── query builder questions ───────────────────────────────────────────────
  gui({ k: "g_orders_today", n: "Orders placed today", d: null, c: "Ops", t: "hot", display: "table", src: "orders" }),
  gui({ k: "g_open_tickets", n: "Open support tickets", d: "Everything not resolved, oldest first.", c: "Support", t: "hot", display: "table", src: "support_tickets" }),
  gui({ k: "g_products_no_inventory", n: "Products without an inventory record", d: null, c: "Ops", t: "cold", display: "table", src: "inventory" }),
  gui({ k: "g_subs_this_week", n: "Subscriptions started this week", d: null, c: "Growth", t: "hot", display: "scalar", src: "subscriptions" }),
  gui({ k: "g_big_refunds", n: "Refunds over 200 USD", d: null, c: null, u: ROSA, t: "warm", display: "table", src: "refunds" }),
  gui({ k: "g_sessions_device", n: "Sessions by device type", d: null, c: null, u: PRIYA, t: "warm", display: "pie", src: "sessions" }),
  gui({ k: "g_loyal_customers", n: "Customers with more than five orders", d: null, c: "Growth", t: "cold", display: "table", src: "dim_customers" }),
  gui({ k: "g_campaign_budgets", n: "Campaign list with budgets", d: null, c: "Growth / Experiments", t: "dead", display: "table", src: "campaigns" }),
  gui({ k: "g_awaiting_pickup", n: "Shipments awaiting carrier pickup", d: null, c: "Ops", t: "hot", display: "table", src: "shipments" }),
  gui({ k: "g_nps_quarter", n: "NPS responses this quarter", d: null, c: "Board", t: "warm", display: "table", src: "nps_responses" }),
  gui({ k: "g_payments_method", n: "Payments by method", d: null, c: "Finance", t: "warm", display: "pie", src: "payments" }),
  gui({ k: "g_inv_on_hand", n: "Inventory on hand by warehouse", d: null, c: "Ops", t: "hot", display: "bar", src: "inventory" }),
  gui({ k: "g_top_brands", n: "Top brands by revenue", d: null, c: "Growth", t: "warm", display: "row", src: "fct_orders" }),
  gui({ k: "g_daily_revenue_trend", n: "Daily revenue trend", d: null, c: "Finance", t: "hot", display: "line", src: "fct_revenue_daily" }),
  gui({ k: "g_cancelled_orders", n: "Cancelled orders this month", d: null, c: "Ops", t: "warm", display: "table", src: "orders" }),
  gui({ k: "g_acquired_by_source", n: "Customers acquired by source", d: null, c: "Growth", t: "cold", display: "bar", src: "dim_customers" }),
  gui({ k: "g_ticket_priority", n: "Ticket volume by priority", d: null, c: "Support", t: "warm", display: "bar", src: "support_tickets" }),
  gui({ k: "g_plan_mix", n: "Subscription plan mix", d: null, c: "Growth", t: "cold", display: "pie", src: "fct_subscription_mrr" }),
  gui({ k: "g_late_shipments", n: "Late shipments", d: null, c: "Ops", t: "warm", display: "table", src: "shipments" }),
  gui({ k: "g_gift_orders", n: "Gift orders", d: null, c: "Support", t: "unknown", display: "table", src: "orders" }),
  gui({ k: "g_paid_sessions", n: "Sessions from paid campaigns", d: null, c: "Growth / Experiments", t: "dead", display: "table", src: "sessions" }),
  gui({ k: "g_ad_spend_platform", n: "Ad spend by platform", d: null, c: "Growth", t: "cold", display: "bar", src: "ad_spend" }),
  gui({ k: "g_customers_no_order", n: "Customers without an order", d: null, c: "Growth", t: "dead", display: "table", src: "customers" }),
  gui({ k: "g_orders_region", n: "Orders by store region", d: null, c: "Board", t: "warm", display: "map", src: "fct_orders" }),
  gui({ k: "g_cancellations_month", n: "Subscription cancellations this month", d: null, c: "Growth", t: "hot", display: "scalar", src: "subscription_events" }),
  gui({ k: "g_below_reorder", n: "Products below reorder point", d: null, c: "Ops", t: "hot", display: "table", src: "inventory" }),
  gui({ k: "g_weekly_signups", n: "Weekly signups", d: null, c: null, u: MARCUS, t: "warm", display: "line", src: "customers" }),
  gui({ k: "g_order_status", n: "Order status breakdown", d: null, c: "Ops", t: "warm", display: "pie", src: "orders" }),
  gui({ k: "g_refund_reasons", n: "Refund reasons", d: null, c: "Support", t: "cold", display: "pie", src: "refunds" }),
  gui({ k: "g_failed_payments_today", n: "Failed payments today", d: null, c: null, u: ROSA, t: "hot", display: "table", src: "payments" }),
  gui({ k: "g_ltv_buckets", n: "Lifetime value buckets", d: null, c: "Growth", t: "dead", display: "bar", src: "dim_customers" }),
  gui({ k: "g_revenue_category", n: "Revenue by product category", d: null, c: "Finance", t: "warm", display: "bar", src: "fct_orders" }),
  gui({ k: "g_trials_expiring", n: "Trials expiring in the next seven days", d: null, c: null, u: NADIA, t: "hot", display: "table", src: "subscriptions" }),
  gui({ k: "g_tickets_assignee", n: "Tickets by assignee", d: null, c: "Support", t: "warm", display: "row", src: "support_tickets" }),
  gui({ k: "g_landing_paths", n: "Sessions by landing path", d: null, c: "Growth / Experiments", t: "dead", display: "table", src: "sessions" }),
  gui({ k: "g_mrr_by_plan", n: "Monthly MRR by plan", d: null, c: "Finance", t: "warm", display: "line", src: "fct_subscription_mrr" }),
  gui({ k: "g_reserved_vs_on_hand", n: "Reserved vs on hand", d: null, c: "Ops", t: "warm", display: "bar", src: "inventory" }),
  gui({ k: "g_priya_scratch_a", n: "Sessions from the app, September", d: null, c: "Personal / Priya Natarajan", t: "warm", display: "table", src: "sessions" }),
  gui({ k: "g_priya_scratch_b", n: "Subscription events, one customer", d: null, c: "Personal / Priya Natarajan", t: "cold", display: "table", src: "subscription_events" }),
  gui({ k: "g_priya_scratch_c", n: "Order items for the packaging test", d: null, c: "Personal / Priya Natarajan", t: "dead", display: "table", src: "order_items" }),
];

/** The Metabase demo content that ships with every install. */
const SAMPLE_CARD = {
  name: "E-commerce Insights, Sample Question",
  description: null,
  display: "bar",
  sql: `SELECT CATEGORY, count(*) AS COUNT FROM PRODUCTS GROUP BY CATEGORY`,
};

/**
 * Dashboards, by the question keys they hold. Status is not set here: it comes
 * out of the analyzer from the cards below. The comments say what each one is
 * meant to demonstrate.
 */
const DASHBOARD_DEFS = [
  {
    name: "Board KPIs",
    description: "What the board sees on Monday morning.",
    collection: "Board",
    creator: DANA,
    views: 2100,
    lastViewed: 1,
    created: 1180,
    cards: ["net_rev_day", "mrr_board", "aov", "new_customers", "churn_rate_sub", "nps_month", "north_star", "run_rate"],
  },
  {
    name: "Weekly Revenue",
    description: "Revenue detail behind the board number.",
    collection: "Finance",
    creator: ROSA,
    views: 640,
    lastViewed: 3,
    created: 900,
    cards: ["weekly_revenue_mart", "gross_margin", "net_rev_channel", "discount_leak", "tax_state", "rev_region"],
  },
  {
    name: "Subscription Health",
    description: "Built for the 2025 retention push.",
    collection: "Growth",
    creator: MARCUS,
    views: 310,
    lastViewed: 96,
    created: 760,
    cards: ["mrr_movement", "churned_mrr", "plan_mix", "trial_starts", "reactivations", "active_by_interval"],
  },
  {
    name: "Marketing Attribution",
    description: null,
    collection: "Growth",
    creator: ELLIS,
    views: 220,
    lastViewed: 142,
    created: 820,
    cards: ["paid_organic", "cac_payback", "campaign_perf", "ad_efficiency", "landing_conv"],
  },
  {
    name: "Ops Daily",
    description: "The warehouse standup screen.",
    collection: "Ops",
    creator: HENRIK,
    views: 480,
    lastViewed: 1,
    created: 640,
    cards: ["same_day_ship", "late_deliveries", "lead_time", "inventory_reorder", "backorder", "ship_cost"],
  },
  {
    name: "Support Overview",
    description: "Queue health and contact rate.",
    collection: "Support",
    creator: JAMIE,
    views: 190,
    lastViewed: 2,
    created: 520,
    cards: ["broken_ltv_mart", "tickets_weekly", "trap_extract_epoch", "backlog", "reopened"],
  },
  {
    name: "Cohorts 2023",
    description: null,
    collection: "Data Team / Scratch",
    creator: PRIYA,
    views: 95,
    lastViewed: 288,
    created: 1080,
    cards: ["cohort_retention", "repeat_purchase", "first_order_value", "orders_per_customer"],
  },
  {
    name: "Q3 Planning (old)",
    description: "Prepared for the Q3 2025 planning week.",
    collection: "Board",
    creator: NADIA,
    views: 60,
    lastViewed: 331,
    created: 430,
    cards: ["deferred_rev", "search_purchase", "event_volume"],
  },
  {
    name: "Priya scratch",
    description: null,
    collection: "Personal / Priya Natarajan",
    creator: PRIYA,
    views: 12,
    lastViewed: 34,
    created: 260,
    cards: [],
    detailsFetched: false,
  },
  {
    name: "Inventory",
    description: "Stock position, refreshed every 15 minutes.",
    collection: "Ops",
    creator: HENRIK,
    views: 150,
    lastViewed: 4,
    created: 390,
    cards: ["stockouts", "g_inv_on_hand", "g_reserved_vs_on_hand", "g_below_reorder"],
  },
  {
    name: "Executive Summary (legacy)",
    description: "Replaced by Board KPIs, still linked from the old wiki.",
    collection: "Board",
    creator: GRANT,
    views: 130,
    lastViewed: 77,
    created: 1250,
    cards: ["broken_mart_rename", "run_rate", "customers_country", "top_products", "nps_detractors", "payment_failures"],
  },
];

// ───────────────────────────── snapshot assembly ────────────────────────────

function buildCards(rng, tableIdByName) {
  const drafts = [];

  for (const def of CARD_DEFS) {
    const band = USAGE_BANDS[def.t];
    if (!band) throw new Error(`make-example: unknown usage band "${def.t}" on ${def.n}`);

    const usedDays = band.used === null ? null : intBetween(rng, band.used[0], band.used[1]);
    // `born` pins the save date. Copies of a question have to be younger than
    // the question they were copied from, or the ids read backwards.
    let ageDays = def.born ?? intBetween(rng, band.age[0], band.age[1]);
    // A question cannot have been opened before it was saved.
    if (usedDays !== null && ageDays < usedDays + 5) ageDays = usedDays + intBetween(rng, 5, 90);
    // Most questions are saved once and never touched again.
    const editedDays = rng() < 0.68 ? ageDays : intBetween(rng, Math.max(1, Math.floor(ageDays * 0.25)), ageDays);
    const views = def.v ?? intBetween(rng, band.views[0], band.views[1]);

    const collectionId = def.c === null || def.c === undefined ? null : COLLECTION_ID_BY_PATH.get(def.c);
    if (def.c && collectionId === undefined) throw new Error(`make-example: unknown collection "${def.c}"`);

    const sourceTableId = def.src ? tableIdByName.get(def.src) ?? null : null;
    if (def.src && sourceTableId === null) throw new Error(`make-example: unknown source table "${def.src}" on ${def.n}`);

    drafts.push({
      key: def.k,
      record: {
        id: 0,
        name: def.n,
        description: def.d ?? null,
        type: def.type ?? "question",
        queryType: def.queryType,
        display: def.display,
        databaseId: WAREHOUSE_DB,
        sourceTableId,
        sql: def.sql ?? null,
        sqlSource: def.sql ? "native" : null,
        collectionId: collectionId ?? null,
        creatorId: def.u ?? DEFAULT_OWNER[def.c] ?? DANA,
        createdAt: stampDaysAgo(rng, ageDays),
        updatedAt: stampDaysAgo(rng, editedDays),
        lastUsedAt: usedDays === null ? null : stampDaysAgo(rng, usedDays),
        viewCount: views,
        archived: def.archived === true,
        hasError: false,
      },
    });
  }

  // The demo question Metabase seeds on install, four years ago.
  drafts.push({
    key: "sample_card",
    record: {
      id: 0,
      name: SAMPLE_CARD.name,
      description: SAMPLE_CARD.description,
      type: "question",
      queryType: "native",
      display: SAMPLE_CARD.display,
      databaseId: SAMPLE_DB,
      sourceTableId: null,
      sql: SAMPLE_CARD.sql,
      sqlSource: "native",
      collectionId: null,
      creatorId: SAMPLE_USER_ID,
      createdAt: stampDaysAgo(rng, 1462),
      updatedAt: stampDaysAgo(rng, 1462),
      lastUsedAt: stampDaysAgo(rng, 1450),
      viewCount: 3,
      archived: false,
      hasError: false,
    },
  });

  // Metabase hands out ids in creation order, so the example does too.
  drafts.sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt) || a.key.localeCompare(b.key));
  const idByKey = new Map();
  drafts.forEach((draft, index) => {
    draft.record.id = 301 + index;
    idByKey.set(draft.key, draft.record.id);
  });

  return { cards: drafts.map((d) => d.record), idByKey };
}

function buildDashboards(rng, idByKey) {
  const dashboards = [];
  let id = 4400;

  for (const def of DASHBOARD_DEFS) {
    const cardIds = def.cards.map((key) => {
      const cardId = idByKey.get(key);
      if (cardId === undefined) throw new Error(`make-example: dashboard "${def.name}" names unknown question "${key}"`);
      return cardId;
    });
    dashboards.push({
      id: ++id,
      name: def.name,
      description: def.description ?? null,
      collectionId: COLLECTION_ID_BY_PATH.get(def.collection) ?? null,
      creatorId: def.creator,
      createdAt: stampDaysAgo(rng, def.created),
      updatedAt: stampDaysAgo(rng, Math.max(1, Math.round(def.created * 0.4))),
      lastViewedAt: stampDaysAgo(rng, def.lastViewed),
      viewCount: def.views,
      archived: false,
      cardIds,
    });
  }

  dashboards.push({
    id: ++id,
    name: "E-commerce Insights",
    description: "Metabase sample dashboard.",
    collectionId: null,
    creatorId: SAMPLE_USER_ID,
    createdAt: stampDaysAgo(rng, 1462),
    updatedAt: stampDaysAgo(rng, 1462),
    lastViewedAt: null,
    viewCount: 1,
    archived: false,
    cardIds: [idByKey.get("sample_card")],
  });

  return dashboards;
}

function buildSnapshotDocument() {
  const rng = makeRng(SEED);
  const { tables, tableIdByName } = buildTables();
  const { cards, idByKey } = buildCards(rng, tableIdByName);
  const dashboards = buildDashboards(rng, idByKey);

  const detailsFetched = DASHBOARD_DEFS.filter((d) => d.detailsFetched !== false).length + 1;

  return {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    instance: { ...INSTANCE },
    databases: [
      { id: WAREHOUSE_DB, name: "Warehouse", engine: "postgres", isSample: false },
      { id: SAMPLE_DB, name: "Sample Database", engine: "h2", isSample: true },
    ],
    tables,
    cards,
    dashboards,
    collections: COLLECTIONS.map(([id, name, parentId, path]) => ({
      id,
      name,
      parentId,
      path,
      archived: false,
    })),
    users: USERS.map((u) => ({ ...u })),
    meta: {
      dashboardDetailsFetched: detailsFetched,
      dashboardDetailsCap: 300,
      usersFetched: true,
      extraUsersFetched: 2,
      compiledCards: 0,
      activityBackfill: false,
      warnings: [
        "Could not fetch dashboard 4409 (Priya scratch): HTTP 403 You do not have permission to see that.",
      ],
    },
  };
}

// ───────────────────────────── self checks ──────────────────────────────────

/**
 * The example exists to show what the tool finds, so a change that quietly
 * stops finding it should fail here rather than in a screenshot. These are the
 * numbers the README and the landing page quote.
 */
function verify(snapshot, findings) {
  const problems = [];
  const exact = findings.duplicates.filter((g) => g.kind === "exact-sql");
  const sameName = findings.duplicates.filter((g) => g.kind === "same-name");

  if (exact.length !== 7) problems.push(`expected 7 exact-SQL duplicate groups, got ${exact.length}`);
  if (sameName.length !== 5) problems.push(`expected 5 same-name duplicate groups, got ${sameName.length}`);
  if (findings.broken.length !== 4) problems.push(`expected 4 broken questions, got ${findings.broken.length}`);
  if (findings.summary.healthScore < 32 || findings.summary.healthScore > 50) {
    problems.push(`expected a health score between 32 and 50, got ${findings.summary.healthScore}`);
  }
  if (findings.stale.length <= 50) {
    problems.push(`expected more than 50 stale questions so the report caps the table, got ${findings.stale.length}`);
  }
  if (findings.creators.length !== 11) problems.push(`expected 11 owners, got ${findings.creators.length}`);

  const statuses = new Set(findings.dashboards.map((d) => d.status));
  for (const status of ["healthy", "warning", "broken", "unknown"]) {
    if (!statuses.has(status)) problems.push(`expected at least one ${status} dashboard`);
  }

  // Every trap has to stay out of the broken list: these are valid queries that
  // a regex-based parser reports as missing tables.
  const brokenIds = new Set(findings.broken.map((b) => b.id));
  const trapNames = snapshot.cards
    .filter((c) => brokenIds.has(c.id))
    .map((c) => c.name)
    .filter((name) => !/2022 close|old billing system|Daily net revenue|customer tier/.test(name));
  if (trapNames.length > 0) problems.push(`these questions should not be broken: ${trapNames.join(", ")}`);

  if (problems.length > 0) {
    throw new Error(`make-example: the generated instance no longer matches its contract:\n- ${problems.join("\n- ")}`);
  }
}

// ───────────────────────────── entry point ──────────────────────────────────

/**
 * Writes the example into `outDir` and returns the findings plus the paths.
 * The temporary `.metalens-tmp` working folder is removed before returning.
 */
export async function generateExample({ outDir = path.join(ROOT, "examples") } = {}) {
  const out = path.resolve(outDir);
  const tmp = path.join(out, ".metalens-tmp");

  const snapshot = buildSnapshotDocument();
  const snapshotPath = await saveSnapshot(snapshot, out);

  const { findings, paths } = await runScan({
    snapshotFile: snapshotPath,
    dir: tmp,
    out,
    now: NOW,
  });

  verify(snapshot, findings);

  const findingsPath = path.join(out, FINDINGS_FILENAME);
  await copyFile(path.join(tmp, FINDINGS_FILENAME), findingsPath);
  await rm(tmp, { recursive: true, force: true });

  return {
    snapshot,
    findings,
    paths: {
      snapshot: path.join(out, SNAPSHOT_FILENAME),
      findings: findingsPath,
      report: paths.report,
      context: paths.context,
    },
  };
}

function parseOutFlag(argv) {
  const index = argv.indexOf("--out");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--out needs a directory");
  return value;
}

async function main() {
  const outDir = parseOutFlag(process.argv.slice(2));
  const { snapshot, findings, paths } = await generateExample(outDir ? { outDir } : {});
  const s = findings.summary;
  process.stdout.write(
    [
      `Example instance: ${snapshot.instance.siteName} (${snapshot.cards.length} questions, ${snapshot.dashboards.length} dashboards, ${snapshot.tables.length} tables)`,
      `Findings: health ${s.healthGrade} (${s.healthScore}/100), ${s.duplicateGroups} duplicate groups, ${s.brokenCards} broken, ${s.staleCards90} stale, ${s.anomalies} anomalies`,
      `Written: ${path.relative(ROOT, paths.snapshot)}, ${path.relative(ROOT, paths.findings)}, ${path.relative(ROOT, paths.report)}, ${path.relative(ROOT, paths.context)}`,
      "",
    ].join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
