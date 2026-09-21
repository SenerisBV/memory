// Migrates memory_test once per run and exposes a handle + resetDb. The guard
// (tests/db-guard.ts) has already exited the process if this is not a _test
// database, so deleting whole tables here is safe by construction.
import { openDb, type Handle } from "../src/db";
import { migrate } from "../src/migrate";

export const TEST_URL = process.env.DATABASE_URL!;
await migrate({ url: TEST_URL });
export const handle: Handle = openDb(TEST_URL);

export async function resetDb(): Promise<void> {
  const { db, tables } = handle;
  await db.delete(tables.observation);
  await db.delete(tables.contribution);
  await db.delete(tables.alias);
  await db.delete(tables.subject);
}
