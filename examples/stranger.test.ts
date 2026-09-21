// The exit, run as a test: the stranger script, spawned as its own process
// against the TEST database, importing "@seneris/memory" by its package
// name rather than any relative path into src/ or into the fleet.
import { expect, test } from "bun:test";
import { resetDb } from "../tests/setup";

test("the stranger script exits 0 against the test database, importing nothing from the fleet", async () => {
  await resetDb();
  const r = Bun.spawnSync(["bun", "examples/stranger.ts"], { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL! }, cwd: `${import.meta.dir}/..` });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const src = await Bun.file(`${import.meta.dir}/stranger.ts`).text();
  expect(src).not.toMatch(/agent-(shared|runtime)|\.\.\/\.\.\//);
});
