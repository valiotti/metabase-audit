/**
 * Pure SQL text helpers. No I/O, no dependencies.
 *
 * The duplicate detector, the broken-query detector and the ERD builder all
 * need to read raw native SQL that users wrote in Metabase. That SQL arrives
 * in every dialect Metabase can talk to (Postgres, BigQuery, Snowflake, MySQL,
 * ClickHouse) and is often half-templated, so nothing here is a real grammar:
 * a small scanner splits the text into tokens and a few rules read table names
 * off those tokens. Every function tolerates garbage and never throws.
 *
 * Scanning rather than regex-matching the raw text matters in practice. A
 * double-quoted string that contains an apostrophe ("Coeur d'Alene, ID")
 * breaks naive quote pairing and silently swallows hundreds of characters of
 * real SQL, which is what made CTE names go missing on a real 2,700-question
 * instance. The scanner also makes a FROM inside a quoted alias
 * (AS "First Reservation From Guest") a non-event.
 */

/** Words that show up where a table name would but never name a warehouse table. */
const NOT_A_TABLE = new Set(["select", "with", "values", "unnest", "lateral", "dual"]);

/**
 * Catalog schemas and object prefixes that exist in every warehouse and are
 * never user tables: information_schema.columns, pg_catalog.pg_class, and
 * BigQuery's dataset.__TABLES__ (any __name__ object).
 */
const SKIP_SCHEMAS = new Set(["information_schema", "pg_catalog"]);
const SKIP_PREFIX = "__";

/**
 * Keywords that legitimately precede an open paren. When a FROM sits inside
 * parens whose preceding token is one of these we are in a CTE body or a
 * subquery; when it is any other bare identifier we are inside a function call
 * and the FROM is argument syntax, not a clause: EXTRACT(epoch FROM ts),
 * SUBSTRING(s FROM 1 FOR 3), TRIM(BOTH ' ' FROM s), OVERLAY(s PLACING x FROM 2).
 */
const CLAUSE_KEYWORDS = new Set([
  "as", "on", "and", "or", "in", "is", "not", "where", "when", "then",
  "else", "select", "distinct", "group", "having", "order", "by", "limit",
  "offset", "union", "intersect", "except", "values", "returning",
  "with", "recursive",
]);

/** Words that can follow a table reference but are never its alias. */
const NOT_AN_ALIAS = new Set([
  "where", "group", "order", "having", "limit", "offset", "union", "intersect",
  "except", "join", "left", "right", "inner", "full", "cross", "outer",
  "natural", "on", "using", "window", "qualify", "into", "returning", "for",
  "from", "and", "or", "not", "when", "then", "else", "end", "set", "values",
  "tablesample", "sample", "final", "prewhere", "settings", "format", "lateral",
]);

// Unicode letters and digits, so identifiers in any language hold together.
// Matching a raw -￿ range instead would swallow non-breaking spaces,
// which real Metabase cards do contain, and glue whole clauses into one token.
const WORD_CHAR = /[\p{L}\p{N}_$]/u;
const WHITESPACE = /\s/;

/**
 * Splits SQL into tokens, dropping whitespace and both comment styles.
 * Kinds: "word" (lowercased), "quoted" (identifier, quotes stripped), "string"
 * (contents discarded), "param" (a Metabase template tag) and "punct" (one
 * character). Tokens keep their offsets so callers can tell generate_series(
 * from foo (a, b), and a-b from a - b.
 */
function tokenize(sql) {
  const tokens = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    if (WHITESPACE.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === "{" && sql[i + 1] === "{") {
      const close = sql.indexOf("}}", i + 2);
      const end = close === -1 ? n : close + 2;
      tokens.push({ kind: "param", value: sql.slice(i, end).toLowerCase(), start: i, end });
      i = end;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      tokens.push({ kind: "string", value: "", start: i, end: j });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "`") {
      let j = i + 1;
      let buf = "";
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            buf += ch;
            j += 2;
            continue;
          }
          j++;
          break;
        }
        buf += sql[j++];
      }
      tokens.push({ kind: "quoted", value: buf.toLowerCase(), start: i, end: j });
      i = j;
      continue;
    }
    if (WORD_CHAR.test(ch)) {
      let j = i;
      while (j < n && WORD_CHAR.test(sql[j])) j++;
      tokens.push({ kind: "word", value: sql.slice(i, j).toLowerCase(), start: i, end: j });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", value: ch, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

function tokensOf(sql) {
  return typeof sql === "string" && sql ? tokenize(sql) : [];
}

const isName = (t) => !!t && (t.kind === "word" || t.kind === "quoted");
const isPunct = (t, value) => !!t && t.kind === "punct" && t.value === value;

/** Index just past the balanced group that opens at k. */
function skipBalanced(tokens, k) {
  let depth = 0;
  for (let i = k; i < tokens.length; i++) {
    if (tokens[i].kind !== "punct") continue;
    if (tokens[i].value === "(") depth++;
    else if (tokens[i].value === ")" && --depth === 0) return i + 1;
  }
  return tokens.length;
}

/**
 * Flattens identifier parts into dotted segments, so "public"."Orders" and the
 * BigQuery form `project.dataset.table` both end up as a list whose last entry
 * is the table itself.
 */
function segmentsOf(parts) {
  const segments = [];
  for (const part of parts) {
    for (const segment of part.split(".")) {
      const trimmed = segment.trim();
      if (trimmed) segments.push(trimmed);
    }
  }
  return segments;
}

/**
 * Reads the identifier path after FROM/JOIN: optional ONLY/LATERAL, then
 * dot-separated parts, each of which may be quoted. Bare parts may contain
 * hyphens when nothing separates them, which is how BigQuery writes project
 * ids (sniffspot-dwh.dataset.table). Returns null when no identifier follows,
 * which is exactly the subquery case FROM (SELECT ...) alias.
 */
function readPath(tokens, start) {
  let k = start;
  while (tokens[k] && tokens[k].kind === "word" && (tokens[k].value === "only" || tokens[k].value === "lateral")) k++;
  const parts = [];
  let current = null;
  let last = null;
  while (k < tokens.length) {
    const t = tokens[k];
    if (current === null) {
      if (!isName(t)) break;
      current = t.value;
      last = t;
      k++;
      continue;
    }
    if (isPunct(t, ".") && isName(tokens[k + 1])) {
      parts.push(current);
      current = null;
      k++;
      continue;
    }
    if (isPunct(t, "-") && t.start === last.end) {
      const next = tokens[k + 1];
      if (next && next.kind === "word" && next.start === t.end) {
        current += `-${next.value}`;
        last = next;
        k += 2;
        continue;
      }
    }
    break;
  }
  if (current === null) return null;
  parts.push(current);
  return { parts, next: k };
}

/** The table name a path points at, or null when it is not a warehouse table. */
function tableNameOf(tokens, path) {
  const segments = segmentsOf(path.parts);
  const name = segments[segments.length - 1];
  if (!name) return null;
  // An open paren right after the name means a table function: unnest(x),
  // generate_series (a, b, c). Whitespace in between is allowed.
  if (isPunct(tokens[path.next], "(")) return null;
  if (segments.some((s) => SKIP_SCHEMAS.has(s))) return null;
  if (name.startsWith(SKIP_PREFIX)) return null;
  if (NOT_A_TABLE.has(name)) return null;
  if (/^\d+$/.test(name)) return null;
  return name;
}

/** Index just past an alias sitting between a table reference and what follows. */
function skipAlias(tokens, k) {
  const t = tokens[k];
  if (!t) return k;
  if (t.kind === "word" && t.value === "as") return isName(tokens[k + 1]) ? k + 2 : k;
  if (t.kind === "quoted") return k + 1;
  if (t.kind === "word" && !NOT_AN_ALIAS.has(t.value)) return k + 1;
  return k;
}

/** Names bound by a WITH clause: WITH a AS (...), , b (cols) AS (...), WITH RECURSIVE t AS (...). */
function cteNames(tokens) {
  const names = new Set();
  if (!tokens.some((t) => t.kind === "word" && t.value === "with")) return names;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isName(t)) continue;
    const prev = tokens[i - 1];
    const opensDefinition =
      !prev ||
      isPunct(prev, ",") ||
      (prev.kind === "word" && (prev.value === "with" || prev.value === "recursive"));
    if (!opensDefinition) continue;
    let k = i + 1;
    if (isPunct(tokens[k], "(")) k = skipBalanced(tokens, k); // column list
    if (!(tokens[k] && tokens[k].kind === "word" && tokens[k].value === "as")) continue;
    if (!isPunct(tokens[k + 1], "(")) continue;
    const segments = segmentsOf([t.value]);
    const name = segments[segments.length - 1];
    if (name && !NOT_A_TABLE.has(name)) names.add(name);
  }
  return names;
}

/**
 * Every table reference in reading order, with the keyword that introduced it
 * and its paren depth. CTE names, catalog objects, table functions and the
 * FROM of IS DISTINCT FROM are already filtered out. Comma-joined tables are
 * reported as "join" so callers can treat FROM a, b like FROM a JOIN b.
 */
function collectRefs(tokens) {
  const refs = [];
  if (tokens.length === 0) return refs;
  const ctes = cteNames(tokens);
  const owners = []; // token in front of each open paren still on the stack

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "punct") {
      if (t.value === "(") owners.push(tokens[i - 1] || null);
      else if (t.value === ")") owners.pop();
      continue;
    }
    if (t.kind !== "word" || (t.value !== "from" && t.value !== "join")) continue;

    // x IS DISTINCT FROM y and x IS NOT DISTINCT FROM y: an operator, not a clause.
    const prev = tokens[i - 1];
    if (prev && prev.kind === "word" && prev.value === "distinct") continue;

    const owner = owners[owners.length - 1];
    if (owner && owner.kind === "word" && !CLAUSE_KEYWORDS.has(owner.value)) continue;

    const path = readPath(tokens, i + 1);
    if (!path) continue;
    const depth = owners.length;
    const name = tableNameOf(tokens, path);
    if (name && !ctes.has(name)) refs.push({ keyword: t.value, name, depth });
    if (t.value !== "from") continue;

    // Old-style comma joins: FROM a, b c, d. An alias may sit before each comma.
    let k = path.next;
    for (let guard = 0; guard < 500; guard++) {
      k = skipAlias(tokens, k);
      if (!isPunct(tokens[k], ",")) break;
      const nextPath = readPath(tokens, k + 1);
      if (!nextPath) break;
      const nextName = tableNameOf(tokens, nextPath);
      if (nextName && !ctes.has(nextName)) refs.push({ keyword: "join", name: nextName, depth });
      k = nextPath.next;
    }
  }
  return refs;
}

/** How a token reads once the query is normalized. */
function normalizedText(token) {
  if (token.kind === "string") return "'?'";
  return token.value;
}

/**
 * Canonical form of a query for exact-duplicate comparison: lowercased, both
 * comment styles removed, whitespace collapsed, punctuation spacing removed,
 * string literals and numbers replaced by placeholders. Two cards that differ
 * only in formatting or in the constants they filter on normalize to the same
 * string.
 *
 * Quoted identifiers keep their text (quotes dropped), so "public"."orders"
 * and "public"."users" stay different queries. Treating them as literals, the
 * way a single regex pass does, collapses every Metabase-generated query onto
 * one string and reports unrelated cards as exact duplicates.
 */
export function normalizeSql(sql) {
  const tokens = tokensOf(sql);
  if (tokens.length === 0) return "";
  let out = "";
  let prevEnd = -1;
  for (const token of tokens) {
    if (prevEnd >= 0 && token.start > prevEnd) out += " ";
    out += normalizedText(token);
    prevEnd = token.end;
  }
  return out
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*=\s*/g, "=")
    .replace(/\s*([()])\s*/g, "$1")
    .replace(/\b\d+\b/g, "?")
    .trim();
}

/**
 * Names defined by a WITH clause, lowercased. They look exactly like table
 * references further down the query, so detectors subtract them before
 * deciding a table is missing.
 */
export function extractCteNames(sql) {
  return cteNames(tokensOf(sql));
}

/**
 * Warehouse tables a query reads, unique and in first-seen order. Names are
 * the last dotted segment, lowercased and unquoted. Excludes CTE names,
 * subquery aliases, catalog objects, table functions and every FROM that is
 * function-call or operator syntax rather than a clause.
 */
export function extractReferencedTables(sql) {
  const seen = new Set();
  const out = [];
  for (const ref of collectRefs(tokensOf(sql))) {
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
  const refs = collectRefs(tokensOf(sql));
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
