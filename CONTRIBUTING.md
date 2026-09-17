# Contributing

Thanks for looking. A few things that make a pull request easy to merge:

- Run `npm test` before opening it. The suite is plain `node:test`, no build step, and it runs in a few seconds.
- If you fix a false positive in the SQL parser, add the offending SQL (trimmed and anonymised) as a test in `test/sql.test.js`. That is how every real-world fix in the repo landed.
- If a Metabase version behaves differently, include the version string from `npx metabase-audit doctor` and the shape of the payload that surprised the code.
- Keep the two-dependency rule. Anything beyond the MCP SDK and zod needs a reason in the pull request.
- Prose in the README, the skills and generated reports avoids em and en dashes. Commas, colons and periods do the job.

To try a change against a real instance without touching it: `npx metabase-audit scan` is read-only, and `archive` without `--apply` never writes. `node scripts/make-example.mjs` regenerates the synthetic sample under `examples/` if your change affects the report or the context file.
