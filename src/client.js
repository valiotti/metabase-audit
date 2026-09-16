/**
 * Metabase REST API client.
 *
 * Talks to a single Metabase instance over `x-api-key` auth, plus a basic-auth
 * header when the instance sits behind a proxy that asks for one. No runtime
 * dependencies: uses the built-in `fetch` and `AbortController` (Node >= 18).
 *
 * Ported from the MetaLens SaaS (`metabase-client.ts`): endpoints, fallback
 * behaviour (dashboard search fallback, activity 404, user 403) and the
 * retry/backoff policy are kept faithful to that source.
 */

/** Package version, also sent as the `user-agent` header. */
export const VERSION = "0.1.0";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Thrown for any non-2xx Metabase response that isn't retried away. */
export class MetabaseHttpError extends Error {
  constructor(message, status, path, body) {
    super(message);
    this.name = "MetabaseHttpError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Metabase list endpoints return either a plain array (older versions) or `{ data: [...] }`. */
function unwrapList(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.data)) return result.data;
  return [];
}

/** `version` in `/api/session/properties` is either `{ tag }` or a plain string, depending on version. */
function versionString(props) {
  const version = props && props.version;
  if (version && typeof version === "object") return String(version.tag || "unknown");
  if (version) return String(version);
  return "unknown";
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Parses the response body as JSON; a 2xx with an empty or non-JSON body resolves to null. */
/** `Basic base64(user:password)`, or null when there are no credentials. */
function basicAuthHeader(basicAuth) {
  if (!basicAuth) return null;
  const username = String(basicAuth.username ?? "");
  const password = String(basicAuth.password ?? "");
  if (!username && !password) return null;
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function safeJson(res) {
  const text = await safeText(res);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class MetabaseClient {
  constructor({
    url,
    apiKey,
    basicAuth = null,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    retries = 3,
    retryDelayMs = 1000,
    logger = null,
  }) {
    this.baseUrl = String(url ?? "").replace(/\/+$/, "");
    this.apiKey = apiKey;
    // Kept as a ready-made header so the credentials are encoded once and are
    // never part of the URL, which is what gets printed and written to disk.
    this.basicAuthHeader = basicAuthHeader(basicAuth);
    this.basicPassword = basicAuth && basicAuth.password ? String(basicAuth.password) : "";
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = Math.max(1, retries);
    this.retryDelayMs = retryDelayMs;
    this.logger = logger;
  }

  _log(message) {
    if (typeof this.logger !== "function") return;
    try {
      this.logger(message);
    } catch {
      // logging must never break a request
    }
  }

  async _backoff(attempt) {
    // attempt is 1-indexed (the try that just failed); exponent is 0-indexed like the SaaS source.
    const delay = this.retryDelayMs * Math.pow(2, attempt - 1) * (0.5 + Math.random());
    await sleep(delay);
  }

  /**
   * Low-level request. `path` includes the `/api/...` prefix (e.g. `/api/dashboard`).
   * Retries on network errors, timeouts and 429/5xx, with exponential backoff + jitter.
   * Never retries other 4xx statuses.
   */
  /**
   * A proxy or a misconfigured instance can echo request headers back in an
   * error body. Those bodies end up in warnings and undo files, so the secrets
   * this client holds are blanked before anything leaves it.
   */
  redactSecrets(text) {
    let out = String(text ?? "");
    if (this.apiKey) out = out.split(this.apiKey).join("****");
    if (this.basicPassword) out = out.split(this.basicPassword).join("****");
    return out;
  }

  async request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const maxAttempts = this.retries;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res;
      try {
        const headers = {
          "x-api-key": this.apiKey,
          "content-type": "application/json",
          "user-agent": `metabase-audit/${VERSION}`,
        };
        if (this.basicAuthHeader) headers.authorization = this.basicAuthHeader;
        const init = { method, headers, signal: controller.signal };
        if (body !== undefined) init.body = JSON.stringify(body);
        res = await this.fetchImpl(url, init);
      } catch (error) {
        clearTimeout(timer);
        const isTimeout = error && error.name === "AbortError";
        const message = isTimeout
          ? `Metabase request timed out after ${this.timeoutMs / 1000}s: ${method} ${path}`
          : `Failed to reach Metabase: ${error && error.message ? error.message : String(error)}`;
        if (attempt < maxAttempts) {
          this._log(`${message} (attempt ${attempt}/${maxAttempts}, retrying)`);
          await this._backoff(attempt);
          continue;
        }
        throw new Error(message);
      }
      clearTimeout(timer);

      if (!res.ok) {
        if (RETRYABLE_STATUSES.has(res.status) && attempt < maxAttempts) {
          this._log(`Metabase ${res.status} on ${method} ${path} (attempt ${attempt}/${maxAttempts}, retrying)`);
          // Read the body we are about to discard: an undrained response keeps
          // the socket busy, and the next attempt then waits on it.
          await res.text().catch(() => {});
          await this._backoff(attempt);
          continue;
        }
        const text = await safeText(res);
        throw new MetabaseHttpError(
          `Metabase ${res.status} on ${method} ${path}`,
          res.status,
          path,
          this.redactSecrets(text.slice(0, 300))
        );
      }

      return safeJson(res);
    }

    // Unreachable: the loop above always either returns or throws.
    throw new Error(`Metabase request failed: ${method} ${path}`);
  }

  /** GET /api/session/properties → { siteName, version } */
  async getInstanceInfo() {
    const props = await this.request("GET", "/api/session/properties");
    return {
      siteName: String((props && props["site-name"]) || "Metabase"),
      version: versionString(props || {}),
    };
  }

  /** GET /api/database → array (unwraps `{ data: [...] }`) */
  async getDatabases() {
    const result = await this.request("GET", "/api/database");
    return unwrapList(result);
  }

  /** GET /api/database/:id/metadata → { tables: [{ id, name, schema, display_name, description, fields:[...] }] } */
  async getDatabaseMetadata(dbId) {
    return this.request("GET", `/api/database/${dbId}/metadata?include_hidden=true`);
  }

  /** GET /api/table, a flat list across all databases; used as a fallback when the metadata endpoint fails. */
  async getAllTables() {
    const result = await this.request("GET", "/api/table");
    return unwrapList(result);
  }

  /** GET /api/card */
  async getAllCards() {
    const result = await this.request("GET", "/api/card");
    return unwrapList(result);
  }

  /** GET /api/card/:id, null on any error (missing, no permission, etc). */
  async getCard(id) {
    try {
      return await this.request("GET", `/api/card/${id}`);
    } catch {
      return null;
    }
  }

  /** GET /api/collection */
  async getCollections() {
    const result = await this.request("GET", "/api/collection");
    return unwrapList(result);
  }

  /** GET /api/user, [] on 402/403/404 (non-admin key, or feature disabled), instead of throwing. */
  async getAllUsers() {
    try {
      const result = await this.request("GET", "/api/user?include_deactivated=true");
      return unwrapList(result);
    } catch (error) {
      if (error instanceof MetabaseHttpError && [402, 403, 404].includes(error.status)) {
        return [];
      }
      throw error;
    }
  }

  /**
   * GET /api/user/:id, null on 402/403/404 instead of throwing.
   *
   * The list endpoint hides the synthetic users Metabase creates behind API
   * keys, yet questions made with an API key carry that user's id as
   * `creator_id`, so the snapshot resolves those ids one by one.
   */
  async getUser(id) {
    try {
      return await this.request("GET", `/api/user/${id}`);
    } catch (error) {
      if (error instanceof MetabaseHttpError && [402, 403, 404].includes(error.status)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * GET /api/dashboard, falling back to GET /api/search?models=dashboard when the primary
   * endpoint 404s or returns an empty list (older Metabase only lists the root collection there).
   * Search rows are mapped onto the same shape the primary endpoint would have produced.
   */
  async getAllDashboards() {
    let primary = null;
    try {
      const result = await this.request("GET", "/api/dashboard");
      primary = unwrapList(result);
    } catch (error) {
      if (!(error instanceof MetabaseHttpError && error.status === 404)) {
        throw error;
      }
    }
    if (primary && primary.length > 0) return primary;

    const searchResult = await this.request("GET", "/api/search?q=&models=dashboard&limit=2000");
    const rows = searchResult && Array.isArray(searchResult.data) ? searchResult.data : [];
    return rows.map((row) => ({
      ...row,
      description: row.description ?? null,
      collection_id: row.collection?.id ?? null,
      archived: !!row.archived,
      view_count: row.view_count ?? 0,
      last_viewed_at: row.last_viewed_at ?? row.last_used_at ?? null,
      creator_id: row.creator_id ?? null,
    }));
  }

  /** GET /api/dashboard/:id → includes dashcards[].card_id. Normalizes legacy `ordered_cards` to `dashcards`. */
  async getDashboard(id) {
    const result = await this.request("GET", `/api/dashboard/${id}`);
    if (result && !Array.isArray(result.dashcards) && Array.isArray(result.ordered_cards)) {
      return { ...result, dashcards: result.ordered_cards };
    }
    return result;
  }

  /** GET /api/activity?limit=..., [] on 404 (endpoint removed in newer Metabase). */
  async getActivity(limit = 2000) {
    try {
      const result = await this.request("GET", `/api/activity?limit=${limit}`);
      return unwrapList(result);
    } catch (error) {
      if (error instanceof MetabaseHttpError && error.status === 404) {
        return [];
      }
      throw error;
    }
  }

  /**
   * POST /api/dataset/native compiles a structured (MBQL) dataset_query to native SQL.
   * Returns null on any error (broken query, permissions, ...) rather than throwing;
   * the underlying request still retries on network errors and 429/5xx.
   */
  async compileToNative(datasetQuery) {
    try {
      const result = await this.request("POST", "/api/dataset/native", datasetQuery);
      return (result && result.query) || null;
    } catch {
      return null;
    }
  }

  /** PUT /api/card/:id, used by archive/unarchive to flip `archived`. */
  async updateCard(id, patch) {
    return this.request("PUT", `/api/card/${id}`, patch);
  }
}
