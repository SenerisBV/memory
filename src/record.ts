// The write pipeline: judge a batch of candidate observations against what is
// already live, then write. Ported from the fleet runtime's
// src/memory/observations.ts (`recordObservations` / `recordContribution`),
// whose comments this file keeps — every branch below was argued into
// existence by a defect, and the reasoning, with its dates and fix rounds, is
// the point. Nothing about WHAT gets written changed in the port.
//
// What did change: a batch is no longer about ONE subject. Each candidate
// carries its own `about` list, resolved to subject keys before anything is
// judged; the row is filed under the first key and carries the rest, and
// retrieval spans all of them. And every database statement now goes through
// the store (./store.ts) — including the agent-visibility scoping this file
// used to build inline, which exists because of the 2026-08-15 fleet-wide
// private-health-data leak and is now impossible to forget here, there being
// no query here to forget it in. The store also stamps `authorAgent`, so this
// file no longer does.
import { createClassify } from "./classify";
import { decide, type DecideInput, type DecideLiveRow, type FetchLiveRowsArgs } from "./decide";
import type { ObservationInput } from "./extract";
import { clampGrade, gradeForSource } from "./grade";
import type { MemoryHost } from "./host";
import { buildNaturalKey, slugifyEntity } from "./keys";
import { createReconcile, type ReconcileResult } from "./reconcile";
import { RegistryError } from "./registry";
import { createResolveAbout, type ResolvedAbout } from "./resolveAbout";
import type { Store } from "./store";

// ───────────────────────────────────────────────────────────────────────────
// Fix round 4: natural-key tokens.
//
// Round 3 normalized these slots and, in doing so, destroyed the identity the
// key exists to carry. `slugifyEntity` keeps only [a-z0-9-], so EVERY
// symbol-only unit slugged to "" and then fell through to the SAME "-"
// placeholder an ABSENT unit used: `unit "€"` then `unit "$"` (same
// predicate/value/valueNum) upserted onto one row keyed "spends:monthly:1540:-"
// and the euro fact was simply gone — no supersession, no `collapsed` note
// (separate batches never share the per-batch map), no audit trail. Same
// failure class as fix round 2's Critical A: a numeric series collapsing
// silently, in a different slot. The value slot had the same defect
// pre-existing rather than as a regression — every unsluggable value (a bare
// symbol, Cyrillic, Chinese) shared one "-" token, so unrelated observations
// at a shared predicate folded into a single row.
//
// So: normalize WITHOUT destroying identity, and keep "absent" distinguishable
// from "present but unsluggable".

/** Absent-slot markers, one per slot, so an absent value can never be read as
 *  an absent unit. `slugifyEntity` strips leading dashes, so no slug can ever
 *  start with "-" — nothing a model writes can forge one of these. */
const ABSENT_PREDICATE = "-p";
const ABSENT_VALUE = "-v";
const ABSENT_NUM = "-n";
const ABSENT_UNIT = "-u";

/** Prefix for the codepoint encoding of a present-but-unsluggable token.
 *
 *  DELIBERATE DEVIATION from the round-4 brief's literal `u${hex}`: that form
 *  IS forgeable — `slugifyEntity("u20ac")` is exactly "u20ac", so a
 *  legitimately-sluggable value would collide with the encoding of "€". The
 *  "--" makes it unforgeable, because `slugifyEntity` collapses every run of
 *  non-[a-z0-9] to a SINGLE "-": no slug ever contains "--". That is the same
 *  argument keys.ts:56-61 makes for ":" itself, applied one level down. */
const UNSLUGGABLE_PREFIX = "u--";

/** A key token that never loses identity.
 *
 *  Absent (null/undefined/blank) → the caller's reserved marker. Present but
 *  unsluggable (symbols, non-Latin scripts) → a deterministic codepoint
 *  encoding rather than a shared placeholder, because "€" and "$" are
 *  different facts and collapsing them silently overwrites one with the other.
 *
 *  Never emits ":" — every branch is a marker, a slug (which `slugifyEntity`
 *  restricts to [a-z0-9-]), or lowercase hex joined by "-". `buildNaturalKey`
 *  joins on ":" and keys.ts:56-61 documents that ":" is unforgeable precisely
 *  because the parts cannot contain it; that premise has to keep holding.
 *
 *  Deliberately NOT put in keys.ts: `buildNaturalKey`/`slugifyEntity` are
 *  shared with extract.ts:69, and changing them would silently alter dedup
 *  identity for every other caller. */
function keyToken(raw: string | null | undefined, absent: string): string {
  if (raw == null) return absent;
  const trimmed = raw.trim();
  if (!trimmed) return absent;
  const slug = slugifyEntity(trimmed);
  if (slug) return slug;
  return encodeCodePoints(trimmed);
}

/** Lossless, deterministic encoding of text that cannot survive slugging.
 *  Spread iterates by CODE POINT, not UTF-16 unit, so astral characters
 *  (emoji, rarer CJK) encode as one token each rather than as a surrogate
 *  pair — two different astral characters cannot alias each other. */
function encodeCodePoints(text: string): string {
  return `${UNSLUGGABLE_PREFIX}${[...text].map((ch) => ch.codePointAt(0)!.toString(16)).join("-")}`;
}

/** The UNIT slot's token. Fix round 5, controller ruling — this slot leaves
 *  the slug path that every other slot still uses.
 *
 *  Round 4 closed the case where a unit slugs to NOTHING ("€", "$", "%" all
 *  became one row). It left open the case where a unit slugs to something
 *  SHORTER: `slugifyEntity("µs")` is "s", because NFKD maps U+00B5 MICRO
 *  SIGN to a Greek mu which is then dropped as non-[a-z0-9]. Microseconds
 *  and seconds collapsed onto one row — the same silent destruction of a
 *  numeric series, one notch narrower. `slugifyEntity("m²")` is "m2", which
 *  collides with a literal "m2", for the same reason.
 *
 *  So: case-fold FIRST, then either take the folded string whole (when it is
 *  purely [a-z0-9] — lossless, and what keeps "EUR"/"eur"/"kg"/"ms" reading
 *  as themselves in the key) or encode it by codepoint. Nothing is ever
 *  dropped, and because the fold happens before the branch, case-folding
 *  survives BOTH branches: "m/s" and "M/S" still land on one row.
 *
 *  This splits "m²" from "m2", deliberately. A duplicate row is visible and
 *  recoverable; a merged one has silently destroyed a fact.
 *
 *  The three outputs cannot collide: the lossless branch emits [a-z0-9]+
 *  with no dashes at all, the encoded branch always contains "--", and
 *  ABSENT_UNIT starts with "-". None can contain ":". */
function unitKeyToken(raw: string | null | undefined): string {
  if (raw == null) return ABSENT_UNIT;
  const trimmed = raw.trim();
  if (!trimmed) return ABSENT_UNIT;
  const norm = trimmed.toLowerCase();
  if (/^[a-z0-9]+$/.test(norm)) return norm;
  return encodeCodePoints(norm);
}

export interface RecordObservationsInput {
  source: string;
  observations: ObservationInput[];
  provenancePath?: string | null;
  ts?: Date;
  /** Test seam only. Production passes nothing and gets the real reconciler. */
  reconcile?: DecideInput["reconcile"];
  /** Test seam only. Production passes nothing and gets the real classifier. */
  classify?: DecideInput["classify"];
}

export interface RecordContributionInput {
  /** One subject: an existing key, a host-registered alias, or a proposal. */
  about: string;
  content: string;
  why: string;
  source?: string;
  principalId?: string | null;
  ts?: Date;
}

export function createRecord(host: MemoryHost, store: Store) {
  const resolveAbout = createResolveAbout(host, store);

  async function recordObservations(input: RecordObservationsInput): Promise<{ recorded: number; upserted: number; restated: number; superseded: number; minted: number }> {
    const ts = input.ts ?? new Date();
    const ceiling = gradeForSource(input.source);

    // Read-before-write, per candidate. `about` may name a known key, an
    // agent-local alias, or PROPOSE a subject that gets minted here
    // (resolveAbout.ts). A candidate whose subjects were all dropped has
    // nothing to be filed under and is skipped rather than filed under a
    // guess — the same asymmetry the rest of this file keeps, since a
    // duplicate row is visible and recoverable and a row on the wrong subject
    // is neither.
    let minted = 0;
    const candidatesRaw: (ObservationInput & { keys: string[] })[] = [];
    for (const o of input.observations) {
      if (!(o.predicate ?? "").trim() || !(o.value ?? "").trim()) continue;
      let r: ResolvedAbout;
      try {
        r = await resolveAbout(o.about);
      } catch (err) {
        // Controller ruling, 2026-09-04: a string key the extractor invented —
        // an undeclared type, or a well-formed key naming no subject — is model
        // error of exactly the kind a bad {type,label} proposal is, and
        // resolveAbout already DROPS those with a log rather than throwing.
        // Letting this throw out would cost every OTHER candidate in the batch,
        // which is a hole; this module's rule is duplicates, not holes, and
        // every other failure path in it degrades one candidate. Only the write
        // pipeline's per-candidate resolution is lenient: host-supplied keys
        // through the store (getOrCreateSubject, putAlias, setMembers) still
        // throw, because there the caller is a program that can be fixed.
        //
        // NARROW, deliberately (fix round 1): only MODEL error is lenient.
        // `RegistryError` (an undeclared type or key) and "not a known
        // subject" are things the extractor invented. Everything else is
        // rethrown — above all a store outage, since every `resolveAbout`
        // call reaches the database: an unconditional catch would turn a
        // total failure into a handful of INFO lines and a cheerful
        // `recorded: 0`, which is the shape of failure this project has been
        // burned by most often.
        const reason = err instanceof Error ? err.message : String(err);
        if (!(err instanceof RegistryError) && !/not a known subject/.test(reason)) throw err;
        try {
          await host.log({ kind: "INFO", source: "memory-reconcile", message: `candidate dropped: ${o.predicate} — ${reason}` });
        } catch {
          // Swallowed like every other log in this function: a flaky logger
          // must not kill the batch this catch exists to save.
        }
        continue;
      }
      if (r.keys.length === 0) continue; // every subject dropped → nothing to file under
      minted += r.minted.length;
      candidatesRaw.push({ ...o, keys: r.keys });
    }
    const candidates = candidatesRaw;
    if (candidates.length === 0) return { recorded: 0, upserted: 0, restated: 0, superseded: 0, minted };

    // Every subject this batch touches, deduped. It is what retrieval spans,
    // what the reconciler is told it is judging, and what gets dirtied.
    const batchKeys = [...new Set(candidates.flatMap((c) => c.keys))];
    const subjectLabel = (await Promise.all(batchKeys.map((k) => store.getSubject(k)))).map((s) => s?.label ?? "?").join(", ");

    const runClassify: DecideInput["classify"] = input.classify ?? ((items) =>
      createClassify(host).classifyBatch({ items }));

    const runReconcile: DecideInput["reconcile"] = input.reconcile ?? ((args) =>
      createReconcile(host).reconcileBatch({
        subjectLabel: args.subjectLabel,
        candidates: args.candidates as never,
        liveRows: args.liveRows as never,
      }));

    // Topic-scoped retrieval, across every subject in `about`. `topic` is the
    // candidate group's PRIMARY topic, matched against each row's FULL topics
    // array. Matching the union of all the candidate's topics instead blows
    // the set out (a gear+work+money candidate reaches 214 rows) and the cap
    // then discards precisely the tight comparison set this exists for.
    //
    // `topic: null` is the `general` group's unscoped window.
    //
    // The visibility scoping is the store's (`liveRowsAbout`), applied for the
    // same reason it guards every other read: without it this hands the
    // reconciler's prompt another agent's `visibility: "author"` rows for the
    // same subject, which is exactly the 2026-08-15 fleet-wide
    // private-health-data leak.
    //
    // The `matched` count is a second query per group, and it is worth it: it
    // is what reports how many rows the cap discarded, which is the
    // measurement that settles 80 vs 100.
    const fetchLiveRows = ({ topic, limit, about }: FetchLiveRowsArgs): Promise<{ rows: DecideLiveRow[]; matched: number }> =>
      store.liveRowsAbout(about, { topic, limit });

    const decided = await decide({
      subjectLabel,
      about: batchKeys,
      candidates,
      classify: runClassify,
      reconcile: runReconcile,
      fetchLiveRows,
    });
    const classified = decided.classified;
    const verdicts = decided.verdicts;
    // The union of rows shown across every group. This is what the two maps
    // below must be built from — NOT the table — so that a target may only be
    // superseded, or have its visibility inherited, if the model was actually
    // shown it.
    const liveRows = [...decided.shown.values()];

    // Preserved verbatim from the pre-topic-scoping code (Fix round 1, C1(a)
    // + I6, and I7). Only their INPUT changes: `liveRows` is now the shown
    // subset rather than every live row for the subject. A `corrects` target
    // must be both live right now and authored by the acting agent; visibility
    // inheritance keys off the union of rows shown across this batch's groups
    // (`decided.shown`, built above as `liveRows`) — not every target the
    // agent could in principle see — since a target's visibility describes
    // whether its wording is safe to make fleet-readable independent of
    // whether the supersede itself is permitted.
    const ownLiveIds = new Set(liveRows.filter((r) => r.authorAgent === host.agentId).map((r) => r.id));
    const liveById = new Map(liveRows.map((r) => [r.id, r]));

    // FINAL FIX WAVE, CRITICAL (taxonomy phase 1 — loss THROUGH the guard):
    // `classified[i]` is computed once per candidate, on the UNSPLIT value,
    // before reconciliation even runs. But `RECONCILE_SYSTEM` instructs the
    // model to fan a single compound candidate out into several verdicts
    // sharing one `index` — "transport budget €400, actual €1,120.40"
    // becomes a `[targets]` verdict and a `[costs]` verdict, both at index 0.
    // Stamping every fanned-out row with the PARENT's one classified `kind`
    // (below, at the `data` object) therefore mis-stamps at least one
    // sibling — e.g. the actual gets stored as `targets`. A later GENUINE
    // `[targets]` candidate about the same subject then shares both modality
    // and topic with that mis-stamped row, so `guardVerdict` ALLOWS the
    // merge and the real target is silently discarded. The guard exists to
    // BLOCK loss; this let loss pass straight through it.
    //
    // Counted here, once, over the finalized `verdicts` array — `v.index`
    // never changes after this point (only `v.verdict` does, further below),
    // so one pass suffices rather than re-filtering per iteration.
    const verdictCountByIndex = new Map<number, number>();
    for (const v of verdicts) {
      verdictCountByIndex.set(v.index, (verdictCountByIndex.get(v.index) ?? 0) + 1);
    }

    // Fix round 1, I3: two `corrects` naming the same target both succeed as
    // UPDATEs (no DB error — the update itself is a plain by-id write, and
    // nothing stops it running twice with two different values). Fix round
    // 2, Minor F: the reason isn't that `supersededById` is "unique per old
    // row" — a scalar column is trivially unique-per-row regardless of any
    // constraint. The schema's `supersededById String? @unique` constrains
    // the VALUE (a new row's id may be the supersession target of at most
    // one old row) — so the real hazard this guards against is a DIFFERENT
    // failure mode: two DIFFERENT old rows both ending up with the SAME
    // `supersededById` value (see the `collapsed` handling below, where two
    // candidates upserting onto the same physical row can produce exactly
    // that). Repeat-target tracking here still matters on its own terms:
    // without it, the second update overwrites the first's supersession,
    // orphaning the first new row live-but-unlinked and making `superseded`
    // overcount. Track what THIS batch has already retired and skip repeats.
    const alreadySuperseded = new Set<string>();
    // Fix round 1, M1/audit: per-verdict override text, keyed by object
    // identity (each verdict is a distinct object, including the fail-open
    // ones synthesized above) — lets later code annotate WHY a write
    // collapsed, or a supersede was skipped or failed, without mutating the
    // verdict itself. `appendNote` CHAINS onto any note already recorded for
    // `v` (fix round 2: the round-1 version overwrote via `v.why` directly,
    // which meant a verdict that was both a batch-collision AND a skipped
    // supersede would lose the first note to the second `.set(v, ...)` call).
    const auditNotes = new Map<ReconcileResult, string>();
    function appendNote(v: ReconcileResult, note: string): void {
      auditNotes.set(v, `${auditNotes.get(v) ?? v.why} (${note})`);
    }

    // `appendNote`, not a bare `.set`: it chains onto `v.why`, so a guard
    // downgrade keeps the reconciler's OWN stated reasoning alongside the
    // guard's — the model's `why` is the more interesting half when auditing
    // a destructive verdict that was blocked. A bare `.set` here would also
    // reintroduce the overwrite bug that `appendNote` exists to prevent.
    for (const [v, note] of decided.notes) appendNote(v, note);

    // Fix round 2, Important D: the derived key each `naturalKey`-bearing
    // write in THIS BATCH resolved to. Two different candidates rewritten to
    // the same predicate/value/valueNum/unit upsert onto the SAME physical
    // row — `recorded` still counts both write attempts (that's the existing
    // meaning of the number: attempts, not distinct rows), but a caller
    // reading `recorded: 2` without this would reasonably assume two rows
    // exist. `collapsed` and the audit note make that visible instead of
    // silently lying by omission. Scoped to this batch only — an ordinary
    // upsert onto a row from an EARLIER batch/day is a normal re-observation,
    // not a collapse.
    const derivedKeysThisBatch = new Map<string, number>();

    // FINAL REVIEW: every subject on a row this batch actually WROTE, read
    // back off the write. `batchKeys` is what the batch is about; this is what
    // the store now holds. The two differ whenever the upsert lands on an
    // existing row, because the conflict clause UNIONS `about` and rewrites
    // value/topics/kind/ts — so a batch about `person:ann` alone can rewrite a
    // row that is also evidence for `group:home`, leaving home's dossier
    // describing a fact the store no longer contains, and clean.
    const rewrittenAbout = new Set<string>();

    let recorded = 0, upserted = 0, restated = 0, superseded = 0, supersedeSkipped = 0, supersedeFailed = 0, collapsed = 0, writeFailed = 0;
    for (const v of verdicts) {
      // Hoisted and guarded rather than `candidates[v.index].grade` inline:
      // this repo runs `noUncheckedIndexedAccess`, so an indexed read is
      // `T | undefined` regardless of any bounds check the compiler cannot
      // follow. Same guard the compiler is asking for, made explicit. Hoisted
      // ABOVE the restates block by fix round 1, because the cross-subject
      // test below needs this candidate's own subjects.
      const c = candidates[v.index];
      if (!c) continue;

      // Fix round 1, plan-mandated: `batchKeys` is a per-BATCH union, so
      // retrieval shows the reconciler rows about ANY subject in the batch —
      // including rows THIS candidate is not about at all. Both destructive
      // verdicts act on a named row: `restates` discards the candidate in
      // favour of it, `corrects` retires it. Neither may act across that gap,
      // because the row it names can belong to an entirely different subject
      // that merely rode along in the same batch. Overlap with this
      // candidate's own subjects is the local test, and failing it fails the
      // way everything else here fails — downgrade to `record` and write,
      // since a duplicate is recoverable and a hole is not.
      //
      // Only a target actually SHOWN (`liveById`) can be tested; a target
      // that is not there at all is left to the checks that already handle
      // it (the restates downgrade below, `ownLiveIds` for corrects).
      const crossSubject = (targetId: string): boolean => {
        const target = liveById.get(targetId);
        return !!target && !target.about.some((k) => c.keys.includes(k));
      };

      // FINAL FIX WAVE, CRITICAL 2: `restates` is the ONLY verdict that loses
      // data by construction, and it was the one path with no validation at
      // all — not against `liveById`, not against `ownLiveIds`. `corrects` was
      // hardened twice so an invalid `targetId` costs only the supersede and
      // the row is still written; `restates` discarded the candidate outright
      // for any string that merely survived `parseVerdicts`. The likely
      // trigger is mundane: the model is shown up to 389 cuids and must echo
      // one back exactly — one mistranscribed character deleted a fact.
      //
      // That violates the spec directly: "on any uncertainty → record", and
      // "an unsure reconciler produces a duplicate, not a hole." So a
      // `restates` whose target cannot be verified is DOWNGRADED to `record`:
      // it falls through to the write path below and the observation stands.
      //
      // A target is verifiable two ways, matching what `parseVerdicts`
      // already permits for this verdict: a stored row the agent can see
      // (`liveById` — not `ownLiveIds`, because discarding a duplicate of a
      // row this agent can READ is correct regardless of who authored it),
      // or an EARLIER candidate label in this same batch ("c0", "c1", …).
      // Re-checked here rather than trusted from `parseVerdicts` because this
      // loop also runs over fail-open verdicts and over anything the
      // `reconcile` seam supplies.
      //
      // FINAL REVIEW, two coupled corrections to what this used to say.
      //
      // (a) The `c<N>` labels ARE in batch coordinates — but only since
      // decide.ts started rewriting them. They are group-LOCAL positions in
      // the reconciler's reply, and decide.ts remapped `index` to the batch
      // while leaving `targetId` local, so `label < v.index` compared a
      // position in one topic group against a position in the batch. Both
      // sides are batch coordinates now, and this comparison means what it
      // reads as. Nothing here may assume otherwise.
      //
      // (b) The cross-subject test below was applied to the stored-row arm
      // only. It belongs on BOTH: retrieval spans the batch's whole subject
      // union, and so does a batch — two candidates about entirely different
      // subjects sit side by side in one reconcile call whenever they share a
      // primary topic. A `restates c0` across that gap discards a fact about
      // one subject because a different subject already had a similar one,
      // which is the same loss the stored-row arm was hardened against.
      if (v.verdict === "restates") {
        const t = v.targetId;
        const label = t !== null && /^c\d+$/.test(t) ? Number(t.slice(1)) : null;
        const validEarlierLabel = label !== null && Number.isInteger(label) && label >= 0 && label < v.index;
        const validStoredRow = t !== null && liveById.has(t);
        // `candidates[label]` is in range whenever `validEarlierLabel` holds
        // (0 <= label < v.index, and `candidates[v.index]` is `c`), but this
        // repo runs `noUncheckedIndexedAccess`, so the read is guarded rather
        // than asserted.
        const labelTarget = validEarlierLabel && label !== null ? candidates[label] : undefined;
        const crossSubjectLabel = !!labelTarget && !labelTarget.keys.some((k) => c.keys.includes(k));
        if (validStoredRow && crossSubject(t)) {
          appendNote(v, `restates DOWNGRADED to record: target ${t} is not about any of this candidate's subjects`);
        } else if (!validStoredRow && crossSubjectLabel) {
          appendNote(v, `restates DOWNGRADED to record: target ${t} is an earlier candidate about none of this candidate's subjects`);
        } else if (validStoredRow || validEarlierLabel) {
          restated += 1;
          continue;
        } else {
        // Fall through and record. `restated` is NOT incremented — it counts
        // discards that actually happened, and a downgraded candidate was not
        // discarded. The audit row carries the reason.
          appendNote(v, `restates DOWNGRADED to record: target ${t ?? "(none)"} is neither a live row this agent can see nor an earlier candidate label in this batch`);
        }
      }

      // The same gap, for the verdict that retires a row rather than
      // discarding a candidate. `targetId` is deliberately NOT cleared, for
      // the reason decide.ts gives when its own guard downgrades: visibility
      // is inherited off the target regardless of verdict, and clearing it
      // would let a blocked corrects on an author-visible row write fleet.
      if (v.verdict === "corrects" && v.targetId && crossSubject(v.targetId)) {
        appendNote(v, `corrects DOWNGRADED to record: target ${v.targetId} is not about any of this candidate's subjects`);
        v.verdict = "record";
      }
      // `||`, not `??`: the extractor carries `grade` whenever the model
      // emits a string, so an EMPTY string reaches here as a present value.
      // `??` would pass "" to clampGrade, which reads it as invalid and
      // pins the row at F6 — every observation from a model that emitted
      // `"grade": ""` silently graded worst, whatever its source warranted.
      // Empty means absent, so it falls back to the source ceiling.
      const grade = clampGrade(c.grade || ceiling, ceiling);

      // Fix round 1, C3: naturalKey must be RE-DERIVED from the rewritten
      // predicate/value the row is about to store, not the raw pair
      // extract.ts:69 built it from — the upsert key has to track what's
      // actually stored, or a later write sharing the raw naturalKey
      // silently updates a row now holding a different rewritten fact
      // (the reviewer's concrete case: `pays-rent: life | 75 eur`, a fact
      // never observed). Only candidates that HAD a naturalKey get one
      // re-derived; a candidate with none still takes the `create` path,
      // unchanged.
      //
      // Fix round 2, Critical A: `RECONCILE_SYSTEM` instructs the model to
      // strip the number OUT of `value` and into `valueNum` — so a key built
      // from predicate+value alone no longer carries the discriminating
      // token for a numeric time series. Proven concretely: three monthly
      // rent observations (1540 → 2400 → 2500), each a legitimate `record`,
      // collapsed to ONE row holding only the last value — silently
      // contradicting the schema's own doc, "a value that genuinely changed
      // over time is two live rows — that is what this table is for." Both
      // `valueNum` and `unit` now join the key; extract.ts's own
      // construction (predicate + slug(value)) is deliberately narrower
      // because at extraction time nothing has been split out of `value`
      // yet — this key diverges from extract.ts's on purpose, not by
      // oversight, because it is keying what actually gets STORED after
      // rewriting, not what was extracted before it.
      // Fix round 3, IMPORTANT: `parseVerdicts` only trims `unit`;
      // `buildNaturalKey` joins parts raw, and only `value` was passed
      // through `slugifyEntity` — so "eur" and "EUR" produced two different
      // keys. The same recurring fact recorded with different unit casing
      // one month to the next stopped upserting and started duplicating —
      // the mirror image of Critical A's bug, corrupting the same time
      // series A exists to protect. `slugifyEntity(unit)` normalizes it the
      // same way `value` already is, rather than changing `parseVerdicts`'
      // contract (kept simplest: it still just trims).
      //
      // Fix round 3, MINOR: `buildNaturalKey` (keys.ts) filters ZERO-LENGTH
      // parts before joining, so once any part goes empty, position carries
      // no information — a bare-symbol `value` that slugs to "" and a
      // `valueNum`/`unit`-only observation could produce the IDENTICAL key
      // as an unrelated observation whose `value` carries the number as text
      // with no `valueNum`. "-" placeholders keep every part non-empty so
      // position stays significant. Deliberately NOT changed inside
      // `buildNaturalKey` itself — `extract.ts:69` shares it, and altering
      // its filtering there would silently change dedup identity for every
      // other caller.
      //
      // Fix round 4: every slot now goes through `keyToken` (above), which
      // keeps round 3's normalization but distinguishes "absent" from
      // "present but unsluggable" instead of folding both onto one "-".
      // `predicate` joins them (it was the one part never slugified, so
      // `predicate "pays:rent" + value "x"` produced a 5-segment key while
      // `predicate "pays" + value "rent:x"` produced 4 — no collision was
      // constructible, since no other part can contain ":", but it broke the
      // arity premise keys.ts:56-61 documents). The 40-char cap stays on
      // `value` only, exactly where round 3 had it; a truncated codepoint
      // token can still alias another very long unsluggable value sharing its
      // first ~7 characters, which is the same bounded property the slug path
      // has always had — a far cry from today's "all of them are one row".
      const predicateToken = keyToken(v.predicate, ABSENT_PREDICATE);
      const valueToken = keyToken(v.value, ABSENT_VALUE).slice(0, 40);
      const numToken = v.valueNum != null ? String(v.valueNum) : ABSENT_NUM;
      // Fix round 5: `unit` alone does NOT go through `keyToken` — see
      // `unitKeyToken` above. The slug path is lossy for a unit that slugs
      // to something shorter rather than to nothing ("µs" → "s").
      const unitToken = unitKeyToken(v.unit);
      const naturalKey = c.naturalKey
        ? buildNaturalKey([predicateToken, valueToken, numToken, unitToken])
        : null;

      // Fix round 1, I7 (controller ruling): a new row inherits its named
      // target's visibility rather than defaulting to "fleet". Only
      // `corrects` ever reaches here with a targetId — `record` verdicts
      // always carry `targetId: null` (reconcile.ts's parseVerdicts), and
      // `restates` already `continue`d above without writing anything. So
      // this only fires for `corrects` today; written generally in case a
      // future verdict type also names a target.
      const targetLive = v.targetId ? liveById.get(v.targetId) : undefined;
      const visibility = targetLive?.visibility === "author" ? "author" : "fleet";

      // A fan-out sibling must NOT inherit the parent's kind. The split
      // exists precisely because the parent held facts of DIFFERENT
      // modality — a budget target and the actual spend — so stamping both
      // with one kind stores at least one of them wrongly, and a later
      // verdict can then merge THROUGH `guardVerdict` on that false match
      // (see the comment above `verdictCountByIndex`). `general` is
      // modality "neither" (taxonomy.ts), so a fanned-out row can never be a
      // merge target. Duplicates, not holes — this project's stated
      // asymmetry. A candidate that produced exactly one verdict is
      // unaffected and still gets its real classified `kind`.
      const fannedOut = (verdictCountByIndex.get(v.index) ?? 0) > 1;
      const data = {
        subjectKey: c.keys[0]!, about: c.keys,
        predicate: v.predicate, value: v.value,
        valueNum: v.valueNum, unit: v.unit,
        ts, source: input.source, sourceGrade: grade,
        naturalKey, provenancePath: input.provenancePath ?? null,
        visibility,
        kind: fannedOut ? "general" : (classified[v.index]?.kind ?? "general"),
        topics: classified[v.index]?.topics ?? ["general"],
      };
      // FINAL FIX WAVE, IMPORTANT 2: the per-candidate write gets its own
      // try/catch, the way the supersede below already has one.
      //
      // These calls sat outside any try. An oversized `naturalKey` raises a
      // REAL Postgres error — reproduced: `index row size 2752 exceeds btree
      // version 4 maximum 2704` — because the key participates in a unique
      // index and the `unit` token is uncapped (fix round 5's accepted
      // trade). The consequence was the worst shape available: rows already
      // written stayed COMMITTED, every later candidate was dropped,
      // `markDossierDirty` never ran so the committed rows never reached
      // synthesis, `host.log` never ran so there was no audit row, and the
      // caller was told zero.
      //
      // Deliberately NOT fixed with a length cap on the key: a cap
      // reintroduces exactly the aliasing fix rounds 4 and 5 removed. Count
      // it, note it, and keep going.
      //
      // The two write branches this replaced — a composite upsert on
      // (authorAgent, subjectKey, naturalKey) when a naturalKey exists, a
      // plain insert when it does not — are now one call, `insertObservation`
      // (store.ts). Its update clause carries the rules argued here across
      // four fix rounds: `predicate`, `value`, `about`, `kind` and `topics`
      // are all updated (C3(b), fix round 2 Minor G, fix round 1/5 Important
      // b — a re-upserted row must never carry the OLD predicate or the OLD
      // classification beside the NEW fact, and a stale `kind` goes on to
      // feed the guard's next judgement), while `visibility` is
      // ESCALATE-ONLY (fix round 2, Critical B: writing it unconditionally
      // let a `record` verdict, always computed "fleet", flip an existing
      // author-visible row back to fleet the moment a rewritten key collided
      // with it — laundering private content through the very update path
      // I7 exists to protect).
      let row: { id: string; about: string[] } | null = null;
      try {
        row = await store.insertObservation(data);
        for (const k of row.about) rewrittenAbout.add(k);
        if (naturalKey) {
          upserted += 1;

          // Fix round 2, Important D: whether this batch already wrote this
          // exact derived key. Moved BELOW the write by the final fix wave — a
          // write that threw must not make a LATER candidate sharing the key
          // look like it collapsed onto a row that was never created. The
          // observable behaviour for a successful write is unchanged: nothing
          // between the read and the set can alter the map.
          // Keyed on subject AND natural key, not the key alone: row identity
          // is (authorAgent, subjectKey, naturalKey), so two candidates with
          // the same derived key but different PRIMARY subjects upsert onto
          // two different rows and nothing collapsed. `authorAgent` is
          // constant within a call, so the pair is the whole identity here.
          const collapseKey = `${c.keys[0]} ${naturalKey}`;
          const priorInBatch = derivedKeysThisBatch.get(collapseKey) ?? 0;
          derivedKeysThisBatch.set(collapseKey, priorInBatch + 1);
          if (priorInBatch > 0) {
            collapsed += 1;
            appendNote(v, `collapsed: naturalKey "${naturalKey}" already written ${priorInBatch} time(s) earlier in this batch — this candidate updated that same row rather than creating a new one`);
          }
        }
      } catch (err) {
        writeFailed += 1;
        const reason = err instanceof Error ? err.message : String(err);
        appendNote(v, `write FAILED, candidate dropped: ${reason}`);
      }
      // `row` is null only on the catch above. `continue` rather than
      // `throw`: the batch's already-committed rows still deserve the dirty
      // flag and the audit row.
      if (!row) continue;
      recorded += 1;

      if (v.verdict === "corrects" && v.targetId) {
        const targetId = v.targetId;
        if (row.id === targetId) {
          // Fix round 3, CRITICAL: the upsert above can match and update the
          // TARGET ROW ITSELF — when a `corrects` verdict's rewritten fields
          // re-derive a naturalKey equal to the one its own target already
          // carries (RECONCILE_SYSTEM pushes the model toward exactly this:
          // "reuse an existing predicate from the rows above… prefer the
          // existing spelling exactly", which a re-observation mislabeled
          // `corrects` naturally satisfies). `row.id === targetId` in that
          // case, and the correction is ALREADY merged into the target — the
          // supersede would set `supersededById` on the row that just
          // absorbed it, vanishing it from every `supersededById: null` read
          // (the store's `evidence` and `liveRowsAbout`, the projection, the
          // reconciler's own liveRows) with nothing left to carry the content
          // forward.
          // `@unique` on `supersededById` does not catch this: only one row
          // ever holds that value. Not merely unsafe — redundant, since the
          // "correction" already happened via the upsert.
          supersedeSkipped += 1;
          appendNote(v, "supersede skipped: the correction upserted onto its own target");
        } else if (!ownLiveIds.has(targetId)) {
          // C1(a): target isn't a live row this agent authored — hallucinated
          // id, reaped by the 30-day sweep, or someone else's row (I6). The
          // row we just wrote stands regardless; only the supersede is
          // skipped.
          supersedeSkipped += 1;
          appendNote(v, `supersede skipped: target ${targetId} is not a live row authored by ${host.agentId}`);
        } else if (alreadySuperseded.has(targetId)) {
          // I3: a repeat target this batch — skip rather than silently
          // overwrite the first supersession.
          supersedeSkipped += 1;
          appendNote(v, `supersede skipped: target ${targetId} already superseded earlier in this batch`);
        } else {
          try {
            // C1(b): this is the write in the loop most likely to fail in
            // production — a target that vanished between the read above and
            // this write, or a unique violation on `supersededById` when the
            // `collapsed` case above means this `row.id` is already another
            // row's. It gets its own try/catch so that failure costs only
            // THIS supersede — rows already written stay committed, every
            // later candidate is still reached, and the dirty flag and the
            // audit row still fire below.
            //
            // Fix round 2, Minor H: the store's WHERE carries `authorAgent =
            // <this agent>`, enforcing I6 at the database rather than only
            // against the in-memory `ownLiveIds` snapshot taken before this
            // loop ran — closing the TOCTOU window between that read and this
            // write. It does not throw when zero rows match, so that case is
            // reported through the returned boolean, not the catch below.
            //
            // FINAL FIX WAVE, CRITICAL 1 — now store.supersede's invariant,
            // restated here because this is its only caller: the tombstone
            // must RELEASE its natural key. Superseded rows are excluded from
            // every READ, but not from the unique index on (authorAgent,
            // subjectKey, naturalKey), and a composite-unique upsert's
            // conflict target structurally cannot filter on `supersededById`.
            // Without the release a tombstone holds its natural key for the
            // whole 30-day retention window, and a later observation that
            // re-derives that key is written INTO the tombstone: the caller
            // is told `recorded: 1`, zero live rows exist, and because the
            // upsert's update clause never touches `supersededAt` the reaper
            // deletes the NEW observation on the OLD row's clock — roughly 18
            // days early rather than 30. Reachability is ordinary, not
            // pathological: the reconciler normalizes predicates as a soft
            // prior against a live-row set that differs batch to batch, so two
            // batches routinely normalize one fact differently.
            // `naturalKey: null` is the fix because Postgres unique indexes
            // are NULLS DISTINCT by default — any number of tombstones
            // coexist, and no live upsert can ever match one again.
            const ok = await store.supersede(targetId, row.id, ts);
            if (ok) {
              superseded += 1;
              alreadySuperseded.add(targetId);
            } else {
              supersedeSkipped += 1;
              appendNote(v, `supersede skipped: target ${targetId} matched zero rows at write time (authorAgent mismatch or the row is gone)`);
            }
          } catch (err) {
            supersedeFailed += 1;
            const reason = err instanceof Error ? err.message : String(err);
            appendNote(v, `supersede FAILED: ${reason}`);
          }
        }
      }
    }

    // Fix round 1, I5: the dirty flag is set ABOVE host.log — a logging
    // failure must not cost it (previously: log-then-flag meant a log failure
    // skipped the flag and the new rows never reached synthesis).
    //
    // EVERY subject in the batch is dirtied, not just the row's primary: a
    // fact filed under one subject is evidence for all of them, so all of
    // their dossiers are now stale. The store also dirties any composite that
    // lists one of these keys as a member.
    //
    // And every subject on a row this batch REWROTE, which is a strictly
    // larger set — see `rewrittenAbout` above. Dirtying `batchKeys` alone left
    // a subject holding a synthesized dossier built from a value the upsert
    // had already replaced, with nothing to make it re-synthesize.
    //
    // Fix round 2, Minor E: each of these has its own try/catch, so neither
    // can cost the other. A failure to dirty must not skip the audit row (the
    // brief calls the audit row load-bearing), and a logging failure must not
    // propagate out of recordObservations.
    //
    // FINAL FIX WAVE, IMPORTANT 3 — correcting the premise this swallow was
    // justified by. Rounds 1-2 asserted here that "every caller of
    // recordObservations is already wrapped in try/catch { return 0 }". That
    // was FALSE, and it was the stated reason for two deliberate error
    // swallows (this one and reconcile.ts's fail-open catch), so leaving it is
    // how the next person reasons into a bug — at least one caller awaited
    // this bare, with no handler of its own.
    //
    // The swallow is still right — it is just right for a stronger reason than
    // "someone else will catch it". By the time control reaches here the
    // batch's rows are already COMMITTED; a throw would turn a partial success
    // into a total loss at every call site, the ones that wrap and the ones
    // that do not.
    if (recorded > 0) {
      try {
        await store.markDirty([...new Set([...batchKeys, ...rewrittenAbout])]);
      } catch {
        // Swallowed deliberately — see comment above. Nothing else in this
        // function's contract can escalate it further.
      }
    }

    try {
      await host.log({
        kind: "INFO",
        source: "memory-reconcile",
        message: `reconcile ${batchKeys.join(", ")}: ${recorded} recorded, ${restated} restated, ${superseded} superseded`,
        payload: {
          about: batchKeys, source: input.source, candidates: candidates.length, liveRows: liveRows.length,
          recorded, upserted, restated, superseded, supersedeSkipped, supersedeFailed, collapsed, writeFailed, minted,
          // kind/topics added 2026-08-17. Both spec tripwires — "minted kinds
          // > 5% of writes" and "general topic > 10% of writes" — had no
          // production data source and had only ever been computed as one-off
          // greps over a backfill dry run, so the claim that soft enforcement
          // works at 20 options was untested rather than confirmed.
          verdicts: verdicts.map((v) => ({
            verdict: v.verdict, targetId: v.targetId, predicate: v.predicate,
            why: auditNotes.get(v) ?? v.why,
            kind: classified[v.index]?.kind ?? null,
            topics: classified[v.index]?.topics ?? null,
          })),
          // Per-group retrieval telemetry: what the cap actually discarded.
          groups: decided.groups,
        },
      });
    } catch {
      // Swallowed deliberately — see comment above.
    }

    return { recorded, upserted, restated, superseded, minted };
  }

  // A deliberate statement about a subject, not an extracted observation: it
  // is never reconciled, never superseded and never graded. `about` goes
  // through the same resolver the observation path uses, so an alias or a
  // proposal works here too; a string that names no known subject throws
  // rather than filing the statement somewhere it does not belong.
  async function recordContribution(input: RecordContributionInput): Promise<void> {
    const { keys } = await resolveAbout([input.about]);
    // resolveAbout throws for a string that is undeclared or unknown, so a
    // string entry either resolves or does not return — there is no dropped
    // case for a single string to leave `keys` empty.
    const subjectKey = keys[0]!;
    await store.insertContribution({
      subjectKey,
      content: input.content.trim(),
      why: input.why.trim(),
      source: input.source ?? "contribution",
      principalId: input.principalId ?? null,
      ts: input.ts ?? new Date(),
    });
    await store.markDirty([subjectKey]);
  }

  return { recordObservations, recordContribution };
}
