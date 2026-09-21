// The KIND axis an observation is filed on. Topics moved to the registry
// (host data); kinds stay built in because modality() is mechanism the merge
// guard depends on. See
// the observation-taxonomy design note.
//
// Pure by design: no Prisma, no host, no I/O. Both the classifier and the
// verdict guard import their vocabulary from here so there is exactly one
// definition of what a topic or a kind is.

// `waiting-on` and `instructs` were added 2026-08-17, after the phase-1
// backfill's dry run tripped the general-KIND tripwire (50/852 = 5.87%,
// against a 5% threshold). Reading those 50 rows
// found four recurring shapes; two got new kinds, two deliberately did not
// (see below):
//
//   - waiting-on: a state gated on something external, not yet resolved.
//     e.g. `waiting-for: school response on a leave request`,
//     `gated-by: an outing requiring childcare pending payroll`,
//     `has-pending: a contract renewal`.
//   - instructs: meta and standing instructions for the agent itself — how
//     it should behave, prescribed rather than merely noted.
//     e.g. `has-standing-instruction: events check before each morning
//     briefing`, `practices: posts local events to a shared channel`.
//
// Deliberately NOT given a kind (left as `general`, on purpose):
//   - bare calendar/scheduling facts, e.g. `school-restart-date: a child's
//     school restarts on 24 August` — no verb-like relation to invent a
//     word for.
//   - corrections of a prior claim, e.g. `corrected: an appointment was
//     not health-related after all` — `general` is an honest label
//     for "nothing fits"; minting a kind for this residue is how the
//     322-predicate sprawl started.
export const KINDS = [
  "prefers", "wants", "needs", "decided", "committed-to", "considering",
  "concerned-about", "interested-in", "values", "plans", "has", "owns", "uses",
  "attends", "costs", "targets", "earns", "acquired", "completed", "general",
  "waiting-on", "instructs",
] as const;
export type Kind = (typeof KINDS)[number];

export const DEFAULT_KIND: Kind = "general";

/** Kinds that describe something INTENDED — an amount someone means to spend,
 *  save or do.
 *
 *  `waiting-on` and `instructs` were added after the phase-1 backfill's own
 *  tripwire caught a vocabulary gap: both are
 *  forward-looking, so both belong here rather than on the ACTUAL side or
 *  left unclassified, where `modality()` would return `"neither"` and block
 *  them from ever merging. */
const INTENDED = new Set<string>([
  "targets", "committed-to", "plans", "wants", "needs",
  "decided", "prefers", "considering", "values", "interested-in",
  "waiting-on", "instructs",
]);

/** Kinds that describe something ACTUAL — observed to be true. */
const ACTUAL = new Set<string>([
  "costs", "has", "owns", "earns", "acquired", "completed", "uses", "attends",
]);

/**
 * Which side of the intended/actual boundary a kind sits on.
 *
 * `concerned-about` is deliberately in NEITHER set: a worry that cites a figure
 * is a third fact, and must never merge with the target or the actual it cites.
 * That is what protects the €92.50 variance row.
 *
 * Anything unrecognised — a minted kind, `general` — is also `neither`, which
 * means the guard refuses to merge it. Failing toward a duplicate is correct;
 * failing toward a merge destroys a fact.
 */
export function modality(kind: string): "intended" | "actual" | "neither" {
  if (INTENDED.has(kind)) return "intended";
  if (ACTUAL.has(kind)) return "actual";
  return "neither";
}
