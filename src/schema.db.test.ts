import { beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { handle, resetDb } from "../tests/setup";

beforeEach(resetDb);

// drizzle-orm's node-postgres driver wraps the raw pg error: `error.message`
// is a generic "Failed query: ...", and the constraint name is in
// `error.cause.message`. bun:test's `.toThrow(regex)` only reads
// `error.message`, so rejections are asserted against the full chain here.
async function expectRejectsMatching(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  const err = thrown as Error & { cause?: unknown };
  const text = `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`;
  expect(text).toMatch(pattern);
}

test("the four tables exist in the memory schema with their columns", async () => {
  const r = await handle.db.execute(sql`
    SELECT table_name, string_agg(column_name, ',' ORDER BY column_name) AS cols
    FROM information_schema.columns WHERE table_schema = 'memory' GROUP BY table_name ORDER BY table_name`);
  const rows = r.rows as { table_name: string; cols: string }[];
  expect(rows.map((x) => x.table_name)).toEqual(["Alias", "Contribution", "Observation", "Subject"]);
  expect(rows.find((x) => x.table_name === "Observation")!.cols.split(",")).toContain("about");
  expect(rows.find((x) => x.table_name === "Observation")!.cols.split(",")).not.toContain("grain");
  expect(rows.find((x) => x.table_name === "Subject")!.cols.split(",")).toContain("members");
});

test("an untyped subject key is refused by the database, not only by the registry", async () => {
  const { db, tables } = handle;
  // bun:test's .rejects/.resolves require a native Promise; drizzle's query
  // builder is thenable but not `instanceof Promise`, so it is wrapped.
  await expectRejectsMatching(Promise.resolve(db.insert(tables.subject).values({ key: "alex", label: "x" })), /Subject_key_typed_check/);
  await expect(Promise.resolve(db.insert(tables.subject).values({ key: "person:alex", label: "x" }))).resolves.toBeDefined();
});

test("about[1] must equal subjectKey", async () => {
  const { db, tables } = handle;
  const base = { authorAgent: "t", predicate: "p", value: "v", source: "s" };
  await expectRejectsMatching(Promise.resolve(db.insert(tables.observation).values({ ...base, subjectKey: "person:a", about: ["person:b", "person:a"] })), /Observation_about_primary_check/);
  await expect(Promise.resolve(db.insert(tables.observation).values({ ...base, subjectKey: "person:a", about: ["person:a", "person:b"] }))).resolves.toBeDefined();
  // about[1] on an empty array is NULL, and a CHECK passes on NULL — the
  // expression must also require at least one element.
  await expectRejectsMatching(Promise.resolve(db.insert(tables.observation).values({ ...base, subjectKey: "person:a", about: [] })), /Observation_about_primary_check/);
});

test("expectRejectsMatching itself fails a rejection for the wrong reason", async () => {
  // Proves the helper's toMatch(pattern) branch can go red: a real rejection
  // (untyped key -> Subject_key_typed_check) checked against an unrelated
  // pattern must cause expectRejectsMatching to throw, not pass silently.
  const { db, tables } = handle;
  await expect(
    expectRejectsMatching(
      Promise.resolve(db.insert(tables.subject).values({ key: "alex", label: "x" })),
      /Observation_about_primary_check/,
    ),
  ).rejects.toThrow();
});
