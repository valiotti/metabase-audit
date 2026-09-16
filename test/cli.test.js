import test from "node:test";
import assert from "node:assert/strict";

import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { main, parseArgs } from "../src/cli.js";
import { resolveConfig } from "../src/config.js";
import { runScan } from "../src/scan.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const BIN = path.join(root, "bin", "metabase-audit.js");
const FIXTURE = path.join(root, "test", "fixtures", "snapshot.small.json");
const NOW = "2026-09-16T00:00:00Z";

const tempDirs = [];

function tmp() {
  const base = path.join(root, "tmp");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "cli-"));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Captures what a command writes, the way process.stdout would receive it. */
function stream() {
  const chunks = [];
  return {
    chunks,
    write(s) {
      chunks.push(String(s));
      return true;
    },
    get text() {
      return chunks.join("");
    },
  };
}

/** A run of `main` with both streams captured and the environment under control. */
async function cli(argv, { env = {}, cwd = root } = {}) {
  const stdout = stream();
  const stderr = stream();
  const code = await main(argv, { env, cwd, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** process.env minus anything that would make a test depend on the machine. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("METABASE_") || key.startsWith("METALENS_")) delete env[key];
  }
  return { ...env, ...extra };
}

/** End to end through bin/metabase-audit.js, so the exit code is the real one. */
async function bin(args, { env = {}, cwd = root, timeout = 60_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], { env: cleanEnv(env), cwd, timeout });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// --- parsing -----------------------------------------------------------

test("parseArgs takes both flag forms and keeps the command separate", () => {
  const parsed = parseArgs(["scan", "--snapshot", "x.json", `--now=${NOW}`, "--json", "--limit", "5"]);
  assert.deepEqual(parsed, {
    command: "scan",
    args: [],
    flags: { snapshot: "x.json", now: NOW, json: true, limit: "5" },
  });
});

test("parseArgs keeps subarguments and reads flags placed after them", () => {
  const parsed = parseArgs(["findings", "duplicates", "--limit", "3", "--dir", "/tmp/x"]);
  assert.equal(parsed.command, "findings");
  assert.deepEqual(parsed.args, ["duplicates"]);
  assert.deepEqual(parsed.flags, { limit: "3", dir: "/tmp/x" });
});

test("boolean flags take no value and negated flags turn output off", () => {
  const parsed = parseArgs(["scan", "--quiet", "--no-report", "--no-context", "--compile"]);
  assert.deepEqual(parsed.flags, { quiet: true, report: false, context: false, compile: true });
  // --quiet must not swallow the command that follows it
  assert.deepEqual(parseArgs(["--quiet", "doctor"]), { command: "doctor", args: [], flags: { quiet: true } });
});

test("parseArgs rejects unknown flags and value flags with nothing after them", () => {
  assert.throws(() => parseArgs(["scan", "--nope"]), /Unknown option "--nope"/);
  assert.throws(() => parseArgs(["scan", "--dir"]), /needs a value/);
});

test("an unknown flag exits 2 with a message, not a stack trace", async () => {
  const r = await cli(["scan", "--nope"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown option "--nope"/);
  assert.equal(r.stdout, "");
});

test("an unknown command exits 2", async () => {
  const r = await cli(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command "frobnicate"/);
});

test("--version prints the package version", async () => {
  const r = await cli(["--version"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "0.1.0");
});

test("help lists every command on one screen", async () => {
  const r = await cli([]);
  assert.equal(r.code, 0);
  for (const command of ["doctor", "scan", "report", "context", "findings", "archive", "unarchive", "mcp"]) {
    assert.match(r.stdout, new RegExp(`\\n  ${command}\\b`), `usage is missing ${command}`);
  }
  assert.ok(r.stdout.split("\n").length < 60, "usage should stay short enough to read at once");
  assert.equal((await cli(["help"])).stdout, r.stdout);
  assert.equal((await cli(["scan", "--help"])).stdout, r.stdout);
});

test("an unparsable --now is an invocation error", async () => {
  const r = await cli(["scan", "--snapshot", FIXTURE, "--now", "yesterday"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Invalid --now/);
});

// --- connection checks -------------------------------------------------

test("scan without a URL, a key or a snapshot explains what to set", async () => {
  const r = await cli(["scan"], { env: {} });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /METABASE_URL/);
  assert.match(r.stderr, /--snapshot/);
});

test("doctor without a connection exits 2", async () => {
  const r = await cli(["doctor"], { env: {} });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /METABASE_URL/);
});

// --- scan, report, context ---------------------------------------------

test("scan on a snapshot file writes all four files and reports a grade", async () => {
  const dir = tmp();
  const r = await bin(["scan", "--snapshot", FIXTURE, "--dir", dir, "--out", dir, "--now", NOW, "--json"]);
  assert.equal(r.code, 0, r.stderr);

  const payload = JSON.parse(r.stdout);
  assert.ok(payload.health.grade, "health.grade is missing");
  assert.equal(payload.health.grade, payload.summary.healthGrade);
  assert.equal(payload.paths.report, path.join(dir, "METALENS-REPORT.md"));

  for (const file of ["METALENS-REPORT.md", "DATA-CONTEXT.md", "findings.json"]) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} was not written`);
  }
  assert.ok(fs.existsSync(payload.paths.snapshot), "the snapshot path does not exist");
});

test("scan prints a human summary and progress on stderr", async () => {
  const dir = tmp();
  const r = await cli(["scan", "--snapshot", FIXTURE, "--dir", dir, "--out", dir, "--now", NOW]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Health: C\+ \(51\/100\)/);
  assert.match(r.stdout, /Duplicates: 2 groups, 2 questions can be archived/);
  assert.match(r.stdout, /Broken: 1 question points at a table that no longer exists/);
  assert.match(r.stdout, /Stale: 3 questions unused for 90\+ days/);
  assert.match(r.stdout, /Dashboards: 1 mostly stale, 1 with broken questions/);
  assert.match(r.stdout, /METALENS-REPORT\.md/);
  assert.match(r.stdout, /DATA-CONTEXT\.md/);
  assert.match(r.stdout, /findings\.json/);
  assert.match(r.stderr, /\[analyze\]/);
});

test("--quiet drops the progress lines, --no-report and --no-context skip files", async () => {
  const dir = tmp();
  const r = await cli(["scan", "--snapshot", FIXTURE, "--dir", dir, "--out", dir, "--now", NOW, "--quiet", "--no-report", "--no-context"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(fs.existsSync(path.join(dir, "METALENS-REPORT.md")), false);
  assert.equal(fs.existsSync(path.join(dir, "DATA-CONTEXT.md")), false);
  assert.ok(fs.existsSync(path.join(dir, "findings.json")));
});

test("report and context re-render from a snapshot without touching the network", async () => {
  const dir = tmp();
  const out = tmp();

  const report = await cli(["report", "--snapshot", FIXTURE, "--dir", dir, "--out", out, "--now", NOW], { env: {} });
  assert.equal(report.code, 0, report.stderr);
  assert.equal(report.stdout.trim(), path.join(out, "METALENS-REPORT.md"));
  assert.ok(fs.existsSync(path.join(out, "METALENS-REPORT.md")));

  const context = await cli(["context", "--snapshot", FIXTURE, "--dir", dir, "--out", out, "--now", NOW], { env: {} });
  assert.equal(context.code, 0, context.stderr);
  assert.equal(context.stdout.trim(), path.join(out, "DATA-CONTEXT.md"));
  assert.ok(fs.existsSync(path.join(out, "DATA-CONTEXT.md")));
});

test("report picks up snapshot.json from --dir when no --snapshot is given", async () => {
  const dir = tmp();
  fs.copyFileSync(FIXTURE, path.join(dir, "snapshot.json"));
  const r = await cli(["report", "--dir", dir, "--out", dir, "--now", NOW], { env: {} });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(dir, "METALENS-REPORT.md"));
  assert.ok(fs.existsSync(path.join(dir, "METALENS-REPORT.md")));
  // context is not rewritten by the report command
  assert.equal(fs.existsSync(path.join(dir, "DATA-CONTEXT.md")), false);
});

test("report without a previous scan fails with an explanation, not a crash", async () => {
  const dir = tmp();
  const r = await cli(["report", "--dir", dir, "--out", dir], { env: {} });
  assert.equal(r.code, 1);
  assert.ok(r.stderr.trim().length > 0);
});

// --- findings ----------------------------------------------------------

test("findings duplicates on a snapshot prints both groups as JSON", async () => {
  const dir = tmp();
  const r = await bin(["findings", "duplicates", "--snapshot", FIXTURE, "--dir", dir, "--json", "--now", NOW]);
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.total, 2);
  assert.equal(payload.duplicates.length, 2);
  assert.deepEqual(payload.duplicates.map((g) => g.kind), ["exact-sql", "same-name"]);
});

test("findings honours --limit and reads findings.json from --dir", async () => {
  const dir = tmp();
  await cli(["scan", "--snapshot", FIXTURE, "--dir", dir, "--out", dir, "--now", NOW, "--quiet"]);
  const r = await cli(["findings", "duplicates", "--dir", dir, "--limit", "1"], { env: {} });
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.duplicates.length, 1);
  assert.equal(payload.total, 2);
});

test("an unknown findings kind exits 2 and names the valid ones", async () => {
  const dir = tmp();
  const r = await cli(["findings", "nonsense", "--snapshot", FIXTURE, "--dir", dir], { env: {} });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown findings kind/);
  assert.match(r.stderr, /duplicates/);
});

test("findings without a kind exits 2", async () => {
  const r = await cli(["findings"], { env: {} });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs a kind/);
});

// --- archive -----------------------------------------------------------

async function scannedDir() {
  const dir = tmp();
  await cli(["scan", "--snapshot", FIXTURE, "--dir", dir, "--out", dir, "--now", NOW, "--quiet"]);
  return dir;
}

test("archive --from duplicates is a dry run and needs no connection", async () => {
  const dir = await scannedDir();
  const r = await cli(["archive", "--from", "duplicates", "--dir", dir], { env: {} });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /2 questions would be archived/);
  assert.match(r.stdout, /Re-run with --apply/);
  assert.match(r.stdout, /id \| name/);
  assert.match(r.stdout, /^2\s+\| Revenue by month \(copy\)/m);
  assert.match(r.stdout, /^3\s+\| revenue_by_month_v2/m);
  // the keep card of the group is never in the plan
  assert.doesNotMatch(r.stdout, /^1\s+\|/m);
});

test("archive --apply without a connection exits 2 before anything happens", async () => {
  const dir = await scannedDir();
  const r = await cli(["archive", "--apply", "--from", "duplicates", "--dir", dir], { env: {} });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /METABASE_URL/);
});

test("archive refuses the card marked keep in a duplicate group", async () => {
  const dir = await scannedDir();
  const r = await cli(["archive", "--ids", "1", "--dir", dir], { env: {} });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Card 1 is the one to keep/);
});

/** Stands in for Metabase: every card is live, every update succeeds. */
async function cardServer() {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const id = Number(req.url.split("/").pop());
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id, name: `Card ${id}`, archived: req.method === "PUT" ? JSON.parse(body || "{}").archived : false }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("archive --apply writes an undo file and prints the command that reverses it", async () => {
  const dir = await scannedDir();
  const metabase = await cardServer();
  const KEY = "mb_secret_test_key";
  try {
    const r = await cli(
      ["archive", "--from", "duplicates", "--apply", "--reason", "duplicate cleanup", "--dir", dir, "--url", metabase.url, "--key", KEY, "--now", NOW],
      { env: {} },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Archived 2 questions/);
    assert.match(r.stdout, /npx metabase-audit unarchive --undo .*undo-.*\.json --apply/);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(KEY));
    assert.deepEqual(metabase.calls.filter((c) => c.startsWith("PUT")).sort(), ["PUT /api/card/2", "PUT /api/card/3"]);

    const undoName = fs.readdirSync(dir).find((f) => f.startsWith("undo-"));
    assert.ok(undoName, "no undo file was written");
    const undo = JSON.parse(fs.readFileSync(path.join(dir, undoName), "utf8"));
    assert.equal(undo.reason, "duplicate cleanup");
    assert.deepEqual(undo.cards.map((c) => c.id).sort(), [2, 3]);
    assert.deepEqual(undo.result.applied.map((c) => c.id).sort(), [2, 3]);

    const back = await cli(["unarchive", "--undo", path.join(dir, undoName), "--apply", "--url", metabase.url, "--key", KEY], { env: {} });
    assert.equal(back.code, 0, back.stderr);
    assert.match(back.stdout, /Restored 2 questions/);
  } finally {
    await metabase.close();
  }
});

test("archive without --ids or --from exits 2", async () => {
  const dir = await scannedDir();
  const r = await cli(["archive", "--dir", dir], { env: {} });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--ids/);
  assert.match(r.stderr, /--from/);
});

test("archive --ids still works when no scan has been run", async () => {
  const dir = tmp();
  const r = await cli(["archive", "--ids", "7,8", "--dir", dir], { env: {} });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /2 questions would be archived/);
  assert.match(r.stderr, /Run "metabase-audit scan" first/);
});

test("archive --from with no scan explains itself and exits 1", async () => {
  const dir = tmp();
  const r = await cli(["archive", "--from", "duplicates", "--dir", dir], { env: {} });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Run "metabase-audit scan" first/);
});

test("unarchive needs an undo file, then prints the plan from it", async () => {
  const dir = tmp();
  const missing = await cli(["unarchive"], { env: {} });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--undo/);

  const undoFile = path.join(dir, "undo-test.json");
  fs.writeFileSync(
    undoFile,
    JSON.stringify({ createdAt: NOW, reason: "test", cards: [{ id: 2, name: "Revenue by month (copy)", previous: { archived: false } }] }),
  );
  const r = await cli(["unarchive", "--undo", undoFile], { env: {} });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Revenue by month \(copy\)/);
  assert.match(r.stdout, /1 question would be restored/);
});

// --- connection failures and the key ------------------------------------

test("doctor against a closed port fails on reachability and never echoes the key", async () => {
  const r = await cli(["doctor", "--url", "https://127.0.0.1:9", "--key", "mb_supersecret_key_value"], { env: {} });
  assert.equal(r.code, 1);
  const output = r.stdout + r.stderr;
  assert.match(output, /Could not reach that URL/);
  assert.doesNotMatch(output, /mb_supersecret_key_value/);
  assert.doesNotMatch(output, /supersecret/);
});

// --- mcp ---------------------------------------------------------------

test("the mcp command is imported lazily so the CLI runs without the server", async () => {
  const source = fs.readFileSync(path.join(root, "src", "cli.js"), "utf8");
  assert.doesNotMatch(source, /^import[^\n]*["']\.\/mcp\.js["']/m, "mcp.js must not be imported at the top level");
  assert.match(source, /await import\("\.\/mcp\.js"\)/);
  // and nothing in that branch may touch stdout: the protocol owns it
  const branch = source.slice(source.indexOf("async function cmdMcp"), source.indexOf("// --- shared helpers"));
  assert.doesNotMatch(branch, /\bout\(/);
});

// --- credentials in the URL ---------------------------------------------

/** A Metabase with one database, one table and one question. Enough for a full scan. */
function stubClient() {
  return {
    async getInstanceInfo() {
      return { siteName: "Acme", version: "v0.62.3" };
    },
    async getDatabases() {
      return [{ id: 2, name: "Warehouse", engine: "postgres" }];
    },
    async getDatabaseMetadata() {
      return {
        tables: [
          {
            id: 10,
            name: "orders",
            schema: "public",
            display_name: "Orders",
            rows: 120,
            fields: [{ id: 100, name: "id", base_type: "type/Integer", semantic_type: "type/PK" }],
          },
        ],
      };
    },
    async getAllCards() {
      return [
        {
          id: 1,
          name: "Revenue by month",
          query_type: "native",
          database_id: 2,
          dataset_query: { type: "native", database: 2, native: { query: "SELECT 1 FROM orders" } },
          collection_id: null,
          creator_id: null,
          last_used_at: "2026-09-11T08:00:00Z",
          view_count: 4,
          archived: false,
        },
      ];
    },
    async getCollections() {
      return [];
    },
    async getAllUsers() {
      return [];
    },
    async getAllDashboards() {
      return [];
    },
    async getDashboard() {
      return null;
    },
    async getActivity() {
      return [];
    },
    async compileToNative() {
      return null;
    },
  };
}

test("credentials in the URL are kept out of the config URL and out of every output", async () => {
  const config = resolveConfig({ url: "https://admin:hunter2@mb.example.com/" }, {}, root);
  assert.equal(config.url, "https://mb.example.com");
  assert.equal(config.basicAuth.username, "admin");
  assert.equal(config.basicAuth.password, "hunter2");

  const dir = tmp();
  const result = await runScan({
    client: stubClient(),
    url: config.url,
    dir,
    out: dir,
    now: new Date(NOW),
  });

  assert.equal(result.snapshot.instance.url, "https://mb.example.com");
  assert.ok(!JSON.stringify(result.snapshot).includes("hunter2"), "the snapshot carries the password");
  for (const file of ["METALENS-REPORT.md", "DATA-CONTEXT.md", "findings.json"]) {
    const body = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(!body.includes("hunter2"), `${file} carries the password`);
    assert.ok(!body.includes("admin:"), `${file} carries the user info`);
  }
});

test("a URL without credentials keeps basicAuth null and only drops the trailing slash", () => {
  const config = resolveConfig({ url: "mb.example.com/metabase/" }, {}, root);
  assert.equal(config.url, "https://mb.example.com/metabase");
  assert.equal(config.basicAuth, null);
});

/** Stands in for a Metabase behind a proxy that quotes the API key back in an error body. */
async function echoingServer(key) {
  const server = http.createServer((req, res) => {
    const url = String(req.url);
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/api/session/properties")) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: `rejected key ${req.headers["x-api-key"] ?? key}` }));
      return;
    }
    if (url.startsWith("/api/database/")) {
      res.end(JSON.stringify({ tables: [{ id: 10, name: "orders", schema: "public", rows: 10, fields: [] }] }));
      return;
    }
    if (url.startsWith("/api/database")) {
      res.end(JSON.stringify([{ id: 2, name: "Warehouse", engine: "postgres" }]));
      return;
    }
    if (url.startsWith("/api/card")) {
      res.end(
        JSON.stringify([
          {
            id: 1,
            name: "Revenue by month",
            query_type: "native",
            database_id: 2,
            dataset_query: { type: "native", database: 2, native: { query: "SELECT 1 FROM orders" } },
            creator_id: null,
            last_used_at: "2026-09-11T08:00:00Z",
            view_count: 4,
            archived: false,
          },
        ]),
      );
      return;
    }
    res.end("[]");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("the API key never reaches a stream or a file, not even when Metabase quotes it back", async () => {
  const KEY = "mb_supersecret_key_value";
  const dir = tmp();
  const metabase = await echoingServer(KEY);
  try {
    const r = await cli(["scan", "--url", metabase.url, "--key", KEY, "--dir", dir, "--out", dir, "--now", NOW], { env: {} });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes(KEY), "the key reached a stream");

    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8"));
    assert.ok(
      snapshot.meta.warnings.some((w) => w.includes("Could not read instance info")),
      "the failing call should have been recorded as a warning",
    );
    for (const file of fs.readdirSync(dir)) {
      const body = fs.readFileSync(path.join(dir, file), "utf8");
      assert.ok(!body.includes(KEY), `${file} carries the key`);
    }
  } finally {
    await metabase.close();
  }
});
