//   bun --env-file=.env src/cli-migrate.ts            → schema "memory"
//   MEMORY_SCHEMA=other bun --env-file=.env src/cli-migrate.ts
import { migrate } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
const { applied } = await migrate({ url, schema: process.env.MEMORY_SCHEMA });
console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
