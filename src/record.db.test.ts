import { beforeEach, expect, test } from "bun:test";

import { handle, resetDb } from "../tests/setup";
import { fakeHost } from "../tests/fakes";
import { createRecord } from "./record";
import { createStore } from "./store";

beforeEach(resetDb);
const host = fakeHost();
const store = createStore(handle, host);
const record = createRecord(host, store);

// Test seams: classify everything as leisure/has, reconcile everything as record.
const classify = async (items: { predicate: string; value: string }[]) => items.map(() => ({ kind: "has", topics: ["leisure"] }));
const recordAll = async (a: { candidates: { predicate?: string | null; value?: string | null }[] }) =>
  a.candidates.map((c, index) => ({ index, verdict: "record" as const, targetId: null, predicate: c.predicate ?? "", value: c.value ?? "", valueNum: null, unit: null, why: "test" }));

test("one fact about two subjects lands as ONE row and is evidence for both", async () => {
  await store.getOrCreateSubject("person:noor", "Noor");
  await store.getOrCreateSubject("group:home", "Home");
  const r = await record.recordObservations({
    source: "office-visit", classify, reconcile: recordAll,
    observations: [{ about: ["person:noor", "group:home"], predicate: "has-class", value: "art on Wednesdays at 13:00" }],
  });
  expect(r).toMatchObject({ recorded: 1, superseded: 0 });
  const rows = await handle.db.select().from(handle.tables.observation);
  expect(rows.length).toBe(1);
  expect(rows[0]!.subjectKey).toBe("person:noor");
  expect(rows[0]!.about).toEqual(["person:noor", "group:home"]);
  expect((await store.evidence("group:home", { fleetOnly: false, limit: 10 })).length).toBe(1);
  // both subjects are dirty
  expect((await store.getSubject("person:noor"))?.profileDirty).toBe(true);
  expect((await store.getSubject("group:home"))?.profileDirty).toBe(true);
});

test("a row the UPSERT rewrote dirties every subject that row is about, not just this batch's", async () => {
  // insertObservation's conflict clause UNIONS `about` and rewrites
  // value/topics/kind/ts. So a batch about ONE subject can rewrite a row that
  // is evidence for several — and every one of those dossiers is now stale.
  // Dirtying only `batchKeys` leaves the others clean, each holding a dossier
  // built from a fact the store no longer contains.
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("group:home", "Home");
  await store.insertObservation({
    subjectKey: "person:ann", about: ["person:ann", "group:home"],
    predicate: "pays-rent", value: "an older wording", valueNum: null, unit: null,
    ts: new Date("2026-01-01"), source: "office-visit", sourceGrade: "C3",
    // exactly what record.ts re-derives for predicate "pays-rent", value
    // "1540 per period", no valueNum, no unit
    naturalKey: "pays-rent:1540-per-period:-n:-u", provenancePath: null,
    visibility: "fleet", kind: "general", topics: ["general"],
  });
  // Consolidate-style: both subjects have been synthesized, so both are clean.
  await handle.db.update(handle.tables.subject).set({ profileDirty: false });

  const r = await record.recordObservations({
    source: "office-visit", classify, reconcile: recordAll,
    observations: [{ about: ["person:ann"], predicate: "pays-rent", value: "1540 per period", naturalKey: "pays-rent:1540-per-period" }],
  });
  expect(r).toMatchObject({ recorded: 1, upserted: 1 });
  const rewritten = await handle.db.select().from(handle.tables.observation);
  expect(rewritten.length).toBe(1);                                  // updated, not inserted
  expect(rewritten[0]!.value).toBe("1540 per period");               // holding a NEW value
  expect(rewritten[0]!.about).toEqual(["person:ann", "group:home"]);  // the union kept home
  expect((await store.getSubject("person:ann"))?.profileDirty).toBe(true);
  expect((await store.getSubject("group:home"))?.profileDirty).toBe(true);
});

test("a corrects verdict against a row seen through another subject supersedes it", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("group:home", "Home");
  await record.recordObservations({ source: "office-visit", classify, reconcile: recordAll,
    observations: [{ about: ["group:home", "person:ann"], predicate: "pays-rent", value: "1540 per period" }] });
  const [old] = await handle.db.select().from(handle.tables.observation);
  const corrects = async (a: { liveRows: { id: string }[]; candidates: { predicate?: string | null; value?: string | null }[] }) =>
    a.candidates.map((c, index) => ({ index, verdict: "corrects" as const, targetId: a.liveRows[0]!.id, predicate: c.predicate ?? "", value: c.value ?? "", valueNum: null, unit: null, why: "test" }));
  const r = await record.recordObservations({ source: "office-visit", classify, reconcile: corrects,
    observations: [{ about: ["person:ann"], predicate: "pays-rent", value: "2400 per period" }] });
  expect(r.superseded).toBe(1);
  const live = await store.evidence("group:home", { fleetOnly: false, limit: 10 });
  expect(live.length).toBe(0); // the old row was about home; the correction is about ann only
  expect((await store.evidence("person:ann", { fleetOnly: false, limit: 10 })).map((x) => x.value)).toEqual(["2400 per period"]);
  const [oldNow] = await handle.db.select().from(handle.tables.observation).where((await import("drizzle-orm")).eq(handle.tables.observation.id, old!.id));
  expect(oldNow!.supersededById).not.toBeNull();
});

test("a proposed subject is minted through the write and counted", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const r = await record.recordObservations({ source: "office-visit", classify, reconcile: recordAll,
    observations: [{ about: [{ type: "pursuit", label: "Arizona Trip" }, "person:ann"], predicate: "plans", value: "October" }] });
  expect(r.minted).toBe(1);
  expect((await store.getSubject("pursuit:arizona-trip"))?.label).toBe("Arizona Trip");
});

test("the grade is clamped to the source ceiling and the audit log is written", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await record.recordObservations({ source: "inferred", classify, reconcile: recordAll,
    observations: [{ about: ["person:ann"], predicate: "p", value: "v", grade: "A1" }] });
  const [row] = await handle.db.select().from(handle.tables.observation);
  expect(row!.sourceGrade).toBe("F6");
  expect(host.events.some((e) => e.source === "memory-reconcile")).toBe(true);
});

test("a contribution lands on its subject and dirties it", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await record.recordContribution({ about: "person:ann", content: "remember the anniversary", why: "matters" });
  expect((await store.contributions("person:ann", 10)).length).toBe(1);
  expect((await store.getSubject("person:ann"))?.profileDirty).toBe(true);
});

test("an unresolvable subject drops that candidate, not the batch", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const r = await record.recordObservations({
    source: "office-visit", classify, reconcile: recordAll,
    observations: [
      { about: ["person:nobody"], predicate: "likes", value: "sailing" },
      { about: ["person:ann"], predicate: "likes", value: "cycling" },
    ],
  });
  expect(r.recorded).toBe(1);
  const rows = await handle.db.select().from(handle.tables.observation);
  expect(rows.length).toBe(1);
  expect(rows[0]!.about).toEqual(["person:ann"]);
  expect(host.events.some((e) => e.message.includes("candidate dropped"))).toBe(true);
});

test("a STORE failure while resolving is rethrown, never swallowed into recorded: 0", async () => {
  // The catch around `resolveAbout` is narrow on purpose: model error (an
  // undeclared type, a key naming no subject) drops one candidate, and
  // everything else escapes. Every resolveAbout call reaches the database, so
  // an unconditional catch would turn a store outage into a handful of INFO
  // lines and a cheerful `recorded: 0` — a total failure reported as a
  // successful empty batch, which is the shape this project has been burned
  // by most often. Nothing else in the suite exercises the rethrow arm.
  const broken = { ...store, getSubject: async () => { throw new Error("boom"); } };
  const brokenRecord = createRecord(host, broken);
  await expect(brokenRecord.recordObservations({
    source: "office-visit", classify, reconcile: recordAll,
    observations: [{ about: ["person:ann"], predicate: "likes", value: "sailing" }],
  })).rejects.toThrow(/boom/);
});

// The `c<N>` arm of the same gap. `restates` naming a STORED row was guarded
// against cross-subject loss; `restates` naming an earlier CANDIDATE was not,
// and it discards a fact just as completely.
const restatesEarlierCandidate = async (a: { candidates: { predicate?: string | null; value?: string | null }[] }) =>
  a.candidates.map((c, index) => ({
    index,
    verdict: (index === 1 ? "restates" : "record") as "restates" | "record",
    targetId: index === 1 ? "c0" : null,
    predicate: c.predicate ?? "", value: c.value ?? "", valueNum: null, unit: null, why: "test",
  }));

test("a restates naming an earlier candidate about DISJOINT subjects is downgraded, not a discard", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("group:home", "Home");
  const before = host.events.length;
  const r = await record.recordObservations({
    source: "office-visit", classify, reconcile: restatesEarlierCandidate,
    observations: [
      { about: ["person:ann"], predicate: "likes", value: "cycling" },
      { about: ["group:home"], predicate: "needs", value: "a new boiler" },
    ],
  });
  expect(r).toMatchObject({ recorded: 2, restated: 0 });
  expect((await store.evidence("group:home", { fleetOnly: false, limit: 10 })).map((x) => x.value)).toEqual(["a new boiler"]);
  const audit = host.events.slice(before).find((e) => e.source === "memory-reconcile" && e.payload?.verdicts);
  const notes = (audit!.payload!.verdicts as { why: string }[]).map((v) => v.why).join(" | ");
  expect(notes).toContain("DOWNGRADED");
});

test("the same restates against an earlier candidate about the SAME subject still discards", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const r = await record.recordObservations({
    source: "office-visit", classify, reconcile: restatesEarlierCandidate,
    observations: [
      { about: ["person:ann"], predicate: "likes", value: "cycling" },
      { about: ["person:ann"], predicate: "needs", value: "a new boiler" },
    ],
  });
  expect(r).toMatchObject({ recorded: 1, restated: 1 });
  expect((await store.evidence("person:ann", { fleetOnly: false, limit: 10 })).map((x) => x.value)).toEqual(["cycling"]);
});

test("a verdict against a row this candidate is not about is downgraded to record, not swallowed", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("group:home", "Home");
  await record.recordObservations({ source: "office-visit", classify, reconcile: recordAll,
    observations: [{ about: ["group:home"], predicate: "pays-rent", value: "1540 per period" }] });
  const [home] = await handle.db.select().from(handle.tables.observation);

  // The ann candidate "restates" the home row — a row it is not about at all.
  const restatesTheHomeRow = async (a: { liveRows: { id: string }[]; candidates: { predicate?: string | null; value?: string | null }[] }) =>
    a.candidates.map((c, index) => ({
      index,
      verdict: (c.value === "cycling" ? "restates" : "record") as "restates" | "record",
      targetId: c.value === "cycling" ? (a.liveRows.find((r) => r.id === home!.id)?.id ?? null) : null,
      predicate: c.predicate ?? "", value: c.value ?? "", valueNum: null, unit: null, why: "test",
    }));
  const before = host.events.length;
  const r = await record.recordObservations({ source: "office-visit", classify, reconcile: restatesTheHomeRow,
    observations: [
      { about: ["person:ann"], predicate: "likes", value: "cycling" },
      { about: ["group:home"], predicate: "needs", value: "a new boiler" },
    ] });
  expect(r.recorded).toBe(2);
  expect(r.restated).toBe(0);
  const annRows = await store.evidence("person:ann", { fleetOnly: false, limit: 10 });
  expect(annRows.map((x) => x.value)).toEqual(["cycling"]);
  const audit = host.events.slice(before).find((e) => e.source === "memory-reconcile" && e.payload?.verdicts);
  const notes = (audit!.payload!.verdicts as { why: string }[]).map((v) => v.why).join(" | ");
  expect(notes).toContain("DOWNGRADED");
});
