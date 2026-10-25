# @seneris/memory

Subject-keyed memory for an agent, or anything that talks to people over
time. You bring a Postgres URL and a model call; the library brings a write
pipeline that reconciles new facts against what it already knows, and a
consolidation pass that turns a subject's raw observations into one readable
dossier file.

It is not a retrieval system. There is no embedding index and no search —
the library does not decide what's relevant to a given moment, because it
has no visibility into that moment. It hands your host readable text for a
named subject (`recall`) or a whole dossier (`project`), and your host
decides what to do with it. And it is deliberately not multi-writer: exactly
one agent identity, the `synthesizer`, is allowed to consolidate a given
store, so there is one archivist, one dossier per subject, and no two
processes racing to overwrite each other's file.

`examples/stranger.ts` runs the whole loop — extract, record, consolidate,
recall, health — against nothing but a fresh database and a scripted stand-in
model. It is also this project's own exit test: `bun run test
examples/stranger.test.ts` spawns it against a throwaway database and checks
it exits clean.

## Install

```bash
bun add github:SenerisBV/memory
# or, developing against a local checkout:
bun add file:../memory
```

The package ships TypeScript SOURCE — `main` is `src/index.ts` and there is
no build step — so a Bun host imports it directly, and a Node host needs a
TypeScript loader (or its own build over the package) to consume it.

## Set up the database

The library owns its own Postgres schema (`memory` by default) and never
touches anything outside it.

```bash
createdb your_app_dev
```

```ts
import { migrate } from "@seneris/memory";
const { applied } = await migrate({ url: process.env.DATABASE_URL! });
// Idempotent, but it takes NO LOCK: call it once at deploy, not concurrently
// from every process that boots. `applied` lists the migrations this call ran.
// Pass `schema` to use a name other than `memory` (must match ^[a-z][a-z0-9_]*$).
```

## Quick start

```ts
import { createMemory, DEFAULT_REGISTRY, type CompleteFn } from "@seneris/memory";

const complete: CompleteFn = async ({ tier, system, messages, jsonSchema }) => {
  // call your model here; return its reply as plain text
  return { text: await yourModel(system, messages[0].content, jsonSchema) };
};

const memory = createMemory({
  agentId: "assistant",
  synthesizer: "assistant",          // you own this store, so you consolidate it
  complete,
  registry: DEFAULT_REGISTRY,
  dossierRoot: "./dossiers",
  log: (e) => console.error(`[${e.kind}] ${e.source}: ${e.message}`),
  db: { url: process.env.DATABASE_URL! },
});

try {
  await memory.record({ source: "chat", observations: await memory.extract(someText) });
} finally {
  await memory.close();              // createMemory opens a pool; you own it
}
```

`createMemory` opens a connection pool and never closes it on its own — a
library doesn't get to decide how long your process lives. Call `close()`.

## The host contract

Everything the library needs from you is one plain object, `MemoryHost`:

```ts
interface MemoryHost {
  agentId: string;        // stamped on every row you write, as authorAgent
  synthesizer: string;    // the one agentId allowed to consolidate this store
  complete: CompleteFn;   // your model call — see below
  registry: Registry;     // your subject types and topics; start from DEFAULT_REGISTRY
  dossierRoot: string;    // a directory the library may write markdown dossiers into
  log: (event) => void | Promise<void>;  // your logger; must not throw
  db: { url: string; schema?: string };  // the Postgres URL, and an optional schema name
  lens?: Lens;            // optional: filter a recalled body, or replace the extraction prompt
}
```

`complete` is the one seam you fill in: `(opts) => Promise<{ text: string }>`,
where `opts` carries a `tier` label you may route on, a `system` prompt, one
user message, and (for some calls) a JSON schema the reply is expected to
match. Nothing in the library cares which model answers it, only that the
text comes back in the shape the caller asked for.

## The registry

The library ships no names of its own — `DEFAULT_REGISTRY` exists so a fresh
host has something on day one, and every subject type or topic it declares is
just host data. A subject type says what may be minted, by whom, and whether
it rolls up other subjects:

```ts
import { withTypes, DEFAULT_REGISTRY } from "@seneris/memory";

const registry = withTypes(DEFAULT_REGISTRY, [
  { name: "vehicle", gloss: "a car, bike or boat with its own maintenance history",
    mintedBy: "model", composite: false },
]);
```

`mintedBy: "model"` lets extraction propose a brand-new subject of that type
(a `{type, label}` pair) the first time it's mentioned; `mintedBy: "host"`
means only your own code may create one, via `subjects.getOrCreateSubject`.

## Writing and reading

```ts
const observations = await memory.extract(someText);           // model call #1: what did this text say?
const result = await memory.record({ source: "call", observations }); // model calls #2, #3: classify, then reconcile against what's live
// { recorded, upserted, restated, superseded, minted }

const pass = await memory.consolidate({ minObs: 3 });           // one model call per dirty subject with enough evidence
// { synthesized: [{ key, bytes }], reaped }

const section = await memory.recall("person:someone", { name: "profile", intro: "What you know:" });
// { kind, name, priority, body } | null — the synthesized dossier if one exists, else a plain evidence projection
```

`record` calls your model once per PRIMARY-TOPIC GROUP per batch for
reconciliation: candidates are classified first, grouped by their primary
topic, and each group is judged against its own retrieved rows, sequentially.
So a ten-candidate batch spanning three topics is three reconcile calls, not
one and not ten — and the scripted stand-in in `examples/stranger.ts` keeps
every observation in ONE group on purpose, so the example needs exactly one
scripted verdict reply.

An observation is `{ about, predicate, value, valueNum?, unit?, naturalKey?, grade? }`.
`about` is a list of subject keys (`"person:someone"`), aliases you registered,
or `{ type, label }` proposals for types the registry lets the model mint.
The first entry is the subject the row is filed under; the rest are carried
along and searched too. You can build observations yourself and skip
`extract` entirely.

`record` and `contribute` are the only calls that write. `consolidate` is the only call that
turns raw rows into a dossier file — it's meant to run on its own schedule
(a cron, a nightly job), not after every write, because a dossier is worth
rewriting only once there's enough new evidence to say something different.
Cadence is entirely your host's decision: the library never guesses how
often you write or consolidate, because a library that guessed would report
either a false alarm or a false all-clear.

`consolidate` enforces the one-archivist rule in code: if `host.agentId`
is not `host.synthesizer`, it throws instead of writing. Several agents can
`record` into one store; only one consolidates it.

### The rest of the surface

```ts
// A free-text note about one subject, kept beside the observations rather than
// reconciled into them. It shows up in `project` and in the evidence for the next dossier.
await memory.contribute({ about: "person:someone", content: "Prefers calls after 6pm.", why: "said so twice" });

// The full readable evidence for a subject, or null if there's nothing.
// `limit` raises the evidence cap for this call (useful when diffing two stores).
const text = await memory.project("person:someone", { limit: 1000 });

// Subject administration.
await memory.subjects.getOrCreateSubject("person:someone", "Someone");
await memory.subjects.getSubject("person:someone");          // row or null
await memory.subjects.knownSubjects();                        // [{ key, label }]
await memory.subjects.setMembers("group:team", ["person:a", "person:b"]); // for composite types
await memory.subjects.putAlias("cust-4411", "person:someone"); // your id -> a subject key, per agentId
await memory.subjects.resolveLocalKey("cust-4411");           // "person:someone", or the input unchanged
```

`recall` takes `{ name, intro, priority?, maxChars? }` and returns a
prompt-section-shaped object; `maxChars` caps the body.

### Who can read what

Every observation carries a `visibility`. Rows written through `record`
are `"fleet"`: readable by every agent that shares the store. `"author"`
rows are readable only by the agent that wrote them. The library never
creates one from fresh input, but a correction to an `"author"` row stays
`"author"`, and an upsert can make a row more private but never less.
Consolidation reads only `"fleet"` rows, because a dossier is visible to
everyone. Aliases are scoped per `agentId`.

## health()

```ts
const h = await memory.health({ writeCadenceDays: 1, consolidateCadenceDays: 7 });
// { ok, flags, lastWriteAt, lastConsolidateAt }
```

You tell it the cadence you expect (how often you write, how often you
consolidate); it tells you whether reality matches. A flag here is not a bug
in the library — it means the schedule that's supposed to call `record` or
`consolidate` isn't running, or ran less often than you told `health` to
expect. Fix the scheduler, or fix the cadence you passed in; `health` can't
tell you which, only that they've drifted apart.

## Measuring your model

The library ships with no claim about how well any particular model
reconciles or synthesizes — that number depends entirely on which model you
point `complete` at, and at what prompt shape. Two starting points:

```bash
bun run test src/reconcile.test.ts   # the verdict parser, model-independent
```

Then, once you have a model wired up, feed `calibrate()` a handful of real
predictions and their outcomes, and read back what it recorded:

```ts
await memory.calibrate({ about: "person:someone", predicted: "under 200", actual: "340", note: "why it missed" });
```

`calibrate` writes a prediction/outcome pair as an ordinary graded
observation, so it ages, consolidates and recalls like everything else —
there's no separate report to go read. Don't assume a number you've seen
quoted elsewhere transfers to your model: one deployment's measured 1.8%
wrong-restatement rate was a figure for one specific model, and changing
nothing but the JSON output contract once swung a *different* model's
reconciliation accuracy from 58% correct to 0% coherent. Measure your own
model against your own contract before trusting either.

## Entry points and scripts

`@seneris/memory` is the whole public surface. The subpaths
`/registry`, `/host` and `/migrate` re-export pieces of it for hosts that
want only those. `/adoptLegacy` is a one-off migration from the store this
library was extracted from. It is not general-purpose, and new hosts can
ignore it.

| Script | What it does |
| --- | --- |
| `bun run db:migrate` | Apply migrations to `DATABASE_URL` from `.env` |
| `bun run db:check` | Verify every declared table, index and constraint exists (`MEMORY_SCHEMA` overrides the schema name) |
| `bun run db:generate` | Generate a new migration after a schema change. Read the SQL before applying it |
| `bun run consolidate` | Run one consolidation pass from the environment (see below) |
| `bun run example:stranger` | Run `examples/stranger.ts` against `.env`'s database |

`bun run consolidate` is for a cron job:

```bash
MEMORY_STORE_URL=postgresql://localhost:5432/your_store \
MEMORY_SYNTHESIZER_ID=archivist \
MEMORY_DOSSIER_ROOT=./dossiers \
MEMORY_COMPLETE_MODULE=./my-model.ts \
  bun run consolidate --live
```

`MEMORY_COMPLETE_MODULE` names a file whose default export is a
`CompleteFn`. If it's unset the runner still starts, and a pass with nothing
to synthesize reports a clean no-op. A pass that needs the model then throws
rather than writing a dossier from a stand-in. `MEMORY_SCHEMA` overrides the
schema name. It refuses any database whose name doesn't end in `_test` unless you pass
`--live`, and refuses `--live` on a `_test` database, so you can't run
against a real store by accident.

## What isn't built

- No SQLite or other embedded-database target — Postgres only.
- No retrieval, ranking, or embeddings. `recall`/`project` return text; what's
  relevant to surface is your host's call, not this library's.
- No adapters for a specific model provider. `complete` is the whole seam.

## Developing

```bash
bun install
createdb memory_dev && createdb memory_test
cp .env.example .env && cp .env.test.example .env.test   # then edit the URLs
bun run db:test:setup      # migrate memory_test
bun run test               # the whole suite, against memory_test only
bun run typecheck
```

Two guards run inside the suite. `src/guards.test.ts` fails if anything
under `src/` imports a host's agent runtime, or contains a name from the
guard list. The real list comes from `MEMORY_GUARD_NAMES` in `.env.test`;
without it the test uses a generic default. Fixture data and prompt
examples must be synthetic. The name guard doesn't check numbers, so
reviewers have to.

## Two things never to do

- Never `drizzle-kit push` against this schema. Generate a migration
  (`bun run db:generate`), read the SQL, then apply it
  (`bun run db:migrate`) — `push` can drift the migration history out from
  under you.
- Never point the suite at a database you care about. `tests/db-guard.ts` is
  the first entry in `bunfig.toml`'s `[test] preload`, so it runs on EVERY
  invocation — `bun run test` and bare `bun test` alike — and `process.exit(1)`s
  on any `DATABASE_URL` whose database name does not end in `_test`. The guard
  keys on the NAME, not on which command started the run. Prefer `bun run test`
  anyway (or `bun run test <file>`), because that is what loads `.env.test`;
  bare `bun test` inherits whatever `DATABASE_URL` your shell already has, and
  is then refused rather than run against it.

## License

MIT — see [LICENSE](LICENSE).
