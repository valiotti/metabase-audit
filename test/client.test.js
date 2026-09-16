import test from "node:test";
import assert from "node:assert/strict";
import { MetabaseClient, MetabaseHttpError } from "../src/client.js";

/** Builds a fake `fetch` that serves canned responses in order and records every call. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    const index = Math.min(calls.length, responses.length - 1);
    calls.push({ url, init });
    const entry = responses[index];
    if (typeof entry === "function") return entry(url, init);
    return entry;
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => JSON.stringify(body),
  };
}

/** A fetch that never resolves on its own; it only rejects once the request's AbortSignal fires. */
function hangingFetch() {
  const fn = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  fn.calls = [];
  return fn;
}

test("sends x-api-key/content-type/user-agent headers and joins the URL without a double slash", async () => {
  const fetchImpl = fakeFetch([jsonResponse(200, [])]);
  const client = new MetabaseClient({ url: "http://localhost:9999/", apiKey: "secret-key", fetchImpl });

  await client.getDatabases();

  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "http://localhost:9999/api/database");
  assert.equal(init.headers["x-api-key"], "secret-key");
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["user-agent"], "metabase-audit/0.1.0");
});

test("getDatabases unwraps both a plain array and a {data:[...]} wrapper", async () => {
  const arrayFetch = fakeFetch([jsonResponse(200, [{ id: 1, name: "db1" }])]);
  const arrayClient = new MetabaseClient({ url: "http://x.test", apiKey: "k", fetchImpl: arrayFetch });
  assert.deepEqual(await arrayClient.getDatabases(), [{ id: 1, name: "db1" }]);

  const wrappedFetch = fakeFetch([jsonResponse(200, { data: [{ id: 2, name: "db2" }] })]);
  const wrappedClient = new MetabaseClient({ url: "http://x.test", apiKey: "k", fetchImpl: wrappedFetch });
  assert.deepEqual(await wrappedClient.getDatabases(), [{ id: 2, name: "db2" }]);
});

test("retries once on a 503 then succeeds", async () => {
  const fetchImpl = fakeFetch([jsonResponse(503, { error: "unavailable" }), jsonResponse(200, [{ id: 1 }])]);
  const client = new MetabaseClient({ url: "http://x.test", apiKey: "k", fetchImpl, retryDelayMs: 1 });

  const result = await client.getDatabases();

  assert.deepEqual(result, [{ id: 1 }]);
  assert.equal(fetchImpl.calls.length, 2);
});

test("does not retry on a 401 and throws MetabaseHttpError", async () => {
  const fetchImpl = fakeFetch([jsonResponse(401, { error: "unauthorized" })]);
  const client = new MetabaseClient({ url: "http://x.test", apiKey: "k", fetchImpl, retryDelayMs: 1 });

  await assert.rejects(
    () => client.getDatabases(),
    (error) => {
      assert.ok(error instanceof MetabaseHttpError);
      assert.equal(error.status, 401);
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test("getAllDashboards falls back to /api/search?models=dashboard when /api/dashboard 404s", async () => {
  const fetchImpl = fakeFetch([
    jsonResponse(404, { error: "not found" }),
    jsonResponse(200, {
      data: [
        {
          id: 5,
          name: "Sales",
          description: "desc",
          collection: { id: 3 },
          archived: false,
          view_count: 7,
          last_used_at: "2026-01-01T00:00:00.000Z",
          creator_id: 9,
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-06-01T00:00:00.000Z",
        },
      ],
    }),
  ]);
  const client = new MetabaseClient({ url: "http://x.test", apiKey: "k", fetchImpl, retryDelayMs: 1 });

  const dashboards = await client.getAllDashboards();

  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0].url, /\/api\/dashboard$/);
  assert.match(fetchImpl.calls[1].url, /\/api\/search\?.*models=dashboard/);
  assert.deepEqual(dashboards, [
    {
      id: 5,
      name: "Sales",
      description: "desc",
      collection: { id: 3 },
      archived: false,
      view_count: 7,
      last_used_at: "2026-01-01T00:00:00.000Z",
      last_viewed_at: "2026-01-01T00:00:00.000Z",
      creator_id: 9,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-06-01T00:00:00.000Z",
      collection_id: 3,
    },
  ]);
});

test("getAllUsers returns [] on a 403 instead of throwing", async () => {
  const fetchImpl = fakeFetch([jsonResponse(403, { error: "forbidden" })]);
  const client = new MetabaseClient({ url: "http://x.test", apiKey: "k", fetchImpl, retryDelayMs: 1 });

  assert.deepEqual(await client.getAllUsers(), []);
});

test("request times out and rejects with a 'timed out' message", async () => {
  const fetchImpl = hangingFetch();
  const client = new MetabaseClient({
    url: "http://x.test",
    apiKey: "k",
    fetchImpl,
    timeoutMs: 10,
    retries: 1,
  });

  await assert.rejects(() => client.getDatabases(), (error) => {
    assert.match(error.message, /timed out/);
    return true;
  });
});

test("compileToNative returns null when the server answers 400", async () => {
  const fetchImpl = fakeFetch([jsonResponse(400, { error: "invalid query" })]);
  const client = new MetabaseClient({ url: "http://x.test", apiKey: "k", fetchImpl, retryDelayMs: 1 });

  const result = await client.compileToNative({ type: "native", native: { query: "select 1" } });

  assert.equal(result, null);
  assert.equal(fetchImpl.calls.length, 1);
});
