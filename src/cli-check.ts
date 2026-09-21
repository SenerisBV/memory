import { openDb } from "./db";
import { assertSchemaObjects, declaredObjects } from "./schemaObjects";

const h = openDb(process.env.DATABASE_URL!, process.env.MEMORY_SCHEMA);
try {
  await assertSchemaObjects(h);
  console.log(`${h.schemaName}: all ${declaredObjects(h.schemaName).length} declared objects present`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  await h.close();
}
