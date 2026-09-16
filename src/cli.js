/**
 * Command line interface: parsing, routing, printing. The work itself lives in
 * the modules this file calls, so each command here stays short enough to read.
 *
 * Two rules shape the file. Every line of human output goes through the
 * injected `stdout`/`stderr` streams, so tests capture it and the `mcp` command
 * can keep stdout clean for the protocol. And the API key is masked before
 * anything is written, including error messages that may quote it back.
 */

import path from "node:path";

import { archiveCards, selectFromFindings, unarchiveCards } from "./archive.js";
import { MetabaseClient, VERSION } from "./client.js";
import { missingConnectionMessage, resolveConfig } from "./config.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { loadFindings, rerender, runScan, sliceFindings } from "./scan.js";
import { fmtInt, maskSecret, pad } from "./util.js";

/** Flags that take a value, either `--flag value` or `--flag=value`. */
const VALUE_FLAGS = new Set(["url", "key", "dir", "out", "snapshot", "now", "ids", "from", "reason", "undo", "limit"]);
/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(["json", "quiet", "compile", "apply", "help", "version"]);
/** `--no-report` and `--no-context` turn the matching output off. */
const NEGATED_FLAGS = new Map([["no-report", "report"], ["no-context", "context"]]);
const SHORT_FLAGS = new Map([["h", "help"], ["v", "version"]]);

const KINDS = "summary, duplicates, broken, stale, dashboards, actions, tables, anomalies, creators";

/**
 * Splits argv into `{ command, args, flags }`. Flags may appear anywhere, in
 * either form; the first non-flag token is the command and the rest are its
 * arguments. Throws on an unknown flag or a value flag with nothing after it.
 */
export function parseArgs(argv = []) {
  const list = Array.isArray(argv) ? argv : [];
  const flags = {};
  const positionals = [];
  let rest = false;

  for (let i = 0; i < list.length; i++) {
    const token = String(list[i]);

    if (rest || token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      rest = true;
      continue;
    }

    let name;
    let inline = null;
    let hasInline = false;

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        name = body.slice(0, eq);
        inline = body.slice(eq + 1);
        hasInline = true;
      } else {
        name = body;
      }
    } else {
      const body = token.slice(1);
      const eq = body.indexOf("=");
      const short = eq >= 0 ? body.slice(0, eq) : body;
      if (!SHORT_FLAGS.has(short)) throw usageError(`Unknown option "${token}".`);
      name = SHORT_FLAGS.get(short);
      if (eq >= 0) {
        inline = body.slice(eq + 1);
        hasInline = true;
      }
    }

    if (NEGATED_FLAGS.has(name)) {
      if (hasInline) throw usageError(`Option "--${name}" takes no value.`);
      flags[NEGATED_FLAGS.get(name)] = false;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = hasInline ? truthy(inline) : true;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      let value = inline;
      if (!hasInline) {
        value = list[++i];
        if (value === undefined) throw usageError(`Option "--${name}" needs a value.`);
      }
      flags[name] = String(value);
      continue;
    }
    throw usageError(`Unknown option "${token}".`);
  }

  const [command = null, ...args] = positionals;
  return { command, args, flags };
}

/**
 * Runs one command and returns the process exit code.
 * 0 success, 1 the command ran and found a problem, 2 the invocation was wrong.
 */
export async function main(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (text) => write(stdout, text);
  const fail = (text) => write(stderr, text);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    fail(error.message);
    fail(`Run "metabase-audit help" for the list of options.`);
    return 2;
  }

  const { command, args, flags } = parsed;

  if (flags.version) {
    out(VERSION);
    return 0;
  }
  if (flags.help || !command || command === "help") {
    out(usage());
    return 0;
  }

  const config = resolveConfig(flags, env, cwd);

  let now;
  try {
    now = parseNow(flags.now);
  } catch (error) {
    fail(error.message);
    return 2;
  }

  const ctx = { config, flags, args, now, env, cwd, out, fail };

  try {
    switch (command) {
      case "doctor":
        return await cmdDoctor(ctx);
      case "scan":
        return await cmdScan(ctx);
      case "report":
      case "context":
        return await cmdRerender(ctx, command);
      case "findings":
        return await cmdFindings(ctx);
      case "archive":
        return await cmdArchive(ctx);
      case "unarchive":
        return await cmdUnarchive(ctx);
      case "mcp":
        return await cmdMcp(ctx);
      default:
        fail(`Unknown command "${command}".`);
        fail(`Run "metabase-audit help" for the list of commands.`);
        return 2;
    }
  } catch (error) {
    fail(redact(error && error.message ? error.message : String(error), config));
    return 1;
  }
}

// --- commands ----------------------------------------------------------

async function cmdDoctor({ config, flags, out, fail }) {
  if (!config.hasConnection) {
    fail(missingConnectionMessage());
    return 2;
  }
  const result = await runDoctor(client(config), { url: config.url, compile: flags.compile === true });
  out(flags.json ? json(result) : formatDoctor(result));
  return result.ok ? 0 : 1;
}

async function cmdScan({ config, flags, now, out, fail }) {
  const fromFile = Boolean(config.snapshotFile);
  if (!fromFile && !config.hasConnection) {
    fail(missingConnectionMessage());
    return 2;
  }

  const result = await runScan({
    client: fromFile ? null : client(config),
    snapshotFile: config.snapshotFile,
    url: config.url,
    dir: config.dir,
    out: config.out,
    compile: flags.compile === true,
    writeReport: flags.report !== false,
    writeContext: flags.context !== false,
    now,
    onProgress: progressWriter(flags, fail),
  });

  if (flags.json) {
    out(json({ summary: result.findings.summary, health: result.findings.health, paths: result.paths }));
  } else {
    out(scanSummary(result.findings, result.paths));
  }
  return 0;
}

async function cmdRerender({ config, flags, now, out }, command) {
  const result = await rerender({
    dir: config.dir,
    out: config.out,
    snapshotFile: config.snapshotFile,
    now,
    writeReport: command === "report",
    writeContext: command === "context",
  });
  const written = command === "report" ? result.paths.report : result.paths.context;
  out(flags.json ? json({ paths: result.paths }) : written);
  return 0;
}

async function cmdFindings(ctx) {
  const { args, flags, out, fail } = ctx;
  const kind = args[0];
  if (!kind) {
    fail(`findings needs a kind. One of: ${KINDS}.`);
    return 2;
  }
  const findings = await readFindings(ctx);
  let slice;
  try {
    slice = sliceFindings(findings, kind, flags.limit ?? 50);
  } catch (error) {
    fail(error.message);
    return 2;
  }
  out(json(slice));
  return 0;
}

async function cmdArchive(ctx) {
  const { config, flags, now, out, fail } = ctx;
  const apply = flags.apply === true;

  if (!flags.ids && !flags.from) {
    fail(`archive needs --ids <a,b> or --from <duplicates|broken>.`);
    return 2;
  }
  if (apply && !config.hasConnection) {
    fail(missingConnectionMessage());
    return 2;
  }

  // Findings drive --from and protect the "keep" card of every duplicate group.
  // With explicit ids we can work without them, but we say so.
  let findings = null;
  try {
    findings = await readFindings(ctx);
  } catch (error) {
    if (flags.from) {
      fail(error.message);
      return 1;
    }
    fail(`${error.message} Continuing with the ids you passed, without duplicate-group protection.`);
  }

  let ids;
  if (flags.ids) {
    ids = String(flags.ids)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  } else {
    ids = selectFromFindings(findings, String(flags.from)).map((row) => row.id);
  }

  if (ids.length === 0) {
    out(`Nothing to archive.`);
    return 0;
  }

  const result = await archiveCards(apply ? client(config) : null, {
    ids,
    apply,
    reason: flags.reason ?? "",
    dir: config.dir,
    now,
    findings,
  });

  if (flags.json) {
    out(json(result));
    return apply && result.failed.length > 0 ? 1 : 0;
  }

  if (!apply) {
    out(planTable(result.plan));
    out(`Dry run: ${result.plan.length} question${result.plan.length === 1 ? "" : "s"} would be archived. Re-run with --apply to archive them.`);
    return 0;
  }

  out(`Archived ${result.applied.length} question${result.applied.length === 1 ? "" : "s"}.`);
  for (const card of result.applied) out(`  ${card.id}  ${card.name ?? ""}`.trimEnd());
  if (result.skipped.length > 0) {
    out(`Skipped ${result.skipped.length} (already archived): ${result.skipped.map((c) => c.id).join(", ")}`);
  }
  if (result.failed.length > 0) {
    out(`Failed ${result.failed.length}:`);
    for (const item of result.failed) out(`  ${item.id}  ${redact(item.error, config)}`);
  }
  out(`Undo: npx metabase-audit unarchive --undo ${result.undoFile} --apply`);
  return result.failed.length > 0 ? 1 : 0;
}

async function cmdUnarchive({ config, flags, cwd, out, fail }) {
  if (!flags.undo) {
    fail(`unarchive needs --undo <file>, the undo file written by the archive run you want to reverse.`);
    return 2;
  }
  const apply = flags.apply === true;
  if (apply && !config.hasConnection) {
    fail(missingConnectionMessage());
    return 2;
  }

  const result = await unarchiveCards(apply ? client(config) : null, {
    undoFile: path.resolve(cwd, String(flags.undo)),
    apply,
  });

  if (flags.json) {
    out(json(result));
    return apply && result.failed.length > 0 ? 1 : 0;
  }

  if (!apply) {
    for (const card of result.plan) out(`  ${card.id}  ${card.name ?? ""}`.trimEnd());
    out(`Dry run: ${result.plan.length} question${result.plan.length === 1 ? "" : "s"} would be restored. Re-run with --apply to restore them.`);
    return 0;
  }

  out(`Restored ${result.restored.length} question${result.restored.length === 1 ? "" : "s"}.`);
  for (const card of result.restored) out(`  ${card.id}  ${card.name ?? ""}`.trimEnd());
  if (result.failed.length > 0) {
    out(`Failed ${result.failed.length}:`);
    for (const item of result.failed) out(`  ${item.id}  ${redact(item.error, config)}`);
  }
  return result.failed.length > 0 ? 1 : 0;
}

/**
 * stdout is the MCP protocol channel here, so this branch prints nothing to it.
 * The import is dynamic so the rest of the CLI runs even without the server.
 */
async function cmdMcp({ env }) {
  const { startMcpServer } = await import("./mcp.js");
  return await startMcpServer({ env });
}

// --- shared helpers ----------------------------------------------------

/** Findings from `--snapshot` (analysed on the spot) or from a previous scan. */
async function readFindings({ config, now }) {
  if (config.snapshotFile) {
    const result = await runScan({
      snapshotFile: config.snapshotFile,
      dir: config.dir,
      out: config.out,
      writeReport: false,
      writeContext: false,
      now,
    });
    return result.findings;
  }
  return loadFindings(config.dir);
}

function client(config) {
  return new MetabaseClient({ url: config.url, apiKey: config.apiKey, basicAuth: config.basicAuth ?? null });
}

function progressWriter(flags, fail) {
  if (flags.quiet) return () => {};
  return ({ phase, done, total }) => {
    if (phase === "done") return;
    fail(total ? `[${phase}] ${fmtInt(done)}/${fmtInt(total)}` : `[${phase}] ...`);
  };
}

function scanSummary(findings, paths) {
  const s = findings.summary;
  const dashboards = findings.dashboards ?? [];
  const warning = dashboards.filter((d) => d.status === "warning").length;
  const broken = dashboards.filter((d) => d.status === "broken").length;

  const lines = [
    `Health: ${s.healthGrade} (${s.healthScore}/100)`,
    `${fmtInt(s.activeCards)} active questions, ${fmtInt(s.totalDashboards)} dashboards, ${fmtInt(s.totalTables)} tables`,
    `Duplicates: ${fmtInt(s.duplicateGroups)} group${s.duplicateGroups === 1 ? "" : "s"}, ${fmtInt(s.duplicateCardsToArchive)} question${s.duplicateCardsToArchive === 1 ? "" : "s"} can be archived`,
    `Broken: ${fmtInt(s.brokenCards)} question${s.brokenCards === 1 ? " points" : "s point"} at a table that no longer exists`,
    `Stale: ${fmtInt(s.staleCards90)} question${s.staleCards90 === 1 ? "" : "s"} unused for 90+ days`,
    `Dashboards: ${fmtInt(warning)} mostly stale, ${fmtInt(broken)} with broken questions`,
    ``,
    `Report:   ${paths.report ?? "(not written)"}`,
    `Context:  ${paths.context ?? "(not written)"}`,
    `Findings: ${paths.findings}`,
    `Snapshot: ${paths.snapshot}`,
  ];
  return lines.join("\n");
}

/** `id | name | views | last used`, aligned, for the archive dry run. */
function planTable(plan) {
  const rows = plan.map((row) => ({
    id: String(row.id),
    name: row.name ?? "(unknown)",
    views: row.viewCount === null || row.viewCount === undefined ? "n/a" : fmtInt(row.viewCount),
    last: row.lastUsedAt ? String(row.lastUsedAt).slice(0, 10) : "never",
  }));
  const header = { id: "id", name: "name", views: "views", last: "last used" };
  const width = (key) => Math.max(header[key].length, ...rows.map((r) => r[key].length));
  const w = { id: width("id"), name: width("name"), views: width("views") };
  const line = (r) => `${pad(r.id, w.id)} | ${pad(r.name, w.name)} | ${pad(r.views, w.views)} | ${r.last}`;
  return [line(header), ...rows.map(line)].join("\n");
}

function usage() {
  return [
    `metabase-audit ${VERSION}`,
    `Audit and clean up a Metabase instance from your own machine.`,
    ``,
    `Usage`,
    `  metabase-audit <command> [options]`,
    ``,
    `Commands`,
    `  doctor              Check URL, key, permissions and instance size`,
    `  scan                Fetch, analyse, write METALENS-REPORT.md and DATA-CONTEXT.md`,
    `  report              Re-render the report from the saved snapshot, no network`,
    `  context             Re-render DATA-CONTEXT.md from the saved snapshot, no network`,
    `  findings <kind>     Print findings as JSON (${KINDS})`,
    `  archive             Archive questions, dry run unless --apply`,
    `  unarchive           Restore questions from an undo file`,
    `  mcp                 Start the MCP server on stdio`,
    `  help                Show this text`,
    ``,
    `Connection`,
    `  --url <u>           Metabase URL, or the METABASE_URL environment variable`,
    `  --key <k>           API key, or METABASE_API_KEY`,
    `  --snapshot <file>   Analyse a saved snapshot instead of fetching, no network`,
    `                      findings and archive re-analyse it and write snapshot.json`,
    `                      and findings.json into --dir`,
    ``,
    `Output`,
    `  --dir <d>           Where snapshot.json and findings.json go (default ./.metalens)`,
    `  --out <d>           Where the two Markdown files go (default .)`,
    `  --json              Machine-readable output`,
    `  --quiet             No progress lines`,
    `  --no-report         Skip METALENS-REPORT.md`,
    `  --no-context        Skip DATA-CONTEXT.md`,
    `  --limit <n>         Rows per findings kind (default 50)`,
    ``,
    `Scan`,
    `  --compile           Compile GUI questions to SQL, one request per question`,
    ``,
    `Archive`,
    `  --ids <a,b>         Question ids to archive`,
    `  --from <source>     Take the ids from findings: duplicates or broken`,
    `  --apply             Actually write to Metabase, after writing an undo file`,
    `  --reason <text>     Recorded in the undo file`,
    `  --undo <file>       Undo file to reverse, for unarchive`,
    ``,
    `Testing`,
    `  --now <iso>         Treat this timestamp as now, for reproducible output`,
    ``,
    `Examples`,
    `  metabase-audit doctor`,
    `  metabase-audit scan --out ./docs`,
    `  metabase-audit findings duplicates --limit 10`,
    `  metabase-audit archive --from duplicates`,
    `  metabase-audit archive --ids 2,3 --apply --reason "duplicate cleanup"`,
  ].join("\n");
}

function parseNow(value) {
  if (value === undefined || value === null || value === "") return new Date();
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw usageError(`Invalid --now value "${value}". Use an ISO timestamp, for example 2026-09-16T00:00:00Z.`);
  }
  return date;
}

/**
 * The key must never reach a terminal or a log, not even inside an error, and
 * neither must a password that came in through the URL.
 */
function redact(message, config) {
  let text = String(message ?? "");
  // The key keeps its first four characters, which is enough to tell two keys
  // apart in a support thread. A password keeps nothing.
  for (const [secret, mask] of [
    [config?.apiKey, maskSecret(config?.apiKey)],
    [config?.basicAuth?.password, "****"],
  ]) {
    if (!secret) continue;
    text = text.split(String(secret)).join(mask);
  }
  return text;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function truthy(value) {
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

function usageError(message) {
  const error = new Error(message);
  error.code = "EUSAGE";
  return error;
}

function write(stream, text) {
  const s = String(text);
  stream.write(s.endsWith("\n") ? s : `${s}\n`);
}
