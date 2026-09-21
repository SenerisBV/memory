import { defineConfig } from "drizzle-kit";

// Does NOT load .env: every script supplies its own env, so nothing here can
// win over an already-set var. schemaFilter scopes the diff to "memory";
// without it a shared database's other tables read as unmodelled and get
// named DROPs. `push` is forbidden (see CLAUDE.md).
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  schemaFilter: ["memory"],
  migrations: { schema: "memory_migrations", table: "__drizzle_migrations" },
  verbose: true,
  strict: true,
});
