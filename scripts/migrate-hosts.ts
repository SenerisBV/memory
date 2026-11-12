// Migrates every live store that runs this checkout, then runs each host's
// post-migrate step (typically: grants for the roles that read and write it).
//
// WHY THIS EXISTS. Hosts depend on this repo through `file:` links, so a
// commit on `main` is live in every consumer the moment it lands, with no
// release and no reinstall. A new migration is therefore a breaking change
// for every store that hasn't run it: the new code writes columns the old
// schema lacks. The window between "code is live" and "store is migrated"
// should be zero, so `.githooks/post-merge` and `.githooks/post-commit` call
// this whenever `drizzle/` changes on `main`. See docs/DESIGN.md §11.
//
// The store list is HOST DATA and is not in the repo (same reason as the name
// guard: a list of stores is a list of names). It lives in a gitignored JSON
// file, `.memory-hosts.local.json` at the repo root, or wherever
// MEMORY_HOSTS_FILE points:
//
//   [
//     { "name": "dev", "envFile": "~/somewhere/.env", "envVar": "DATABASE_URL" },
//     { "name": "fleet", "envFile": "~/other/.env", "envVar": "STORE_URL", "schema": "memory",
//       "after": { "cwd": "~/other", "command": ["bun", "scripts/grants.ts"] } }
//   ]
//
// The URL is read from `envVar` in `envFile` and never printed: these are
// owner credentials, because only the schema owner may migrate it. `after`
// runs with MEMORY_STORE_URL and MEMORY_SCHEMA in its environment.
//
// Same safety gate as the consolidate runner: a real store needs --live, and
// --live refuses a _test store. One host failing doesn't stop the others; the
// exit code is 1 if any failed.
//
//   bun scripts/migrate-hosts.ts --live
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "../src/migrate";

export interface HostEntry {
  name: string;
  envFile: string;
  envVar: string;
  schema?: string;
  after?: { cwd: string; command: string[] };
}

export interface HostResult {
  name: string;
  ok: boolean;
  applied: string[];
  error?: string;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_HOSTS_FILE = join(REPO_ROOT, ".memory-hosts.local.json");

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** A minimal .env reader: KEY=value, optional `export `, optional quotes,
 *  `#` comments on their own line. Values keep any `=` they contain. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

function databaseName(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || null;
  } catch {
    return null;
  }
}

/** Throws unless the URL is allowed for this mode. Messages name the
 *  database only, never the URL, which carries the owner's password. */
export function gateUrl(url: string, live: boolean): void {
  const name = databaseName(url);
  const isTest = name !== null && name.endsWith("_test");
  if (isTest && live) throw new Error(`--live was passed but "${name}" is a _test database`);
  if (!isTest && !live) throw new Error(`refusing "${name ?? "(unparseable)"}" without --live: it is not a _test database`);
}

export function loadHosts(path: string): HostEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array of hosts`);
  return parsed.map((h, i) => {
    const e = h as Partial<HostEntry>;
    for (const field of ["name", "envFile", "envVar"] as const) {
      if (typeof e[field] !== "string" || !e[field]) throw new Error(`${path}: host #${i} is missing "${field}"`);
    }
    if (e.after && (typeof e.after.cwd !== "string" || !Array.isArray(e.after.command) || e.after.command.length === 0)) {
      throw new Error(`${path}: host "${e.name}" has an "after" without cwd and a non-empty command`);
    }
    return e as HostEntry;
  });
}

/** Any URL a message might carry, reduced to its database name. pg errors
 *  don't normally include the URL, but this is cheap insurance. */
function scrub(message: string, url: string | undefined): string {
  return url ? message.split(url).join(`<${databaseName(url) ?? "url"}>`) : message;
}

export async function migrateHosts(
  hosts: HostEntry[],
  opts: { live: boolean; log?: (line: string) => void },
): Promise<HostResult[]> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const results: HostResult[] = [];
  for (const host of hosts) {
    let url: string | undefined;
    try {
      const envPath = expandHome(host.envFile);
      if (!existsSync(envPath)) throw new Error(`env file ${host.envFile} not found`);
      url = parseEnvFile(readFileSync(envPath, "utf8"))[host.envVar];
      if (!url) throw new Error(`${host.envVar} is not set in ${host.envFile}`);
      gateUrl(url, opts.live);
      const { applied } = await migrate({ url, schema: host.schema });
      if (host.after) {
        const [cmd, ...args] = host.after.command;
        const r = spawnSync(cmd!, args, {
          cwd: expandHome(host.after.cwd),
          env: { ...process.env, MEMORY_STORE_URL: url, MEMORY_SCHEMA: host.schema ?? "memory" },
          encoding: "utf8",
        });
        if (r.error) throw r.error;
        if (r.status !== 0) throw new Error(`after-command exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(-500)}`);
      }
      log(`${host.name} (${databaseName(url)}): ${applied.length ? `applied ${applied.join(", ")}` : "nothing to apply"}${host.after ? "; after-command ok" : ""}`);
      results.push({ name: host.name, ok: true, applied });
    } catch (err) {
      // drizzle wraps the driver's error as "Failed query: …"; the reason
      // (no such database, permission denied) is on `cause`.
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
      const error = scrub((err instanceof Error ? err.message.split("\nparams:")[0]!.trim() : String(err)) + cause, url);
      log(`${host.name}: FAILED — ${error}`);
      results.push({ name: host.name, ok: false, applied: [], error });
    }
  }
  return results;
}

if (import.meta.main) {
  const live = process.argv.includes("--live");
  const file = process.env.MEMORY_HOSTS_FILE ?? DEFAULT_HOSTS_FILE;
  if (!existsSync(file)) {
    console.error(`no hosts file at ${file}; nothing migrated. See the header of scripts/migrate-hosts.ts.`);
    process.exit(1);
  }
  const results = await migrateHosts(loadHosts(file), { live });
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
