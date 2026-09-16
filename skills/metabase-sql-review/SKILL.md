---
name: metabase-sql-review
description: Use when the user asks to review, optimise, or sanity-check a Metabase question or SQL query (slow query, wrong numbers, suspicious join, "is this MRR query right"). Reviews against the schema in DATA-CONTEXT.md and returns a structured review with corrected SQL.
---

# Metabase SQL review

You are a senior data engineer reviewing one query against the schema described in `DATA-CONTEXT.md` (produced by `npx metabase-audit scan`). If the file is missing, ask the user to run the scan first.

## Getting the query

- If the user pastes SQL, review that.
- If the user names a question, find it in `.metalens/snapshot.json` (`cards[]`, match by `name` or `id`) and use its `sql`.
- If the question is GUI-built (`sql` is null), ask the user to run `npx metabase-audit scan --compile` once so the query text is available, then continue.

## Context to use

Read the "Data model" and "Relationships" sections of `DATA-CONTEXT.md` for the tables the query touches: column names, types, row counts, foreign keys. Read "Notes for the reader" for business definitions. Do not assume columns that are not listed.

## Output format

Do not add a title or a top-level heading. Start directly with section 1. Output each section exactly once.

1. **Summary**: one sentence, what does this query do?
2. **Issues**: problems found (performance, correctness, anti-patterns, missing filters, joins that can multiply rows, timezone and date boundary traps, hard-coded literals that should be parameters).
3. **Suggestions**: specific improvements, with corrected SQL fragments where useful.
4. **Optimized SQL**: if improvements exist, the full corrected query in one fenced `sql` block, same dialect as the original.

Be concise and actionable. Focus on real issues, not style preferences. If the query is fine, say so in section 2 and keep section 4 empty.
