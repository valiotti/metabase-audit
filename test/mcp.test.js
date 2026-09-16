/**
 * Smoke test for the stdio MCP server: spawn the real binary, talk to it with
 * the MCP client, and walk the whole tool surface against the small fixture.
 *
 * The child gets METALENS_SNAPSHOT and no credentials, so every tool that can
 * work offline must work, and every tool that needs Metabase must say so
 * instead of trying to reach the network.
 */

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { resolveConfig } from "../src/config.js";
import { createServer } from "../src/mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const snapshotFixture = path.join(here, "fixtures", "snapshot.small.json");
const binary = path.join(repoRoot, "bin", "metabase-audit.js");

const TOOL_NAMES = [
  "metabase_doctor",
  "metabase_scan",
  "metabase_findings",
  "metabase_context",
  "metabase_archive_cards",
  "metabase_unarchive",
];

let workDir;
let client;
let transport;
let childPid = null;

/** process.env with the undefined values dropped, which the transport requires. */
function stringEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries({ ...process.env, ...extra })) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function textOf(result) {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "metalens-mcp-"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [binary, "mcp"],
    cwd: repoRoot,
    stderr: "pipe",
    env: stringEnv({
      METABASE_URL: "",
      METABASE_API_KEY: "",
      METALENS_SNAPSHOT: snapshotFixture,
      METALENS_DIR: workDir,
    }),
  });
  client = new Client({ name: "metabase-audit-test", version: "0.0.0" });
  await client.connect(transport);
  transport.stderr?.resume();
  childPid = transport.pid;
});

after(async () => {
  try {
    await client?.close();
  } catch {
    // the child may already be gone
  }
  try {
    await transport?.close();
  } catch {
    // same
  }
  if (childPid) {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // already exited, which is what we want
    }
  }
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("createServer builds the tool surface without a transport of its own", async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(
    resolveConfig({}, { METALENS_DIR: workDir, METALENS_SNAPSHOT: snapshotFixture }, repoRoot)
  );
  await server.connect(serverSide);

  const inProcess = new Client({ name: "metabase-audit-test-inprocess", version: "0.0.0" });
  await inProcess.connect(clientSide);
  try {
    const { tools } = await inProcess.listTools();
    assert.equal(tools.length, TOOL_NAMES.length);
  } finally {
    await inProcess.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

test("lists exactly the six audit tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...TOOL_NAMES].sort()
  );
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string", `${tool.name} needs a description`);
    assert.ok(tool.description.length > 20, `${tool.name} description is too thin`);
  }
});

test("metabase_scan analyses the snapshot and writes the report", async () => {
  const result = await client.callTool({ name: "metabase_scan", arguments: {} });
  assert.notEqual(result.isError, true, textOf(result));

  const { health, summary, paths } = result.structuredContent;
  assert.equal(typeof health.grade, "string");
  assert.equal(typeof summary.totalCards, "number");
  await access(paths.report);
  await access(paths.findings);

  const text = textOf(result);
  assert.match(text, /Health:/);
  assert.match(text, /METALENS-REPORT\.md/);
});

test("metabase_findings returns the duplicate groups", async () => {
  const result = await client.callTool({ name: "metabase_findings", arguments: { kind: "duplicates" } });
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(result.structuredContent.duplicates.length, 2);
  assert.equal(result.structuredContent.total, 2);
});

test("metabase_findings rejects an unknown kind", async () => {
  const result = await client.callTool({ name: "metabase_findings", arguments: { kind: "nonsense" } });
  assert.equal(result.isError, true);
});

test("metabase_archive_cards previews without touching Metabase", async () => {
  const result = await client.callTool({ name: "metabase_archive_cards", arguments: { ids: [2, 3] } });
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(result.structuredContent.apply, false);
  assert.equal(result.structuredContent.plan.length, 2);
  assert.match(textOf(result), /Dry run: 2 questions would be archived/);
  assert.match(textOf(result), /apply: true/);
});

test("metabase_archive_cards takes its ids from the duplicate findings", async () => {
  const result = await client.callTool({ name: "metabase_archive_cards", arguments: { from: "duplicates" } });
  assert.notEqual(result.isError, true, textOf(result));
  assert.deepEqual(
    result.structuredContent.plan.map((row) => row.id),
    [2, 3]
  );
});

test("metabase_archive_cards with apply needs a connection", async () => {
  const result = await client.callTool({ name: "metabase_archive_cards", arguments: { ids: [2, 3], apply: true } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /METABASE_URL/);
});

test("metabase_archive_cards refuses the keeper of a duplicate group", async () => {
  const result = await client.callTool({ name: "metabase_archive_cards", arguments: { ids: [1] } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /keep/i);
});

test("metabase_archive_cards needs ids or from", async () => {
  const result = await client.callTool({ name: "metabase_archive_cards", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /ids/);
});

test("metabase_context returns the generated data context", async () => {
  const result = await client.callTool({ name: "metabase_context", arguments: {} });
  assert.notEqual(result.isError, true, textOf(result));
  assert.match(textOf(result), /# Data context/);
  assert.equal(typeof result.structuredContent.path, "string");
});

test("metabase_doctor reports the missing connection instead of dialling out", async () => {
  const result = await client.callTool({ name: "metabase_doctor", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /METABASE_URL/);
});

test("an unscanned working directory sends the model to metabase_scan", async () => {
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), "metalens-mcp-empty-"));
  const otherTransport = new StdioClientTransport({
    command: process.execPath,
    args: [binary, "mcp"],
    cwd: repoRoot,
    stderr: "pipe",
    env: stringEnv({ METABASE_URL: "", METABASE_API_KEY: "", METALENS_SNAPSHOT: "", METALENS_DIR: emptyDir }),
  });
  const otherClient = new Client({ name: "metabase-audit-test-empty", version: "0.0.0" });
  await otherClient.connect(otherTransport);
  otherTransport.stderr?.resume();

  try {
    const findings = await otherClient.callTool({ name: "metabase_findings", arguments: { kind: "summary" } });
    assert.equal(findings.isError, true);
    assert.match(textOf(findings), /metabase_scan/);

    const context = await otherClient.callTool({ name: "metabase_context", arguments: {} });
    assert.equal(context.isError, true);
    assert.match(textOf(context), /metabase_scan/);

    const scan = await otherClient.callTool({ name: "metabase_scan", arguments: {} });
    assert.equal(scan.isError, true);
    assert.match(textOf(scan), /METABASE_URL/);
  } finally {
    await otherClient.close().catch(() => {});
    await otherTransport.close().catch(() => {});
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test("metabase_unarchive previews a restore from an undo file", async () => {
  const undoFile = path.join(workDir, "undo-test.json");
  await writeFile(
    undoFile,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      reason: "test",
      cards: [
        { id: 2, name: "Revenue by month (copy)", previous: { archived: false } },
        { id: 3, name: "revenue_by_month_v2", previous: { archived: false } },
      ],
    })
  );

  const result = await client.callTool({ name: "metabase_unarchive", arguments: { undoFile } });
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(result.structuredContent.apply, false);
  assert.equal(result.structuredContent.plan.length, 2);
  assert.match(textOf(result), /Dry run: 2 questions would be restored/);
});

test("metabase_unarchive explains a missing undo file", async () => {
  const result = await client.callTool({
    name: "metabase_unarchive",
    arguments: { undoFile: path.join(workDir, "undo-nope.json") },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Undo file not found/);
});

test("the API key is masked in structuredContent, not only in the text", async () => {
  const KEY = "mb_supersecret_key_value";
  // A working directory that carries the key is the plainest way to get it into
  // a payload a client reads instead of the text block.
  const keyedDir = path.join(workDir, KEY);
  await mkdir(keyedDir, { recursive: true });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(
    resolveConfig(
      {},
      { METALENS_DIR: keyedDir, METALENS_SNAPSHOT: snapshotFixture, METABASE_API_KEY: KEY },
      repoRoot
    )
  );
  await server.connect(serverSide);

  const inProcess = new Client({ name: "metabase-audit-test-masking", version: "0.0.0" });
  await inProcess.connect(clientSide);
  try {
    const result = await inProcess.callTool({ name: "metabase_scan", arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));

    const structured = JSON.stringify(result.structuredContent);
    assert.ok(structured.includes("mb_s************"), "the masked form should be there instead");
    assert.ok(!structured.includes(KEY), "the raw key reached structuredContent");
    assert.ok(!textOf(result).includes(KEY), "the raw key reached the text block");
  } finally {
    await inProcess.close().catch(() => {});
    await server.close().catch(() => {});
  }
});
