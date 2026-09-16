/**
 * Resolves connection settings and output locations from flags and env.
 * The API key is never written anywhere and is masked in messages.
 */

import path from "node:path";
import { maskSecret } from "./util.js";

export const ENV_URL = "METABASE_URL";
export const ENV_KEY = "METABASE_API_KEY";
export const ENV_DIR = "METALENS_DIR";
export const ENV_SNAPSHOT = "METALENS_SNAPSHOT";

export const REPORT_FILENAME = "METALENS-REPORT.md";
export const CONTEXT_FILENAME = "DATA-CONTEXT.md";
export const FINDINGS_FILENAME = "findings.json";

/**
 * @param {object} flags   parsed CLI flags ({ url, key, dir, out, snapshot })
 * @param {object} env     process.env or a stub
 * @param {string} cwd
 */
export function resolveConfig(flags = {}, env = process.env, cwd = process.cwd()) {
  const rawUrl = flags.url ?? env[ENV_URL] ?? "";
  const url = normalizeUrl(rawUrl);
  const basicAuth = extractBasicAuth(rawUrl);
  const apiKey = String(flags.key ?? env[ENV_KEY] ?? "");
  const dir = path.resolve(cwd, String(flags.dir ?? env[ENV_DIR] ?? ".metalens"));
  const out = path.resolve(cwd, String(flags.out ?? "."));
  const snapshotFile = flags.snapshot ?? env[ENV_SNAPSHOT] ?? null;
  return {
    url,
    basicAuth,
    apiKey,
    dir,
    out,
    snapshotFile: snapshotFile ? path.resolve(cwd, String(snapshotFile)) : null,
    hasConnection: Boolean(url && apiKey),
    maskedKey: maskSecret(apiKey),
  };
}

/** Adds the scheme when it is missing, so `new URL()` has something to parse. */
function withScheme(value) {
  const u = String(value ?? "").trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/**
 * Adds https:// when the scheme is missing, drops any `user:password@` in front
 * of the host, and strips the query, the fragment and trailing slashes. The
 * result is what goes into the snapshot and every printed link, so credentials
 * a person pasted into the URL never reach a file. `resolveConfig` keeps them
 * separately in `basicAuth`.
 */
export function normalizeUrl(value) {
  const u = withScheme(value);
  if (!u) return "";
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return u.replace(/\/+$/, "");
  }
  parsed.username = "";
  parsed.password = "";
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

/**
 * `{ username, password }` when the URL carries basic-auth credentials, null
 * otherwise. Some self-hosted instances sit behind a basic-auth proxy, so the
 * client still sends them, it just never writes them down.
 */
export function extractBasicAuth(value) {
  const u = withScheme(value);
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (!parsed.username && !parsed.password) return null;
  return {
    username: safeDecode(parsed.username),
    password: safeDecode(parsed.password),
  };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Message shown when a command needs Metabase and nothing is configured. */
export function missingConnectionMessage() {
  return [
    `No Metabase connection configured.`,
    `Set ${ENV_URL} and ${ENV_KEY} in the environment (or pass --url and --key),`,
    `or pass --snapshot <file> to analyse a saved snapshot without network access.`,
    `Create a key in Metabase: Admin settings, Authentication, API Keys, group Administrators.`,
  ].join("\n");
}
