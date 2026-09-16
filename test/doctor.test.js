import test from "node:test";
import assert from "node:assert/strict";

import { runDoctor, formatDoctor } from "../src/doctor.js";

function stub(overrides = {}) {
  return {
    async getInstanceInfo() { return { siteName: "Acme", version: "v0.62.3" }; },
    async getDatabases() { return [{ id: 2, name: "Warehouse", engine: "postgres" }]; },
    async getAllUsers() { return [{ id: 3, common_name: "Jane" }]; },
    async getAllCards() { return [{ id: 1, archived: false, query_type: "native" }, { id: 2, archived: false, query_type: "query" }]; },
    async getAllDashboards() { return [{ id: 20, archived: false }]; },
    ...overrides,
  };
}

test("all green on a healthy admin key", async () => {
  const r = await runDoctor(stub(), { url: "https://metabase.acme.test" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => s.status), ["ok", "ok", "ok", "ok", "ok"]);
  assert.equal(r.size.cards, 2);
  assert.equal(r.size.guiCards, 1);
  assert.match(formatDoctor(r), /Ready to scan/);
  assert.match(formatDoctor(r), /--compile/);
});

test("malformed URL fails before any request", async () => {
  let calls = 0;
  const r = await runDoctor(stub({ async getInstanceInfo() { calls++; return {}; } }), { url: "metabase" });
  assert.equal(r.ok, false);
  assert.equal(r.steps[0].status, "fail");
  assert.equal(calls, 0);
});

test("401 on /api/database is reported as a rejected key with the fix", async () => {
  const err = new Error("Metabase 401 on GET /api/database");
  err.status = 401;
  const r = await runDoctor(stub({ async getDatabases() { throw err; } }), { url: "https://metabase.acme.test" });
  assert.equal(r.ok, false);
  const auth = r.steps.find((s) => s.id === "auth");
  assert.equal(auth.status, "fail");
  assert.match(auth.title, /rejected/);
  assert.match(auth.fix, /Administrators/);
  assert.match(formatDoctor(r), /fix the failed step/i);
});

test("non-admin key warns on permissions but does not fail", async () => {
  const r = await runDoctor(stub({ async getAllUsers() { return []; } }), { url: "https://metabase.acme.test" });
  assert.equal(r.ok, true);
  const perm = r.steps.find((s) => s.id === "permissions");
  assert.equal(perm.status, "warn");
});

test("unreachable host fails on reach with a network hint", async () => {
  const r = await runDoctor(stub({ async getInstanceInfo() { throw new Error("fetch failed"); } }), { url: "https://nowhere.test" });
  assert.equal(r.ok, false);
  const reach = r.steps.find((s) => s.id === "reach");
  assert.equal(reach.status, "fail");
  assert.match(reach.fix, /VPN or firewall/);
});
