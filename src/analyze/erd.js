/**
 * ERD edges from query text.
 *
 * Warehouses rarely declare foreign keys and Metabase only knows the ones it
 * was told about, so the most reliable source of "these two tables belong
 * together" is how analysts actually join them.
 *
 * Difference from the SaaS `buildJoinEdges`: real JOIN targets come first.
 * The SaaS only ever emitted co-occurrence pairs, so a query touching five
 * tables produced ten edges and the diagram turned into a hairball. Here a
 * query with parseable top-level joins contributes exactly those joins, and the
 * co-occurrence fallback only kicks in when no join pair survives.
 */

import { extractJoinPairs, extractReferencedTables } from "../sql.js";

/** Unique `{ from, to, count }` edges, most joined pair first. */
export function buildErdEdges(snapshot, ctx) {
  // Key on the unordered pair so `a → b` and `b → a` are one edge; the first
  // direction seen is the one reported.
  const edges = new Map();

  const addEdge = (from, to) => {
    if (!from || !to || from === to) return;
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    const existing = edges.get(key);
    if (existing) existing.count++;
    else edges.set(key, { from, to, count: 1 });
  };

  for (const card of ctx.activeCards) {
    if (!card.sql) continue;

    const known = (name) => ctx.tableNameSet.has(name);
    const pairs = extractJoinPairs(card.sql).filter((p) => known(p.from) && known(p.to));

    if (pairs.length > 0) {
      const seen = new Set();
      for (const pair of pairs) {
        const key = `${pair.from}|${pair.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        addEdge(pair.from, pair.to);
      }
      continue;
    }

    // Fallback: no parseable top-level join (subquery anchor, CTE anchor, comma
    // joins inside a derived table). Treat the tables the query reads as
    // co-occurring and hang them off the first one.
    const referenced = extractReferencedTables(card.sql).filter(known);
    if (referenced.length < 2) continue;
    const seen = new Set();
    for (let i = 1; i < referenced.length; i++) {
      const key = `${referenced[0]}|${referenced[i]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addEdge(referenced[0], referenced[i]);
    }
  }

  return [...edges.values()].sort(
    (a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}
