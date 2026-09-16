/** Small shared helpers. No dependencies. */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between two dates (later minus earlier). Accepts Date or ISO string. */
export function daysBetween(later, earlier) {
  const a = later instanceof Date ? later : new Date(later);
  const b = earlier instanceof Date ? earlier : new Date(earlier);
  return Math.floor((a.getTime() - b.getTime()) / MS_PER_DAY);
}

/** Returns an ISO string for a valid date input, otherwise null. Never undefined. */
export function isoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Days since `date` relative to `now`, or null when `date` is null. */
export function daysSince(date, now) {
  if (!date) return null;
  return daysBetween(now, date);
}

/** en-US thousands formatting for report output. */
export function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return Number(n).toLocaleString("en-US");
}

/** Pads a string to the right for simple aligned console tables. */
export function pad(str, width) {
  const s = String(str ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Run `fn` over `items` with at most `limit` in flight. Preserves order of results. */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

/** Mask a secret for logs: first 4 chars then asterisks. */
export function maskSecret(value) {
  if (!value) return "";
  const s = String(value);
  return s.length <= 4 ? "****" : `${s.slice(0, 4)}${"*".repeat(Math.min(12, s.length - 4))}`;
}
