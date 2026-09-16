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
  const url = normalizeUrl(flags.url ?? env[ENV_URL] ?? "");
  const apiKey = String(flags.key ?? env[ENV_KEY] ?? "");
  const dir = path.resolve(cwd, String(flags.dir ?? env[ENV_DIR] ?? ".metalens"));
  const out = path.resolve(cwd, String(flags.out ?? "."));
  const snapshotFile = flags.snapshot ?? env[ENV_SNAPSHOT] ?? null;
  return {
    url,
    apiKey,
    dir,
    out,
    snapshotFile: snapshotFile ? path.resolve(cwd, String(snapshotFile)) : null,
    hasConnection: Boolean(url && apiKey),
    maskedKey: maskSecret(apiKey),
  };
}

/** Adds https:// when the scheme is missing and strips trailing slashes. */
export function normalizeUrl(value) {
  let u = String(value ?? "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, "");
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
