/**
 * Connection and permission check. Ported from the MetaLens SaaS
 * `connections/test` route: each step explains what failed and how to fix it
 * in plain words, because "401" on its own sends people to the wrong place.
 *
 * Read-only: five GET requests at most.
 */

import { DASHBOARD_DETAILS_CAP } from "./analyze/constants.js";

const KEY_FIX =
  "Create a key in Metabase: Admin settings, Authentication, API Keys, group Administrators. Then export METABASE_API_KEY again.";

function step(id, status, title, detail = "", fix = "") {
  return { id, status, title, detail, fix };
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function shortMessage(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.length > 200 ? `${msg.slice(0, 200)}...` : msg;
}

/**
 * @param {object} client  MetabaseClient (or a stub with the same methods)
 * @param {{ url: string, compile?: boolean }} opts
 * @returns {Promise<{ ok: boolean, steps: object[], instance: object|null, size: object|null, estimate: string|null }>}
 */
export async function runDoctor(client, { url, compile = false } = {}) {
  const steps = [];
  let instance = null;
  let size = null;
  let estimate = null;

  // Step 1: URL shape
  if (!isHttpUrl(url)) {
    steps.push(
      step(
        "url",
        "fail",
        "URL looks malformed",
        `Got "${url ?? ""}".`,
        "Use the full address you open in the browser, for example https://metabase.example.com, and export METABASE_URL."
      )
    );
    return { ok: false, steps, instance, size, estimate };
  }
  steps.push(step("url", "ok", "URL looks valid", String(url)));

  // Step 2: reachability. /api/session/properties is public, so a bad key still passes here.
  try {
    instance = await client.getInstanceInfo();
    steps.push(step("reach", "ok", `Reached ${instance.siteName}`, `Metabase ${instance.version}`));
  } catch (err) {
    steps.push(
      step(
        "reach",
        "fail",
        "Could not reach that URL",
        shortMessage(err),
        "Check the address, VPN or firewall. The endpoint /api/session/properties answers without a key, so this is not an auth problem yet."
      )
    );
    return { ok: false, steps, instance, size, estimate };
  }

  // Step 3: auth and permissions. /api/database needs a real key with enough rights.
  let databases = [];
  try {
    databases = await client.getDatabases();
  } catch (err) {
    const status = err && err.status;
    if (status === 401 || status === 403) {
      steps.push(
        step(
          "auth",
          "fail",
          "API key was rejected",
          `Metabase answered ${status} on /api/database. The key is wrong, expired, or scoped to a group that cannot see databases.`,
          KEY_FIX
        )
      );
    } else {
      steps.push(step("auth", "fail", "Connected, but /api/database failed", shortMessage(err), "Try again. If it keeps failing, open an issue with the Metabase version above."));
    }
    return { ok: false, steps, instance, size, estimate };
  }
  const realDbs = databases.filter((d) => !(d.is_sample === true));
  if (databases.length === 0) {
    steps.push(
      step(
        "auth",
        "warn",
        "Connected, but no databases visible",
        "The key works, and Metabase reports zero databases for it.",
        "If the instance has databases, the key's group lacks data access. Use an Administrators key."
      )
    );
  } else {
    steps.push(step("auth", "ok", "API key accepted", `${databases.length} database${databases.length === 1 ? "" : "s"} visible${realDbs.length !== databases.length ? " (including the Sample Database)" : ""}.`));
  }

  // Step 4: admin-only endpoints. Without them the report shows "User 42" instead of names.
  let users = [];
  try {
    users = await client.getAllUsers();
  } catch {
    users = [];
  }
  if (users.length === 0) {
    steps.push(
      step(
        "permissions",
        "warn",
        "User names not readable",
        "The key is not in the Administrators group, so owners will show as User <id> and dashboard details may be incomplete.",
        KEY_FIX
      )
    );
  } else {
    steps.push(step("permissions", "ok", "Admin endpoints readable", `${users.length} user${users.length === 1 ? "" : "s"} visible.`));
  }

  // Step 5: size, so the user knows what to expect before scan.
  try {
    const [cards, dashboards] = await Promise.all([client.getAllCards(), client.getAllDashboards()]);
    const activeCards = cards.filter((c) => !c.archived);
    const guiCards = activeCards.filter((c) => c.query_type === "query" || (c.dataset_query && c.dataset_query.type === "query")).length;
    const detailFetches = Math.min(dashboards.filter((d) => !d.archived).length, DASHBOARD_DETAILS_CAP);
    const requests = 3 + realDbs.length + detailFetches + (compile ? guiCards : 0);
    size = { cards: cards.length, activeCards: activeCards.length, guiCards, dashboards: dashboards.length, databases: databases.length, requests };
    const slow = cards.length > 2000 || detailFetches > 150 || (compile && guiCards > 300);
    estimate = slow ? "a few minutes, mostly waiting on Metabase" : "under a minute";
    steps.push(
      step(
        "size",
        "ok",
        `${cards.length} question${cards.length === 1 ? "" : "s"}, ${dashboards.length} dashboard${dashboards.length === 1 ? "" : "s"}`,
        `Scan will make about ${requests} requests; expect ${estimate}.${guiCards > 0 && !compile ? ` ${guiCards} questions are GUI-built; add --compile to check them by SQL.` : ""}`
      )
    );
  } catch (err) {
    steps.push(step("size", "warn", "Could not count questions and dashboards", shortMessage(err), "Scan may still work; this step is informational."));
  }

  const ok = steps.every((s) => s.status !== "fail");
  return { ok, steps, instance, size, estimate };
}

/** Plain-text rendering for the terminal. */
export function formatDoctor(result) {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  const lines = [];
  for (const s of result.steps) {
    lines.push(`[${mark[s.status]}] ${s.title}${s.detail ? `: ${s.detail}` : ""}`);
    if (s.fix && s.status !== "ok") lines.push(`       fix: ${s.fix}`);
  }
  lines.push(result.ok ? "Ready to scan." : "Fix the failed step above, then run doctor again.");
  return lines.join("\n");
}
