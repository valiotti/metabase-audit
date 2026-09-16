// Placeholder until Task 8. Prints usage so the bin runs from day one.
export async function main(argv) {
  process.stdout.write("metabase-audit 0.1.0\nUsage: metabase-audit <doctor|scan|report|context|findings|archive|unarchive|mcp>\n");
  return argv.length ? 0 : 0;
}
