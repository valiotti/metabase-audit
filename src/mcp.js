/**
 * MCP server on stdio: the same audit the CLI runs, exposed as six tools an
 * assistant can call.
 *
 * Three rules shape this file. stdout belongs to the protocol, so nothing here
 * ever writes to it and the few status lines go to stderr. The API key is never
 * logged and is masked out of any error text before it leaves a handler. And a
 * thrown error becomes `isError: true` with a readable message, because a model
 * can act on "run metabase_scan first" but not on a stack trace.
 *
 * Note on lifetime: `startMcpServer` resolves only when the transport closes.
 * `bin/metabase-audit.js` exits the process as soon as `main()` resolves, so a
 * server that returned right after connecting would be killed mid-handshake.
 * Pass `waitForClose: false` when you want the handle immediately, or use
 * `createServer(config)` and connect it yourself.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { archiveCards, selectFromFindings, unarchiveCards } from "./archive.js";
import { MetabaseClient, VERSION } from "./client.js";
import { CONTEXT_FILENAME, missingConnectionMessage, resolveConfig } from "./config.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { loadFindings, runScan, sliceFindings } from "./scan.js";
import { fmtInt, maskSecret } from "./util.js";

const SERVER_NAME = "metabase-audit";

const FINDING_KINDS = [
  "summary",
  "duplicates",
  "broken",
  "stale",
  "dashboards",
  "actions",
  "tables",
  "anomalies",
  "creators",
];

/**
 * Builds the server with every tool registered, without connecting it.
 * Exported so tests (and any other transport) can drive it in process.
 *
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {McpServer}
 */
export function createServer(config) {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });

  server.registerTool(
    "metabase_doctor",
    {
      title: "Check the Metabase connection",
      description: [
        "Check that the Metabase connection works, before anything else.",
        "Verifies the URL, that the instance answers, that the API key is accepted, that it has admin-level read access, and how big the instance is.",
        "Read-only, takes no arguments, and reads METABASE_URL and METABASE_API_KEY from the environment.",
        "Run this first when another tool reports a connection problem.",
      ].join(" "),
      inputSchema: z.object({}),
    },
    wrap(config, async () => {
      if (!config.hasConnection) return errorResult(missingConnectionMessage());
      const result = await runDoctor(buildClient(config), { url: config.url });
      return okResult(formatDoctor(result), result);
    })
  );

  server.registerTool(
    "metabase_scan",
    {
      title: "Scan the instance and write the audit",
      description: [
        "Scan the Metabase instance and produce the audit: duplicate questions, questions pointing at tables that no longer exist, stale questions, dashboard health, and a health score out of 100.",
        "Writes METALENS-REPORT.md (the audit) and DATA-CONTEXT.md (a description of the data model for later questions) plus findings.json into the working directory, and returns the summary.",
        "Read-only against Metabase: it never changes anything there.",
        "Run this before metabase_findings, metabase_context or metabase_archive_cards; a large instance can take a few minutes.",
        "When METALENS_SNAPSHOT points at a saved snapshot the scan runs from that file with no network access.",
      ].join(" "),
      inputSchema: z.object({
        compile: z
          .boolean()
          .optional()
          .describe(
            "Ask Metabase to compile point-and-click questions to SQL so they can be compared with written SQL. Finds more duplicates, adds one request per question, so it is slower. Default false."
          ),
      }),
    },
    wrap(config, async ({ compile } = {}) => {
      const fromFile = Boolean(config.snapshotFile);
      if (!fromFile && !config.hasConnection) return errorResult(missingConnectionMessage());

      const result = await runScan({
        client: fromFile ? null : buildClient(config),
        snapshotFile: config.snapshotFile,
        url: config.url,
        dir: config.dir,
        out: config.dir,
        compile: compile === true,
        writeReport: true,
        writeContext: true,
      });

      const payload = {
        summary: result.findings.summary,
        health: result.findings.health,
        paths: result.paths,
      };
      return okResult(scanText(result.findings, result.paths), payload);
    })
  );

  server.registerTool(
    "metabase_findings",
    {
      title: "Read one slice of the last scan",
      description: [
        "Read one part of the findings from the last metabase_scan, without re-reading the whole report.",
        `Kinds: ${FINDING_KINDS.join(", ")}.`,
        "Each returns the list plus the total, so you can tell a truncated answer from a complete one.",
        "Read-only, no network. If no scan has been run yet it says so; run metabase_scan first.",
      ].join(" "),
      inputSchema: z.object({
        kind: z
          .enum(FINDING_KINDS)
          .describe(
            "Which slice to read: summary (counts and health score), duplicates, broken (questions on missing tables), stale (unused for 90+ days), dashboards, actions (what to do next), tables (usage per table), anomalies, creators (who made what)."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum rows to return, newest or worst first depending on the kind. Default 50."),
      }),
    },
    wrap(config, async ({ kind, limit } = {}) => {
      const findings = await readFindings(config);
      return withText(sliceFindings(findings, kind, limit ?? 50), (slice) => findingsText(kind, slice));
    })
  );

  server.registerTool(
    "metabase_context",
    {
      title: "Read the generated data context",
      description: [
        "Read DATA-CONTEXT.md, the description of the instance that metabase_scan writes: databases, the tables that actually get used, how they join, the busiest dashboards, who owns what, and the questions worth trusting.",
        "Use it as background before answering questions about this Metabase or writing SQL against it.",
        "Read-only, no network. Run metabase_scan first if it is not there yet.",
      ].join(" "),
      inputSchema: z.object({}),
    },
    wrap(config, async () => {
      const file = path.join(config.dir, CONTEXT_FILENAME);
      let markdown;
      try {
        markdown = await readFile(file, "utf8");
      } catch {
        return errorResult(`No data context at ${file}. Run metabase_scan first, it writes this file.`);
      }
      return okResult(markdown, { path: file, characters: markdown.length });
    })
  );

  server.registerTool(
    "metabase_archive_cards",
    {
      title: "Archive questions (preview by default)",
      description: [
        "Archive questions in Metabase. This is the only tool that changes anything.",
        "With apply false (the default) nothing is touched: it returns the list of questions that would be archived, so you can show it and ask before going ahead.",
        "With apply true it archives them and writes an undo file first, listing every question it is about to touch; metabase_unarchive reverses the run from that file.",
        "Archiving in Metabase hides a question, it does not delete it.",
        "Pass ids for specific questions, or from: \"duplicates\" to take every redundant copy the scan found (never the one it recommends keeping), or from: \"broken\" for questions whose table no longer exists.",
        "The question the scan marks as the one to keep in a duplicate group is refused, in preview and in apply.",
      ].join(" "),
      inputSchema: z.object({
        ids: z.array(z.number().int()).optional().describe("Question (card) ids to archive, for example [214, 377]."),
        from: z
          .enum(["duplicates", "broken"])
          .optional()
          .describe(
            'Take the ids from the last scan instead of listing them: "duplicates" for the redundant copies of identical queries, "broken" for questions pointing at a table that no longer exists.'
          ),
        apply: z
          .boolean()
          .optional()
          .describe("false (default) previews and changes nothing. true archives the questions and writes an undo file."),
        reason: z
          .string()
          .optional()
          .describe("Short note recorded in the undo file, for example \"duplicate cleanup, approved by the data team\"."),
      }),
    },
    wrap(config, async ({ ids, from, apply = false, reason = "" } = {}) => {
      if (!ids && !from) {
        return errorResult(
          'metabase_archive_cards needs ids (for example [214, 377]) or from ("duplicates" or "broken", taken from the last scan).'
        );
      }
      if (apply === true && !config.hasConnection) return errorResult(missingConnectionMessage());

      // Findings drive `from` and protect the keeper of every duplicate group.
      // Explicit ids can work without them, but the answer says so.
      let findings = null;
      let note = "";
      try {
        findings = await readFindings(config);
      } catch (error) {
        if (from) return errorResult(error.message);
        note = `${error.message} Continuing with the ids you passed, without duplicate-group protection.`;
      }

      const selected = from ? selectFromFindings(findings, from).map((row) => row.id) : ids;
      if (!selected || selected.length === 0) {
        return okResult(join([note, "Nothing to archive."]), { apply: apply === true, plan: [] });
      }

      const result = await archiveCards(apply === true ? buildClient(config) : null, {
        ids: selected,
        apply: apply === true,
        reason,
        dir: config.dir,
        findings,
      });

      return okResult(join([note, archiveText(result)]), result);
    })
  );

  server.registerTool(
    "metabase_unarchive",
    {
      title: "Undo an archive run",
      description: [
        "Reverse a metabase_archive_cards run from the undo file it wrote, putting those questions back exactly as they were.",
        "With apply false (the default) it lists what would be restored and changes nothing; with apply true it restores them.",
        "The undo file path is in the result of the archive run, inside the working directory.",
      ].join(" "),
      inputSchema: z.object({
        undoFile: z.string().describe("Path to the undo file written by the archive run you want to reverse."),
        apply: z.boolean().optional().describe("false (default) previews the restore. true restores the questions."),
      }),
    },
    wrap(config, async ({ undoFile, apply = false } = {}) => {
      if (apply === true && !config.hasConnection) return errorResult(missingConnectionMessage());
      const result = await unarchiveCards(apply === true ? buildClient(config) : null, {
        undoFile: path.resolve(config.dir, String(undoFile)),
        apply: apply === true,
      });
      return okResult(unarchiveText(result), result);
    })
  );

  return server;
}

/**
 * Starts the server on stdio. Resolves when the transport closes, which is what
 * keeps the process alive under `bin/metabase-audit.js` (see the file header).
 *
 * @param {object} opts
 * @param {object} opts.env            process.env or a stub
 * @param {string} opts.cwd
 * @param {boolean} opts.waitForClose  false returns the handle right after connecting
 * @returns {Promise<McpServer>}
 */
export async function startMcpServer({ env = process.env, cwd = process.cwd(), waitForClose = true } = {}) {
  const config = resolveConfig({}, env, cwd);
  const server = createServer(config);

  const closed = new Promise((resolve) => {
    const previous = server.server.onclose;
    server.server.onclose = () => {
      try {
        if (typeof previous === "function") previous();
      } finally {
        resolve();
      }
    };
  });

  await server.connect(new StdioServerTransport());
  logStderr(
    `${SERVER_NAME} ${VERSION} on stdio. Working directory: ${config.dir}.` +
      (config.snapshotFile ? ` Snapshot: ${config.snapshotFile}.` : config.url ? ` Metabase: ${config.url}.` : " No Metabase connection configured.")
  );

  if (waitForClose) await closed;
  return server;
}

// --- results -----------------------------------------------------------

/**
 * Wraps a handler so module errors come back as readable tool errors rather
 * than crashing the server, and so the API key is masked in every line of text
 * that leaves a tool, including messages that quote a request back.
 */
function wrap(config, handler) {
  return async (args) => {
    try {
      return maskInText(await handler(args ?? {}), config.apiKey);
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error);
      return errorResult(redact(message, config.apiKey));
    }
  };
}

function maskInText(result, apiKey) {
  if (!apiKey || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map((block) =>
      block && block.type === "text" ? { ...block, text: redact(block.text, apiKey) } : block
    ),
  };
}

function okResult(text, structuredContent) {
  const result = { content: [{ type: "text", text: String(text) }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

function errorResult(text) {
  return { content: [{ type: "text", text: String(text) }], isError: true };
}

/** okResult for a payload whose summary is derived from the payload itself. */
function withText(payload, render) {
  return okResult(render(payload), payload);
}

// --- text renderings ---------------------------------------------------

function scanText(findings, paths) {
  const s = findings.summary;
  return join([
    `Health: ${s.healthGrade} (${s.healthScore}/100)`,
    `${fmtInt(s.activeCards)} active questions, ${fmtInt(s.totalDashboards)} dashboards, ${fmtInt(s.totalTables)} tables`,
    `Duplicates: ${fmtInt(s.duplicateGroups)} ${plural(s.duplicateGroups, "group")}, ${fmtInt(s.duplicateCardsToArchive)} ${plural(s.duplicateCardsToArchive, "question")} can be archived`,
    `Broken: ${fmtInt(s.brokenCards)} ${plural(s.brokenCards, "question")} on a table that no longer exists`,
    `Stale: ${fmtInt(s.staleCards90)} ${plural(s.staleCards90, "question")} unused for 90+ days`,
    ``,
    `Report:   ${paths.report ?? "(not written)"}`,
    `Context:  ${paths.context ?? "(not written)"}`,
    `Findings: ${paths.findings}`,
    ``,
    `Read a slice with metabase_findings, or the data model with metabase_context.`,
  ]);
}

function findingsText(kind, slice) {
  if (kind === "summary") {
    const s = slice.summary;
    return join([
      `Health: ${s.healthGrade} (${s.healthScore}/100)`,
      `${fmtInt(s.activeCards)} active questions, ${fmtInt(s.archivedCards)} archived, ${fmtInt(s.totalDashboards)} dashboards, ${fmtInt(s.totalTables)} tables`,
      `${fmtInt(s.duplicateGroups)} duplicate ${plural(s.duplicateGroups, "group")}, ${fmtInt(s.brokenCards)} broken, ${fmtInt(s.staleCards90)} stale (90+ days)`,
    ]);
  }

  const rows = slice[kind] ?? [];
  const head = `${fmtInt(rows.length)} of ${fmtInt(slice.total)} ${kind}${rows.length < slice.total ? " (truncated, raise limit for more)" : ""}`;
  if (rows.length === 0) return `${head}. Nothing to show.`;

  if (kind === "duplicates") {
    return join([
      `${head}:`,
      ...rows.map((group) => {
        const archive = (group.archive ?? []).map((c) => c.id).join(", ");
        return `  ${group.kind}: keep ${group.keep?.id} "${group.keep?.name ?? ""}", archive ${archive || "(none)"}`;
      }),
    ]);
  }

  return join([`${head}:`, ...rows.map((row) => `  ${rowLabel(row)}`)]);
}

/** One line per finding row, using whatever identifying fields the kind has. */
function rowLabel(row) {
  if (!row || typeof row !== "object") return String(row);
  const id = row.id ?? row.cardId ?? null;
  const name = row.name ?? row.title ?? row.table ?? row.creator ?? "";
  const detail = row.reason ?? row.status ?? row.kind ?? row.recommendation ?? "";
  return [id === null ? "" : `${id}`, name, detail].filter(Boolean).join("  ").trim();
}

function archiveText(result) {
  if (result.apply === false) {
    return join([
      ...result.plan.map((row) => `  ${row.id}  ${row.name ?? ""}`.trimEnd()),
      `Dry run: ${result.plan.length} ${plural(result.plan.length, "question")} would be archived. Call again with apply: true to archive them.`,
    ]);
  }

  const lines = [
    `Archived ${result.applied.length} ${plural(result.applied.length, "question")}.`,
    ...result.applied.map((card) => `  ${card.id}  ${card.name ?? ""}`.trimEnd()),
  ];
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} (already archived): ${result.skipped.map((c) => c.id).join(", ")}`);
  }
  if (result.failed.length > 0) {
    lines.push(`Failed ${result.failed.length}:`);
    for (const item of result.failed) lines.push(`  ${item.id}  ${item.error}`);
  }
  lines.push(`Undo file: ${result.undoFile}. Reverse this run with metabase_unarchive, apply true.`);
  return join(lines);
}

function unarchiveText(result) {
  if (result.apply === false) {
    return join([
      ...result.plan.map((row) => `  ${row.id}  ${row.name ?? ""}`.trimEnd()),
      `Dry run: ${result.plan.length} ${plural(result.plan.length, "question")} would be restored. Call again with apply: true to restore them.`,
    ]);
  }

  const lines = [
    `Restored ${result.restored.length} ${plural(result.restored.length, "question")}.`,
    ...result.restored.map((card) => `  ${card.id}  ${card.name ?? ""}`.trimEnd()),
  ];
  if (result.failed.length > 0) {
    lines.push(`Failed ${result.failed.length}:`);
    for (const item of result.failed) lines.push(`  ${item.id}  ${item.error}`);
  }
  return join(lines);
}

// --- shared helpers ----------------------------------------------------

/**
 * Findings from METALENS_SNAPSHOT (analysed on the spot) or from the last scan.
 * scan.js phrases its "no findings" error for the CLI, so the tool name a model
 * can actually call is added here.
 */
async function readFindings(config) {
  if (config.snapshotFile) {
    const result = await runScan({
      snapshotFile: config.snapshotFile,
      dir: config.dir,
      out: config.dir,
      writeReport: false,
      writeContext: false,
    });
    return result.findings;
  }
  try {
    return await loadFindings(config.dir);
  } catch (error) {
    throw new Error(`${error.message} Here that is the metabase_scan tool.`);
  }
}

function buildClient(config) {
  return new MetabaseClient({ url: config.url, apiKey: config.apiKey });
}

/** Replaces the key with its masked form anywhere it shows up in a message. */
function redact(message, apiKey) {
  const text = String(message ?? "");
  if (!apiKey) return text;
  return text.split(String(apiKey)).join(maskSecret(apiKey));
}

/** Joins lines, keeping blank separators inside but trimming them off the ends. */
function join(lines) {
  const list = lines.filter((line) => line !== null && line !== undefined).map(String);
  while (list.length > 0 && list[0].trim() === "") list.shift();
  while (list.length > 0 && list[list.length - 1].trim() === "") list.pop();
  return list.join("\n");
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

/** stdout is the protocol channel, so status lines go to stderr or nowhere. */
function logStderr(message) {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // a closed stderr must never break the server
  }
}
