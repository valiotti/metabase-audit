---
name: metabase-audit
description: Use when the user asks to audit, review, clean up, tidy, or check the health of a Metabase instance (duplicates, stale questions, broken queries, dead dashboards, who owns what). Runs the metabase-audit CLI locally, reads METALENS-REPORT.md, explains it in plain language and proposes a cleanup list. Never archives anything without an explicit go from the user.
---

# Metabase audit

You help the user audit and clean up their own Metabase using the `metabase-audit` CLI. Everything runs on their machine against their Metabase. Nothing is sent anywhere else.

## Preconditions

1. `METABASE_URL` and `METABASE_API_KEY` must be set in the environment. If they are not, tell the user how to create an API key (Metabase Admin settings, Authentication, API Keys, group Administrators) and ask them to export both variables. Never ask the user to paste the key into the chat. Never print the key.
2. Node 18 or newer must be available. `npx metabase-audit --version` confirms it.

## Workflow

1. Run `npx metabase-audit doctor`. If it fails on auth or permissions, stop and explain the fix from its output. Do not retry with guessed values.
2. Run `npx metabase-audit scan`. On instances with many GUI-built questions, offer `npx metabase-audit scan --compile` afterwards (it compiles GUI questions to SQL so duplicates are found by query text, not only by name). It takes longer.
3. Read `METALENS-REPORT.md` in full. Then read `.metalens/findings.json` for exact ids when you need them.
4. Summarise for the user in this order:
   - the grade and the one-line verdict
   - the top 5 actions from "Do this first", each in one sentence with the number of questions it touches
   - the duplicates, grouped by owner, with the question you propose to keep and why (most views, most recent use)
   - broken questions with the missing table names
   - dashboards with status warning or broken
5. Propose a cleanup list. Always show the dry run first:
   `npx metabase-audit archive --from duplicates` and `npx metabase-audit archive --ids <ids>`.
   Explain that nothing changes until `--apply` is added, and that every apply writes an undo file under `.metalens/`.
6. Only when the user explicitly says to go ahead, run the same command with `--apply`. Report what was archived and the undo command:
   `npx metabase-audit unarchive --undo .metalens/undo-<timestamp>.json --apply`.

## Do not

- Do not run any `--apply` command unless the user asked for it in their own words in this conversation.
- Do not archive a question that the report marks as the one to keep in a duplicate group.
- Do not archive dashboards; v1 works with questions only.
- Do not paste the API key anywhere, including logs, commit messages, or issue reports.
- Do not invent numbers. If a section of the report is empty, say so.

## When the report is not enough

If the user cannot decide what to archive because owners disagree, metric definitions conflict, or nobody knows which dashboard is the source of truth, say that this is a people problem, not a tooling problem, and point to the README section "When the report is not enough".
