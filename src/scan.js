/**
 * One pipeline behind `scan`, `report`, `context` and the MCP tools:
 * snapshot (fetched or loaded) → findings → Markdown files.
 * Writes: <dir>/snapshot.json, <dir>/findings.json, <out>/METALENS-REPORT.md, <out>/DATA-CONTEXT.md.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { analyze } from "./analyze/index.js";
import { renderContext } from "./context.js";
import { renderReport } from "./report.js";
import { buildSnapshot, loadSnapshot, loadSnapshotFile, saveSnapshot, SNAPSHOT_FILENAME } from "./snapshot.js";
import { CONTEXT_FILENAME, FINDINGS_FILENAME, REPORT_FILENAME } from "./config.js";

/**
 * @param {object} opts
 * @param {object|null} opts.client        MetabaseClient; required unless snapshotFile is given
 * @param {string|null} opts.snapshotFile  analyse this file instead of fetching
 * @param {string} opts.url                instance URL (for links in the report when fetching)
 * @param {string} opts.dir                where snapshot.json and findings.json go
 * @param {string} opts.out                where the two Markdown files go
 * @param {boolean} opts.compile           compile GUI questions to SQL via Metabase
 * @param {boolean} opts.writeReport
 * @param {boolean} opts.writeContext
 * @param {Date} opts.now
 * @param {(p: {phase: string, done?: number, total?: number}) => void} opts.onProgress
 */
export async function runScan({
  client = null,
  snapshotFile = null,
  url = "",
  dir,
  out,
  compile = false,
  writeReport = true,
  writeContext = true,
  now = new Date(),
  onProgress = () => {},
} = {}) {
  if (!dir) throw new Error("runScan: dir is required");
  if (!out) out = dir;
  await mkdir(dir, { recursive: true });
  await mkdir(out, { recursive: true });

  let snapshot;
  let snapshotPath;
  if (snapshotFile) {
    snapshot = await loadSnapshotFile(snapshotFile);
    snapshotPath = snapshotFile;
  } else {
    if (!client) throw new Error("runScan: a client is required when no snapshot file is given");
    snapshot = await buildSnapshot(client, { url, compile, onProgress, now });
    snapshotPath = await saveSnapshot(snapshot, dir);
    if (typeof snapshotPath !== "string") snapshotPath = path.join(dir, SNAPSHOT_FILENAME);
  }

  safeProgress(onProgress, { phase: "analyze" });
  const findings = analyze(snapshot, { now });
  const findingsPath = path.join(dir, FINDINGS_FILENAME);
  await writeFile(findingsPath, `${JSON.stringify(findings, null, 2)}\n`, "utf8");

  const paths = { snapshot: snapshotPath, findings: findingsPath, report: null, context: null };

  if (writeReport) {
    safeProgress(onProgress, { phase: "report" });
    paths.report = path.join(out, REPORT_FILENAME);
    await writeFile(paths.report, renderReport(findings, { now }), "utf8");
  }
  if (writeContext) {
    safeProgress(onProgress, { phase: "context" });
    paths.context = path.join(out, CONTEXT_FILENAME);
    await writeFile(paths.context, renderContext(snapshot, findings, { now }), "utf8");
  }
  safeProgress(onProgress, { phase: "done" });
  return { snapshot, findings, paths };
}

/** Re-analyse an existing snapshot in `dir` (no network) and rewrite the requested files. */
export async function rerender({ dir, out, snapshotFile = null, now = new Date(), writeReport = true, writeContext = true } = {}) {
  const file = snapshotFile ?? path.join(dir, SNAPSHOT_FILENAME);
  return runScan({ snapshotFile: file, dir, out, now, writeReport, writeContext });
}

/** Loads <dir>/findings.json; throws a clear error when a scan has not been run. */
export async function loadFindings(dir) {
  const file = path.join(dir, FINDINGS_FILENAME);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new Error(`No findings at ${file}. Run "metabase-audit scan" first.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Findings file at ${file} is not valid JSON. Run "metabase-audit scan" again.`);
  }
}

/** Loads <dir>/snapshot.json through the snapshot module (validates schemaVersion). */
export async function loadSnapshotFromDir(dir) {
  return loadSnapshot(dir);
}

/** A slice of findings for `findings <kind>` and the MCP tool. */
export function sliceFindings(findings, kind, limit = 50) {
  const n = Math.max(1, Number(limit) || 50);
  switch (kind) {
    case "summary":
      return { summary: findings.summary, health: findings.health, instance: findings.instance, generatedAt: findings.generatedAt };
    case "duplicates":
    case "broken":
    case "stale":
    case "dashboards":
    case "actions":
    case "tables":
    case "anomalies":
    case "creators":
      return { [kind]: (findings[kind] || []).slice(0, n), total: (findings[kind] || []).length };
    default:
      throw new Error(`Unknown findings kind "${kind}". Use one of: summary, duplicates, broken, stale, dashboards, actions, tables, anomalies, creators.`);
  }
}

function safeProgress(fn, payload) {
  try {
    fn(payload);
  } catch {
    // progress listeners must never break the scan
  }
}
