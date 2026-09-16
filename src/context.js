/**
 * DATA-CONTEXT.md renderer.
 *
 * The report tells a human what to clean up. This file tells a model what the
 * data means: the schema of the tables that are actually queried, how they are
 * joined, which saved questions the team trusts, and the words the team uses
 * for its own business. A person pastes it into Claude, or keeps it next to the
 * code, and the four skills in `skills/` read it back as their only context.
 *
 * Ported from the MetaLens SaaS `doc-generator.ts` (section layout) and
 * `schema-context.ts` (the compact schema block, the caps and the glossary
 * heuristic). Differences on purpose:
 *  - one Markdown file instead of structured sections for a web renderer, so
 *    every section is plain text a model can read top to bottom;
 *  - no LLM-written prose. Everything here is derived from the snapshot, which
 *    keeps the file deterministic and free to generate;
 *  - the SaaS truncated SQL to 300 characters. A query cut mid-expression is
 *    worse than useless for review, so full statements are kept up to a line
 *    cap instead.
 *
 * Pure: no I/O, no clock of its own, no network.
 */

import { fmtInt, isoOrNull } from "./util.js";
import { SAMPLE_USER_ID } from "./analyze/constants.js";

/** Lines of SQL kept per trusted query before the block is cut. */
const MAX_SQL_LINES = 60;
/** Glossary terms printed at most. */
const MAX_GLOSSARY_TERMS = 30;
/** A term has to name this many distinct questions to earn a glossary line. */
const GLOSSARY_MIN_CARDS = 2;

/** Words that carry no business meaning in a question name. From the SaaS glossary builder. */
const STOP_WORDS = new Set([
  "the", "a", "an", "by", "in", "of", "to", "for", "and", "or", "per", "vs", "with", "from",
  "all", "new", "total", "count", "rate", "daily", "weekly", "monthly", "copy", "test", "temp",
  "old", "final", "report", "chart", "dashboard", "question", "query", "data", "last", "this",
  "card", "cards", "collection", "day", "days", "week", "weeks", "month", "months", "year",
  "years", "quarter", "quarterly", "hour", "hours", "time", "date", "dates", "over", "top",
]);

/**
 * Terms worth defining even when they show up once. A single query named
 * "Churn cohort" still tells the reader that churn is a concept here.
 */
const BUSINESS_TERMS = new Set([
  "revenue", "arr", "mrr", "ltv", "cac", "gmv", "aov", "arpu", "margin", "profit", "ebitda",
  "churn", "retention", "cohort", "conversion", "funnel", "activation", "engagement",
  "subscription", "subscriptions", "renewal", "refund", "refunds", "payment", "payments",
  "invoice", "invoices", "booking", "bookings", "order", "orders", "customer", "customers",
  "account", "accounts", "user", "users", "session", "sessions", "signup", "signups",
  "lead", "leads", "pipeline", "opportunity", "deal", "deals", "ticket", "tickets",
  "inventory", "shipment", "traffic", "attribution", "campaign", "spend", "budget", "forecast",
]);

/** Lookup key for a table: database id plus schema plus name, with no delimiter to guess. */
function usageKey(dbId, schema, name) {
  return JSON.stringify([String(dbId ?? ""), String(schema ?? ""), String(name ?? "")]);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Free text on its way into the file. Em and en dashes are rewritten to a
 * hyphen so the whole document stays dash free, which is the house style and
 * also what makes a diff of two generated files readable.
 */
function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\u2010-\u2015\u2212]/g, "-").trim();
}

/**
 * Markdown that would otherwise be active: a backslash, the brackets that open
 * a link and the backtick that opens a code span. Names and descriptions come
 * from Metabase, so a question named "Revenue [click me](https://evil.example.com)"
 * has to read as that text instead of rendering as a link someone else chose.
 * SQL blocks and URLs do not go through here.
 */
function escapeMarkdown(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/[[\]`]/g, "\\$&");
}

/** Free text on its way into prose or a heading: cleaned, then Markdown-escaped. */
function text(value) {
  return escapeMarkdown(clean(value));
}

/** Same, plus what a Markdown table cell cannot contain. */
function cell(value) {
  return text(value).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
}

/** Metabase prefixes every type with `type/`. Nobody needs to read that. */
function shortType(value) {
  const cleaned = text(value);
  return cleaned ? cleaned.replace(/^type\//, "") : "";
}

/** `YYYY-MM-DD`, or null when the value is not a date. */
function ymd(value) {
  const iso = isoOrNull(value);
  return iso ? iso.slice(0, 10) : null;
}

/** `N thing` / `N things`. Never prints a bare number without its noun. */
function plural(count, one, many) {
  return `${fmtInt(count)} ${count === 1 ? one : many}`;
}

/** Picks the verb form that agrees with `count`, for "N of M things ..." bullets. */
function agree(count, singular, plural_) {
  return count === 1 ? singular : plural_;
}

/** A finite count, or 0. Keeps `NaN` and `undefined` out of the output. */
function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/** Markdown table from a header row and already-escaped cells. */
function table(headers, rows) {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines;
}

/**
 * Lookups shared by the sections: which databases and tables are real (the
 * Metabase sample database is left out everywhere), which cards count as the
 * customer's own, and where a foreign key points.
 */
function buildIndex(snapshot, findings) {
  const databases = asArray(snapshot.databases).filter((d) => !d.isSample);
  const sampleDbIds = new Set(asArray(snapshot.databases).filter((d) => d.isSample).map((d) => d.id));
  const tables = asArray(snapshot.tables).filter((t) => !sampleDbIds.has(t.dbId));

  const fieldIndex = new Map();
  for (const t of tables) {
    for (const f of asArray(t.fields)) fieldIndex.set(f.id, { table: t, field: f });
  }

  // Usage comes from the analyzer, which counts GUI source tables and parses
  // native SQL. Matching on database id plus schema plus name keeps two tables
  // of the same name on different schemas apart, and keeps the lookup out of
  // reach of anything that rewrites a database name for display.
  const usageByTable = new Map();
  for (const t of asArray(findings.tables)) {
    usageByTable.set(usageKey(t.dbId, t.schema, t.name), num(t.usageCount));
  }

  const usersKnown = asArray(snapshot.users).filter((u) => u.id !== SAMPLE_USER_ID).length;

  const cards = asArray(snapshot.cards).filter(
    (c) => !sampleDbIds.has(c.databaseId) && c.creatorId !== SAMPLE_USER_ID,
  );
  const activeCards = cards.filter((c) => !c.archived);

  const collectionPaths = new Map();
  for (const c of asArray(snapshot.collections)) {
    collectionPaths.set(c.id, text(c.path || c.name));
  }

  // Cards a duplicate group proposes to archive are not "trusted": they are the
  // copies the audit wants gone, and showing them would teach the model a
  // definition the team is about to drop.
  const duplicateArchiveIds = new Set();
  for (const group of asArray(findings.duplicates)) {
    for (const card of asArray(group.archive)) duplicateArchiveIds.add(card.id);
  }

  return {
    databases,
    tables,
    fieldIndex,
    activeCards,
    usersKnown,
    collectionPaths,
    duplicateArchiveIds,
    usageFor(dbId, tbl) {
      return usageByTable.get(usageKey(dbId, tbl.schema, tbl.name)) ?? 0;
    },
  };
}

function renderHeader(snapshot, findings, now) {
  const siteName = text(findings.instance?.siteName ?? snapshot.instance?.siteName) || "this Metabase";
  const url = clean(findings.instance?.url ?? snapshot.instance?.url) || "not recorded";
  const version = text(findings.instance?.version ?? snapshot.instance?.version) || "unknown";
  return [
    `# Data context: ${siteName}`,
    "",
    "This file is generated by metabase-audit. Paste it into your LLM or keep it next to your code. It contains the schema, usage, relationships and the queries the team already trusts.",
    "",
    `Instance: ${url} (Metabase version ${version})`,
    `Generated: ${ymd(now) ?? "unknown"}`,
  ];
}

function renderOverview(findings, index) {
  const s = findings.summary || {};
  const engines = [...new Set(index.databases.map((d) => text(d.engine)).filter(Boolean))].sort();
  return [
    "## Instance overview",
    "",
    `- Databases: ${fmtInt(num(s.totalDatabases))}`,
    `- Tables: ${fmtInt(num(s.totalTables))}`,
    `- Active questions: ${fmtInt(num(s.activeCards))}`,
    `- Dashboards: ${fmtInt(num(s.totalDashboards))}`,
    `- Users known: ${fmtInt(index.usersKnown)}`,
    `- Health: ${text(s.healthGrade) || "n/a"} (${fmtInt(num(s.healthScore))} of 100)`,
    `- Engines in use: ${engines.length > 0 ? engines.join(", ") : "not detected"}`,
  ];
}

/** `public.orders` when the table carries a schema, `orders` when it does not. */
function qualifiedName(tbl) {
  const schema = text(tbl.schema);
  const name = text(tbl.name);
  return schema ? `${schema}.${name}` : name;
}

function renderColumn(field, index) {
  const parts = [`- ${text(field.name)}: ${shortType(field.baseType) || "unknown"}`];
  const semantic = shortType(field.semanticType);
  if (semantic) parts.push(` [${semantic}]`);
  const target = field.fkTargetFieldId != null ? index.fieldIndex.get(field.fkTargetFieldId) : null;
  if (target && target.table.id !== field.tableId) parts.push(` -> ${text(target.table.name)}`);
  return parts.join("");
}

function renderDataModel(index, { maxTablesPerDb, maxColumns }) {
  const lines = ["## Data model"];
  if (index.databases.length === 0) {
    lines.push("", "No databases found.");
    return lines;
  }

  for (const database of index.databases) {
    const dbName = text(database.name) || `Database ${database.id}`;
    const engine = text(database.engine) || "unknown engine";
    const dbTables = index.tables
      .filter((t) => t.dbId === database.id)
      .map((t) => ({ table: t, usage: index.usageFor(database.id, t) }))
      // Queried tables first: that is the core model, and it is what a reader
      // with a limited context window should spend its tokens on.
      .sort((a, b) => b.usage - a.usage || String(a.table.name).localeCompare(String(b.table.name)));

    lines.push("", `### Database: ${dbName} (${engine})`);
    if (dbTables.length === 0) {
      lines.push("", "No tables found in this database.");
      continue;
    }

    const shown = dbTables.slice(0, maxTablesPerDb);
    for (const { table: tbl, usage } of shown) {
      const rows = num(tbl.rowCount) > 0 ? `~${fmtInt(tbl.rowCount)} rows` : "rows unknown";
      lines.push("", `#### ${qualifiedName(tbl)} (${plural(usage, "question", "questions")}, ${rows})`);
      const description = text(tbl.description);
      if (description) lines.push(description, "");

      const fields = asArray(tbl.fields);
      if (fields.length === 0) lines.push("- (no column metadata in the snapshot)");
      for (const field of fields.slice(0, maxColumns)) {
        lines.push(renderColumn({ ...field, tableId: tbl.id }, index));
      }
      if (fields.length > maxColumns) {
        lines.push(`- ... ${plural(fields.length - maxColumns, "more column", "more columns")}`);
      }
    }

    const cut = dbTables.length - shown.length;
    if (cut > 0) lines.push("", `and ${plural(cut, "more table", "more tables")} not listed`);
  }

  return lines;
}

function renderRelationships(findings, index) {
  const lines = ["## Relationships"];

  const declared = [];
  for (const tbl of index.tables) {
    for (const field of asArray(tbl.fields)) {
      if (field.fkTargetFieldId == null) continue;
      const target = index.fieldIndex.get(field.fkTargetFieldId);
      if (!target || target.table.id === tbl.id) continue;
      declared.push(
        `- ${text(tbl.name)}.${text(field.name)} -> ${text(target.table.name)}.${text(target.field.name)}`,
      );
    }
  }

  const edges = asArray(findings.erdEdges).filter((e) => e.from && e.to);

  if (declared.length === 0 && edges.length === 0) {
    lines.push("", "No relationships detected.");
    return lines;
  }

  if (declared.length > 0) {
    lines.push("", "Declared foreign keys:", "");
    lines.push(...declared);
  }

  if (edges.length > 0) {
    lines.push("", "Inferred from JOINs in saved questions:", "");
    for (const edge of edges) {
      lines.push(
        `- ${text(edge.from)} <-> ${text(edge.to)} (${plural(num(edge.count), "question", "questions")}, inferred)`,
      );
    }
  }

  return lines;
}

function renderDashboards(findings) {
  const lines = ["## Dashboards", ""];
  const dashboards = asArray(findings.dashboards);
  if (dashboards.length === 0) {
    lines.push("None.");
    return lines;
  }
  const rows = dashboards.map((d) => {
    const name = cell(d.name) || `Dashboard ${num(d.id)}`;
    const url = clean(d.url);
    return [
      url ? `[${name}](${url})` : name,
      fmtInt(num(d.cardCount)),
      cell(d.status) || "unknown",
      cell(d.creatorName) || "Unknown",
      fmtInt(num(d.viewCount)),
    ];
  });
  lines.push(...table(["Dashboard", "Questions", "Status", "Owner", "Views"], rows));
  return lines;
}

function renderOwnership(findings) {
  const lines = ["## Team and ownership", ""];
  const creators = asArray(findings.creators);
  if (creators.length === 0) {
    lines.push("Owner names are not available (the API key is not in the Administrators group).");
    return lines;
  }
  lines.push("Questions counts active questions. Stale counts the ones nobody has opened in 90 days.", "");
  const rows = creators.map((c) => [
    cell(c.name) || "Unknown",
    fmtInt(num(c.activeCards)),
    fmtInt(num(c.staleCards)),
  ]);
  lines.push(...table(["Owner", "Questions", "Stale"], rows));
  return lines;
}

function renderKeyFindings(findings) {
  const s = findings.summary || {};
  const anomalyCount = (type) =>
    num(asArray(findings.anomalies).find((a) => a.type === type)?.count);
  const unusedTables = asArray(findings.tables).filter((t) => num(t.usageCount) === 0).length;
  const shakyDashboards = asArray(findings.dashboards).filter(
    (d) => d.status === "broken" || d.status === "warning",
  ).length;
  const activeCards = num(s.activeCards);
  const totalTables = num(s.totalTables);
  const undocumented = anomalyCount("naming");
  const dashboardCount = asArray(findings.dashboards).length;

  return [
    "## Key findings",
    "",
    `- Health grade ${text(s.healthGrade) || "n/a"}, score ${fmtInt(num(s.healthScore))} of 100.`,
    `- ${plural(num(s.duplicateGroups), "duplicate group", "duplicate groups")}, ${plural(num(s.duplicateCardsToArchive), "question", "questions")} proposed for archiving.`,
    `- ${plural(num(s.brokenCards), "question references", "questions reference")} a table or a column that is not in the schema.`,
    `- ${plural(num(s.staleCards90), "question", "questions")} unused for 90 days, ${fmtInt(num(s.staleCards180))} of them for 180 days.`,
    `- ${fmtInt(undocumented)} of ${fmtInt(activeCards)} active questions ${agree(undocumented, "carries", "carry")} no description.`,
    `- ${fmtInt(unusedTables)} of ${fmtInt(totalTables)} tables ${agree(unusedTables, "is", "are")} never read by a saved question.`,
    `- ${fmtInt(shakyDashboards)} of ${fmtInt(dashboardCount)} dashboards ${agree(shakyDashboards, "carries", "carry")} a broken or a stale card.`,
  ];
}

/** Where a saved question lives, as a readable path. */
function collectionOf(card, index) {
  if (card.collectionId === null || card.collectionId === undefined) return "none";
  return index.collectionPaths.get(card.collectionId) || "none";
}

function renderSql(sql) {
  // SQL is data, not prose: it is copied verbatim (no dash rewriting), only trimmed.
  const lines = String(sql ?? "").trim().split("\n");
  const kept = lines.slice(0, MAX_SQL_LINES);
  if (lines.length > MAX_SQL_LINES) kept.push(`-- truncated, ${fmtInt(lines.length - MAX_SQL_LINES)} more lines`);
  // A query that carries a fence of its own would close the block early.
  const fence = kept.some((l) => l.includes("```")) ? "````" : "```";
  return [`${fence}sql`, ...kept, fence];
}

function renderTrustedQueries(index, topQueries) {
  const lines = ["## Trusted queries", ""];

  const candidates = index.activeCards
    .filter((c) => clean(c.sql).length > 0 && !index.duplicateArchiveIds.has(c.id))
    .sort((a, b) => {
      const views = num(b.viewCount) - num(a.viewCount);
      if (views !== 0) return views;
      const aUsed = ymd(a.lastUsedAt) ?? "";
      const bUsed = ymd(b.lastUsedAt) ?? "";
      if (aUsed !== bUsed) return bUsed.localeCompare(aUsed);
      return String(a.name).localeCompare(String(b.name));
    })
    .slice(0, topQueries);

  if (candidates.length === 0) {
    lines.push("None. No saved question carries query text; run the scan with --compile to include questions built in the query builder.");
    return lines;
  }

  lines.push(
    "The questions the team opens most, with the SQL behind them. Treat these as the working definition of the metrics they name.",
  );

  for (const card of candidates) {
    const source = card.sqlSource === "native" ? "native SQL" : "compiled from the query builder";
    lines.push("", `### ${text(card.name) || `Question ${num(card.id)}`}`, "");
    lines.push(
      `Views: ${fmtInt(num(card.viewCount))}. Last used: ${ymd(card.lastUsedAt) ?? "never"}. Collection: ${collectionOf(card, index)}. Source: ${source}.`,
    );
    const description = text(card.description);
    if (description) lines.push("", description);
    lines.push("", ...renderSql(card.sql));
  }

  return lines;
}

/**
 * Business vocabulary, taken from what people named their questions. A term
 * earns a line when two questions use it, or when it is a word that almost
 * always means something specific to a company (revenue, churn, cohort).
 * Ported from the SaaS `buildGlossary`, with the threshold lowered: a self
 * hosted Metabase with 40 questions never reached the SaaS cut of five.
 */
function renderGlossary(index) {
  const lines = ["## Glossary candidates", ""];
  const freq = new Map();

  for (const card of index.activeCards) {
    const words = new Set(
      clean(card.name)
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
    );
    for (const word of words) freq.set(word, (freq.get(word) || 0) + 1);
  }

  const terms = [...freq.entries()]
    .filter(([term, count]) => count >= GLOSSARY_MIN_CARDS || BUSINESS_TERMS.has(term))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_GLOSSARY_TERMS)
    .map(([term]) => term);

  if (terms.length === 0) {
    lines.push("None.");
    return lines;
  }

  lines.push("Words the team puts in question names. Define the ones that carry a business meaning here.", "");
  lines.push(terms.join(", "));
  return lines;
}

function renderNotes() {
  return [
    "## Notes for the reader",
    "",
    "Add your own definitions below (what counts as revenue, which dashboard is the source of truth, who owns which area). The audit skills treat this section as ground truth.",
    "",
    "- (your notes here)",
  ];
}

/**
 * Renders `DATA-CONTEXT.md` from a snapshot and its findings.
 *
 * @param {object} snapshot  the scan snapshot
 * @param {object} findings  the output of `analyze(snapshot)`
 * @param {object} [options]
 * @param {number} [options.maxTablesPerDb=30]  tables listed per database
 * @param {number} [options.maxColumns=25]      columns listed per table
 * @param {number} [options.topQueries=15]      saved questions quoted with SQL
 * @param {Date}   [options.now=new Date()]     the generation date
 * @returns {string} the Markdown document, ending in a single newline
 */
export function renderContext(snapshot, findings, options = {}) {
  const {
    maxTablesPerDb = 30,
    maxColumns = 25,
    topQueries = 15,
    now = new Date(),
  } = options;

  const safeFindings = findings || {};
  const index = buildIndex(snapshot || {}, safeFindings);

  const blocks = [
    renderHeader(snapshot || {}, safeFindings, now),
    renderOverview(safeFindings, index),
    renderDataModel(index, { maxTablesPerDb, maxColumns }),
    renderRelationships(safeFindings, index),
    renderDashboards(safeFindings),
    renderOwnership(safeFindings),
    renderKeyFindings(safeFindings),
    renderTrustedQueries(index, topQueries),
    renderGlossary(index),
    renderNotes(),
  ];

  return `${blocks.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}
