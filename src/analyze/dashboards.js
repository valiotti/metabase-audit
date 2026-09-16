/**
 * Dashboard health and per-author ownership.
 *
 * The SaaS version of this fetched dashboard details from the Metabase API
 * while analysing. Here the snapshot already carries them, so this is a pure
 * function: it only decides status and groups cards by author.
 *
 * Difference from the SaaS: a dashboard whose card list is empty is reported
 * with status "unknown" rather than being dropped. An empty dashboard is a real
 * finding (someone made it and never filled it), and silently dropping it made
 * the dashboard count disagree with what the user sees in Metabase.
 */

import { isoOrNull } from "../util.js";
import { DASHBOARD_WARNING_STALE_RATIO, SAMPLE_USER_ID } from "./constants.js";

/** `{ dashboards, creators }`, both sorted biggest first. */
export function analyzeDashboards(snapshot, ctx) {
  const brokenIds = new Set(ctx.broken.map((b) => b.id));
  const staleIds = new Set(ctx.stale.map((s) => s.id));
  const nonSampleCardIds = new Set(ctx.nonSampleCards.map((c) => c.id));

  const dashboards = [];
  for (const dash of Array.isArray(snapshot.dashboards) ? snapshot.dashboards : []) {
    if (dash.archived) continue;
    if (dash.creatorId === SAMPLE_USER_ID) continue;

    const cardIds = Array.isArray(dash.cardIds) ? dash.cardIds : [];
    // Every card on a sample database means a factory demo dashboard, not the
    // customer's work. An empty dashboard has nothing to judge it by, so it stays.
    if (cardIds.length > 0 && !cardIds.some((id) => nonSampleCardIds.has(id))) continue;

    const brokenCardCount = cardIds.filter((id) => brokenIds.has(id)).length;
    const staleCardCount = cardIds.filter((id) => staleIds.has(id)).length;

    let status;
    if (brokenCardCount > 0) status = "broken";
    else if (cardIds.length === 0) status = "unknown";
    else if (staleCardCount / cardIds.length > DASHBOARD_WARNING_STALE_RATIO) status = "warning";
    else status = "healthy";

    dashboards.push({
      id: dash.id,
      name: dash.name ?? null,
      url: ctx.urlFor("dashboard", dash.id),
      cardCount: cardIds.length,
      brokenCardCount,
      staleCardCount,
      creatorName: ctx.creatorName(dash.creatorId ?? null),
      lastViewedAt: isoOrNull(dash.lastViewedAt),
      viewCount: dash.viewCount ?? 0,
      status,
    });
  }
  dashboards.sort((a, b) => b.viewCount - a.viewCount || a.id - b.id);

  const byCreator = new Map();
  for (const card of ctx.activeCards) {
    const id = card.creatorId ?? null;
    if (!byCreator.has(id)) byCreator.set(id, { totalCards: 0, staleCards: 0 });
    const entry = byCreator.get(id);
    entry.totalCards++;
    if (staleIds.has(card.id)) entry.staleCards++;
  }

  const creators = [...byCreator.entries()]
    .map(([id, entry]) => ({
      id,
      name: ctx.creatorName(id),
      totalCards: entry.totalCards,
      activeCards: entry.totalCards - entry.staleCards,
      staleCards: entry.staleCards,
    }))
    .sort((a, b) => b.totalCards - a.totalCards || String(a.name).localeCompare(String(b.name)));

  return { dashboards, creators };
}
