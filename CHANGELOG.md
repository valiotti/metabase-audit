# Changelog

## 0.1.0

First public release of the MetaLens toolkit as an open-source package.

- `doctor`: connection and permission check with plain-language fixes.
- `scan`: snapshot of databases, tables, questions, dashboards, collections and users into `.metalens/snapshot.json`; analysis into `.metalens/findings.json`; `METALENS-REPORT.md` and `DATA-CONTEXT.md` written to the current folder.
- Findings: exact-SQL and same-name duplicates, questions referencing missing tables, stale questions (90 and 180 days), unused tables, undocumented and orphan questions, dashboard status, ownership, health score A to F with four factors, JOIN-inferred relationships.
- `archive` and `unarchive`: dry run by default, `--apply` to execute, undo log for every apply.
- `mcp`: stdio MCP server exposing doctor, scan, findings, context and archive tools.
- Claude Code skills: `metabase-audit`, `metabase-gaps`, `metabase-sql-review`, `metabase-metric-tree`.
- `--compile`: compile GUI-built questions to SQL through Metabase so they take part in duplicate and broken detection.
