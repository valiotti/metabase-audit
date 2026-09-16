/**
 * The do-this-next list.
 *
 * Ordered by leverage, not by section: whoever reads the report should be able
 * to work top down and stop whenever they run out of appetite. Every action
 * carries the card ids it applies to, so the CLI can feed them to a bulk
 * archive without the user copying ids out of a table.
 *
 * Differences from the SaaS `generateActions`, on purpose:
 *  - broken cards get their own action. The SaaS had none, so the most urgent
 *    finding in the report had no entry in the action list at all;
 *  - the arbitrary emit thresholds are gone (stale only past 20 cards, name
 *    duplicates only past 5 groups, core model only under 30 tables). An action
 *    appears whenever it has something to act on, which is what makes the list
 *    usable on small instances.
 */

import { STALE_DAYS } from "./constants.js";

/** Display caps: how many ids an action carries before the list stops being actionable. */
const UNDOCUMENTED_CARD_CAP = 20;
const STALE_CARD_CAP = 50;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/** `plural(1, "query", "queries")` -> "1 query". English plurals are not a suffix. */
function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many ?? `${one}s`}`;
}

/** Prioritised actions, highest first. Only actions with something to act on. */
export function generateActions(snapshot, ctx) {
  const actions = [];

  const missingTableCards = ctx.broken.filter((b) => b.kind === "missing-table");
  if (missingTableCards.length > 0) {
    const names = [...new Set(missingTableCards.flatMap((b) => b.missingTables))];
    actions.push({
      priority: "high",
      title: `Fix ${plural(missingTableCards.length, "question", "questions")} pointing at missing tables`,
      description: `These questions read tables that no longer exist in the warehouse (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""}). They fail for everyone who opens them.`,
      impact: "Broken questions erode trust in the whole instance faster than anything else on this list.",
      cardIds: missingTableCards.map((b) => b.id),
    });
  }

  const exactGroups = ctx.duplicates.filter((g) => g.kind === "exact-sql");
  const exactArchiveIds = exactGroups.flatMap((g) => g.archive.map((c) => c.id));
  if (exactArchiveIds.length > 0) {
    actions.push({
      priority: "high",
      title: `Archive ${plural(exactArchiveIds.length, "exact duplicate query", "exact duplicate queries")}`,
      description: `${plural(exactGroups.length, "group", "groups")} of structurally identical queries. Keep one from each group and archive the rest.`,
      impact: `Removes ${exactArchiveIds.length} redundant questions, so search returns one answer per metric instead of several.`,
      cardIds: exactArchiveIds,
    });
  }

  if (ctx.stale.length > 0) {
    const share = Math.round((ctx.stale.length / Math.max(ctx.activeCards.length, 1)) * 100);
    actions.push({
      priority: "medium",
      title: `Review ${plural(ctx.stale.length, "stale query", "stale queries")} (${STALE_DAYS}+ days unused)`,
      description: `Nobody has opened these in ${STALE_DAYS}+ days. Archive the ones that are no longer needed.`,
      impact: `Cleaning up ${share}% of the question library cuts the noise in search and in collection browsing.`,
      cardIds: ctx.stale.slice(0, STALE_CARD_CAP).map((c) => c.id),
    });
  }

  const undocumented = ctx.activeCards.filter((c) => !c.description);
  if (undocumented.length > 0) {
    actions.push({
      priority: "medium",
      title: `Add descriptions to ${plural(undocumented.length, "question", "questions")}`,
      description: `${undocumented.length} of ${ctx.activeCards.length} active questions have no description. Start with the most-viewed ones.`,
      impact: "A description lets a teammate tell what a question measures without reading its SQL.",
      cardIds: [...undocumented]
        .sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0) || a.id - b.id)
        .slice(0, UNDOCUMENTED_CARD_CAP)
        .map((c) => c.id),
    });
  }

  const nameGroups = ctx.duplicates.filter((g) => g.kind === "same-name");
  if (nameGroups.length > 0) {
    actions.push({
      priority: "low",
      title: `Review ${plural(nameGroups.length, "group", "groups")} of questions with the same name`,
      description: "Same name, different query. They may be old versions, or the same metric measured two ways.",
      impact: "Consolidating variants into one source of truth prevents conflicting numbers across dashboards.",
      cardIds: nameGroups.flatMap((g) => [g.keep.id, ...g.archive.map((c) => c.id)]),
    });
  }

  const coreTables = ctx.tables.filter((t) => t.usageCount > 0);
  if (coreTables.length > 0) {
    actions.push({
      priority: "low",
      title: `Your core data model is ${plural(coreTables.length, "table", "tables")}`,
      description: `Out of ${ctx.tables.length} tables, only ${coreTables.length} are read by a saved question. Those are the real business tables.`,
      impact: "Point documentation, tests and any warehouse migration at these first. The rest are supporting or unused.",
      cardIds: [],
    });
  }

  return actions.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}
