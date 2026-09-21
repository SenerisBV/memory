// Someone starting fresh. A Postgres URL, a model, a directory. Nothing else.
//   createdb memory_dev
//   DATABASE_URL=postgresql://you@localhost:5432/memory_dev bun examples/stranger.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemory, migrate, DEFAULT_REGISTRY, type CompleteFn } from "@seneris/memory";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

// Bring your own model. This one is a stub that answers in the shapes the
// pipeline expects, so the script runs with no model at all; replace
// `complete` with a call to whatever you use (see README).
//
// Three calls happen in order: extract (a bare JSON array of observations),
// classify (one object, one entry per observation — every entry below
// shares "home" as its PRIMARY topic on purpose, so they land in one
// reconcile group and this queue only needs one reconcile answer),
// reconcile (a bare JSON array of verdicts — the predicate/value on each
// "record" verdict is what actually gets written, so they repeat the real
// facts rather than standing in empty). Then one synth answer per subject
// that ends up dirty, in key order ("person:me" sorts before
// "pursuit:move-to-the-coast").
const scripted: string[] = [
  JSON.stringify([
    { about: ["person:me"], predicate: "pays-rent", value: "1200 per month", naturalKey: "pays-rent:1200" },
    { about: ["person:me", { type: "pursuit", label: "Move to the coast" }], predicate: "considering", value: "moving to the coast next year" },
    { about: [{ type: "pursuit", label: "Move to the coast" }], predicate: "needs", value: "a job within an hour of the sea" },
  ]),
  JSON.stringify({
    classifications: [
      { index: 0, topics: ["home", "money"], kind: "costs" },
      { index: 1, topics: ["home"], kind: "considering" },
      { index: 2, topics: ["home", "work"], kind: "needs" },
    ],
  }),
  JSON.stringify([
    { index: 0, verdict: "record", targetId: null, predicate: "pays-rent", value: "1200 per month", why: "new" },
    { index: 1, verdict: "record", targetId: null, predicate: "considering", value: "moving to the coast next year", why: "new" },
    { index: 2, verdict: "record", targetId: null, predicate: "needs", value: "a job within an hour of the sea", why: "new" },
  ]),
  "## Model\n\nPays 1200 in rent; thinking about the coast.\n\n## Where this is heading\n\n- A move. [evidence: considering:moving to the coast next year]\n",
  "## Model\n\nA move to the coast, gated on finding work within an hour of the sea.\n",
];
const complete: CompleteFn = async () => ({ text: scripted.shift() ?? "[]" });

await migrate({ url });
const memory = createMemory({
  agentId: "me", synthesizer: "me", complete, registry: DEFAULT_REGISTRY,
  dossierRoot: process.env.DOSSIER_ROOT ?? mkdtempSync(join(tmpdir(), "memory-stranger-")),
  log: (e) => console.error(`[${e.kind}] ${e.source}: ${e.message}`),
  db: { url },
});
try {
  await memory.subjects.getOrCreateSubject("person:me", "Me");
  const observations = await memory.extract("I pay 1200 a month in rent and I'm thinking of moving to the coast next year, if I can find a job within an hour of the sea.");
  const recorded = await memory.record({ source: "office-visit", observations });
  const consolidated = await memory.consolidate({ minObs: 1 });
  const section = await memory.recall("pursuit:move-to-the-coast", { name: "coast", intro: "What you know about the move:" });
  const health = await memory.health({ writeCadenceDays: 1, consolidateCadenceDays: 1 });
  console.log(JSON.stringify({ recorded, consolidated, recall: section?.body, health: health.ok }, null, 2));
  if (recorded.recorded !== 3 || consolidated.synthesized.length !== 2 || !section || !health.ok) process.exit(1);
} finally {
  await memory.close();
}
