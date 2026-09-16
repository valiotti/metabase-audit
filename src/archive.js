/**
 * Archive and unarchive cards, dry run first, with an undo file.
 *
 * This is the only module in the toolkit that writes to the user's Metabase.
 * The rules are the safety net: nothing changes without `apply: true`, every
 * apply writes an undo file before it issues a single update, and a card
 * marked "keep" in a duplicate group (from `findings.json`) can never be
 * selected for archiving, in dry run or in apply.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { mapWithConcurrency } from "./util.js";

const CONCURRENCY = 3;

/** Turns a Date (or anything `new Date()` accepts) into "undo-<ISO with : and . as ->.json". */
export function undoFileName(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const iso = date.toISOString().replace(/[:.]/g, "-");
  return `undo-${iso}.json`;
}

/**
 * Picks the ids to archive out of `findings.json` for a given source.
 * "duplicates" takes only `exact-sql` groups (never `same-name`, and never
 * the `keep` card). "broken" takes only `missing-table` entries (not
 * `error`, which is not necessarily safe to remove). Throws on any other
 * source name.
 */
export function selectFromFindings(findings, source) {
  if (!findings || typeof findings !== "object") {
    throw new Error("selectFromFindings: findings is required");
  }

  let candidates;
  if (source === "duplicates") {
    candidates = (findings.duplicates ?? [])
      .filter((group) => group.kind === "exact-sql")
      .flatMap((group) => group.archive ?? []);
  } else if (source === "broken") {
    candidates = (findings.broken ?? []).filter((item) => item.kind === "missing-table");
  } else {
    throw new Error(`Unknown findings source: "${source}" (expected "duplicates" or "broken")`);
  }

  return dedupeById(candidates).map(toSelectionRow);
}

/**
 * Dry run (default): validates and enriches, makes no network calls, returns
 * `{ apply: false, plan }`.
 *
 * Apply: fetches each card, skips any that are already archived, writes an
 * undo file listing every card about to be archived, flips `archived: true`
 * on the rest (concurrency 3), then rewrites the undo file with a `result`
 * so a partial failure is visible from the file alone. Returns
 * `{ apply: true, applied, skipped, failed, undoFile }`.
 */
export async function archiveCards(client, options = {}) {
  const { ids, apply = false, reason = "", dir, now = new Date(), findings = null } = options;

  const uniqueIds = normalizeIds(ids);
  if (uniqueIds.length === 0) {
    throw new Error("Nothing to archive");
  }
  assertNoneAreKeepers(findings, uniqueIds);

  if (!apply) {
    return {
      apply: false,
      plan: uniqueIds.map((id) => toPlanRow(id, lookupFinding(findings, id))),
    };
  }

  if (!dir) {
    throw new Error("archiveCards: dir is required when apply is true");
  }

  const classified = await mapWithConcurrency(uniqueIds, CONCURRENCY, (id) => classifyForArchive(client, id));

  const failed = [];
  const skipped = [];
  const toArchive = [];
  for (const item of classified) {
    if (item.status === "fetch-error") {
      failed.push({ id: item.id, error: item.error });
    } else if (item.status === "not-found") {
      failed.push({ id: item.id, error: "Card not found" });
    } else if (item.status === "already-archived") {
      skipped.push({ id: item.id, name: item.name, reason: "already archived" });
    } else {
      toArchive.push(item);
    }
  }

  await mkdir(dir, { recursive: true });
  const undoPath = path.join(dir, undoFileName(now));
  const undoData = {
    createdAt: now.toISOString(),
    reason,
    cards: toArchive.map((c) => ({ id: c.id, name: c.name, previous: { archived: c.previousArchived } })),
  };
  await writeFile(undoPath, JSON.stringify(undoData, null, 2));

  const applied = [];
  const updateResults = await mapWithConcurrency(toArchive, CONCURRENCY, (c) => applyOneArchive(client, c));
  for (const result of updateResults) {
    if (result.ok) {
      applied.push({ id: result.id, name: result.name });
    } else {
      failed.push({ id: result.id, error: result.error });
    }
  }

  undoData.result = {
    applied: applied.map((a) => ({ id: a.id, name: a.name })),
    failed: failed.map((f) => ({ id: f.id, error: f.error })),
  };
  await writeFile(undoPath, JSON.stringify(undoData, null, 2));

  return { apply: true, applied, skipped, failed, undoFile: undoPath };
}

/**
 * Reverses one `archiveCards` apply run from its undo file.
 *
 * Dry run (default): returns `{ apply: false, plan }` from the file's card
 * list, no network calls. Apply: replays `updateCard(id, { archived:
 * previous.archived })` (always `false`) for every card the file says was
 * live before the archive, and returns `{ apply: true, restored, failed }`.
 */
export async function unarchiveCards(client, options = {}) {
  const { undoFile, apply = false } = options;
  const data = await readUndoFile(undoFile);
  const cards = data.cards;

  if (!apply) {
    return {
      apply: false,
      plan: cards.map((c) => ({ id: c.id, name: c.name ?? null })),
    };
  }

  const restorable = cards.filter((c) => c.previous && c.previous.archived === false);
  const results = await mapWithConcurrency(restorable, CONCURRENCY, (c) => applyOneUnarchive(client, c));

  const restored = [];
  const failed = [];
  for (const result of results) {
    if (result.ok) {
      restored.push({ id: result.id, name: result.name });
    } else {
      failed.push({ id: result.id, error: result.error });
    }
  }

  return { apply: true, restored, failed };
}

// --- internals ---------------------------------------------------------

/** Accepts numbers or numeric strings, dedupes, rejects anything else with a clear message. */
function normalizeIds(ids) {
  const list = ids ?? [];
  if (!Array.isArray(list)) {
    throw new Error("ids must be an array of card ids");
  }

  const seen = new Set();
  const result = [];
  for (const raw of list) {
    const isNumber = typeof raw === "number";
    // Only plain digits: "1e3" and "0x10" are numbers to `Number()` and card
    // ids to nobody, so they are rejected instead of quietly becoming 1000.
    const isNumericString = typeof raw === "string" && /^\d+$/.test(raw.trim());
    if (!isNumber && !isNumericString) {
      throw new Error(`Invalid card id: ${JSON.stringify(raw)} (must be a number or a numeric string)`);
    }
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      throw new Error(`Invalid card id: ${JSON.stringify(raw)} (must be a whole number)`);
    }
    if (!seen.has(n)) {
      seen.add(n);
      result.push(n);
    }
  }
  return result;
}

/** Throws if any requested id is the `keep` card of a duplicate group in `findings`. */
function assertNoneAreKeepers(findings, ids) {
  if (!findings) return;
  const keepIds = new Set();
  for (const group of findings.duplicates ?? []) {
    if (group.keep && group.keep.id !== undefined && group.keep.id !== null) {
      keepIds.add(Number(group.keep.id));
    }
  }
  for (const id of ids) {
    if (keepIds.has(id)) {
      throw new Error(`Card ${id} is the one to keep in a duplicate group; refusing to archive it`);
    }
  }
}

/** Searches `duplicates[].archive[]`, `duplicates[].keep`, `broken[]` and `stale[]` for `id`. */
function lookupFinding(findings, id) {
  if (!findings) return null;

  for (const group of findings.duplicates ?? []) {
    if (group.keep && Number(group.keep.id) === id) return group.keep;
    for (const item of group.archive ?? []) {
      if (Number(item.id) === id) return item;
    }
  }
  for (const item of findings.broken ?? []) {
    if (Number(item.id) === id) return item;
  }
  for (const item of findings.stale ?? []) {
    if (Number(item.id) === id) return item;
  }
  return null;
}

function toPlanRow(id, found) {
  return {
    id,
    name: found?.name ?? null,
    url: found?.url ?? null,
    viewCount: found?.viewCount ?? null,
    lastUsedAt: found?.lastUsedAt ?? null,
  };
}

function toSelectionRow(item) {
  return {
    id: item.id,
    name: item.name ?? null,
    url: item.url ?? null,
    viewCount: item.viewCount ?? null,
    lastUsedAt: item.lastUsedAt ?? null,
  };
}

function dedupeById(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

/** Fetches one card and sorts it into "to archive" / "already archived" / not found / fetch error. */
async function classifyForArchive(client, id) {
  let card;
  try {
    card = await client.getCard(id);
  } catch (error) {
    return { id, status: "fetch-error", error: error.message };
  }
  if (!card) {
    return { id, status: "not-found" };
  }
  if (card.archived === true) {
    return { id, status: "already-archived", name: card.name ?? null };
  }
  return {
    id,
    status: "to-archive",
    name: card.name ?? null,
    previousArchived: card.archived === true,
    collectionId: card.collection_id ?? null,
  };
}

async function applyOneArchive(client, c) {
  try {
    await client.updateCard(c.id, { archived: true });
    return { ok: true, id: c.id, name: c.name };
  } catch (error) {
    return { ok: false, id: c.id, error: error.message };
  }
}

async function applyOneUnarchive(client, c) {
  try {
    await client.updateCard(c.id, { archived: c.previous.archived });
    return { ok: true, id: c.id, name: c.name ?? null };
  } catch (error) {
    return { ok: false, id: c.id, error: error.message };
  }
}

/** Reads and validates an undo file, throwing a clear error for every way it can be unusable. */
async function readUndoFile(undoFile) {
  if (!undoFile) {
    throw new Error("unarchiveCards: undoFile is required");
  }

  let raw;
  try {
    raw = await readFile(undoFile, "utf8");
  } catch {
    throw new Error(`Undo file not found: ${undoFile}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Undo file is not valid JSON: ${undoFile}`);
  }

  if (!data || !Array.isArray(data.cards)) {
    throw new Error(`Undo file is malformed, missing a "cards" array: ${undoFile}`);
  }

  return data;
}
