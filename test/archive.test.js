import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { archiveCards, unarchiveCards, selectFromFindings, undoFileName } from "../src/archive.js";

/** Records every getCard/updateCard call. `cards` maps id -> row (or an Error to throw on fetch). */
function makeStubClient(cards = {}, { updateCardImpl } = {}) {
  const calls = { getCard: [], updateCard: [] };
  return {
    calls,
    async getCard(id) {
      calls.getCard.push(id);
      const card = cards[id];
      if (card instanceof Error) throw card;
      return card === undefined ? null : card;
    },
    async updateCard(id, patch) {
      calls.updateCard.push({ id, patch });
      if (updateCardImpl) return updateCardImpl(id, patch);
      return { ...cards[id], ...patch };
    },
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "metalens-"));
}

const SAMPLE_FINDINGS = {
  duplicates: [
    {
      kind: "exact-sql",
      keep: {
        id: 1,
        name: "Revenue by month",
        url: "http://mb.test/question/1",
        viewCount: 120,
        lastUsedAt: "2026-09-01T00:00:00.000Z",
      },
      archive: [
        {
          id: 2,
          name: "Revenue by month (copy)",
          url: "http://mb.test/question/2",
          viewCount: 3,
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        },
        { id: 3, name: "Revenue duplicate", url: "http://mb.test/question/3", viewCount: 0, lastUsedAt: null },
      ],
    },
    {
      kind: "same-name",
      keep: { id: 10, name: "Same name kept", url: "http://mb.test/question/10", viewCount: 5, lastUsedAt: null },
      archive: [{ id: 11, name: "Same name dup", url: "http://mb.test/question/11", viewCount: 1, lastUsedAt: null }],
    },
  ],
  broken: [
    {
      id: 20,
      name: "Broken A",
      url: "http://mb.test/question/20",
      kind: "missing-table",
      reason: "table gone",
      missingTables: ["foo"],
    },
    { id: 21, name: "Broken B", url: "http://mb.test/question/21", kind: "error", reason: "sql error" },
  ],
};

// --- undoFileName --------------------------------------------------------

test("undoFileName turns an ISO date into a filesystem-safe undo filename", () => {
  assert.equal(undoFileName(new Date("2026-09-16T10:00:00.000Z")), "undo-2026-09-16T10-00-00-000Z.json");
});

// --- selectFromFindings ---------------------------------------------------

test("selectFromFindings('duplicates') selects only exact-sql archive ids, never keep ids", () => {
  const selected = selectFromFindings(SAMPLE_FINDINGS, "duplicates");
  assert.deepEqual(
    selected.map((c) => c.id),
    [2, 3],
  );
  assert.equal(selected.find((c) => c.id === 1), undefined);
  assert.equal(selected.find((c) => c.id === 11), undefined);
  assert.deepEqual(selected[0], {
    id: 2,
    name: "Revenue by month (copy)",
    url: "http://mb.test/question/2",
    viewCount: 3,
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  });
});

test("selectFromFindings('broken') selects only missing-table ids", () => {
  const selected = selectFromFindings(SAMPLE_FINDINGS, "broken");
  assert.deepEqual(
    selected.map((c) => c.id),
    [20],
  );
});

test("selectFromFindings throws on an unknown source", () => {
  assert.throws(() => selectFromFindings(SAMPLE_FINDINGS, "stale"), /Unknown findings source/);
});

// --- keep protection -------------------------------------------------------

test("archiveCards refuses to archive a duplicate group's keep card, dry run and apply", async () => {
  await assert.rejects(
    archiveCards(makeStubClient(), { ids: [1], findings: SAMPLE_FINDINGS }),
    /Card 1 is the one to keep in a duplicate group/,
  );
});

test("archiveCards keep protection also fires for apply", async () => {
  await assert.rejects(
    archiveCards(makeStubClient(), { ids: [1], apply: true, dir: tmpDir(), findings: SAMPLE_FINDINGS }),
    /Card 1 is the one to keep in a duplicate group/,
  );
});

// --- dry run -----------------------------------------------------------

test("archiveCards dry run makes no calls and enriches the plan from findings", async () => {
  const client = makeStubClient();
  const result = await archiveCards(client, { ids: [2, 3], findings: SAMPLE_FINDINGS });

  assert.equal(client.calls.getCard.length, 0);
  assert.equal(client.calls.updateCard.length, 0);
  assert.deepEqual(result, {
    apply: false,
    plan: [
      {
        id: 2,
        name: "Revenue by month (copy)",
        url: "http://mb.test/question/2",
        viewCount: 3,
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      },
      { id: 3, name: "Revenue duplicate", url: "http://mb.test/question/3", viewCount: 0, lastUsedAt: null },
    ],
  });
});

test("archiveCards dry run without findings returns null-named rows and still makes no calls", async () => {
  const client = makeStubClient();
  const result = await archiveCards(client, { ids: ["5", 5, 6] });

  assert.equal(client.calls.getCard.length, 0);
  assert.equal(client.calls.updateCard.length, 0);
  // numeric-string and number for the same id dedupe to one plan row
  assert.deepEqual(result.plan, [
    { id: 5, name: null, url: null, viewCount: null, lastUsedAt: null },
    { id: 6, name: null, url: null, viewCount: null, lastUsedAt: null },
  ]);
});

test("archiveCards rejects a non-numeric id with a clear error", async () => {
  await assert.rejects(archiveCards(makeStubClient(), { ids: ["abc"] }), /Invalid card id/);
});

test("archiveCards rejects ids that only look numeric to Number()", async () => {
  // "1e3" would silently become card 1000 and "0x10" card 16. Neither is an id
  // anybody typed on purpose.
  await assert.rejects(archiveCards(makeStubClient(), { ids: ["1e3"] }), /Invalid card id: "1e3"/);
  await assert.rejects(archiveCards(makeStubClient(), { ids: ["0x10"] }), /Invalid card id: "0x10"/);
  await assert.rejects(archiveCards(makeStubClient(), { ids: [" 12.0 "] }), /Invalid card id/);
  // plain digits, with or without surrounding space, still work
  const result = await archiveCards(makeStubClient(), { ids: [" 12 "] });
  assert.deepEqual(result.plan.map((row) => row.id), [12]);
});

test("archiveCards rejects empty ids with 'Nothing to archive'", async () => {
  await assert.rejects(archiveCards(makeStubClient(), { ids: [] }), /Nothing to archive/);
});

// --- apply: happy path ---------------------------------------------------

test("archiveCards apply archives every requested id and writes an undo file", async () => {
  const client = makeStubClient({
    2: { id: 2, name: "Revenue by month (copy)", archived: false, collection_id: 5 },
    3: { id: 3, name: "Revenue duplicate", archived: false, collection_id: 5 },
  });
  const dir = tmpDir();
  const now = new Date("2026-09-16T10:00:00.000Z");

  const result = await archiveCards(client, { ids: [2, 3], apply: true, dir, now, reason: "dup cleanup" });

  assert.equal(client.calls.getCard.length, 2);
  assert.equal(client.calls.updateCard.length, 2);
  for (const call of client.calls.updateCard) {
    assert.deepEqual(call.patch, { archived: true });
  }

  assert.equal(result.apply, true);
  assert.deepEqual(
    result.applied.map((a) => a.id).sort(),
    [2, 3],
  );
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.undoFile, path.join(dir, "undo-2026-09-16T10-00-00-000Z.json"));

  const undoData = JSON.parse(fs.readFileSync(result.undoFile, "utf8"));
  assert.equal(undoData.reason, "dup cleanup");
  assert.equal(undoData.cards.length, 2);
  for (const card of undoData.cards) {
    assert.equal(card.previous.archived, false);
  }
  assert.deepEqual(
    undoData.result.applied.map((a) => a.id).sort(),
    [2, 3],
  );
  assert.deepEqual(undoData.result.failed, []);
});

test("archiveCards apply keeps working with findings-enriched ids from selectFromFindings", async () => {
  const client = makeStubClient({
    2: { id: 2, name: "Revenue by month (copy)", archived: false, collection_id: 5 },
    3: { id: 3, name: "Revenue duplicate", archived: false, collection_id: 5 },
  });
  const ids = selectFromFindings(SAMPLE_FINDINGS, "duplicates").map((c) => c.id);
  const result = await archiveCards(client, { ids, apply: true, dir: tmpDir(), findings: SAMPLE_FINDINGS });
  assert.deepEqual(result.applied.map((a) => a.id).sort(), [2, 3]);
});

// --- apply: already archived ---------------------------------------------

test("archiveCards apply skips a card that is already archived", async () => {
  const client = makeStubClient({
    2: { id: 2, name: "Already archived", archived: true, collection_id: 5 },
    3: { id: 3, name: "Live card", archived: false, collection_id: 5 },
  });

  const result = await archiveCards(client, { ids: [2, 3], apply: true, dir: tmpDir() });

  assert.equal(client.calls.updateCard.length, 1);
  assert.equal(client.calls.updateCard[0].id, 3);
  assert.deepEqual(result.skipped, [{ id: 2, name: "Already archived", reason: "already archived" }]);
  assert.deepEqual(result.applied, [{ id: 3, name: "Live card" }]);
  assert.deepEqual(result.failed, []);
});

// --- apply: partial failure ------------------------------------------------

test("archiveCards apply continues after one updateCard rejection and records it in failed", async () => {
  const client = makeStubClient(
    {
      2: { id: 2, name: "Will fail", archived: false, collection_id: 5 },
      3: { id: 3, name: "Will succeed", archived: false, collection_id: 5 },
    },
    {
      updateCardImpl(id, patch) {
        if (id === 2) throw new Error("Metabase said no");
        return { id, ...patch };
      },
    },
  );

  const result = await archiveCards(client, { ids: [2, 3], apply: true, dir: tmpDir() });

  assert.deepEqual(result.applied, [{ id: 3, name: "Will succeed" }]);
  assert.deepEqual(result.failed, [{ id: 2, error: "Metabase said no" }]);

  const undoData = JSON.parse(fs.readFileSync(result.undoFile, "utf8"));
  // the undo file lists both cards as "about to be archived" (written before any update),
  // and the rewritten result makes the partial failure visible from the file alone.
  assert.equal(undoData.cards.length, 2);
  assert.deepEqual(undoData.result.failed, [{ id: 2, error: "Metabase said no" }]);
  assert.deepEqual(
    undoData.result.applied.map((a) => a.id),
    [3],
  );
});

test("archiveCards apply records a getCard fetch error in failed and keeps going", async () => {
  const client = makeStubClient({
    2: new Error("permission denied"),
    3: { id: 3, name: "Live card", archived: false, collection_id: 5 },
  });

  const result = await archiveCards(client, { ids: [2, 3], apply: true, dir: tmpDir() });

  assert.deepEqual(result.failed, [{ id: 2, error: "permission denied" }]);
  assert.deepEqual(result.applied, [{ id: 3, name: "Live card" }]);
});

test("archiveCards apply requires a dir", async () => {
  const client = makeStubClient({ 2: { id: 2, name: "X", archived: false } });
  await assert.rejects(archiveCards(client, { ids: [2], apply: true }), /dir is required/);
});

// --- unarchiveCards ----------------------------------------------------

function writeUndoFile(dir, data) {
  const file = path.join(dir, "undo-test.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

test("unarchiveCards dry run makes no calls and returns the plan from the undo file", async () => {
  const dir = tmpDir();
  const undoFile = writeUndoFile(dir, {
    createdAt: "2026-09-16T10:00:00.000Z",
    reason: "dup cleanup",
    cards: [
      { id: 2, name: "Revenue by month (copy)", previous: { archived: false } },
      { id: 3, name: "Revenue duplicate", previous: { archived: false } },
    ],
  });
  const client = makeStubClient();

  const result = await unarchiveCards(client, { undoFile });

  assert.equal(client.calls.getCard.length, 0);
  assert.equal(client.calls.updateCard.length, 0);
  assert.deepEqual(result, {
    apply: false,
    plan: [
      { id: 2, name: "Revenue by month (copy)" },
      { id: 3, name: "Revenue duplicate" },
    ],
  });
});

test("unarchiveCards apply replays { archived: false } for every card", async () => {
  const dir = tmpDir();
  const undoFile = writeUndoFile(dir, {
    createdAt: "2026-09-16T10:00:00.000Z",
    reason: "",
    cards: [
      { id: 2, name: "Revenue by month (copy)", previous: { archived: false } },
      { id: 3, name: "Revenue duplicate", previous: { archived: false } },
    ],
  });
  const client = makeStubClient({
    2: { id: 2, name: "Revenue by month (copy)", archived: true },
    3: { id: 3, name: "Revenue duplicate", archived: true },
  });

  const result = await unarchiveCards(client, { undoFile, apply: true });

  assert.equal(client.calls.updateCard.length, 2);
  for (const call of client.calls.updateCard) {
    assert.deepEqual(call.patch, { archived: false });
  }
  assert.deepEqual(
    result.restored.map((r) => r.id).sort(),
    [2, 3],
  );
  assert.deepEqual(result.failed, []);
});

test("unarchiveCards apply records an updateCard failure in failed", async () => {
  const dir = tmpDir();
  const undoFile = writeUndoFile(dir, {
    createdAt: "2026-09-16T10:00:00.000Z",
    reason: "",
    cards: [{ id: 2, name: "Revenue by month (copy)", previous: { archived: false } }],
  });
  const client = makeStubClient(
    { 2: { id: 2, name: "Revenue by month (copy)", archived: true } },
    {
      updateCardImpl() {
        throw new Error("Metabase unreachable");
      },
    },
  );

  const result = await unarchiveCards(client, { undoFile, apply: true });
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.failed, [{ id: 2, error: "Metabase unreachable" }]);
});

test("unarchiveCards throws a clear error when the undo file is missing", async () => {
  const dir = tmpDir();
  await assert.rejects(
    unarchiveCards(makeStubClient(), { undoFile: path.join(dir, "does-not-exist.json") }),
    /Undo file not found/,
  );
});

test("unarchiveCards throws a clear error when the undo file is malformed", async () => {
  const dir = tmpDir();
  const badFile = path.join(dir, "bad.json");
  fs.writeFileSync(badFile, "not json");
  await assert.rejects(unarchiveCards(makeStubClient(), { undoFile: badFile }), /not valid JSON/);

  const badShapeFile = path.join(dir, "bad-shape.json");
  fs.writeFileSync(badShapeFile, JSON.stringify({ createdAt: "now" }));
  await assert.rejects(unarchiveCards(makeStubClient(), { undoFile: badShapeFile }), /missing a "cards" array/);
});
