# Design

Why `@seneris/memory` is shaped the way it is. The README says how to use
it; this says what each piece is for and what it protects against. Source
comments that cite a design decision point to a section here.

The library was extracted from a running multi-agent system. Most of what
looks fussy below exists because the simpler version broke against real
data. Those failures are summarised here without the data.

## 1. What it is, and what it refuses to be

It's a memory for something that talks to the same people over months: an
assistant, an agent, a CRM-like tool. It keeps facts about **subjects**,
reconciles new facts against old ones, and periodically writes each subject
a readable **dossier**.

It refuses three jobs, on purpose:

- **Retrieval.** There's no embedding index and no search. Deciding what's
  relevant *right now* needs the context of right now, which only the host
  has. The library returns text for a named subject. The host decides when
  to ask and what to do with it.
- **Scheduling.** The library never guesses how often the host writes or
  consolidates. A library that guessed would misfire either way: alarming on
  a quiet host, or calling a dead one healthy.
- **Picking a model.** `complete` is the whole seam. The library tells the
  model what shape of answer it wants and validates what comes back. It
  doesn't care who answers.

## 2. Principles

1. **The host owns every name.** Subject types and topics are registry
   data, and `DEFAULT_REGISTRY` exists only so day one works. Nothing in
   `src/` names a host's agents, people or businesses, and a test enforces
   that.
2. **Fail toward a duplicate, never toward a merge.** A duplicate fact is
   visible and fixable. A wrongly merged fact is gone. Every uncertain path
   in reconciliation (an unparseable verdict, an unknown kind, a missing
   target) falls back to writing a new row.
3. **Never drop silently.** An invalid model reply is treated as "record
   everything as new", not "record nothing". Silent loss is the one failure
   nobody notices until the store is empty.
4. **Confidence only goes down.** See [§5](#5-grades).
5. **One archivist per store.** See [§7](#7-consolidation-and-the-single-synthesizer).
6. **Deny by default on reads.** A scoped read with no reading agent throws
   rather than returning unfiltered rows. See [§8](#8-visibility).
7. **Measure, don't assume.** The parts with thresholds (caps, tripwires,
   `minObs`) were set from measurements, and `calibrate` and `health` exist
   so a host can keep measuring.

## 3. The data model

- **Subject.** Something memory is about, keyed `type:slug` (`person:ann`,
  `pursuit:move-to-the-coast`). It has a label, an attention level, a dirty
  flag and, for composite types, a member list.
- **Alias.** A host's own identifier mapped to a subject key, scoped to the
  agent that registered it.
- **Observation.** One fact: `predicate` + `value`, with an optional parsed
  `valueNum` and `unit`. It also carries a `kind` and `topics` (see
  [§4](#4-kinds-and-topics)), a source and a grade, a `visibility`, an
  `authorAgent`, and an `about` list: the subject it's filed under first,
  then every other subject it concerns. Superseded rows are kept for 30 days
  and then reaped.
- **Contribution.** A deliberate free-text note about a subject, with a
  `why`. It isn't reconciled and feeds straight into synthesis.

### Subject resolution (read before write)

The extractor may name an existing key, an alias, or propose
`{ type, label }`. A proposal is matched against existing subjects by label
(case-insensitive, within the type), then by alias, then by slug, and only
then created. Only types the registry marks `mintedBy: "model"` can be
created this way. Without this order, one conversation about household
pests and cleaning minted fifteen separate "efforts", including one each for
"vacuum" and "ants".

## 4. Kinds and topics

Every observation is classified on two independent axes, by a model call
that sees **no** stored rows. It decides only what the fact *is*.

- **Topics** are the host's (registry data): what area of life a fact
  belongs to. An observation can have several. The first is its *primary*
  topic, and `general` is the fallback.
- **Kinds** are built in (`src/kinds.ts`): the relation the fact expresses,
  such as `wants`, `decided`, `costs`, `earns` or `waiting-on`. They stay in
  the library because the merge guard depends on them. Each kind sits on one
  side of an *intended / actual* line (`targets`: "400 a month on groceries"
  vs `costs`: "460 on groceries last month"). The guard won't merge across that line, because
  a target and an actual are two facts, not a correction. `concerned-about`
  and anything unrecognised sit on neither side, so they never merge.

The kind vocabulary is closed on purpose. Letting the model mint predicates
freely produced hundreds of near-synonyms over a few hundred facts. Kinds are
added only when a measured share of rows falls through to `general` and
reading those rows shows a recurring shape (that's how `waiting-on` and
`instructs` arrived). Residue with no common shape stays `general`, which is
an honest label for "nothing fits".

## 5. Grades

Every row carries an Admiralty-style grade: a reliability letter (A best … F
worst) and a credibility digit (1 best … 6 worst), e.g. `C3`. Each source
type has a ceiling. The extractor may propose a grade, but it's clamped to
the more pessimistic of the proposal and the ceiling. A model can say "less
sure" than the source warrants, never "more sure". `calibrate` asks for
`B2` because an outcome recorded after the fact is a direct observation, but
it's clamped like everything else.

## 6. The write path (`record`)

1. **Resolve** each candidate's `about` list to subject keys ([§3](#3-the-data-model)).
2. **Classify** each candidate's kind and topics in one model call ([§4](#4-kinds-and-topics)).
3. **Group by primary topic.**
4. **Retrieve per group:** the live rows about the same subjects in the same
   topic, capped. Retrieval is *topic-scoped* because reconciling against
   everything known about a subject buries the few rows that matter. A
   candidate about money would otherwise be judged against a subject's
   entire history.
5. **Reconcile per group:** one model call per group, which returns a
   verdict per candidate. `record` means new. `restates` points at a live row
   saying the same thing, and the candidate is dropped in its favour.
   `corrects` points at a live row this one replaces, and the old row is
   superseded. The prompt insists numbers survive rewriting digit for digit,
   and the parser checks that a returned `valueNum` actually appears in the
   text.
6. **Guard.** Before anything is written, a deterministic check downgrades
   verdicts the model isn't entitled to: a target that isn't live, wasn't
   written by this agent, isn't about any of the candidate's subjects (rows
   from other subjects in the batch ride along in retrieval), or sits across
   the intended/actual line. A
   downgraded verdict becomes `record`, per principle 2.
7. **Write**, stamping `authorAgent`, and mark every touched subject dirty.

Steps 2–6 hold no database access. The caller injects a row-fetching
function, so the whole pipeline is testable without a database, and a replay
harness can drive exactly the code production runs.

## 7. Consolidation and the single synthesizer

Recording is multi-writer: several agents can `record` into one store.
Consolidation is not. Exactly one agent identity, `host.synthesizer`, may
run it, and `consolidate` throws for any other. This gives one archivist,
one dossier per subject, and no two processes overwriting the same file.
`scripts/consolidate-store.ts` is that archivist as a standalone cron job.

A pass visits every dirty subject with at least `minObs` pieces of evidence
(observations, contributions, and member dossiers for composites; default
3). It renders that evidence plus the previous dossier into one model call,
and writes the result to `dossierRoot/subjects/<slug>.md`. Evidence is read
**fleet-only** ([§8](#8-visibility)), because a dossier is visible to every
agent. When every row shares an author, source and grade, that citation is
stated once instead of on every line. Repeated identical citations add
nothing, and the model starts echoing them into the prose.

A failure on one subject is logged and the pass continues. If the previous
dossier is unreadable, the synthesizer is told "(none yet)" rather than the
pass failing.

## 8. Visibility

Visibility scopes **agents**, not humans. `"fleet"` rows are readable by
every agent sharing the store. `"author"` rows are readable only by the
agent that wrote them. Every read goes through the store, and the store
applies the scope, so no module can forget it by writing its own query. That
includes the rows shown to the reconciler: without the scope, one agent's
private rows would land in a prompt whose output another agent can read.

Fresh writes are `"fleet"`. A correction inherits its target's visibility,
and an upsert may make a row more private but never less.

## 9. Reading

- `recall(key, …)` returns the dossier if one exists. Otherwise it returns a
  plain projection of the evidence, wrapped as a prompt section and capped at
  1800 characters by default. `host.lens.recallFilter` is applied last, so a
  host can redact per agent.
- `project(key, { limit })` returns the full evidence as text. `limit`
  exists because a capped projection was the wrong tool for *comparing* two
  stores: a 200-row window hid most of the differences being looked for.

## 10. Health and calibration

`health` takes the cadence the host expects and reports whether reality
matches. It counts the most recent write by either observations or
contributions, since a host may write only contributions. The pure half
(`computeHealth`) takes dates and returns flags, so it's tested without a
database.

`calibrate` writes a prediction/outcome pair as an ordinary observation. It
ages, consolidates and recalls like anything else, so there's no second
store or reporting path to keep alive.

## 11. Current state

Version 0.1.0. Postgres only. TypeScript source with no build step.

Not built, deliberately: retrieval or embeddings, model-provider adapters,
other databases (see the README's "What isn't built").

Known rough edges:

- `adoptLegacy` is exported but specific to the store this library came
  from. It should probably move out of the public exports.
- Two distinct subjects whose slugs collide after the 48-character cap can
  name the same dossier file. `consolidate` refuses the second one and
  leaves it dirty rather than overwriting, but there's no automatic rename.
- The library has no tuned model claims. Every threshold above came from
  one deployment's model. Re-measure with your own before trusting them.
