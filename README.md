# MetaLens: open-source Metabase audit kit

The Metabase audit I run for clients, as a script you run yourself. One command on your laptop, one report out. Your Metabase API key never leaves your machine, and nothing is sent to us.

It finds duplicate questions, questions that point at tables that no longer exist, stale questions nobody has opened in months, dashboards that are quietly dead, and who owns what. It grades the instance A to F, writes a cleanup list, and can archive questions for you, dry run first, with an undo file.

It also writes `DATA-CONTEXT.md`: your schema, relationships, the queries the team actually trusts, and a glossary. Paste it into Claude (or any LLM) and it knows your data. Four Claude Code skills and an MCP server are included.

## Run it

1. In Metabase, create an API key: Admin settings, Authentication, API Keys, group Administrators. (Why admin: see Permissions below.)
2. Put the two values in your environment:

```bash
export METABASE_URL="https://metabase.yourcompany.com"
export METABASE_API_KEY="mb_..."
```

3. Run the audit. Node 18 or newer is the only requirement.

```bash
npx metabase-audit doctor   # checks URL, key and permissions, explains fixes in plain words
npx metabase-audit scan     # writes METALENS-REPORT.md and DATA-CONTEXT.md to the current folder
```

A 100-question instance takes well under a minute. Large instances take a few minutes, mostly waiting on Metabase.

## What you get

`METALENS-REPORT.md` looks like this:

```
# Metabase health report: Acme
https://metabase.acme.com, Metabase v0.62.3, generated 2026-09-16
9 active questions, 3 dashboards, 1 database, 4 tables

## Health: C (61/100)
Duplicates and stale content are dragging the score. Fix the two exact-duplicate groups first.

| Factor                      | Score | How to improve                                   |
| Content freshness           | 20/35 | 3 of 9 questions unused for 90+ days              |
| No duplicates               | 12/25 | 2 duplicate groups, 2 questions can be archived   |
| Documentation & organization| 9/20  | 5 questions have no description, 1 is in no collection |
| Dashboard reliability       | 20/20 | ...

## Do this first
1. Archive 2 exact duplicate questions (keep "Revenue by month")
2. Fix "Old orders report": it references a table that no longer exists (legacy_orders)
...
```

Then duplicates (with the question to keep and why), broken questions, stale questions by owner, dashboards with status, ownership, the core data model, and the exact CLI lines to act on each finding.

`.metalens/` holds the raw data: `snapshot.json` (everything fetched from Metabase) and `findings.json` (everything the report is built from). Both are plain JSON, so you can script on top of them.

## What leaves your machine

Nothing, except the calls to your own Metabase over the URL you provided. No telemetry, no phone-home, no MetaLens account. The source is small enough to read in one sitting: `src/client.js` is the only file that talks to the network.

The API key is read from the environment or the `--key` flag and is never written to disk, never printed, and masked in error messages.

## Permissions

The key needs to be in the Administrators group. Metabase only exposes `/api/database`, table metadata, user names and the full question list to admins. A key scoped to a regular group will pass `doctor` on reachability and fail on permissions, and `doctor` will tell you so.

Everything the audit does is read-only except the `archive` command, which you have to opt into with `--apply`.

## Cleanup, safely

```bash
npx metabase-audit archive --from duplicates          # dry run: shows what would be archived
npx metabase-audit archive --ids 2,3 --apply           # archives questions 2 and 3, writes .metalens/undo-<timestamp>.json
npx metabase-audit unarchive --undo .metalens/undo-2026-09-16T10-00-00.json --apply
```

Rules the tool enforces: nothing changes without `--apply`; every apply writes an undo file first; the question marked "keep" in a duplicate group can never be selected by `--from duplicates`; v1 archives questions only, never dashboards or collections.

## Use it with Claude

Three ways, pick one.

**Claude Code skills.** Copy the `skills/` folder into your project (`.claude/skills/`) or your home (`~/.claude/skills/`). Then ask Claude Code to audit your Metabase. The `metabase-audit` skill runs the scan, explains the report, proposes a cleanup list and asks before applying anything. `metabase-gaps` tells you which dashboards are missing, `metabase-sql-review` reviews a question against your schema, `metabase-metric-tree` builds a North Star tree as a Mermaid diagram.

**MCP server.** Add this to Claude Desktop, Claude Code or Cursor:

```json
{
  "mcpServers": {
    "metabase-audit": {
      "command": "npx",
      "args": ["-y", "metabase-audit", "mcp"],
      "env": {
        "METABASE_URL": "https://metabase.yourcompany.com",
        "METABASE_API_KEY": "mb_...",
        "METALENS_DIR": "/absolute/path/where/outputs/go/.metalens"
      }
    }
  }
}
```

Tools exposed: `metabase_doctor`, `metabase_scan`, `metabase_findings`, `metabase_context`, `metabase_archive_cards` (preview unless `apply: true`), `metabase_unarchive`.

**Plain paste.** Open `DATA-CONTEXT.md`, paste it into any chat, ask your questions.

## Commands

| Command | What it does |
|---|---|
| `doctor` | Checks URL, key, permissions, instance size |
| `scan [--compile]` | Fetches metadata, analyses it, writes the report and the context file |
| `report` | Re-renders `METALENS-REPORT.md` from the existing snapshot, no network |
| `context` | Re-renders `DATA-CONTEXT.md` from the existing snapshot |
| `findings <summary\|duplicates\|broken\|stale\|dashboards\|actions\|tables> [--limit N]` | Prints a slice of the findings as JSON |
| `archive --ids a,b \| --from duplicates\|broken [--apply] [--reason "..."]` | Dry run by default |
| `unarchive --undo <file> [--apply]` | Restores from an undo file |
| `mcp` | Starts the MCP server on stdio |

Global flags: `--url`, `--key` (or the env vars), `--dir` (default `./.metalens`), `--out` (where the two Markdown files go, default `.`), `--json`, `--quiet`, `--snapshot <file>` (analyse a saved snapshot instead of fetching).

`--compile` asks Metabase to compile GUI-built questions to SQL, one request per question. Without it, GUI questions are compared by name only and cannot be checked for missing tables. Worth running once on instances built mostly with the query builder.

## How the score works

Four factors, 100 points total, the same formula MetaLens uses in its hosted version:

| Factor | Points | What it measures |
|---|---|---|
| Content freshness | 35 | Share of questions unused for 90+ days |
| No duplicates | 25 | Exact-SQL and same-name duplicate groups |
| Documentation & organization | 20 | Questions without descriptions, questions outside collections, unused tables |
| Dashboard reliability | 20 | Dashboards with broken questions or mostly stale content |

Grades are calibrated on real instances, where 30 to 50 is typical for a company that has used Metabase for a few years: A from 85, B+ from 70, B from 55, C+ from 40, C from 30, D from 20, F below that. An instance with dashboards but zero saved questions is scored on reusability instead, because everything there lives ad hoc inside dashboards.

## Limits

- Duplicate detection compares SQL text. GUI-built questions are compared by name unless you run `scan --compile`.
- "Broken" means the SQL references a table that does not exist in Metabase's metadata. Column errors, syntax errors and permission errors are not detected; that would require running every query.
- Dashboard details are fetched for the 300 most viewed dashboards by default. The rest are listed without their questions.
- Older Metabase versions (before 0.50) do not report when a question was last used. The tool falls back to the activity log where available; otherwise those questions show as "unknown" rather than stale.
- Tested against Metabase 0.50 through 0.62.

## When the report is not enough

The report tells you what is wrong. It does not tell you which of the three revenue definitions is the right one, who is allowed to archive the CFO's dashboard, or what the board should be looking at instead of the pages nobody opens. That part is people and decisions, and a script will not do it.

That is what the MetaLens Sprint is: two weeks, we run this same toolkit with you, sit down with the owners, get the definitions signed off, execute the cleanup with someone accountable for it, and hand back `DATA-CONTEXT.md` as a living document your team keeps. From $12,000. Details at [metalens.it/sprint](https://metalens.it/sprint).

There is no gated feature behind that. The toolkit is complete as it is.

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening one. If you hit a Metabase version where something breaks, include the version string from `doctor` and the relevant line from `.metalens/findings.json` or the warning from `meta.warnings` in the snapshot.

## License

MIT. Built by [Valiotti Data](https://valiotti.com).
