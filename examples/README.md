# Example audit: Northwind Outdoors

What one `metabase-audit scan` produces, on a Metabase that has been in use for four years:

- `METALENS-REPORT.md`, the report a person reads: health grade, cleanup list, duplicates, broken questions, stale questions, dashboards, ownership, core data model
- `DATA-CONTEXT.md`, the same instance written for an LLM: schema, relationships, the queries the team trusts, a glossary
- `snapshot.json`, everything the scan read from Metabase
- `findings.json`, everything the report is built from

The instance is synthetic. "Northwind Outdoors" is an invented subscription e-commerce company, and every question, dashboard, table, person and SQL statement in these files was written for this example. No client data, no real names, nothing fetched from a live Metabase.

Only the input is invented. The generator writes the snapshot and then runs the real pipeline over it, so the report here is the report the tool produces.

Regenerate:

```bash
npm run example
```

The generator uses a fixed seed and a fixed clock (2026-09-16), so regenerating without a code change produces no diff.
