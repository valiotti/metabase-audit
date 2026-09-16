/**
 * Duplicate detection.
 *
 * Two passes, same as the SaaS: identical SQL after normalisation, then
 * identical names among everything the first pass did not already claim.
 *
 * Differences from the SaaS, on purpose:
 *  - the group carries an explicit keep/archive split instead of an ordered
 *    card list, so the report can name the survivor and the CLI can hand the
 *    archive ids straight to `metalens archive`;
 *  - exact-SQL groups are keyed by database as well as by query text, because
 *    the same SQL run against two different warehouses is two different
 *    numbers, not a duplicate.
 */

import { normalizeSql } from "../sql.js";
import { isoOrNull } from "../util.js";

/** Name comparison key: lowercase, punctuation collapsed to single spaces. */
function nameKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The card a team should keep: most viewed, then most recently used (unknown
 * usage loses), then the oldest id as a stable tie-break.
 */
function pickKeeper(cards) {
  return [...cards].sort((a, b) => {
    const views = (b.viewCount || 0) - (a.viewCount || 0);
    if (views !== 0) return views;
    const aUsed = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : -Infinity;
    const bUsed = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : -Infinity;
    if (aUsed !== bUsed) return bUsed - aUsed;
    return a.id - b.id;
  })[0];
}

function cardRef(card, ctx) {
  return {
    id: card.id,
    name: card.name ?? null,
    url: ctx.urlFor("card", card.id),
    viewCount: card.viewCount ?? 0,
    lastUsedAt: isoOrNull(card.lastUsedAt),
  };
}

/** Source table names behind a set of cards, for the same-name recommendation. */
function sourceTableNames(cards, ctx) {
  const names = new Set();
  for (const card of cards) {
    const table = card.sourceTableId != null ? ctx.tablesById.get(card.sourceTableId) : null;
    if (table?.name) names.add(table.name);
  }
  return [...names];
}

function buildGroup(kind, similarity, cards, ctx) {
  const keep = pickKeeper(cards);
  const archive = cards.filter((c) => c.id !== keep.id).sort((a, b) => a.id - b.id);
  const count = cards.length;

  let recommendation;
  if (kind === "exact-sql") {
    recommendation = `These ${count} queries are structurally identical. Keep "${keep.name}" and archive the other ${archive.length}.`;
  } else {
    const tables = sourceTableNames(cards, ctx);
    recommendation = tables.length > 1
      ? `${count} questions share the name "${keep.name}" but read from different source tables (${tables.join(", ")}). They may be the same metric from different angles.`
      : `${count} questions share the name "${keep.name}". Review whether all of them are still needed, or consolidate into one.`;
  }

  return {
    kind,
    similarity,
    databaseId: keep.databaseId ?? null,
    keep: cardRef(keep, ctx),
    archive: archive.map((c) => cardRef(c, ctx)),
    recommendation,
  };
}

/** Duplicate groups, most copies first and exact matches ahead of name matches. */
export function detectDuplicates(snapshot, ctx) {
  const groups = [];
  const claimed = new Set();

  const bySql = new Map();
  for (const card of ctx.activeCards) {
    if (!card.sql) continue;
    const normalized = normalizeSql(card.sql);
    if (!normalized) continue;
    const key = `${card.databaseId}::${normalized}`;
    if (!bySql.has(key)) bySql.set(key, []);
    bySql.get(key).push(card);
  }
  for (const cards of bySql.values()) {
    if (cards.length < 2) continue;
    for (const card of cards) claimed.add(card.id);
    groups.push(buildGroup("exact-sql", 1, cards, ctx));
  }

  const byName = new Map();
  for (const card of ctx.activeCards) {
    if (claimed.has(card.id)) continue;
    const key = nameKey(card.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(card);
  }
  for (const cards of byName.values()) {
    if (cards.length < 2) continue;
    groups.push(buildGroup("same-name", 0.8, cards, ctx));
  }

  return groups.sort((a, b) => {
    const sizeA = a.archive.length + 1;
    const sizeB = b.archive.length + 1;
    if (sizeA !== sizeB) return sizeB - sizeA;
    return b.similarity - a.similarity;
  });
}
