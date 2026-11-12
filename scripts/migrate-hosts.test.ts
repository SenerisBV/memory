import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { handle, TEST_URL } from "../tests/setup";
import { gateUrl, loadHosts, migrateHosts, parseEnvFile, type HostEntry } from "./migrate-hosts";

const dir = mkdtempSync(join(tmpdir(), "migrate-hosts-"));
const PROBE_SCHEMA = "hosts_probe";
afterAll(async () => {
  await handle.db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${PROBE_SCHEMA}" CASCADE`));
  await handle.db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${PROBE_SCHEMA}_migrations" CASCADE`));
  rmSync(dir, { recursive: true, force: true });
});

function envFile(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

const quiet = () => {};

test("parseEnvFile reads quoted, exported and commented lines, and keeps '=' inside values", () => {
  expect(parseEnvFile([
    "# a comment",
    "",
    "PLAIN=one",
    'DOUBLE="two words"',
    "SINGLE='three'",
    "export EXPORTED=four",
    "WITH_EQ=postgresql://u:p@h:5432/db?sslmode=require&x=y",
    "  SPACED = five  ",
  ].join("\n"))).toEqual({
    PLAIN: "one", DOUBLE: "two words", SINGLE: "three", EXPORTED: "four",
    WITH_EQ: "postgresql://u:p@h:5432/db?sslmode=require&x=y", SPACED: "five",
  });
});

test("gateUrl: a real store needs --live, and --live refuses a _test store", () => {
  expect(() => gateUrl("postgresql://localhost/real_store", false)).toThrow(/--live/);
  expect(() => gateUrl("postgresql://localhost/real_store", true)).not.toThrow();
  expect(() => gateUrl("postgresql://localhost/some_test", true)).toThrow(/_test/);
  expect(() => gateUrl("postgresql://localhost/some_test", false)).not.toThrow();
});

test("gateUrl never echoes a password in its error", () => {
  let msg = "";
  try { gateUrl("postgresql://owner:s3cret@localhost/real_store", false); } catch (e) { msg = String(e); }
  expect(msg).toContain("real_store");
  expect(msg).not.toContain("s3cret");
});

test("loadHosts rejects an entry without the fields it needs", () => {
  const bad = envFile("bad.json", JSON.stringify([{ name: "x", envFile: "/nowhere" }]));
  expect(() => loadHosts(bad)).toThrow(/envVar/);
  const good = envFile("good.json", JSON.stringify([{ name: "x", envFile: "/e", envVar: "U", after: { cwd: "/", command: ["true"] } }]));
  expect(loadHosts(good)).toHaveLength(1);
});

test("a fresh store gets every migration, then the after-command runs with the URL and schema; a rerun applies nothing", async () => {
  const out = join(dir, "after.out");
  const host: HostEntry = {
    name: "probe",
    envFile: envFile("probe.env", `STORE_URL="${TEST_URL}"\n`),
    envVar: "STORE_URL",
    schema: PROBE_SCHEMA,
    after: { cwd: dir, command: ["sh", "-c", 'printf "%s|%s" "$MEMORY_STORE_URL" "$MEMORY_SCHEMA" > "$0"', out] },
  };
  const [first] = await migrateHosts([host], { live: false, log: quiet });
  expect(first!.ok).toBe(true);
  expect(first!.applied).toContain("0001_subject_dirty_gen");
  expect(readFileSync(out, "utf8")).toBe(`${TEST_URL}|${PROBE_SCHEMA}`);

  const cols = await handle.db.execute(sql.raw(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = '${PROBE_SCHEMA}' AND table_name = 'Subject' AND column_name = 'dirtyGen'`,
  ));
  expect(cols.rows).toHaveLength(1);

  const [second] = await migrateHosts([host], { live: false, log: quiet });
  expect(second).toMatchObject({ ok: true, applied: [] });
});

test("one failing host doesn't stop the next, and no error carries a password", async () => {
  const results = await migrateHosts([
    { name: "missing-var", envFile: envFile("empty.env", "OTHER=x\n"), envVar: "STORE_URL" },
    { name: "bad-db", envFile: envFile("bad.env", "STORE_URL=postgresql://nobody:s3cret@localhost:5432/no_such_db_test\n"), envVar: "STORE_URL" },
    { name: "after-fails", envFile: envFile("ok.env", `STORE_URL=${TEST_URL}\n`), envVar: "STORE_URL", after: { cwd: dir, command: ["sh", "-c", "exit 3"] } },
    { name: "fine", envFile: envFile("ok2.env", `STORE_URL=${TEST_URL}\n`), envVar: "STORE_URL" },
  ], { live: false, log: quiet });
  expect(results.map((r) => [r.name, r.ok])).toEqual([["missing-var", false], ["bad-db", false], ["after-fails", false], ["fine", true]]);
  expect(results[0]!.error).toMatch(/STORE_URL/);
  expect(results[1]!.error).toMatch(/\(.*does not exist\)$/); // the driver's reason, not just drizzle's "Failed query"
  expect(results[2]!.error).toMatch(/exited 3/);
  for (const r of results) expect(r.error ?? "").not.toContain("s3cret");
});
