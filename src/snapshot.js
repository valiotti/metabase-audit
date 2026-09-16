/**
 * Metabase metadata snapshot: fetch everything the analyzers need in one pass
 * and write it to a single JSON file.
 *
 * This is the open-source port of the MetaLens SaaS sync (`syncMetadata` in
 * `connections/route.ts`), with Postgres replaced by `<dir>/snapshot.json`.
 * The snapshot is the only input analyzers get, so every field is normalised
 * here: dates are ISO strings or null, counts are numbers, nothing is
 * `undefined`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isoOrNull, mapWithConcurrency } from "./util.js";
import { DASHBOARD_DETAILS_CAP, SAMPLE_USER_ID } from "./analyze/constants.js";

/** Bumped whenever the snapshot shape changes in a way analyzers care about. */
export const SCHEMA_VERSION = 1;
export const SNAPSHOT_FILENAME = "snapshot.json";

/** Activity feed rows to pull when backfilling `lastUsedAt` (matches the SaaS). */
const ACTIVITY_LIMIT = 2000;
/** Backfill only kicks in when more than this share of cards lack a timestamp. */
const ACTIVITY_NULL_RATIO = 0.5;
/** At most this many creator ids are resolved one by one after the user list. */
const EXTRA_USER_CAP = 100;
/** Compile failures listed one by one before the rest become a single line. */
const COMPILE_WARNING_CAP = 20;

function message(err) {
  return err instanceof Error ? err.message : String(err);
}

function numOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Metabase ships a demo H2 database ("Sample Database") on every new install.
 * It is not customer content, so cards pointing at it are dropped and its
 * tables are flagged through `databases[].isSample`.
 */
export function isSampleDatabase(db) {
  if (!db || typeof db !== "object") return false;
  if (db.is_sample === true) return true;
  const engine = String(db.engine ?? "").toLowerCase();
  return engine === "h2" && /sample|example/i.test(String(db.name ?? ""));
}

/**
 * Pull SQL, query type and source table out of a card's `dataset_query`.
 *
 * Two formats are in the wild: the legacy one (`{type, native:{query}, query}`)
 * and MBQL v2 from Metabase v0.62+ (`{stages:[{"lib/type", native, "source-table"}]}`).
 * `queryTypeHint` is Metabase's own `card.query_type`, which is authoritative
 * when present; structure decides otherwise.
 */
export function extractCardSql(datasetQuery, queryTypeHint) {
  const dq = datasetQuery && typeof datasetQuery === "object" ? datasetQuery : {};
  const stages = Array.isArray(dq.stages) ? dq.stages : null;
  const firstStage = stages && stages.length > 0 && stages[0] && typeof stages[0] === "object" ? stages[0] : null;
  const stageLibType = firstStage ? firstStage["lib/type"] : undefined;
  const legacyNative = dq.native && typeof dq.native === "object" ? dq.native : null;

  // Native SQL: legacy `native.query`, or the v2 stage, where `native` is
  // either the SQL string itself or an object carrying `query`.
  const stageNative = firstStage ? firstStage.native : undefined;
  const sql =
    strOrNull(legacyNative?.query) ||
    strOrNull(typeof stageNative === "string" ? stageNative : stageNative?.query) ||
    null;

  // Source table: only structured queries have one, and only numeric ids count
  // (a card-backed source reads `card__810`, which is not a table).
  const sourceTableId =
    numOrNull(firstStage?.["source-table"]) ??
    numOrNull(dq.query && typeof dq.query === "object" ? dq.query["source-table"] : undefined);

  let queryType = "unknown";
  if (queryTypeHint === "native" || queryTypeHint === "query") {
    queryType = queryTypeHint;
  } else if (dq.type === "native" || stageLibType === "mbql.stage/native" || sql !== null) {
    queryType = "native";
  } else if (
    dq.type === "query" ||
    stageLibType === "mbql.stage/mbql" ||
    (dq.query && typeof dq.query === "object")
  ) {
    queryType = "query";
  }

  return { sql, queryType, sourceTableId };
}

function mapTable(table, dbId, { withFields = true } = {}) {
  const fields = withFields && Array.isArray(table.fields) ? table.fields : [];
  return {
    id: numOrNull(table.id),
    dbId,
    schema: strOrNull(table.schema),
    name: strOrNull(table.name),
    displayName: strOrNull(table.display_name) ?? strOrNull(table.name),
    description: strOrNull(table.description),
    rowCount: numOrNull(table.rows) ?? numOrNull(table.row_count),
    fields: fields.map((f) => ({
      id: numOrNull(f.id),
      name: strOrNull(f.name),
      baseType: strOrNull(f.base_type),
      semanticType: strOrNull(f.semantic_type),
      fkTargetFieldId: numOrNull(f.fk_target_field_id),
    })),
  };
}

function userName(user) {
  const common = strOrNull(user.common_name);
  if (common) return common;
  const full = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
  if (full) return full;
  // Users behind an API key have no name at all, only a synthetic address;
  // printing that address as an owner name helps nobody.
  const email = strOrNull(user.email);
  if (email && /@api-key\.invalid$/i.test(email)) return `API key user ${user.id}`;
  return email ?? `User ${user.id}`;
}

function mapUser(user) {
  return {
    id: numOrNull(user.id),
    name: userName(user),
    email: strOrNull(user.email),
    isActive: user.is_active !== false,
  };
}

/** `/1/5/` → `[1, 5]`. Anything non-numeric in the path is ignored. */
function parseLocation(location) {
  if (typeof location !== "string") return [];
  return location
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((id) => Number.isFinite(id));
}

function mapCollections(rawCollections) {
  // Metabase exposes a virtual root collection with a string id ("root"); it is
  // not a real folder, so it never appears in the snapshot.
  const rows = (rawCollections || []).filter((c) => c && numOrNull(c.id) !== null);
  const nameById = new Map(rows.map((c) => [c.id, strOrNull(c.name)]));

  return rows.map((c) => {
    const ancestors = parseLocation(c.location);
    const names = ancestors.map((id) => nameById.get(id)).filter((n) => typeof n === "string" && n.length > 0);
    const own = strOrNull(c.name);
    return {
      id: c.id,
      name: own,
      parentId: ancestors.length > 0 ? ancestors[ancestors.length - 1] : numOrNull(c.parent_id),
      path: [...names, own].filter(Boolean).join(" / "),
      archived: c.archived === true,
    };
  });
}

/**
 * Fetch a full metadata snapshot from a Metabase instance.
 *
 * `client` is duck-typed: any object with the async methods used below works,
 * which keeps this module testable without a network stub.
 */
export async function buildSnapshot(client, options = {}) {
  const {
    url = "",
    compile = false,
    dashboardDetailsCap = DASHBOARD_DETAILS_CAP,
    concurrency = 4,
    onProgress = () => {},
    now = new Date(),
  } = options;

  const warnings = [];
  const meta = {
    dashboardDetailsFetched: 0,
    dashboardDetailsCap,
    usersFetched: false,
    extraUsersFetched: 0,
    compiledCards: 0,
    activityBackfill: false,
    warnings,
  };

  // A broken progress listener must never take the whole scan down with it.
  const progress = (phase, done, total) => {
    try {
      onProgress({ phase, done, total });
    } catch {
      /* ignore listener errors */
    }
  };

  // ─── instance ──────────────────────────────────────────────────────────
  progress("instance", 0, 1);
  let siteName = null;
  let version = null;
  try {
    const info = await client.getInstanceInfo();
    siteName = strOrNull(info?.siteName);
    version = strOrNull(info?.version);
  } catch (err) {
    warnings.push(`Could not read instance info: ${message(err)}`);
  }
  progress("instance", 1, 1);

  // ─── databases ─────────────────────────────────────────────────────────
  progress("databases", 0, 0);
  let rawDatabases = [];
  let databasesError = null;
  try {
    rawDatabases = (await client.getDatabases()) || [];
  } catch (err) {
    databasesError = message(err);
    warnings.push(`Could not fetch databases: ${databasesError}`);
  }
  const databases = rawDatabases.map((d) => ({
    id: numOrNull(d.id),
    name: strOrNull(d.name),
    engine: strOrNull(d.engine),
    isSample: isSampleDatabase(d),
  }));
  const sampleDbIds = new Set(databases.filter((d) => d.isSample).map((d) => d.id));
  progress("databases", databases.length, databases.length);

  // ─── tables ────────────────────────────────────────────────────────────
  // `/api/database/:id/metadata` is the only endpoint that returns fields, so
  // it is worth one call per database. When it fails (permissions, timeouts)
  // the flat table list still gives names and schemas.
  const tables = [];
  let flatTables = null;
  progress("tables", 0, databases.length);
  for (let i = 0; i < databases.length; i++) {
    const db = databases[i];
    try {
      const metadata = await client.getDatabaseMetadata(db.id);
      for (const table of metadata?.tables || []) tables.push(mapTable(table, db.id));
    } catch (err) {
      warnings.push(`Could not fetch metadata for database ${db.id} (${db.name}): ${message(err)}`);
      if (flatTables === null) {
        try {
          flatTables = (await client.getAllTables()) || [];
        } catch (listErr) {
          flatTables = [];
          warnings.push(`Could not fetch the table list: ${message(listErr)}`);
        }
      }
      for (const table of flatTables) {
        const tableDbId = numOrNull(table.db_id) ?? numOrNull(table.database_id);
        if (tableDbId !== db.id) continue;
        tables.push(mapTable(table, db.id, { withFields: false }));
      }
    }
    progress("tables", i + 1, databases.length);
  }

  // ─── cards ─────────────────────────────────────────────────────────────
  progress("cards", 0, 0);
  let rawCards = [];
  let cardsError = null;
  try {
    rawCards = (await client.getAllCards()) || [];
  } catch (err) {
    cardsError = message(err);
    warnings.push(`Could not fetch questions: ${cardsError}`);
  }
  const cards = [];
  // `dataset_query` is needed for `--compile` but is far too big to write into
  // the snapshot, so it stays in memory for the length of the build only.
  const datasetQueryById = new Map();

  for (const card of rawCards) {
    const creatorId = numOrNull(card.creator_id);
    if (creatorId === SAMPLE_USER_ID) continue; // Metabase demo content
    const databaseId = numOrNull(card.database_id) ?? numOrNull(card.dataset_query?.database);
    if (databaseId !== null && sampleDbIds.has(databaseId)) continue;

    const { sql, queryType, sourceTableId } = extractCardSql(card.dataset_query, card.query_type);
    cards.push({
      id: numOrNull(card.id),
      name: strOrNull(card.name),
      description: strOrNull(card.description),
      type: strOrNull(card.type) ?? "question",
      queryType,
      display: strOrNull(card.display),
      databaseId,
      sourceTableId,
      sql,
      sqlSource: sql === null ? null : "native",
      collectionId: numOrNull(card.collection_id),
      creatorId,
      createdAt: isoOrNull(card.created_at),
      updatedAt: isoOrNull(card.updated_at),
      lastUsedAt: isoOrNull(card.last_used_at),
      viewCount: Number(card.view_count) || 0,
      archived: card.archived === true,
      hasError: false,
    });
    if (card.dataset_query) datasetQueryById.set(card.id, card.dataset_query);
  }
  progress("cards", cards.length, rawCards.length);

  // Nothing at all on both lists, with a failure behind at least one of them,
  // is a broken connection rather than an empty Metabase. Reporting an A grade
  // on zero content would be worse than stopping here.
  if (databases.length === 0 && cards.length === 0 && (databasesError || cardsError)) {
    const reason = [databasesError, cardsError].filter(Boolean).join("; ");
    throw new Error(`Could not read databases or questions from Metabase: ${reason}`);
  }

  // ─── collections ───────────────────────────────────────────────────────
  progress("collections", 0, 0);
  let collections = [];
  try {
    collections = mapCollections((await client.getCollections()) || []);
  } catch (err) {
    warnings.push(`Could not fetch collections: ${message(err)}`);
  }
  progress("collections", collections.length, collections.length);

  // ─── users ─────────────────────────────────────────────────────────────
  // Non-admin API keys get a 403 here; the report then falls back to creator
  // ids instead of names, which is why `usersFetched` is recorded.
  progress("users", 0, 0);
  let users = [];
  try {
    const rawUsers = (await client.getAllUsers()) || [];
    users = rawUsers.map(mapUser);
    meta.usersFetched = users.length > 0;
  } catch (err) {
    warnings.push(`Could not fetch users: ${message(err)}`);
  }
  progress("users", users.length, users.length);

  // ─── dashboards ────────────────────────────────────────────────────────
  progress("dashboards", 0, 0);
  let rawDashboards = [];
  try {
    rawDashboards = (await client.getAllDashboards()) || [];
  } catch (err) {
    warnings.push(`Could not fetch dashboards: ${message(err)}`);
  }
  const keptDashboards = rawDashboards.filter((d) => numOrNull(d.creator_id) !== SAMPLE_USER_ID);

  // Card mappings only come from the per-dashboard detail call, which is one
  // request each. Busy instances have thousands, so spend the calls on the
  // most viewed non-archived ones and leave the rest with empty `cardIds`.
  const detailTargets = keptDashboards
    .filter((d) => d.archived !== true)
    .slice()
    .sort((a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0))
    .slice(0, Math.max(0, dashboardDetailsCap));

  const detailById = new Map();
  let detailsDone = 0;
  progress("dashboards", 0, detailTargets.length);
  await mapWithConcurrency(detailTargets, concurrency, async (dash) => {
    try {
      const detail = await client.getDashboard(dash.id);
      if (detail) {
        detailById.set(dash.id, detail);
        meta.dashboardDetailsFetched++;
      }
    } catch (err) {
      warnings.push(`Could not fetch dashboard ${dash.id} (${dash.name}): ${message(err)}`);
    }
    progress("dashboards", ++detailsDone, detailTargets.length);
  });

  const dashboards = keptDashboards.map((d) => {
    const detail = detailById.get(d.id) || null;
    const dashcards = (detail && (detail.dashcards || detail.ordered_cards)) || [];
    const cardIds = dashcards
      .map((dc) => numOrNull(dc?.card_id) ?? numOrNull(dc?.card?.id))
      .filter((id) => id !== null);
    return {
      id: numOrNull(d.id),
      name: strOrNull(detail?.name) ?? strOrNull(d.name),
      description: strOrNull(detail?.description) ?? strOrNull(d.description),
      collectionId: numOrNull(detail?.collection_id) ?? numOrNull(d.collection_id),
      creatorId: numOrNull(detail?.creator_id) ?? numOrNull(d.creator_id),
      createdAt: isoOrNull(detail?.created_at) ?? isoOrNull(d.created_at),
      updatedAt: isoOrNull(detail?.updated_at) ?? isoOrNull(d.updated_at),
      lastViewedAt:
        isoOrNull(detail?.last_viewed_at) ??
        isoOrNull(detail?.last_used_at) ??
        isoOrNull(d.last_viewed_at) ??
        isoOrNull(d.last_used_at),
      viewCount: Number(detail?.view_count ?? d.view_count) || 0,
      archived: (detail?.archived ?? d.archived) === true,
      cardIds,
    };
  });

  // ─── creator ids missing from the user list ────────────────────────────
  // `/api/user` omits the synthetic users Metabase creates behind API keys,
  // yet questions saved through an API key carry that user's id as creator,
  // so the report would name them "User 33". `/api/user/:id` still answers for
  // those ids, so the stragglers are resolved one request at a time.
  if (typeof client.getUser === "function") {
    const known = new Set(users.map((u) => u.id));
    const ownedCount = new Map();
    for (const item of [...cards, ...dashboards]) {
      const id = item.creatorId;
      if (id === null || id === SAMPLE_USER_ID || known.has(id)) continue;
      ownedCount.set(id, (ownedCount.get(id) || 0) + 1);
    }

    let missingIds = [...ownedCount.keys()];
    if (missingIds.length > EXTRA_USER_CAP) {
      missingIds = [...ownedCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, EXTRA_USER_CAP)
        .map(([id]) => id);
      warnings.push(
        `${ownedCount.size} creator ids are missing from the user list; resolved only the ${EXTRA_USER_CAP} most frequent.`,
      );
    }

    if (missingIds.length > 0) {
      let usersDone = 0;
      progress("users", 0, missingIds.length);
      const resolved = await mapWithConcurrency(missingIds, concurrency, async (id) => {
        let row = null;
        try {
          row = await client.getUser(id);
        } catch (err) {
          warnings.push(`Could not fetch user ${id}: ${message(err)}`);
        }
        progress("users", ++usersDone, missingIds.length);
        return row;
      });
      for (const row of resolved) {
        // Ids that resolve to nothing are simply left out; the report falls
        // back to "User <id>" for them.
        if (!row || numOrNull(row.id) === null) continue;
        users.push(mapUser(row));
        meta.extraUsersFetched++;
      }
    }
  }

  // ─── activity backfill ─────────────────────────────────────────────────
  // Metabase v0.50.x and older do not return `last_used_at` on /api/card. When
  // most cards look untouched it is usually this, not genuine staleness, so
  // the activity feed fills the gaps before anything is called stale.
  const liveCards = cards.filter((c) => !c.archived);
  const nullCount = liveCards.filter((c) => c.lastUsedAt === null).length;
  if (liveCards.length > 0 && nullCount / liveCards.length > ACTIVITY_NULL_RATIO) {
    progress("activity", 0, 1);
    let activity = [];
    try {
      activity = (await client.getActivity(ACTIVITY_LIMIT)) || [];
    } catch (err) {
      warnings.push(`Could not fetch the activity feed: ${message(err)}`);
    }

    const latestByCardId = new Map();
    for (const row of activity) {
      const model = String(row?.model ?? "").toLowerCase();
      const isCard = row?.topic === "card-read" || model === "card" || model === "question";
      const cardId = numOrNull(row?.model_id);
      const timestamp = isoOrNull(row?.timestamp);
      if (!isCard || cardId === null || timestamp === null) continue;
      const seen = latestByCardId.get(cardId);
      if (!seen || timestamp > seen) latestByCardId.set(cardId, timestamp);
    }

    let filled = 0;
    for (const card of cards) {
      if (card.lastUsedAt !== null) continue; // never overwrite a real timestamp
      const timestamp = latestByCardId.get(card.id);
      if (!timestamp) continue;
      card.lastUsedAt = timestamp;
      filled++;
    }
    meta.activityBackfill = filled > 0;
    progress("activity", 1, 1);
  }

  // ─── compile ───────────────────────────────────────────────────────────
  // GUI (structured) cards have no SQL of their own. Metabase can compile them
  // on request, which makes duplicate detection and the SQL review skill see
  // them too. One request per card, so it is opt-in.
  if (compile) {
    const targets = cards.filter(
      (c) => c.queryType === "query" && c.sql === null && !c.archived && datasetQueryById.has(c.id),
    );
    let compileDone = 0;
    let compileFailures = 0;
    progress("compile", 0, targets.length);
    await mapWithConcurrency(targets, concurrency, async (card) => {
      let native = null;
      try {
        native = await client.compileToNative(datasetQueryById.get(card.id));
      } catch {
        native = null; // treated as a permanent failure, same as the SaaS
      }
      if (typeof native === "string" && native.trim() !== "") {
        card.sql = native;
        card.sqlSource = "compiled";
        meta.compiledCards++;
      } else {
        // One line per card is useful for a handful of failures and noise for
        // a thousand, so the rest are counted into a single summary warning.
        compileFailures++;
        if (compileFailures <= COMPILE_WARNING_CAP) {
          warnings.push(`Could not compile card ${card.id} (${card.name})`);
        }
      }
      progress("compile", ++compileDone, targets.length);
    });
    if (compileFailures > COMPILE_WARNING_CAP) {
      warnings.push(`${compileFailures - COMPILE_WARNING_CAP} more questions could not be compiled`);
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: isoOrNull(now) ?? new Date().toISOString(),
    instance: { url: String(url || ""), siteName, version },
    databases,
    tables,
    cards,
    dashboards,
    collections,
    users,
    meta,
  };
}

/** Writes `<dir>/snapshot.json`, creating `dir` if needed. Returns the path. */
export async function saveSnapshot(snapshot, dir) {
  const file = path.join(dir, SNAPSHOT_FILENAME);
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return file;
}

/** Reads and validates a snapshot from an explicit file path. */
export async function loadSnapshotFile(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`No snapshot found at ${file}. Run "metabase-audit scan" first.`);
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Snapshot at ${file} is not valid JSON: ${message(err)}`);
  }

  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Snapshot at ${file} has schemaVersion ${parsed?.schemaVersion ?? "none"}, expected ${SCHEMA_VERSION}. Re-run "metabase-audit scan".`,
    );
  }
  return parsed;
}

/** Reads and validates `<dir>/snapshot.json`. */
export async function loadSnapshot(dir) {
  return loadSnapshotFile(path.join(dir, SNAPSHOT_FILENAME));
}
