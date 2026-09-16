/**
 * Broken card detection.
 *
 * Two causes, both cheap enough to run on every scan because neither executes
 * a query: an explicit error flag captured during the snapshot, and static
 * analysis of native SQL against the synced table list.
 *
 * Difference from the SaaS: archived and stale cards are NOT reported here.
 * The SaaS folded "Archived" and "Not accessed in N days" into the same list,
 * which made "broken" mean four different things in one column. Staleness has
 * its own section (`stale[]`) and archived cards are simply out of scope.
 */

import { extractReferencedTables } from "../sql.js";

const MAX_NAMED_TABLES = 3;

function missingTablesFor(card, ctx) {
  // No table baseline (undersynced instance) means we cannot tell a dropped
  // table from an unsynced one, so we claim nothing.
  if (ctx.tableNameSet.size === 0) return [];
  if (!card.sql) return [];
  return extractReferencedTables(card.sql).filter((name) => !ctx.tableNameSet.has(name));
}

function missingReason(missing) {
  const shown = missing.slice(0, MAX_NAMED_TABLES).join(", ");
  const suffix = missing.length > MAX_NAMED_TABLES ? "..." : "";
  return `References missing table${missing.length === 1 ? "" : "s"}: ${shown}${suffix}`;
}

/** Cards that cannot run as written, in snapshot order. */
export function detectBroken(snapshot, ctx) {
  const broken = [];

  for (const card of ctx.activeCards) {
    if (card.hasError) {
      broken.push({
        id: card.id,
        name: card.name ?? null,
        url: ctx.urlFor("card", card.id),
        kind: "error",
        reason: card.errorMessage || "Query returns an error",
        missingTables: [],
        collectionPath: ctx.collectionPath(card.collectionId),
      });
      continue;
    }

    const missing = missingTablesFor(card, ctx);
    if (missing.length > 0) {
      broken.push({
        id: card.id,
        name: card.name ?? null,
        url: ctx.urlFor("card", card.id),
        kind: "missing-table",
        reason: missingReason(missing),
        missingTables: missing,
        collectionPath: ctx.collectionPath(card.collectionId),
      });
    }
  }

  return broken;
}
