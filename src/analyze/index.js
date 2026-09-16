/**
 * Analyzer entry point.
 *
 * Every analyzer in this folder is a pure function of the snapshot: same JSON
 * in, same findings out, no clock of its own and no network. `analyze()` builds
 * the shared context once (lookups, the filtered card set, URL helpers) and
 * runs the analyzers in dependency order, since the later ones read the earlier
 * results (dashboards need the broken and stale lists, health needs everything).
 * Those intermediate results are attached to `ctx` as the pipeline advances so
 * each analyzer keeps the same `(snapshot, ctx)` signature.
 *
 * Ported from the MetaLens SaaS analysis engine. Where the port deviates on
 * purpose, the module in question says so at the point of the difference.
 */

import { isoOrNull } from "../util.js";
import { SAMPLE_USER_ID } from "./constants.js";
import { detectDuplicates } from "./duplicates.js";
import { detectBroken } from "./broken.js";
import { detectStale } from "./stale.js";
import { analyzeUsage } from "./usage.js";
import { buildErdEdges } from "./erd.js";
import { analyzeDashboards } from "./dashboards.js";
import { scoreHealth } from "./health.js";
import { generateActions } from "./actions.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function lowerName(value) {
  return String(value ?? "").toLowerCase();
}

/**
 * Shared, read-only view over the snapshot.
 *
 * `activeCards` is the set every analyzer works on: not archived, not sitting
 * on a sample database, not authored by the Metabase demo user. Those three
 * filters are what keeps a fresh Metabase install from reporting the factory
 * "E-commerce Insights" content as the customer's own mess.
 */
function buildContext(snapshot, now) {
  const cards = asArray(snapshot.cards);
  const tables = asArray(snapshot.tables);
  const databases = asArray(snapshot.databases);
  const users = asArray(snapshot.users);
  const collections = asArray(snapshot.collections);

  const sampleDbIds = new Set(databases.filter((d) => d.isSample).map((d) => d.id));
  const nonSampleCards = cards.filter(
    (c) => !sampleDbIds.has(c.databaseId) && c.creatorId !== SAMPLE_USER_ID,
  );
  const activeCards = nonSampleCards.filter((c) => !c.archived);

  const tablesById = new Map(tables.map((t) => [t.id, t]));
  const databasesById = new Map(databases.map((d) => [d.id, d]));
  const cardsById = new Map(cards.map((c) => [c.id, c]));
  const usersById = new Map(users.map((u) => [u.id, u]));
  const collectionsById = new Map(collections.map((c) => [c.id, c]));

  // Table names are matched case-insensitively against SQL text. The set spans
  // every database, sample ones included: it answers "does a table by this name
  // exist anywhere", so a broader set means fewer false "missing table" calls.
  const tableNameSet = new Set(tables.map((t) => lowerName(t.name)));
  const tablesByName = new Map();
  for (const table of tables) {
    const key = lowerName(table.name);
    if (!tablesByName.has(key)) tablesByName.set(key, []);
    tablesByName.get(key).push(table);
  }

  const baseUrl = String(snapshot.instance?.url ?? "").replace(/\/+$/, "");

  return {
    now,
    cards,
    nonSampleCards,
    activeCards,
    allTables: tables,
    databases,
    tablesById,
    tableNameSet,
    tablesByName,
    cardsById,
    usersById,
    collectionsById,
    databasesById,
    sampleDbIds,
    /** Deep link to an entity in the Metabase UI. */
    urlFor(kind, id) {
      const segment = kind === "dashboard" ? "dashboard" : "question";
      return `${baseUrl}/${segment}/${id}`;
    },
    /** Display name for a card or dashboard author. Never returns undefined. */
    creatorName(id) {
      if (id === null || id === undefined) return "Unknown";
      const user = usersById.get(id);
      return user?.name || `User ${id}`;
    },
    /** "Finance / Archive" style path, or null when the card sits outside collections. */
    collectionPath(id) {
      if (id === null || id === undefined) return null;
      const collection = collectionsById.get(id);
      return collection?.path ?? collection?.name ?? null;
    },
  };
}

/** Counts of cards grouped by `queryType`, biggest bucket first. */
function cardsByType(activeCards) {
  const counts = new Map();
  for (const card of activeCards) {
    const type = card.queryType || "unknown";
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** Counts of cards grouped by database name, biggest first. */
function cardsByDatabase(activeCards, ctx) {
  const counts = new Map();
  for (const card of activeCards) {
    const database = ctx.databasesById.get(card.databaseId)?.name || "Unknown";
    counts.set(database, (counts.get(database) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([database, count]) => ({ database, count }))
    .sort((a, b) => b.count - a.count || a.database.localeCompare(b.database));
}

/**
 * Runs every analyzer over a snapshot and returns the findings document that
 * the report and the CLI render. The shape is stable and JSON-safe: no Dates,
 * no Maps, no undefined.
 */
export function analyze(snapshot, { now = new Date() } = {}) {
  const ctx = buildContext(snapshot, now);

  ctx.duplicates = detectDuplicates(snapshot, ctx);
  ctx.broken = detectBroken(snapshot, ctx);
  const staleResult = detectStale(snapshot, ctx);
  ctx.stale = staleResult.stale;
  const usage = analyzeUsage(snapshot, ctx);
  ctx.tables = usage.tables;
  ctx.anomalies = usage.anomalies;
  const ownership = analyzeDashboards(snapshot, ctx);
  ctx.dashboards = ownership.dashboards;
  const health = scoreHealth(snapshot, ctx);

  const nonSampleTables = ctx.tables.length;
  const exactDuplicateArchives = ctx.duplicates
    .filter((g) => g.kind === "exact-sql")
    .reduce((sum, g) => sum + g.archive.length, 0);

  return {
    schemaVersion: 1,
    generatedAt: isoOrNull(now),
    instance: {
      url: snapshot.instance?.url ?? null,
      siteName: snapshot.instance?.siteName ?? null,
      version: snapshot.instance?.version ?? null,
    },
    summary: {
      totalCards: ctx.nonSampleCards.length,
      activeCards: ctx.activeCards.length,
      archivedCards: ctx.nonSampleCards.length - ctx.activeCards.length,
      totalDashboards: ctx.dashboards.length,
      totalDatabases: ctx.databases.filter((d) => !d.isSample).length,
      totalTables: nonSampleTables,
      coreTables: ctx.tables.filter((t) => t.usageCount > 0).length,
      duplicateGroups: ctx.duplicates.length,
      duplicateCardsToArchive: exactDuplicateArchives,
      brokenCards: ctx.broken.length,
      staleCards90: ctx.stale.length,
      staleCards180: staleResult.staleCards180,
      anomalies: ctx.anomalies.length,
      healthScore: health.score,
      healthGrade: health.grade,
    },
    health,
    duplicates: ctx.duplicates,
    broken: ctx.broken,
    stale: ctx.stale,
    anomalies: ctx.anomalies,
    tables: ctx.tables,
    dashboards: ctx.dashboards,
    creators: ownership.creators,
    actions: generateActions(snapshot, ctx),
    erdEdges: buildErdEdges(snapshot, ctx),
    cardsByType: cardsByType(ctx.activeCards),
    cardsByDatabase: cardsByDatabase(ctx.activeCards, ctx),
  };
}
