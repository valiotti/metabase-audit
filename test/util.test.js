import test from "node:test";
import assert from "node:assert/strict";

import { daysBetween, daysSince, fmtInt, isoOrNull, maskSecret, pad } from "../src/util.js";

test("fmtInt groups thousands and leaves small numbers alone", () => {
  assert.equal(fmtInt(0), "0");
  assert.equal(fmtInt(7), "7");
  assert.equal(fmtInt(1234), "1,234");
  assert.equal(fmtInt(5000000), "5,000,000");
  assert.equal(fmtInt("1234"), "1,234", "a numeric string still formats");
});

test("fmtInt prints n/a for anything that is not a finite number", () => {
  assert.equal(fmtInt(null), "n/a");
  assert.equal(fmtInt(undefined), "n/a");
  assert.equal(fmtInt(NaN), "n/a");
  assert.equal(fmtInt(Infinity), "n/a", "Infinity rows is never a fact worth printing");
  assert.equal(fmtInt(-Infinity), "n/a");
  assert.equal(fmtInt("not a number"), "n/a");
  assert.equal(fmtInt({}), "n/a");
  assert.equal(fmtInt([1, 2]), "n/a");
});

test("isoOrNull keeps valid dates and rejects the rest", () => {
  assert.equal(isoOrNull("2026-09-16T00:00:00Z"), "2026-09-16T00:00:00.000Z");
  assert.equal(isoOrNull("not a date"), null);
  assert.equal(isoOrNull(null), null);
  assert.equal(isoOrNull(""), null);
});

test("daysBetween and daysSince count whole days", () => {
  const now = new Date("2026-09-16T00:00:00Z");
  assert.equal(daysBetween(now, "2026-09-06T00:00:00Z"), 10);
  assert.equal(daysSince(null, now), null);
  assert.ok(Number.isNaN(daysSince("not a date", now)), "an unparseable date is not a number of days");
});

test("maskSecret keeps the first four characters only", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("abc"), "****");
  assert.equal(maskSecret("mb_supersecret_key_value"), "mb_s************");
  assert.ok(!maskSecret("mb_supersecret_key_value").includes("secret"));
});

test("pad fills to the width and never truncates", () => {
  assert.equal(pad("id", 4), "id  ");
  assert.equal(pad("longer", 3), "longer");
  assert.equal(pad(null, 2), "  ");
});
