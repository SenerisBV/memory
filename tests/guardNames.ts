// The names the source tree must never contain.
//
// A ban list is a name list. Writing the real one down here — the host's
// agents, the people it serves, the businesses it works for — would publish
// in a public repository exactly what the guard exists to keep out of it, and
// it would do so in the one file a reader is most likely to open to find out
// what the project is guarding against.
//
// So the real list is supplied at run time: MEMORY_GUARD_NAMES, comma
// separated, read from `.env.test` (gitignored) by `bun run test`. What ships
// is a generic default over this repository's own fixture names, so the guard
// still means something for anyone who clones it and runs the suite cold —
// a guard that falls back to nothing reads exactly like a guard finding
// nothing.
//
// `household`, `home` and `family` are deliberately absent from the default.
// They are generic English, and they are the gloss the default registry gives
// the `group` subject type ("a household, a team, a family") — banning them
// would force that gloss to be worse to satisfy a test.
export const DEFAULT_GUARD_NAMES = [
  "alex", "robin", "noor", "scribe", "ledger",
  "seneris", "business", "portfolio", "founder",
];

export function guardNames(): string[] {
  const fromEnv = (process.env.MEMORY_GUARD_NAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_GUARD_NAMES;
}
