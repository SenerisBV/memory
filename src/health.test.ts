import { expect, test } from "bun:test";

import { computeHealth } from "./health";

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-04T09:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * day);

test("a store nobody has written to for longer than the cadence raises", () => {
  const r = computeHealth({
    now, writeCadenceDays: 3, consolidateCadenceDays: 2,
    lastWriteByAuthor: [{ author: "a", at: daysAgo(4) }, { author: "b", at: daysAgo(10) }],
    lastConsolidateAt: daysAgo(1),
  });
  expect(r.ok).toBe(false);
  expect(r.flags.map((f) => f.code)).toEqual(["no_writes"]);
  expect(r.lastWriteAt).toEqual(daysAgo(4));
});

test("one write inside the cadence clears it", () => {
  const r = computeHealth({
    now, writeCadenceDays: 3, consolidateCadenceDays: 2,
    lastWriteByAuthor: [{ author: "a", at: daysAgo(4) }, { author: "b", at: daysAgo(2) }],
    lastConsolidateAt: daysAgo(1),
  });
  expect(r.ok).toBe(true);
  expect(r.flags).toEqual([]);
});

test("a consolidator older than its cadence raises", () => {
  const r = computeHealth({
    now, writeCadenceDays: 3, consolidateCadenceDays: 2,
    lastWriteByAuthor: [{ author: "a", at: daysAgo(1) }],
    lastConsolidateAt: daysAgo(3),
  });
  expect(r.flags.map((f) => f.code)).toEqual(["stale_consolidation"]);
});

test("an empty store says never, not stale", () => {
  const r = computeHealth({ now, writeCadenceDays: 3, consolidateCadenceDays: 2, lastWriteByAuthor: [], lastConsolidateAt: null });
  expect(r.flags.map((f) => f.code)).toEqual(["never_written", "never_consolidated"]);
});

test("the boundary is exclusive: exactly the cadence is still fine", () => {
  const r = computeHealth({ now, writeCadenceDays: 3, consolidateCadenceDays: 2, lastWriteByAuthor: [{ author: "a", at: daysAgo(3) }], lastConsolidateAt: daysAgo(2) });
  expect(r.ok).toBe(true);
});

test("an invalid date throws rather than reading healthy", () => {
  expect(() =>
    computeHealth({
      now, writeCadenceDays: 3, consolidateCadenceDays: 2,
      lastWriteByAuthor: [{ author: "a", at: daysAgo(1) }],
      lastConsolidateAt: new Date("nope"),
    }),
  ).toThrow(/invalid date/);
});
