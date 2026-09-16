/**
 * Markdown report renderer.
 *
 * This is the artifact a person actually reads: `METALENS-REPORT.md`. It is a
 * pure function of the findings document, so every number printed here came out
 * of an analyzer and nothing is recomputed on the way to the page. No I/O, no
 * clock of its own beyond the fallback date for the header line.
 *
 * Two rules shape the formatting:
 *  - the reader may never have run the tool before, so each section says what it
 *    counted and the command that acts on it sits next to the finding, not in a
 *    manual;
 *  - no em dash or en dash anywhere in the output. Commas, colons, parentheses
 *    and periods carry the same load and survive every terminal and diff.
 */

import { fmtInt } from "./util.js";
import { STALE_DAYS } from "./analyze/constants.js";

/** Display caps. Everything past them lives in `.metalens/findings.json`. */
const MAX_ACTIONS = 5;
const MAX_ACTION_CARD_IDS = 5;
const MAX_TABLES = 15;
const MAX_TABLE_SUGGESTIONS = 10;
const FINDINGS_HINT = "see .metalens/findings.json";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** `plural(1, "view")` -> "1 view", `plural(40, "view")` -> "40 views". */
function plural(count, one, many) {
  const n = Number(count) || 0;
  return `${fmtInt(n)} ${n === 1 ? one : many ?? `${one}s`}`;
}

/** Table-cell safe text: single line, pipes escaped, never "undefined". */
function cell(value) {
  return String(value ?? "")
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/** `YYYY-MM-DD`, or the fallback word when there is no usable date. */
function fmtDate(value, fallback = "never") {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
}

/** One cell-safe sentence, with the period the analyzers do not always carry. */
function sentence(value) {
  const text = cell(value);
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A Markdown link, or plain text when the instance URL is unknown. */
function link(label, url) {
  const text = cell(label);
  return url ? `[${text}](${url})` : text;
}

/** Cards and dashboards can come back without a name. Never print an empty link. */
function entityLabel(name, id) {
  const trimmed = String(name ?? "").trim();
  return trimmed || `Question ${id}`;
}

/** Markdown table with the header separator row Markdown requires. */
function table(headers, rows) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

/** "40 views, last used 2026-09-11" for a duplicate group member. */
function usageNote(card) {
  return `${plural(card.viewCount ?? 0, "view")}, last used ${fmtDate(card.lastUsedAt)}`;
}

/** Instance base URL without a trailing slash, or "" when it is unknown. */
function baseUrlOf(findings) {
  return String(findings.instance?.url ?? "").replace(/\/+$/, "");
}

/** Host name of the instance, used when the site has no name set. */
function hostOf(url) {
  return String(url ?? "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .trim();
}

function headerSection(findings, now) {
  const instance = findings.instance ?? {};
  const summary = findings.summary ?? {};
  const url = baseUrlOf(findings);
  const siteName = String(instance.siteName ?? "").trim() || hostOf(url) || "your instance";

  const meta = [];
  if (url) meta.push(url);
  if (instance.version) meta.push(`Metabase ${instance.version}`);
  const generated = fmtDate(findings.generatedAt || now, "");
  if (generated) meta.push(`generated ${generated}`);

  const counts = [
    plural(summary.activeCards ?? 0, "active question"),
    plural(summary.totalDashboards ?? 0, "dashboard"),
    plural(summary.totalDatabases ?? 0, "database"),
    plural(summary.totalTables ?? 0, "table"),
  ];

  return [`# Metabase health report: ${siteName}`, meta.join(", "), counts.join(", ")].join("\n");
}

function healthSection(findings) {
  const health = findings.health ?? {};
  const summary = findings.summary ?? {};
  const grade = health.grade ?? summary.healthGrade ?? "n/a";
  const score = health.score ?? summary.healthScore ?? 0;
  const factors = asArray(health.factors);

  const blocks = [`## Health: ${grade} (${fmtInt(score)}/100)`];
  if (health.verdict) blocks.push(cell(health.verdict));
  if (factors.length > 0) {
    blocks.push(
      table(
        ["Factor", "Score", "How to improve"],
        factors.map((f) => [
          cell(f.name),
          `${fmtInt(f.score)}/${fmtInt(f.maxScore)}`,
          [sentence(f.description), sentence(f.howToImprove)].filter(Boolean).join(" "),
        ]),
      ),
    );
  }
  return blocks.join("\n\n");
}

function actionsSection(findings) {
  const actions = asArray(findings.actions).slice(0, MAX_ACTIONS);
  if (actions.length === 0) {
    return "## Do this first\n\nNothing urgent. The instance is in good shape.";
  }

  const base = baseUrlOf(findings);
  const items = actions.map((action, index) => {
    const ids = asArray(action.cardIds);
    let suffix = "";
    if (ids.length > 0) {
      const shown = ids
        .slice(0, MAX_ACTION_CARD_IDS)
        .map((id) => link(String(id), base ? `${base}/question/${id}` : null));
      const rest = ids.length - shown.length;
      suffix = ` (questions: ${shown.join(", ")}${rest > 0 ? `, and ${fmtInt(rest)} more` : ""})`;
    }
    return `${index + 1}. **${cell(action.title)}**: ${cell(action.description)}${suffix}`;
  });

  return `## Do this first\n\n${items.join("\n")}`;
}

function duplicatesSection(findings) {
  const groups = asArray(findings.duplicates);
  const toArchive = groups
    .filter((g) => g.kind === "exact-sql")
    .reduce((sum, g) => sum + asArray(g.archive).length, 0);
  const heading = `## Duplicates (${plural(groups.length, "group")}, ${plural(toArchive, "question")} to archive)`;

  if (groups.length === 0) return `${heading}\n\nNo duplicate questions found.`;

  const blocks = [heading];
  for (const group of groups) {
    const verb = group.kind === "exact-sql" ? "Archive" : "Review";
    const keep = group.keep ?? {};
    const lines = [
      `**Keep ${link(entityLabel(keep.name, keep.id), keep.url)} (${usageNote(keep)})**`,
      ...asArray(group.archive).map(
        (card) => `- ${verb} ${link(entityLabel(card.name, card.id), card.url)} (${usageNote(card)})`,
      ),
    ];
    blocks.push(lines.join("\n"));
    if (group.recommendation) blocks.push(cell(group.recommendation));
    if (group.kind === "exact-sql") {
      const ids = asArray(group.archive).map((c) => c.id);
      if (ids.length > 0) {
        blocks.push("```bash\n" + `npx metabase-audit archive --ids ${ids.join(",")}` + "\n```");
      }
    }
  }
  return blocks.join("\n\n");
}

function brokenSection(findings) {
  const broken = asArray(findings.broken);
  const heading = `## Broken questions (${fmtInt(broken.length)})`;
  if (broken.length === 0) return `${heading}\n\nNone found.`;

  const rows = broken.map((card) => [
    link(entityLabel(card.name, card.id), card.url),
    cell(card.reason),
    cell(card.collectionPath || "no collection"),
  ]);
  return `${heading}\n\n${table(["Question", "Reason", "Collection"], rows)}`;
}

function staleSection(findings, maxStaleRows) {
  const stale = asArray(findings.stale);
  const heading = `## Stale questions (${fmtInt(stale.length)} not used in ${STALE_DAYS}+ days)`;
  if (stale.length === 0) return `${heading}\n\nNone found.`;

  const shown = stale.slice(0, Math.max(0, maxStaleRows));
  const rows = shown.map((card) => [
    link(entityLabel(card.name, card.id), card.url),
    fmtDate(card.lastUsedAt),
    fmtInt(card.daysSinceUse),
    fmtInt(card.viewCount ?? 0),
    cell(card.creatorName || "Unknown"),
    cell(card.collectionPath || "no collection"),
  ]);

  const blocks = [
    heading,
    table(["Question", "Last used", "Days", "Views", "Owner", "Collection"], rows),
  ];
  const rest = stale.length - shown.length;
  if (rest > 0) blocks.push(`and ${fmtInt(rest)} more, ${FINDINGS_HINT}`);
  return blocks.join("\n\n");
}

function dashboardsSection(findings) {
  const dashboards = asArray(findings.dashboards);
  const heading = `## Dashboards (${fmtInt(dashboards.length)})`;
  if (dashboards.length === 0) return `${heading}\n\nNone found.`;

  const rows = dashboards.map((dash) => [
    link(String(dash.name ?? "").trim() || `Dashboard ${dash.id}`, dash.url),
    cell(dash.status),
    fmtInt(dash.cardCount ?? 0),
    fmtInt(dash.staleCardCount ?? 0),
    fmtInt(dash.brokenCardCount ?? 0),
    fmtInt(dash.viewCount ?? 0),
    fmtDate(dash.lastViewedAt),
    cell(dash.creatorName || "Unknown"),
  ]);

  return `${heading}\n\n${table(
    ["Dashboard", "Status", "Questions", "Stale", "Broken", "Views", "Last viewed", "Owner"],
    rows,
  )}`;
}

function ownershipSection(findings) {
  const creators = asArray(findings.creators);
  if (creators.length === 0) {
    return "## Ownership\n\nNo owner information (the API key is not in the Administrators group).";
  }
  const rows = creators.map((creator) => [
    cell(creator.name || "Unknown"),
    fmtInt(creator.totalCards ?? 0),
    fmtInt(creator.activeCards ?? 0),
    fmtInt(creator.staleCards ?? 0),
  ]);
  return `## Ownership\n\n${table(["Owner", "Questions", "Active", "Stale"], rows)}`;
}

/** "public.orders", or just "orders" when the engine has no schemas. */
function tableLabel(entry) {
  const name = String(entry.name ?? "").trim() || "unnamed table";
  const schema = String(entry.schema ?? "").trim();
  return schema ? `${schema}.${name}` : name;
}

function tablesSection(findings) {
  const all = asArray(findings.tables);
  if (all.length === 0) return "## Core data model\n\nNone found.";

  const shown = all.slice(0, MAX_TABLES);
  const rows = shown.map((entry) => [
    cell(tableLabel(entry)),
    fmtInt(entry.usageCount ?? 0),
    fmtInt(entry.rowCount ?? null),
    fmtInt(entry.columnCount ?? 0),
    cell(asArray(entry.referencedBy).join(", ") || "none"),
  ]);

  const blocks = [
    "## Core data model",
    "Ordered by how many saved questions read each table.",
    table(["Table", "Questions", "Rows", "Columns", "Referenced by"], rows),
  ];

  const rest = all.length - shown.length;
  if (rest > 0) blocks.push(`and ${fmtInt(rest)} more, ${FINDINGS_HINT}`);

  const bullets = [];
  for (const entry of shown) {
    for (const suggestion of asArray(entry.suggestions)) {
      if (bullets.length >= MAX_TABLE_SUGGESTIONS) break;
      bullets.push(`- **${cell(tableLabel(entry))}**: ${cell(suggestion)}`);
    }
  }
  if (bullets.length > 0) blocks.push(bullets.join("\n"));

  return blocks.join("\n\n");
}

function anomaliesSection(findings) {
  const anomalies = asArray(findings.anomalies);
  if (anomalies.length === 0) return "## Anomalies\n\nNone.";
  const bullets = anomalies.map((item) => {
    const entity = cell(item.entity);
    return `- ${cell(item.severity)}: ${cell(item.message)}${entity ? ` (${entity})` : ""}`;
  });
  return `## Anomalies\n\n${bullets.join("\n")}`;
}

/** Fixed footer. Commands only, no pitch. */
function footerSection() {
  return [
    "## How to act on this",
    "Preview a cleanup. This changes nothing:",
    "```bash\nnpx metabase-audit archive --from duplicates\n```",
    "Add `--apply` to carry it out. Every apply writes an undo file into `.metalens/` before it touches a question, and `unarchive` puts the questions back:",
    "```bash\nnpx metabase-audit archive --from duplicates --apply\nnpx metabase-audit unarchive --undo .metalens/undo-<timestamp>.json --apply\n```",
    "`DATA-CONTEXT.md`, written next to this report, describes the same instance for an LLM: schema, relationships, the queries the team trusts and a glossary. Paste it into Claude when you want help writing a question or planning a migration.",
    "If the findings are clear but the decisions are not (who owns what, which definition is right), see the README section When the report is not enough.",
  ].join("\n\n");
}

/**
 * Renders the findings document as `METALENS-REPORT.md`.
 *
 * @param {object} findings result of `analyze()`
 * @param {{ now?: Date, maxStaleRows?: number }} options
 * @returns {string} Markdown, ending in a single newline
 */
export function renderReport(findings, { now = new Date(), maxStaleRows = 50 } = {}) {
  const doc = findings ?? {};
  const sections = [
    headerSection(doc, now),
    healthSection(doc),
    actionsSection(doc),
    duplicatesSection(doc),
    brokenSection(doc),
    staleSection(doc, maxStaleRows),
    dashboardsSection(doc),
    ownershipSection(doc),
    tablesSection(doc),
    anomaliesSection(doc),
    footerSection(),
  ];
  return `${sections.join("\n\n")}\n`;
}
