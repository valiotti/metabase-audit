/**
 * Table usage and instance-level anomalies.
 *
 * Usage answers "which tables does this Metabase actually read", which is what
 * turns a 900-table warehouse into a 40-table core model. GUI questions declare
 * their source table, native questions have to be parsed.
 *
 * Differences from the SaaS, on purpose:
 *  - the dbt/artifact table name filter is not ported. This tool reports the
 *    warehouse as it is; hiding `stg_*` and `not_null_*` tables belongs in the
 *    renderer, not in the analysis;
 *  - anomalies are emitted whenever the count is above zero. The SaaS only
 *    reported undocumented questions past a 50% threshold, so a well-kept
 *    instance with a handful of undocumented questions silently reported none.
 */

import { daysSince } from "../util.js";
import { extractReferencedTables } from "../sql.js";
import {
  CLUSTER_USAGE_MIN,
  LARGE_TABLE_ROWS,
  MATERIALIZE_COLUMN_MIN,
  MATERIALIZE_USAGE_MIN,
  PARTITION_ROW_HINT,
  VERY_STALE_DAYS,
} from "./constants.js";

const SAMPLE_NAMES_IN_ENTITY = 5;
const ROWS_PER_MILLION = 1000000;

/** Metabase prefixes every type with `type/`; drop it for readable comparisons. */
function shortType(value) {
  if (!value) return null;
  return String(value).replace(/^type\//, "");
}

/**
 * Table-shaped guesses for a foreign-key-ish column name: `user_id` on a table
 * points at `users` (or `user`, for schemas that keep table names singular).
 */
function fkTargetNames(columnName) {
  const match = /^(.+)_id$/.exec(String(columnName ?? "").toLowerCase());
  if (!match) return [];
  const base = match[1];
  return base.endsWith("s") ? [base] : [base, `${base}s`];
}

/** Optimisation hints for one table. Ported from `generateTableSuggestions`. */
function suggestionsFor(columns, usageCount, rowCount, engine) {
  const suggestions = [];
  const isBigQuery = engine === "bigquery-cloud-sdk";

  const timestampCols = columns.filter(
    (c) => c.type === "DateTimeWithLocalTZ" || c.type === "DateTime" || c.type === "Date" ||
      c.name.includes("created_at") || c.name.includes("updated_at") || c.name.includes("_date"),
  );
  if (timestampCols.length > 0 && (rowCount === null || rowCount > PARTITION_ROW_HINT)) {
    const colName = timestampCols.find((c) => c.name.includes("created"))?.name || timestampCols[0].name;
    suggestions.push(
      `Partition by ${colName} (${isBigQuery ? `PARTITION BY DATE(${colName})` : `range partitioning on ${colName}`})`,
    );
  }

  const clusterCandidates = columns.filter(
    (c) => c.semanticType === "FK" || c.semanticType === "Category" ||
      c.name.endsWith("_id") || c.name === "status" || c.name === "type",
  );
  if (clusterCandidates.length > 0 && usageCount >= CLUSTER_USAGE_MIN) {
    const names = clusterCandidates.slice(0, 4).map((c) => c.name);
    suggestions.push(
      isBigQuery
        ? `Cluster by (${names.join(", ")})`
        : `Add composite index on (${names.slice(0, 3).join(", ")})`,
    );
  }

  if (usageCount >= MATERIALIZE_USAGE_MIN && columns.length > MATERIALIZE_COLUMN_MIN) {
    suggestions.push("High query volume, consider creating a materialized view or dbt model");
  }

  if (rowCount && rowCount > LARGE_TABLE_ROWS) {
    suggestions.push(`Large table (${(rowCount / ROWS_PER_MILLION).toFixed(1)}M rows), ensure proper indexing`);
  }

  return suggestions;
}

/** Counts how many active questions read each non-sample table. */
function countUsage(ctx) {
  const counts = new Map();
  const tracked = ctx.allTables.filter((t) => !ctx.sampleDbIds.has(t.dbId));
  for (const table of tracked) counts.set(table.id, 0);

  const bump = (table) => {
    if (table && counts.has(table.id)) counts.set(table.id, counts.get(table.id) + 1);
  };

  for (const card of ctx.activeCards) {
    if (card.sql) {
      for (const name of extractReferencedTables(card.sql)) {
        const matches = ctx.tablesByName.get(name) || [];
        // A name can exist on several databases. The card's own database wins;
        // without a match there we credit every table carrying that name, which
        // is what the SaaS did.
        const onSameDb = matches.filter((t) => t.dbId === card.databaseId);
        for (const table of onSameDb.length > 0 ? onSameDb : matches) bump(table);
      }
      continue;
    }
    if (card.sourceTableId != null) bump(ctx.tablesById.get(card.sourceTableId));
  }

  return { counts, tracked };
}

/** Tables that reference each table, from FK metadata plus `*_id` naming. */
function buildReferencedBy(tracked, ctx) {
  const tableByFieldId = new Map();
  for (const table of ctx.allTables) {
    for (const field of table.fields || []) tableByFieldId.set(field.id, table);
  }
  const trackedByName = new Map(tracked.map((t) => [String(t.name ?? "").toLowerCase(), t]));

  const referencedBy = new Map(tracked.map((t) => [t.id, new Set()]));
  const add = (targetTable, sourceTable) => {
    if (!targetTable || !sourceTable) return;
    if (targetTable.id === sourceTable.id) return;
    referencedBy.get(targetTable.id)?.add(sourceTable.name);
  };

  for (const source of tracked) {
    for (const field of source.fields || []) {
      if (field.fkTargetFieldId != null) add(tableByFieldId.get(field.fkTargetFieldId), source);
      for (const guess of fkTargetNames(field.name)) add(trackedByName.get(guess), source);
    }
  }

  return referencedBy;
}

/** `{ tables, anomalies }` for the findings document. */
export function analyzeUsage(snapshot, ctx) {
  const { counts, tracked } = countUsage(ctx);
  const referencedBy = buildReferencedBy(tracked, ctx);

  const tables = tracked
    .map((table) => {
      const database = ctx.databasesById.get(table.dbId);
      const engine = database?.engine || "";
      const usageCount = counts.get(table.id) || 0;
      const rowCount = table.rowCount ?? null;
      const columns = (table.fields || []).map((f) => ({
        name: String(f.name ?? ""),
        type: shortType(f.baseType) || "",
        semanticType: shortType(f.semanticType),
      }));
      return {
        name: table.name ?? null,
        schema: table.schema ?? null,
        // The id is what other renderers join on; the name is for reading only.
        dbId: table.dbId ?? null,
        database: database?.name || "Unknown",
        engine,
        usageCount,
        rowCount,
        columnCount: columns.length,
        referencedBy: [...(referencedBy.get(table.id) || [])].sort(),
        suggestions: suggestionsFor(columns, usageCount, rowCount, engine),
      };
    })
    .sort((a, b) => b.usageCount - a.usageCount || String(a.name).localeCompare(String(b.name)));

  return { tables, anomalies: detectAnomalies(tables, ctx) };
}

/** Organizational issues worth a line in the report. */
function detectAnomalies(tables, ctx) {
  const anomalies = [];
  const nameList = (items, pick) =>
    items.slice(0, SAMPLE_NAMES_IN_ENTITY).map(pick).filter(Boolean).join(", ");

  const unused = tables.filter((t) => t.usageCount === 0);
  if (unused.length > 0) {
    anomalies.push({
      type: "unused_table",
      severity: "medium",
      message: `${unused.length} table${unused.length === 1 ? " has" : "s have"} zero query references`,
      entity: nameList(unused, (t) => t.name),
      count: unused.length,
    });
  }

  const veryStale = ctx.activeCards.filter((c) => {
    if (!c.lastUsedAt) return false;
    const days = daysSince(c.lastUsedAt, ctx.now);
    return days !== null && days > VERY_STALE_DAYS;
  });
  if (veryStale.length > 0) {
    anomalies.push({
      type: "stale_query",
      severity: "low",
      message: `${veryStale.length} queries haven't been accessed in ${VERY_STALE_DAYS}+ days`,
      entity: nameList(veryStale, (c) => c.name),
      count: veryStale.length,
    });
  }

  const undocumented = ctx.activeCards.filter((c) => !c.description);
  if (undocumented.length > 0) {
    const pct = Math.round((undocumented.length / Math.max(ctx.activeCards.length, 1)) * 100);
    anomalies.push({
      type: "naming",
      severity: "medium",
      message: `${undocumented.length} of ${ctx.activeCards.length} active questions have no description`,
      entity: `${pct}% undocumented`,
      count: undocumented.length,
    });
  }

  const orphans = ctx.activeCards.filter((c) => c.collectionId === null || c.collectionId === undefined);
  if (orphans.length > 0) {
    anomalies.push({
      type: "orphan",
      severity: "low",
      message: `${orphans.length} question${orphans.length === 1 ? " is" : "s are"} not organized in any collection`,
      entity: nameList(orphans, (c) => c.name),
      count: orphans.length,
    });
  }

  return anomalies;
}
