/**
 * Pure SQL text helpers. No I/O, no dependencies.
 *
 * The duplicate detector, the broken-query detector and the ERD builder all
 * need to read raw native SQL that users wrote in Metabase. That SQL arrives
 * in every dialect Metabase can talk to (Postgres, BigQuery, Snowflake, MySQL,
 * ClickHouse) and is often half-templated, so the parsing here is deliberately
 * heuristic and forgiving: regexes over a lightly cleaned copy of the text,
 * never a real grammar. Every function tolerates garbage and never throws.
 */

/** One identifier part: "quoted", `backticked`, or bare. */
const PART = String.raw`(?:"[^"]+"|\`[^\`]+\`|\w+)`;

/** FROM/JOIN (any variant: LEFT OUTER JOIN, CROSS JOIN, …) plus up to three dotted parts. */
const FROM_JOIN_SRC = String.raw`\b(from|join)\s+(?:(?:only|lateral)\s+)?(${PART})(?:\s*\.\s*(${PART}))?(?:\s*\.\s*(${PART}))?`;

/** ", table" continuation of an old-style comma join list. */
const COMMA_PART_SRC = String.raw`^\s*,\s*(${PART})(?:\s*\.\s*(${PART}))?(?:\s*\.\s*(${PART}))?`;

/** An alias sitting right after a table reference: "t x" or "t AS x". */
const ALIAS_SRC = String.raw`^\s+(?:as\s+)?${PART}`;

/** `WITH name AS (`, `WITH RECURSIVE name AS (`, `, name (cols) AS (`. */
const CTE_SRC = String.raw`(?:^|\bwith\b\s+(?:recursive\s+)?|,)\s*(${PART})\s*(?:\([^)]*\))?\s+as\s*\(`;

/** Words that show up where a table name would but never name a warehouse table. */
const NOT_A_TABLE = new Set(["select", "with", "values", "unnest", "lateral", "dual"]);

/**
 * Keywords that legitimately precede `(`. Used by the backwards paren walk: if
 * the token before the enclosing `(` is one of these we are inside a CTE body
 * or a subquery, not inside a function call.
 */
const CLAUSE_KEYWORDS = new Set([
  "as", "on", "and", "or", "in", "is", "not", "where", "when", "then",
  "else", "select", "distinct", "group", "having", "order", "by", "limit",
  "offset", "union", "intersect", "except", "values", "returning",
  "with", "recursive",
]);

/**
 * Cleans the text before any pattern matching: drops comments, neutralizes
 * Metabase template tags ({{date}}, {{snippet: …}}) and empties string
 * literals so their contents can never look like a table reference. Indexes
 * shift, which is fine because every caller works on the cleaned copy only.
 */
function prepare(sql) {
  if (typeof sql !== "string") return "";
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\{\{[\s\S]*?\}\}/g, "1")
    .replace(/'[^']*'/g, "''");
}

/** Strips quoting and keeps the last dotted segment: "public"."Orders" → orders. */
function bareName(part) {
  if (!part) return "";
  const trimmed = part.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"));
  const inner = quoted ? trimmed.slice(1, -1) : trimmed;
  const segments = inner.split(".");
  return segments[segments.length - 1].trim().toLowerCase();
}

/**
 * Picks the table name out of the captured identifier parts (the last part
 * wins, so schema and project qualifiers fall away). Returns null when the
 * match is not a table: a keyword, a number left behind by a template tag, or
 * a table-valued function call such as `FROM unnest(...)`.
 */
function pickName(parts, sql, end) {
  let raw = "";
  for (const part of parts) if (part) raw = part;
  if (!raw) return null;
  if (sql[end] === "(") return null;
  const name = bareName(raw);
  if (!name || NOT_A_TABLE.has(name) || /^\d+$/.test(name)) return null;
  return name;
}

/**
 * Walks backwards from `pos` balancing parens. At the nearest unmatched `(`,
 * looks at the token in front of it: a bare identifier that is not a clause
 * keyword means we are inside a function call. Catches the dialect quirks that
 * use FROM as argument syntax: EXTRACT(epoch FROM ts), SUBSTRING(s FROM 1 FOR 3),
 * TRIM(BOTH ' ' FROM s), OVERLAY(s PLACING x FROM 2).
 */
function isInsideFunctionCall(sql, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = sql[i];
    if (c === ")") {
      depth++;
    } else if (c === "(") {
      if (depth === 0) {
        let j = i - 1;
        while (j >= 0 && /\s/.test(sql[j])) j--;
        if (j < 0 || !/\w/.test(sql[j])) return false;
        let k = j;
        while (k >= 0 && /\w/.test(sql[k])) k--;
        const token = sql.slice(k + 1, j + 1).toLowerCase();
        if (!token) return false;
        return !CLAUSE_KEYWORDS.has(token);
      }
      depth--;
    }
  }
  return false;
}

/** CTE names found in already-prepared text. */
function cteNamesOf(sql) {
  const names = new Set();
  if (!/\bwith\b/i.test(sql)) return names;
  const re = new RegExp(CTE_SRC, "gi");
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = bareName(m[1]);
    if (name && !NOT_A_TABLE.has(name) && name !== "as") names.add(name);
  }
  return names;
}

/**
 * Every table reference in already-prepared text, in reading order, with the
 * keyword that introduced it and its paren nesting depth. CTE names, function
 * calls and keywords are already filtered out. Comma-joined tables are
 * reported as "join" so callers can treat `FROM a, b` like `FROM a JOIN b`.
 */
function collectRefs(sql) {
  const refs = [];
  if (!sql) return refs;
  const cteNames = cteNamesOf(sql);
  const re = new RegExp(FROM_JOIN_SRC, "gi");
  const commaRe = new RegExp(COMMA_PART_SRC, "i");
  const aliasRe = new RegExp(ALIAS_SRC, "i");
  let depth = 0;
  let cursor = 0;
  let m;

  while ((m = re.exec(sql)) !== null) {
    while (cursor < m.index) {
      const ch = sql[cursor++];
      if (ch === "(") depth++;
      else if (ch === ")" && depth > 0) depth--;
    }
    if (isInsideFunctionCall(sql, m.index)) continue;

    const keyword = m[1].toLowerCase();
    const end = m.index + m[0].length;
    const name = pickName([m[2], m[3], m[4]], sql, end);
    if (name && !cteNames.has(name)) refs.push({ keyword, name, depth });
    if (keyword !== "from") continue;

    // Old-style comma joins: FROM a, b c, d. Aliases sit between the table and
    // the next comma, so skip one before each lookahead.
    let pos = end;
    for (let guard = 0; guard < 100; guard++) {
      const alias = aliasRe.exec(sql.slice(pos));
      const afterAlias = alias ? pos + alias[0].length : pos;
      const next = commaRe.exec(sql.slice(afterAlias));
      if (!next) break;
      const nextEnd = afterAlias + next[0].length;
      if (nextEnd <= pos) break;
      const nextName = pickName([next[1], next[2], next[3]], sql, nextEnd);
      if (nextName && !cteNames.has(nextName)) refs.push({ keyword: "join", name: nextName, depth });
      pos = nextEnd;
    }
  }
  return refs;
}

/**
 * Canonical form of a query for exact-duplicate comparison: lowercased, both
 * comment styles removed, whitespace collapsed, punctuation spacing removed,
 * string literals and numbers replaced by placeholders. Two cards that differ
 * only in formatting or in the constants they filter on normalize to the same
 * string.
 */
export function normalizeSql(sql) {
  if (typeof sql !== "string") return "";
  return sql
    .toLowerCase()
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*=\s*/g, "=")
    .replace(/\s*([()])\s*/g, "$1")
    // Only single-quoted text is a literal. Double quotes and backticks wrap
    // identifiers (Metabase compiles GUI questions to "schema"."table"), so
    // they are unwrapped rather than blanked: otherwise "orders" and "users"
    // would normalise to the same query and be reported as duplicates.
    .replace(/'[^']*'/g, "'?'")
    .replace(/["`]([^"`]*)["`]/g, "$1")
    .replace(/\b\d+\b/g, "?")
    .trim();
}

/**
 * Names defined by a WITH clause, lowercased. They look exactly like table
 * references further down the query, so detectors subtract them before
 * deciding a table is missing.
 */
export function extractCteNames(sql) {
  return cteNamesOf(prepare(sql));
}

/**
 * Warehouse tables a query reads, unique and in first-seen order. Names are
 * the last dotted segment, lowercased and unquoted. Excludes CTE names,
 * subquery aliases and FROM/IN that belong to a function call.
 */
export function extractReferencedTables(sql) {
  const seen = new Set();
  const out = [];
  for (const ref of collectRefs(prepare(sql))) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    out.push(ref.name);
  }
  return out;
}

/**
 * Join edges for the ERD: every top-level JOIN target paired with the
 * outermost FROM table. Joins inside subqueries stay out of it, and a query
 * whose outermost FROM is a subquery or a CTE produces no pairs. Unique by
 * from+to, in first-seen order.
 */
export function extractJoinPairs(sql) {
  const refs = collectRefs(prepare(sql));
  const anchor = refs.find((r) => r.keyword === "from" && r.depth === 0);
  if (!anchor) return [];
  const pairs = [];
  const seen = new Set();
  for (const ref of refs) {
    if (ref.keyword !== "join" || ref.depth !== 0) continue;
    if (ref.name === anchor.name) continue;
    const key = `${anchor.name}|${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ from: anchor.name, to: ref.name });
  }
  return pairs;
}
