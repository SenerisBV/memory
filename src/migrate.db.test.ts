import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { openDb } from "./db";
import { migrate } from "./migrate";
import { TEST_URL } from "../tests/setup";

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
