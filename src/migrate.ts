// Applies drizzle/'s generated SQL, in journal order, into the schema the
// host named. drizzle-kit writes "memory"."Table" literally, so the schema
// name is substituted textually; that is safe because every generated
// statement qualifies the schema (Task 4 Step 3 checks) and no table or
// column is called "memory". History lives in <schema>_migrations, the same
// per-owner shape the fleet uses.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";

import { openDb } from "./db";
import { memorySchemaName } from "./schema";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

interface Journal { entries: { idx: number; tag: string }[] }

export async function migrate(opts: { url: string; schema?: string }): Promise<{ applied: string[] }> {
  const schemaName = opts.schema ?? memorySchemaName;
  if (!/^[a-z][a-z0-9_]*$/.test(schemaName)) throw new Error(`schema name "${schemaName}" must match ^[a-z][a-z0-9_]*$`);
  const historySchema = `${schemaName}_migrations`;
  const handle = openDb(opts.url, schemaName);
  const { db } = handle;
  const applied: string[] = [];
  try {
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${historySchema}"`));
    await db.execute(sql.raw(
      `CREATE TABLE IF NOT EXISTS "${historySchema}"."__drizzle_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    ));
    const done = new Set(
      ((await db.execute(sql.raw(`SELECT hash FROM "${historySchema}"."__drizzle_migrations"`))).rows as { hash: string }[]).map((r) => r.hash),
    );
    const journal = JSON.parse(await readFile(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as Journal;
    for (const entry of journal.entries.sort((a, b) => a.idx - b.idx)) {
      if (done.has(entry.tag)) continue;
      const raw = await readFile(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      const text = raw.replaceAll(`"${memorySchemaName}".`, `"${schemaName}".`).replaceAll(`CREATE SCHEMA "${memorySchemaName}"`, `CREATE SCHEMA "${schemaName}"`);
      await db.transaction(async (tx) => {
        for (const statement of text.split("--> statement-breakpoint")) {
          const s = statement.trim();
          if (s) await tx.execute(sql.raw(s));
        }
        await tx.execute(sql.raw(
          `INSERT INTO "${historySchema}"."__drizzle_migrations" (hash, created_at) VALUES ('${entry.tag}', ${Date.now()})`,
        ));
      });
      applied.push(entry.tag);
    }
  } finally {
    await handle.close();
  }
  return { applied };
}
