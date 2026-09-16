/**
 * Staleness.
 *
 * A card is stale when Metabase last served it more than STALE_DAYS ago. Cards
 * that were never served carry a null `lastUsedAt`: that is unknown usage, not
 * proven abandonment, so they stay out of the list. The health score treats the
 * never-used-and-never-viewed subset separately.
 */

import { daysSince, isoOrNull } from "../util.js";
import { STALE_DAYS, VERY_STALE_DAYS } from "./constants.js";

/** `{ stale, staleCards180 }` with the list sorted oldest first. */
export function detectStale(snapshot, ctx) {
  const stale = [];
  let staleCards180 = 0;

  for (const card of ctx.activeCards) {
    if (!card.lastUsedAt) continue;
    const days = daysSince(card.lastUsedAt, ctx.now);
    if (days === null || days <= STALE_DAYS) continue;
    if (days > VERY_STALE_DAYS) staleCards180++;
    stale.push({
      id: card.id,
      name: card.name ?? null,
      url: ctx.urlFor("card", card.id),
      lastUsedAt: isoOrNull(card.lastUsedAt),
      daysSinceUse: days,
      viewCount: card.viewCount ?? 0,
      creatorName: ctx.creatorName(card.creatorId ?? null),
      collectionPath: ctx.collectionPath(card.collectionId),
    });
  }

  stale.sort((a, b) => b.daysSinceUse - a.daysSinceUse || a.id - b.id);
  return { stale, staleCards180 };
}
