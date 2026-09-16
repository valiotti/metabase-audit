#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(typeof code === "number" ? code : 0),
  (err) => {
    process.stderr.write(`metabase-audit: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  }
);
