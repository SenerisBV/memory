import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { buildTables, memorySchemaName, type Tables } from "./schema";

export interface Handle {
  db: NodePgDatabase;
  tables: Tables;
  schemaName: string;
  close(): Promise<void>;
}

// One pool per handle, closed by the caller. Not a global singleton: a
// library must not decide how many connections a host wants, and a test
// suite opens and closes many. TimeZone=UTC in the startup packet, because
// timestamp(3) without time zone read through a local-time session shifts by
// the UTC offset (measured in the fleet, 2026-08-24).
/** The same identifier rule `migrate` enforces, and for the same reason: the
 *  schema name is interpolated into SQL textually. `migrate` is not the only
 *  door into this function — a host calls `openDb` directly — so the check
 *  belongs on the door every caller uses, not on one of them. */
const SCHEMA_NAME = /^[a-z][a-z0-9_]*$/;

export function openDb(url: string, schemaName: string = memorySchemaName): Handle {
  if (!SCHEMA_NAME.test(schemaName)) throw new Error(`schema name "${schemaName}" must match ^[a-z][a-z0-9_]*$`);
  const pool = new Pool({ connectionString: url, options: "-c TimeZone=UTC" });
  return { db: drizzle(pool), tables: buildTables(schemaName), schemaName, close: () => pool.end() };
}
