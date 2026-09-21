// Two invariants of the spec, enforced on the source tree: nothing in src/
// imports the fleet, and nothing in src/ names it. tests/, scripts/ and
// examples/ are about the fleet by nature and are exempt, and so is
// adoptLegacy.ts — its whole subject is the legacy store it copies from.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { guardNames } from "../tests/guardNames";

const SRC = join(import.meta.dir);

/** Every source file under src/, at ANY depth. Recursive on purpose: a
 *  top-level-only scan goes silently blind the day someone adds src/adapters/,
 *  and a guard that has stopped looking reads exactly like a guard finding
 *  nothing. Paths come back relative to src/, so a failure names the file
 *  usefully once there are subdirectories to disambiguate. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // node_modules by name; dotdirs because a build cache is not source.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    if (entry.name === "adoptLegacy.ts") continue;
    out.push(relative(SRC, full));
  }
  return out;
}

const files = sourceFiles(SRC);

test("the guard reads a non-empty set of source files", () => {
  // Without this, both tests below pass vacuously if the walk ever stops
  // matching (a rename, a move, a skip rule that eats too much): a loop over
  // nothing reports no violations exactly the way a clean tree does.
  expect(files.length).toBeGreaterThan(20);
});

test("src/ imports nothing from agent-shared or agent-runtime", () => {
  for (const f of files) {
    const text = readFileSync(join(SRC, f), "utf8");
    expect(text, f).not.toMatch(/from ["']agent-(shared|runtime)/);
    expect(text, f).not.toMatch(/from ["']\.\.\/\.\.\/agent-/);
  }
});

// The list is names: agents, people, businesses. It is NOT written down here
// — see tests/guardNames.ts for why, and for how to supply the real one.
const BANNED = guardNames();

test("src/ names no fleet agent, person or business", () => {
  for (const f of files) {
    const text = readFileSync(join(SRC, f), "utf8").toLowerCase();
    for (const word of BANNED) expect(text, `${f} mentions "${word}"`).not.toMatch(new RegExp(`\\b${word}\\b`));
  }
});
