import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { handle, resetDb } from "../tests/setup";
import { fakeHost } from "../tests/fakes";
import { RegistryError } from "./registry";
import { createStore } from "./store";

beforeEach(resetDb);
const host = fakeHost();
const store = createStore(handle, host);

test("a subject is created once, with a declared key only", async () => {
  const a = await store.getOrCreateSubject("person:ann", "Ann");
  const b = await store.getOrCreateSubject("person:ann", "Ann again");
  expect(b.id).toBe(a.id);
  expect(b.label).toBe("Ann");
  await expect(store.getOrCreateSubject("business:acme", "Acme")).rejects.toThrow(RegistryError);
});

test("aliases resolve for this agent only, else the key is itself", async () => {
  await store.putAlias("42", "person:ann");
  expect(await store.resolveLocalKey("42")).toBe("person:ann");
  expect(await store.resolveLocalKey("person:bob")).toBe("person:bob");
  const other = createStore(handle, fakeHost({ agentId: "someone-else" }));
  expect(await other.resolveLocalKey("42")).toBe("42");
});

test("a row about two subjects is evidence for both", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("group:home", "Home");
  await store.insertObservation({ subjectKey: "person:ann", about: ["person:ann", "group:home"], predicate: "has-class", value: "art on Wednesdays", source: "test", sourceGrade: "C3", naturalKey: null, visibility: "fleet", kind: "has", topics: ["leisure"], ts: new Date(), valueNum: null, unit: null, provenancePath: null });
  expect((await store.evidence("person:ann", { fleetOnly: false, limit: 10 })).length).toBe(1);
  expect((await store.evidence("group:home", { fleetOnly: false, limit: 10 })).length).toBe(1);
  const { rows, matched } = await store.liveRowsAbout(["group:home"], { topic: "leisure", limit: 10 });
  expect(matched).toBe(1);
  expect(rows[0]!.about).toEqual(["person:ann", "group:home"]);
  expect((await store.liveRowsAbout(["group:home"], { topic: "money", limit: 10 })).matched).toBe(0);
});

test("author-visibility rows are hidden from other readers and from fleetOnly reads", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const base = { subjectKey: "person:ann", about: ["person:ann"], predicate: "p", value: "private", source: "test", sourceGrade: "C3", naturalKey: null, kind: "general", topics: ["general"], ts: new Date(), valueNum: null, unit: null, provenancePath: null };
  await store.insertObservation({ ...base, visibility: "author" });
  await store.insertObservation({ ...base, value: "public", visibility: "fleet" });
  expect((await store.evidence("person:ann", { fleetOnly: false, limit: 10 })).length).toBe(2);
  expect((await store.evidence("person:ann", { fleetOnly: true, limit: 10 })).length).toBe(1);
  const other = createStore(handle, fakeHost({ agentId: "someone-else" }));
  expect((await other.evidence("person:ann", { fleetOnly: false, limit: 10 })).length).toBe(1);
});

test("naturalKey upserts; supersede only touches the acting agent's own live row", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const base = { subjectKey: "person:ann", about: ["person:ann"], predicate: "pays-rent", value: "1540 per period", source: "test", sourceGrade: "C3", naturalKey: "pays-rent:1540", visibility: "fleet", kind: "costs", topics: ["money"], ts: new Date(), valueNum: 1540, unit: "eur", provenancePath: null };
  const a = await store.insertObservation(base);
  const b = await store.insertObservation({ ...base, value: "1540 per pay period" });
  expect(b.id).toBe(a.id);
  const c = await store.insertObservation({ ...base, naturalKey: null, value: "2400 per period" });
  expect(await store.supersede(a.id, c.id, new Date())).toBe(true);
  expect((await store.evidence("person:ann", { fleetOnly: false, limit: 10 })).map((r) => r.id)).toEqual([c.id]);
  const other = createStore(handle, fakeHost({ agentId: "someone-else" }));
  expect(await other.supersede(c.id, a.id, new Date())).toBe(false);
});

test("knownSubjects: important first, ignored never, capped", async () => {
  for (let i = 0; i < 45; i++) await store.getOrCreateSubject(`pursuit:p${i}`, `P${i}`);
  await store.getOrCreateSubject("person:vip", "VIP");
  await handle.db.update(handle.tables.subject).set({ attention: "important" }).where(eq(handle.tables.subject.key, "person:vip"));
  await store.getOrCreateSubject("thing:junk", "Junk");
  await handle.db.update(handle.tables.subject).set({ attention: "ignore" }).where(eq(handle.tables.subject.key, "thing:junk"));
  const known = await store.knownSubjects();
  expect(known[0]!.key).toBe("person:vip");
  expect(known.some((k) => k.key === "thing:junk")).toBe(false);
  expect(known.length).toBe(41); // KNOWN_SUBJECTS_CAP most recent + the important one
});

test("findSubjectByLabel is case-insensitive within a type", async () => {
  await store.getOrCreateSubject("person:robin", "Robin");
  expect((await store.findSubjectByLabel("person", "robin"))?.key).toBe("person:robin");
  expect(await store.findSubjectByLabel("thing", "robin")).toBeNull();
});

test("findSubjectByLabel('%') does not match every label — equality, not a LIKE pattern", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  expect(await store.findSubjectByLabel("person", "%")).toBeNull();
});

test("markDirty dirties the named subject and every composite that lists it as a member; [] is a no-op", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("group:home", "Home");
  await store.setMembers("group:home", ["person:ann"]);
  // setMembers dirties the composite itself; clear it, or the assertion below
  // would pass whether or not markDirty reaches composites at all.
  expect((await store.getSubject("group:home"))?.profileDirty).toBe(true);
  await handle.db.update(handle.tables.subject).set({ profileDirty: false }).where(eq(handle.tables.subject.key, "group:home"));
  await store.markDirty(["person:ann"]);
  expect((await store.getSubject("person:ann"))?.profileDirty).toBe(true);
  expect((await store.getSubject("group:home"))?.profileDirty).toBe(true);
  await expect(store.markDirty([])).resolves.toBeUndefined();
});

test("setMembers throws on a missing subject or an undeclared member key", async () => {
  await expect(store.setMembers("group:ghost", ["person:ann"])).rejects.toThrow(/no subject/);
  await store.getOrCreateSubject("group:home", "Home");
  await expect(store.setMembers("group:home", ["business:acme"])).rejects.toThrow(RegistryError);
});

test("insertContribution then contributions returns rows newest first", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.insertContribution({ subjectKey: "person:ann", content: "first", why: "because", source: "test", principalId: null, ts: new Date("2026-01-01T00:00:00Z") });
  await store.insertContribution({ subjectKey: "person:ann", content: "second", why: "because too", source: "test", principalId: null, ts: new Date("2026-01-02T00:00:00Z") });
  const rows = await store.contributions("person:ann", 10);
  expect(rows.map((r) => r.content)).toEqual(["second", "first"]);
  expect(rows[0]!.why).toBe("because too");
});

test("reapSuperseded deletes rows superseded past retention, keeps the rest", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const base = { subjectKey: "person:ann", about: ["person:ann"], predicate: "p", value: "v", source: "test", sourceGrade: "C3", naturalKey: null, visibility: "fleet", kind: "general", topics: ["general"], ts: new Date(), valueNum: null, unit: null, provenancePath: null };
  const oldTarget = await store.insertObservation(base);
  const oldBy = await store.insertObservation({ ...base, value: "v-old-by" });
  const recentTarget = await store.insertObservation({ ...base, value: "v-recent" });
  const recentBy = await store.insertObservation({ ...base, value: "v-recent-by" });
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  await store.supersede(oldTarget.id, oldBy.id, new Date(now.getTime() - 31 * day));
  await store.supersede(recentTarget.id, recentBy.id, new Date(now.getTime() - 29 * day));
  const n = await store.reapSuperseded(now);
  expect(n).toBe(1);
  const remaining = await handle.db.select({ id: handle.tables.observation.id }).from(handle.tables.observation);
  const ids = remaining.map((r) => r.id);
  expect(ids).not.toContain(oldTarget.id);
  expect(ids).toContain(recentTarget.id);
});

test("escalate-only visibility: an author row never becomes fleet by upsert; a fleet row does become author", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const base1 = { subjectKey: "person:ann", about: ["person:ann"], predicate: "pays-rent", value: "v1", source: "test", sourceGrade: "C3", naturalKey: "rent:1", kind: "costs", topics: ["money"], ts: new Date(), valueNum: null, unit: null, provenancePath: null };
  await store.insertObservation({ ...base1, visibility: "author" });
  await store.insertObservation({ ...base1, value: "v2", visibility: "fleet" });
  const stillAuthor = (await store.evidence("person:ann", { fleetOnly: false, limit: 10 })).find((r) => r.predicate === "pays-rent");
  expect(stillAuthor?.visibility).toBe("author");

  const base2 = { ...base1, naturalKey: "rent:2" };
  await store.insertObservation({ ...base2, visibility: "fleet" });
  await store.insertObservation({ ...base2, value: "v3", visibility: "author" });
  const becameAuthor = (await store.evidence("person:ann", { fleetOnly: false, limit: 10 })).find((r) => r.value === "v3");
  expect(becameAuthor?.visibility).toBe("author");
});

test("an upsert UNIONS about — a re-observation naming fewer subjects never narrows the row", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("group:home", "Home");
  await store.getOrCreateSubject("person:bob", "Bob");
  const base = { subjectKey: "person:ann", predicate: "pays-rent", value: "v1", source: "test", sourceGrade: "C3", naturalKey: "rent:1", visibility: "fleet", kind: "costs", topics: ["money"], ts: new Date(), valueNum: null, unit: null, provenancePath: null };
  const first = await store.insertObservation({ ...base, about: ["person:ann", "group:home"] });
  const read = async () => (await handle.db.select().from(handle.tables.observation).where(eq(handle.tables.observation.id, first.id)))[0]!;
  expect((await read()).about).toEqual(["person:ann", "group:home"]);

  await store.insertObservation({ ...base, value: "v2", about: ["person:ann"] });
  expect((await read()).about).toEqual(["person:ann", "group:home"]);

  await store.insertObservation({ ...base, value: "v3", about: ["person:ann", "person:bob"] });
  expect((await read()).about).toEqual(["person:ann", "group:home", "person:bob"]);
});

test("dirtySubjects returns every dirty subject except the ignored ones, ordered by key", async () => {
  await store.getOrCreateSubject("person:zoe", "Zoe");
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("thing:junk", "Junk");
  await store.getOrCreateSubject("person:clean", "Clean");
  await store.markDirty(["person:zoe", "person:ann", "thing:junk"]);
  await handle.db.update(handle.tables.subject).set({ attention: "ignore" }).where(eq(handle.tables.subject.key, "thing:junk"));
  expect((await store.dirtySubjects()).map((s) => s.key)).toEqual(["person:ann", "person:zoe"]);
});

test("liveRowsAbout with no keys answers empty instead of erroring", async () => {
  // Postgres cannot type an empty array literal on `&&`, so the honest empty
  // answer would arrive as a database error rather than as no rows.
  expect(await store.liveRowsAbout([], { topic: null, limit: 10 })).toEqual({ rows: [], matched: 0 });
});

test("setProfile records the path and the synth time, and clears the dirty flag", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.markDirty(["person:ann"]);
  const seen = (await store.getSubject("person:ann"))!.dirtyGen;
  const at = new Date("2026-02-03T04:05:06Z");
  await store.setProfile("person:ann", { profilePath: "subjects/person-ann.md", profileSynthAt: at, seenDirtyGen: seen });
  const s = await store.getSubject("person:ann");
  expect(s?.profilePath).toBe("subjects/person-ann.md");
  expect(s?.profileSynthAt?.toISOString()).toBe(at.toISOString());
  expect(s?.profileDirty).toBe(false);
});

test("markDirty bumps dirtyGen on the subject and on every composite listing it, and setMembers bumps it too", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("group:home", "Home");
  expect((await store.getSubject("person:ann"))?.dirtyGen).toBe(0);
  await store.setMembers("group:home", ["person:ann"]);
  expect((await store.getSubject("group:home"))?.dirtyGen).toBe(1);
  await store.markDirty(["person:ann"]);
  await store.markDirty(["person:ann"]);
  expect((await store.getSubject("person:ann"))?.dirtyGen).toBe(2);
  expect((await store.getSubject("group:home"))?.dirtyGen).toBe(3);
});

test("setProfile with a stale dirtyGen records the path but leaves the subject dirty", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.markDirty(["person:ann"]);
  const seen = (await store.getSubject("person:ann"))!.dirtyGen;
  await store.markDirty(["person:ann"]); // dirtied again after the pass read it
  const at = new Date("2026-02-03T04:05:06Z");
  await store.setProfile("person:ann", { profilePath: "subjects/person-ann.md", profileSynthAt: at, seenDirtyGen: seen });
  const s = await store.getSubject("person:ann");
  expect(s?.profilePath).toBe("subjects/person-ann.md");
  expect(s?.profileSynthAt?.toISOString()).toBe(at.toISOString());
  expect(s?.profileDirty).toBe(true);
});

test("lastWriteByAuthor is per author, and an empty store reports nobody", async () => {
  expect(await store.lastWriteByAuthor()).toEqual([]);
  await store.getOrCreateSubject("person:ann", "Ann");
  const base = { subjectKey: "person:ann", about: ["person:ann"], predicate: "p", value: "v", source: "test", sourceGrade: "C3", naturalKey: null, visibility: "fleet", kind: "has", topics: ["money"], ts: new Date(), valueNum: null, unit: null, provenancePath: null };
  await store.insertObservation(base);
  const other = createStore(handle, fakeHost({ agentId: "someone-else" }));
  await other.insertObservation({ ...base, value: "v2" });

  const rows = await store.lastWriteByAuthor();
  expect(rows.map((r) => r.author)).toEqual(["someone-else", "tester"]);
  // A max() through a raw sql template can come back as a string; the health
  // check does date arithmetic on it, so the type is load-bearing.
  for (const r of rows) expect(r.at).toBeInstanceOf(Date);
});

test("lastConsolidateAt is the newest profileSynthAt, and null before any synthesis", async () => {
  expect(await store.lastConsolidateAt()).toBeNull();
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("person:bob", "Bob");
  // Still null with subjects but no synthesis — a subject row is not a pass.
  expect(await store.lastConsolidateAt()).toBeNull();

  const older = new Date("2026-02-03T04:05:06.000Z");
  const newer = new Date("2026-03-04T05:06:07.000Z");
  await store.setProfile("person:ann", { profilePath: "a.md", profileSynthAt: newer, seenDirtyGen: 0 });
  await store.setProfile("person:bob", { profilePath: "b.md", profileSynthAt: older, seenDirtyGen: 0 });
  const at = await store.lastConsolidateAt();
  expect(at).toBeInstanceOf(Date);
  expect(at?.toISOString()).toBe(newer.toISOString());
});

test("a contribution counts as a write — an author with contributions and no observations is not silent", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.insertContribution({ subjectKey: "person:ann", content: "Ann prefers mornings", why: "she said so", source: "contribution", principalId: null, ts: new Date() });

  const rows = await store.lastWriteByAuthor();
  expect(rows.map((r) => r.author)).toEqual(["tester"]);
  expect(rows[0]!.at).toBeInstanceOf(Date);
});

test("lastWriteByAuthor takes the newest write per author across both tables", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const older = new Date("2026-01-01T00:00:00.000Z");
  const newer = new Date("2026-06-01T00:00:00.000Z");
  const { db, tables } = handle;

  // createdAt is written explicitly here: it defaults to CURRENT_TIMESTAMP, and
  // this test is entirely about which of the two tables wins on it.
  await db.insert(tables.observation).values({ authorAgent: "tester", subjectKey: "person:ann", about: ["person:ann"], predicate: "p", value: "v", source: "test", sourceGrade: "C3", ts: older, createdAt: older });
  await db.insert(tables.contribution).values({ authorAgent: "tester", subjectKey: "person:ann", content: "c", why: "w", source: "contribution", ts: newer, createdAt: newer });
  // And the mirror image, so the test fails if the merge only ever picks one side.
  await db.insert(tables.observation).values({ authorAgent: "other", subjectKey: "person:ann", about: ["person:ann"], predicate: "p", value: "v", source: "test", sourceGrade: "C3", ts: newer, createdAt: newer });
  await db.insert(tables.contribution).values({ authorAgent: "other", subjectKey: "person:ann", content: "c", why: "w", source: "contribution", ts: older, createdAt: older });

  const rows = await store.lastWriteByAuthor();
  expect(rows.map((r) => r.author)).toEqual(["other", "tester"]);
  expect(rows.map((r) => r.at?.toISOString())).toEqual([newer.toISOString(), newer.toISOString()]);
});

test("recentlyActive orders pursuits by newest evidence and skips empty ones", async () => {
  const day = 86_400_000;
  const now = Date.now();
  const o = (key: string, ts: Date) => ({ subjectKey: key, about: [key], predicate: "p", value: "v", source: "test", sourceGrade: "C3", naturalKey: null, visibility: "fleet", kind: "general", topics: ["general"], ts, valueNum: null, unit: null, provenancePath: null });
  for (const [k, l] of [["pursuit:a", "A"], ["pursuit:b", "B"], ["pursuit:c", "C"], ["person:x", "X"]] as const) await store.getOrCreateSubject(k, l);
  await store.insertObservation(o("pursuit:a", new Date(now - day)));
  await store.insertContribution({ subjectKey: "pursuit:b", content: "c", why: "w", source: "contribution", principalId: null, ts: new Date(now - 2 * 3_600_000) });
  await store.insertObservation(o("person:x", new Date(now)));
  const r = await store.recentlyActive({ type: "pursuit", limit: 5 });
  expect(r.map((x) => x.key)).toEqual(["pursuit:b", "pursuit:a"]);
  expect(r[0]!.label).toBe("B");
  expect(r[0]!.lastEvidenceAt).toBeInstanceOf(Date);
  expect((await store.recentlyActive({ type: "pursuit", limit: 1 })).map((x) => x.key)).toEqual(["pursuit:b"]);
});

test("recentlyActive counts a live row that is only ABOUT the subject, and ignores superseded rows", async () => {
  const day = 86_400_000;
  const now = Date.now();
  const o = (key: string, about: string[], ts: Date) => ({ subjectKey: key, about, predicate: "p", value: "v", source: "test", sourceGrade: "C3", naturalKey: null, visibility: "fleet", kind: "general", topics: ["general"], ts, valueNum: null, unit: null, provenancePath: null });
  for (const [k, l] of [["pursuit:a", "A"], ["pursuit:d", "D"], ["person:x", "X"]] as const) await store.getOrCreateSubject(k, l);
  await store.insertObservation(o("pursuit:a", ["pursuit:a"], new Date(now - 10 * day)));
  await store.insertObservation(o("person:x", ["person:x", "pursuit:a"], new Date(now - day)));
  const old = await store.insertObservation(o("pursuit:d", ["pursuit:d"], new Date(now - 1000)));
  const repl = await store.insertObservation(o("pursuit:d", ["pursuit:d"], new Date(now - 20 * day)));
  await store.supersede(old.id, repl.id, new Date());
  const r = await store.recentlyActive({ type: "pursuit", limit: 5 });
  expect(r.map((x) => x.key)).toEqual(["pursuit:a", "pursuit:d"]);
  expect(r[0]!.lastEvidenceAt.getTime()).toBe(now - day);
  expect(r[1]!.lastEvidenceAt.getTime()).toBe(now - 20 * day);
});

const retireObs = (value: string) => ({ subjectKey: "person:ann", about: ["person:ann"], predicate: "p", value, source: "test", sourceGrade: "C3", naturalKey: null, visibility: "fleet", kind: "general", topics: ["general"], ts: new Date(), valueNum: null, unit: null, provenancePath: null });
const person = { kind: "person" as const, id: "u1" };

test("retire hides a contribution from project, recall and contributions, and keeps the row", async () => {
  const { createProject } = await import("./project");
  const { createRecall } = await import("./recall");
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("pursuit:a", "A");
  await store.getOrCreateSubject("pursuit:b", "B");
  const keep = await store.insertContribution({ subjectKey: "person:ann", content: "keep me", why: "w", source: "contribution", principalId: null, ts: new Date() });
  const gone = await store.insertContribution({ subjectKey: "pursuit:a", about: ["pursuit:a", "pursuit:b"], content: "retire me", why: "w", source: "contribution", principalId: null, ts: new Date() });
  await store.insertContribution({ subjectKey: "person:ann", content: "retire me too", why: "w", source: "contribution", principalId: null, ts: new Date() });
  expect((await store.contributions("pursuit:b", 10)).length).toBe(1);
  expect((await store.recentlyActive({ type: "pursuit", limit: 5 })).length).toBe(2);
  await handle.db.update(handle.tables.subject).set({ profileDirty: false });

  expect(await store.retire({ id: gone.id, actor: person, reason: "wrong" })).toBe(true);

  expect(await store.contributions("pursuit:a", 10)).toEqual([]);
  expect(await store.contributions("pursuit:b", 10)).toEqual([]);
  expect(await store.recentlyActive({ type: "pursuit", limit: 5 })).toEqual([]);
  expect((await store.contributions("person:ann", 10)).map((c) => c.content).sort()).toEqual(["keep me", "retire me too"]);
  const md = await createProject(host, store).projectDossier("pursuit:a");
  expect(md ?? "").not.toContain("retire me");
  const body = (await createRecall(host, store).recall("pursuit:b", { name: "n", intro: "i" }))?.body ?? "";
  expect(body).not.toContain("retire me");

  const [row] = await handle.db.select().from(handle.tables.contribution).where(eq(handle.tables.contribution.id, gone.id));
  expect(row?.retiredAt).toBeInstanceOf(Date);
  expect(row?.retiredByKind).toBe("person");
  expect(row?.retiredById).toBe("u1");
  expect(row?.retiredReason).toBe("wrong");
  expect(keep.id).not.toBe(gone.id);
  // both subjects the note was about are dirty again
  for (const k of ["pursuit:a", "pursuit:b"]) expect((await store.getSubject(k))?.profileDirty).toBe(true);
  expect((await store.getSubject("person:ann"))?.profileDirty).toBe(false);
});

test("retire hides an observation from liveRowsAbout and evidence", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("group:home", "Home");
  const a = await store.insertObservation({ ...retireObs("gone"), about: ["person:ann", "group:home"], naturalKey: "k1" });
  await store.insertObservation(retireObs("stays"));
  await handle.db.update(handle.tables.subject).set({ profileDirty: false });

  expect(await store.retire({ id: a.id, actor: person, reason: "wrong" })).toBe(true);

  expect((await store.evidence("person:ann", { fleetOnly: false, limit: 10 })).map((r) => r.value)).toEqual(["stays"]);
  expect((await store.evidence("person:ann", { fleetOnly: true, limit: 10 })).map((r) => r.value)).toEqual(["stays"]);
  expect((await store.liveRowsAbout(["person:ann"], { topic: null, limit: 10 })).matched).toBe(1);
  expect((await store.liveRowsAbout(["group:home"], { topic: null, limit: 10 })).matched).toBe(0);
  const [row] = await handle.db.select().from(handle.tables.observation).where(eq(handle.tables.observation.id, a.id));
  expect(row?.retiredAt).toBeInstanceOf(Date);
  expect(row?.retiredById).toBe("u1");
  for (const k of ["person:ann", "group:home"]) expect((await store.getSubject(k))?.profileDirty).toBe(true);
});

test("retire returns false for an unknown or already-retired id", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const c = await store.insertContribution({ subjectKey: "person:ann", content: "x", why: "w", source: "contribution", principalId: null, ts: new Date() });
  expect(await store.retire({ id: "nope", actor: person, reason: "r" })).toBe(false);
  expect(await store.retire({ id: c.id, actor: person, reason: "first" })).toBe(true);
  await handle.db.update(handle.tables.subject).set({ profileDirty: false });
  expect(await store.retire({ id: c.id, actor: { kind: "agent", id: "a2" }, reason: "second" })).toBe(false);
  const [row] = await handle.db.select().from(handle.tables.contribution).where(eq(handle.tables.contribution.id, c.id));
  expect(row?.retiredReason).toBe("first");
  expect((await store.getSubject("person:ann"))?.profileDirty).toBe(false);
});

test("reapSuperseded does not delete retired rows", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const o = await store.insertObservation(retireObs("old"));
  const newer = await store.insertObservation(retireObs("new"));
  const long = new Date("2020-01-01T00:00:00Z");
  // superseded long ago AND retired: retirement protects it
  await store.supersede(o.id, newer.id, long);
  await handle.db.update(handle.tables.observation).set({ retiredAt: long }).where(eq(handle.tables.observation.id, o.id));
  expect(await store.reapSuperseded(new Date())).toBe(0);
  expect((await handle.db.select().from(handle.tables.observation).where(eq(handle.tables.observation.id, o.id))).length).toBe(1);
});
