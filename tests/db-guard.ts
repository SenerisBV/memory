// The one thing between a test run and a real database. Listed FIRST in
// bunfig.toml's preload and importing nothing from src/, so no later import
// can run ahead of it. A throw is not enough: bun attributes a preload throw
// to one file and moves on to the next, unguarded. Only process.exit stops
// the run. (agent-shared/src/testDatabase.ts learned this on 2026-08-24.)

export function databaseNameOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

export function isTestDatabaseUrl(url: string): boolean {
  const name = databaseNameOf(url);
  return name !== null && /_test$/.test(name);
}

const url = process.env.DATABASE_URL ?? "";
if (!isTestDatabaseUrl(url)) {
  const name = url ? JSON.stringify(databaseNameOf(url) ?? "(unparseable)") : "(unset)";
  console.error(
    `\nREFUSING TO RUN THE TEST SUITE.\nDATABASE_URL names database ${name}, which does not end in "_test".\n` +
      `Run \`bun run test\` (loads .env.test), never bare \`bun test\`.\n`,
  );
  process.exit(1);
}
