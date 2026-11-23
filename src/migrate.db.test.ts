import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { openDb } from "./db";
import { migrate } from "./migrate";
import { TEST_URL, handle, resetDb } from "../tests/setup";

test("migrate is idempotent", async () => {
  expect((await migrate({ url: TEST_URL })).applied).toEqual([]);
});

test("the schema name is a parameter: the same history lands in another schema", async () => {
  const h = openDb(TEST_URL, "memory_alt");
  try {
    await h.db.execute(sql.raw(`DROP SCHEMA IF EXISTS "memory_alt" CASCADE`));
    await h.db.execute(sql.raw(`DROP SCHEMA IF EXISTS "memory_alt_migrations" CASCADE`));
    const first = await migrate({ url: TEST_URL, schema: "memory_alt" });
    expect(first.applied.length).toBeGreaterThan(0);
    const r = await h.db.execute(sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'memory_alt'`);
    expect((r.rows[0] as { n: number }).n).toBe(4);
    await h.db.insert(h.tables.subject).values({ key: "person:x", label: "x" });
    expect((await h.db.select().from(h.tables.subject)).length).toBe(1);
  } finally {
    await h.db.execute(sql.raw(`DROP SCHEMA IF EXISTS "memory_alt" CASCADE`));
    await h.db.execute(sql.raw(`DROP SCHEMA IF EXISTS "memory_alt_migrations" CASCADE`));
    await h.close();
  }
});

test("a schema name that is not an identifier is refused", async () => {
  await expect(migrate({ url: TEST_URL, schema: 'x"; DROP SCHEMA public; --' })).rejects.toThrow(/must match/);
  // …and by openDb itself, which a host calls without going through migrate.
  expect(() => openDb(TEST_URL, 'x"; DROP SCHEMA public; --')).toThrow(/must match/);
});

test("the Contribution.about backfill sets about = [subjectKey] for rows that predate it", async () => {
  const dir = new URL("../drizzle/", import.meta.url).pathname;
  const file = (await import("node:fs")).readdirSync(dir).find((f) => f.startsWith("0003_"))!;
  const stmts = (await import("node:fs")).readFileSync(dir + file, "utf8").split("--> statement-breakpoint");
  const backfill = stmts.find((s) => /UPDATE\s+"memory"\."Contribution"|UPDATE\s+"Contribution"/.test(s))!;
  expect(backfill).toBeDefined();
  await resetDb();
  await handle.db.insert(handle.tables.subject).values({ key: "person:old", label: "Old" });
  // a pre-migration row: the new column's default leaves about empty. The 0005
  // trigger would fill it on insert, so it is off for this one row.
  await handle.db.execute(sql`ALTER TABLE "memory"."Contribution" DISABLE TRIGGER "Contribution_about_default"`);
  try {
    await handle.db.insert(handle.tables.contribution).values({ authorAgent: "a", subjectKey: "person:old", content: "c", why: "", about: [] });
  } finally {
    await handle.db.execute(sql`ALTER TABLE "memory"."Contribution" ENABLE TRIGGER "Contribution_about_default"`);
  }
  const before = await handle.db.execute(sql`SELECT "about" FROM "memory"."Contribution"`);
  expect((before.rows[0] as { about: string[] }).about).toEqual([]);
  await handle.db.execute(sql.raw(backfill));
  const r = await handle.db.execute(sql`SELECT "about" FROM "memory"."Contribution"`);
  expect((r.rows[0] as { about: string[] }).about).toEqual(["person:old"]);
  const empty = await handle.db.execute(sql`SELECT count(*)::int AS n FROM "memory"."Contribution" WHERE cardinality("about") = 0`);
  expect((empty.rows[0] as { n: number }).n).toBe(0);
});

test("a Contribution inserted with an empty about gets about = [subjectKey] (0005 trigger)", async () => {
  const { createStore } = await import("./store");
  const { fakeHost } = await import("../tests/fakes");
  await resetDb();
  await handle.db.insert(handle.tables.subject).values({ key: "person:raw", label: "Raw" });
  await handle.db.execute(sql`INSERT INTO "memory"."Contribution" ("id", "authorAgent", "subjectKey", "about", "content", "why")
    VALUES ('raw-1', 'a', 'person:raw', '{}', 'written by raw SQL', '')`);
  const r = await handle.db.execute(sql`SELECT "about" FROM "memory"."Contribution" WHERE "id" = 'raw-1'`);
  expect((r.rows[0] as { about: string[] }).about).toEqual(["person:raw"]);
  const rows = await createStore(handle, fakeHost()).contributions("person:raw", 10);
  expect(rows.map((c) => c.content)).toEqual(["written by raw SQL"]);
});
