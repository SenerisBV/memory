// The whole loop through the public surface only — no module below index.ts is
// imported here. If a wire in createMemory is crossed, this is the test that
// says so; every other db test builds its own store and would not notice.
import { beforeEach, expect, test } from "bun:test";

import { resetDb } from "../tests/setup";
import { fakeComplete, fakeHost } from "../tests/fakes";
import { createMemory } from "./index";

beforeEach(resetDb);

test("record → consolidate → recall → health, through createMemory, with no fleet import", async () => {
  const model = fakeComplete([
    // extract
    JSON.stringify([{ about: ["person:ann", { type: "thing", label: "Bakfiets" }], predicate: "bought", value: "a bakfiets through the company", naturalKey: "bought:bakfiets" }]),
    // classify
    JSON.stringify({ classifications: [{ index: 0, topics: ["gear", "money"], kind: "acquired" }] }),
    // reconcile — a bare array, which is what parseVerdicts/RECONCILE_SCHEMA
    // expect. No live rows for either subject, so the only legal verdict is
    // `record`, and the predicate/value carried here are what get WRITTEN.
    // The predicate is deliberately REWRITTEN here (`bought` → `acquired`):
    // normalizing a predicate against the live set is the reconciler's job,
    // and a wire that failed open — dropping the verdict and keeping the
    // candidate's own predicate — would still write "bought" and look fine.
    JSON.stringify([{ index: 0, verdict: "record", targetId: null, predicate: "acquired", value: "a bakfiets through the company", why: "new" }]),
    // synth person:ann, then synth thing:bakfiets (dirtySubjects is key-ordered)
    "## Model\n\nAnn bought a bakfiets.\n",
    "## Model\n\nA cargo bike, bought by Ann.\n",
  ]);
  const host = fakeHost({ complete: model.fn });
  const m = createMemory(host);
  try {
    await m.subjects.getOrCreateSubject("person:ann", "Ann");

    const extracted = await m.extract("Ann bought a bakfiets through the company.");
    expect(extracted).toHaveLength(1);

    const r = await m.record({ source: "office-visit", observations: extracted });
    // minted: 1 — the thing was PROPOSED by the model and created by the write.
    expect(r).toMatchObject({ recorded: 1, minted: 1 });

    const c = await m.consolidate({ minObs: 1 });
    expect(c.synthesized.map((s) => s.key).sort()).toEqual(["person:ann", "thing:bakfiets"]);

    const section = await m.recall("thing:bakfiets", { name: "bike", intro: "About the bike:" });
    // "cargo bike" appears only in the synthesized dossier, never in the
    // evidence projection recall falls back to — so this also proves the
    // A-layer answered.
    expect(section?.body).toContain("cargo bike");
    expect(section?.body).toContain("About the bike:");

    const projected = await m.project("person:ann");
    expect(projected).toContain("a bakfiets through the company");
    // The RECONCILER's predicate is what got stored, not the extractor's.
    expect(projected).toContain("acquired: a bakfiets through the company");
    expect(projected).not.toContain("bought:");

    const h = await m.health({ writeCadenceDays: 1, consolidateCadenceDays: 1 });
    expect(h.ok).toBe(true);
    expect(h.flags).toEqual([]);
    expect(h.lastWriteAt).toBeInstanceOf(Date);
    expect(h.lastConsolidateAt).toBeInstanceOf(Date);

    // Every queued answer was consumed: five calls, in the order above.
    expect(model.calls.map((c) => c.source)).toEqual([
      "memory-extract", "memory-classify", "memory-reconcile", "memory-synth", "memory-synth",
    ]);
  } finally {
    await m.close();
  }
});

test("health flags a store nobody has written to or consolidated", async () => {
  const m = createMemory(fakeHost());
  try {
    const h = await m.health({ writeCadenceDays: 1, consolidateCadenceDays: 1 });
    expect(h.ok).toBe(false);
    expect(h.flags.map((f) => f.code).sort()).toEqual(["never_consolidated", "never_written"]);
  } finally {
    await m.close();
  }
});

test("calibrate writes a prediction outcome as an ordinary observation", async () => {
  const model = fakeComplete([
    // classify
    JSON.stringify({ classifications: [{ index: 0, topics: ["money"], kind: "general" }] }),
    // reconcile
    JSON.stringify([{ index: 0, verdict: "record", targetId: null, predicate: "prediction-outcome", value: "predicted: under 200 | actual: 340 | the quote excluded parts", why: "new" }]),
  ]);
  const m = createMemory(fakeHost({ complete: model.fn }));
  try {
    await m.subjects.getOrCreateSubject("person:ann", "Ann");
    const r = await m.calibrate({ about: "person:ann", predicted: "under 200", actual: "340", note: "the quote excluded parts" });
    expect(r).toMatchObject({ recorded: 1 });

    const dossier = await m.project("person:ann");
    expect(dossier).toContain("prediction-outcome: predicted: under 200 | actual: 340 | the quote excluded parts");
    // source "decision" ceils at B2, and calibration proposes B2 — an outcome
    // observed after the fact outranks the transcript line that predicted it.
    expect(dossier).toContain("(B2)");
  } finally {
    await m.close();
  }
});
