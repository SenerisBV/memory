import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { handle, resetDb } from "../tests/setup";
import { fakeComplete, fakeHost } from "../tests/fakes";
import { createConsolidate, type SynthFn } from "./consolidate";
import { DEFAULT_REGISTRY } from "./registry";
import { subjectFile } from "./keys";
import { createStore } from "./store";

beforeEach(resetDb);

const obs = (subjectKey: string, about: string[], predicate: string, value: string) => ({
  subjectKey, about, predicate, value, valueNum: null, unit: null, ts: new Date(), source: "test", sourceGrade: "C3",
  naturalKey: null, provenancePath: null, visibility: "fleet", kind: "general", topics: ["general"],
});

test("only the synthesizer may consolidate", async () => {
  const host = fakeHost({ agentId: "reader", synthesizer: "archivist" });
  await expect(createConsolidate(host, createStore(handle, host)).consolidate()).rejects.toThrow(/single-synthesizer/);
});

test("a dirty subject above the threshold is synthesized to a file under dossierRoot and marked clean", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  for (const [p, v] of [["owns", "a bike"], ["pays-rent", "1540"], ["plans", "a trip"]]) await store.insertObservation(obs("person:ann", ["person:ann"], p!, v!));
  await store.markDirty(["person:ann"]);
  const { fn, calls } = fakeComplete(["## Model\n\nAnn owns a bike and pays 1540.\n\n## Where this is heading\n\n- A trip. [evidence: plans:a trip]\n- Ungrounded guess.\n"]);
  const r = await createConsolidate(host, store).consolidate({ synth: fn });
  expect(r.synthesized.map((s) => s.key)).toEqual(["person:ann"]);
  expect(calls[0]!.messages[0]!.content).toContain("owns: a bike");
  const file = join(host.dossierRoot, "subjects", "person-ann.md");
  expect(existsSync(file)).toBe(true);
  const body = readFileSync(file, "utf8");
  expect(body).toContain("Ann owns a bike");
  expect(body).toContain("[evidence: plans:a trip]");
  expect(body).not.toContain("Ungrounded guess");
  const s = await store.getSubject("person:ann");
  expect(s?.profileDirty).toBe(false);
  expect(s?.profilePath).toBe("subjects/person-ann.md");
  expect(s?.profileSynthAt).not.toBeNull();
});

test("a write that lands while the model is synthesizing keeps the subject dirty", async () => {
  // The lost-update race: consolidate reads the evidence, waits on the model,
  // then clears the dirty flag. A record() in that window marks the subject
  // dirty again, and an unconditional clear would erase that mark: the
  // dossier would silently miss the new row until something else dirtied
  // the subject. The clear must be conditional on nothing having dirtied it
  // since the pass read it.
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  for (const [p, v] of [["owns", "a bike"], ["pays-rent", "1540"], ["plans", "a trip"]]) await store.insertObservation(obs("person:ann", ["person:ann"], p!, v!));
  await store.markDirty(["person:ann"]);
  const synth: SynthFn = async () => {
    // a concurrent record(), mid-synthesis
    await store.insertObservation(obs("person:ann", ["person:ann"], "moved-to", "the coast"));
    await store.markDirty(["person:ann"]);
    return { text: "## Model\n\nAnn owns a bike.\n" };
  };
  const r = await createConsolidate(host, store).consolidate({ synth });
  expect(r.synthesized.map((s) => s.key)).toEqual(["person:ann"]); // the dossier is still written
  const s = await store.getSubject("person:ann");
  expect(s?.profilePath).toBe("subjects/person-ann.md");
  expect(s?.profileDirty).toBe(true); // ...but the late write is not forgotten
});

test("below the threshold nothing is synthesized and the subject stays dirty", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.insertObservation(obs("person:ann", ["person:ann"], "owns", "a bike"));
  await store.markDirty(["person:ann"]);
  const { fn, calls } = fakeComplete([]);
  const r = await createConsolidate(host, store).consolidate({ synth: fn });
  expect(r.synthesized).toEqual([]);
  expect(calls.length).toBe(0);
  expect((await store.getSubject("person:ann"))?.profileDirty).toBe(true);
});

test("a composite is synthesized from its members' dossiers plus its own rows, after the members", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("person:bob", "Bob");
  await store.getOrCreateSubject("group:home", "Home");
  await store.setMembers("group:home", ["person:ann", "person:bob"]);
  for (const k of ["person:ann", "person:bob"]) for (const i of [1, 2, 3]) await store.insertObservation(obs(k, [k], `p${i}`, `v${i}`));
  await store.insertObservation(obs("group:home", ["group:home"], "pays-rent", "1540"));
  await store.markDirty(["person:ann", "person:bob"]); // dirties home too, via members
  expect((await store.getSubject("group:home"))?.profileDirty).toBe(true);
  const { fn, calls } = fakeComplete([
    "## Model\n\nAnn.\n", "## Model\n\nBob.\n",
    "## Across the set\n\nAnn and Bob share the rent.\n\n## Where this is heading\n\n- More. [evidence: pays-rent:1540]\n",
  ]);
  const r = await createConsolidate(host, store).consolidate({ synth: fn, minObs: 1 });
  expect(r.synthesized.map((s) => s.key)).toEqual(["person:ann", "person:bob", "group:home"]);
  const compositePrompt = calls[2]!.messages[0]!.content;
  expect(compositePrompt).toContain("### Ann");
  expect(compositePrompt).toContain("Bob.");
  expect(compositePrompt).toContain("pays-rent: 1540");
  expect(readFileSync(join(host.dossierRoot, "subjects", "group-home.md"), "utf8")).toContain("share the rent");
});

test("superseded rows older than the retention window are reaped, newer ones kept", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  const a = await store.insertObservation(obs("person:ann", ["person:ann"], "p", "old"));
  const b = await store.insertObservation(obs("person:ann", ["person:ann"], "p", "new"));
  await store.supersede(a.id, b.id, new Date(Date.now() - 40 * 86_400_000));
  const c = await store.insertObservation(obs("person:ann", ["person:ann"], "q", "old"));
  const d = await store.insertObservation(obs("person:ann", ["person:ann"], "q", "new"));
  await store.supersede(c.id, d.id, new Date());
  const r = await createConsolidate(host, store).consolidate({ synth: fakeComplete([]).fn });
  expect(r.reaped).toBe(1);
  expect((await handle.db.select().from(handle.tables.observation)).length).toBe(3);
});

test("consolidate keeps superseded rows forever when supersededRetentionDays is null", async () => {
  const host = fakeHost({ supersededRetentionDays: null });
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  const a = await store.insertObservation(obs("person:ann", ["person:ann"], "p", "old"));
  const b = await store.insertObservation(obs("person:ann", ["person:ann"], "p", "new"));
  await store.supersede(a.id, b.id, new Date(Date.now() - 400 * 86_400_000));
  const r = await createConsolidate(host, store).consolidate({ synth: fakeComplete([]).fn });
  expect(r.reaped).toBe(0);
  expect((await handle.db.select().from(handle.tables.observation)).length).toBe(2);
});

test("a numeric supersededRetentionDays replaces the 30-day default", async () => {
  const host = fakeHost({ supersededRetentionDays: 500 });
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  const a = await store.insertObservation(obs("person:ann", ["person:ann"], "p", "old"));
  const b = await store.insertObservation(obs("person:ann", ["person:ann"], "p", "new"));
  await store.supersede(a.id, b.id, new Date(Date.now() - 400 * 86_400_000));
  const r = await createConsolidate(host, store).consolidate({ synth: fakeComplete([]).fn });
  expect(r.reaped).toBe(0);
  expect((await handle.db.select().from(handle.tables.observation)).length).toBe(2);
});

// Beyond the brief's five: archiveAnticipations only runs on a RE-synthesis,
// so none of the tests above reaches it. Without this one the whole
// archive-the-prior-forecast path is unexercised.
test("a re-synthesis archives the prior anticipation section under a dated heading", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  for (const [p, v] of [["owns", "a bike"], ["pays-rent", "1540"], ["plans", "a trip"]]) await store.insertObservation(obs("person:ann", ["person:ann"], p!, v!));
  const c = createConsolidate(host, store);
  const archive = join(host.dossierRoot, "subjects", "person-ann.anticipations.md");
  const now = new Date("2026-02-03T04:05:06Z"); // the pass's clock, not the wall clock

  await store.markDirty(["person:ann"]);
  await c.consolidate({ now, synth: fakeComplete(["## Model\n\nAnn.\n\n## Where this is heading\n\n- A trip. [evidence: plans:a trip]\n"]).fn });
  expect(existsSync(archive)).toBe(false); // first pass: no prior forecast to keep

  await store.markDirty(["person:ann"]);
  await c.consolidate({ now, synth: fakeComplete(["## Model\n\nAnn again.\n\n## Where this is heading\n\n- A longer trip. [evidence: plans:a trip]\n"]).fn });
  const body = readFileSync(archive, "utf8");
  expect(body).toContain("## 2026-02-03");
  expect(body).toContain("- A trip. [evidence: plans:a trip]");
  expect(body).not.toContain("A longer trip"); // the archive holds the OLD forecast, not the new one
});

test("a dossier that cannot be read is logged as an ERROR, not mistaken for a first synthesis", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  for (const [p, v] of [["owns", "a bike"], ["pays-rent", "1540"], ["plans", "a trip"]]) await store.insertObservation(obs("person:ann", ["person:ann"], p!, v!));
  await store.setProfile("person:ann", { profilePath: "subjects/nope.md", profileSynthAt: new Date(), seenDirtyGen: 0 }); // a path with no file behind it
  await store.markDirty(["person:ann"]);
  const r = await createConsolidate(host, store).consolidate({ synth: fakeComplete(["## Model\n\nAnn.\n"]).fn });
  const errs = host.events.filter((e) => e.kind === "ERROR" && e.message.includes("dossier read failed"));
  expect(errs.length).toBe(1);
  expect(errs[0]!.payload).toMatchObject({ key: "person:ann", profilePath: "subjects/nope.md" });
  expect(r.synthesized.map((s) => s.key)).toEqual(["person:ann"]); // and the pass still finishes
});

test("two keys whose slugs collide do not overwrite each other's dossier", async () => {
  // `subjectFile` slugs the key and `slugifyEntity` caps at 48 characters, so
  // two DISTINCT subjects can name the same file. Left undetected the second
  // synthesis silently overwrites the first subject's dossier and then claims
  // the path as its own — both keys read as synthesized, one dossier exists,
  // and it describes the wrong subject.
  const host = fakeHost();
  const store = createStore(handle, host);
  const base = `pursuit:${"a".repeat(40)}`;
  const k1 = `${base}-one`;
  const k2 = `${base}-two`;
  expect(subjectFile(k1)).toBe(subjectFile(k2)); // the premise, asserted not assumed
  await store.getOrCreateSubject(k1, "One");
  await store.getOrCreateSubject(k2, "Two");
  for (const k of [k1, k2]) for (const i of [1, 2, 3]) await store.insertObservation(obs(k, [k], `p${i}`, `v${i}`));
  await store.markDirty([k1, k2]);

  // TWO answers queued on purpose: without the collision check the second
  // subject synthesizes happily and its dossier lands on the first one's file.
  const { fn, calls } = fakeComplete(["## Model\n\nOne.\n", "## Model\n\nTwo.\n"]);
  const r = await createConsolidate(host, store).consolidate({ synth: fn });

  expect(r.synthesized.map((s) => s.key)).toEqual([k1]);
  expect(calls.length).toBe(1); // the clashing subject is refused before the model is called
  const errs = host.events.filter((e) => e.kind === "ERROR" && e.message.includes("dossier path collision"));
  expect(errs.length).toBe(1);
  expect(errs[0]!.payload).toMatchObject({ key: k2, existingKey: k1, path: subjectFile(k2) });
  expect((await store.getSubject(k2))?.profileDirty).toBe(true); // left dirty, nothing written
  expect((await store.getSubject(k2))?.profilePath).toBeNull();
  expect(readFileSync(join(host.dossierRoot, subjectFile(k1)), "utf8")).toContain("One.");
});

describe("privateSubjectTypes", () => {
  const registry = { ...DEFAULT_REGISTRY, subjectTypes: [...DEFAULT_REGISTRY.subjectTypes,
    { name: "carrier", gloss: "a payer", mintedBy: "host" as const, composite: false },
    { name: "practice", gloss: "a practice", mintedBy: "host" as const, composite: false }] };
  const setup = async (over: { privateSubjectTypes?: string[] }) => {
    const host = fakeHost({ registry, ...over });
    const store = createStore(handle, host);
    await store.getOrCreateSubject("carrier:x", "X");
    await store.getOrCreateSubject("practice:a", "A");
    const c = (about: string[], content: string) => store.insertContribution({ subjectKey: about[0]!, about, content, why: "w", source: "contribution", principalId: null, ts: new Date() });
    await c(["carrier:x"], "shared note");
    await c(["carrier:x", "practice:a"], "practice-private note");
    await store.markDirty(["carrier:x", "practice:a"]);
    return { host, store };
  };
  const prompt = async (key: string, over: { privateSubjectTypes?: string[] }) => {
    const { host, store } = await setup(over);
    const { fn, calls } = fakeComplete(["## Model\n\nok\n", "## Model\n\nok\n"]);
    await createConsolidate(host, store).consolidate({ synth: fn, minObs: 1 });
    return calls.map((x) => x.messages[0]!.content).find((m) => m.startsWith(`Subject: ${key === "carrier:x" ? "X" : "A"}\n`))!;
  };

  test("consolidating carrier:x skips a note that is also about practice:a when practice is a private type", async () => {
    const p = await prompt("carrier:x", { privateSubjectTypes: ["practice"] });
    expect(p).toContain("shared note");
    expect(p).not.toContain("practice-private note");
  });
  test("consolidating practice:a includes that note", async () => {
    const p = await prompt("practice:a", { privateSubjectTypes: ["practice"] });
    expect(p).toContain("practice-private note");
  });
  test("with no privateSubjectTypes, consolidation is unchanged", async () => {
    const p = await prompt("carrier:x", {});
    expect(p).toContain("shared note");
    expect(p).toContain("practice-private note");
  });
});

describe("privateSubjectTypes: observations and composites", () => {
  const registry = { ...DEFAULT_REGISTRY, subjectTypes: [...DEFAULT_REGISTRY.subjectTypes,
    { name: "carrier", gloss: "a payer", mintedBy: "host" as const, composite: false },
    { name: "practice", gloss: "a practice", mintedBy: "host" as const, composite: false }] };
  const prompt = async (key: string, over: { privateSubjectTypes?: string[] }) => {
    const host = fakeHost({ registry, ...over });
    const store = createStore(handle, host);
    await store.getOrCreateSubject("carrier:x", "X");
    await store.getOrCreateSubject("practice:a", "A");
    await store.insertObservation(obs("carrier:x", ["carrier:x"], "pays", "shared obs"));
    await store.insertObservation(obs("carrier:x", ["carrier:x", "practice:a"], "denies", "practice-private obs"));
    await store.markDirty(["carrier:x", "practice:a"]);
    const { fn, calls } = fakeComplete(["## Model\n\nok\n", "## Model\n\nok\n"]);
    await createConsolidate(host, store).consolidate({ synth: fn, minObs: 1 });
    return calls.map((x) => x.messages[0]!.content).find((m) => m.startsWith(`Subject: ${key === "carrier:x" ? "X" : "A"}\n`))!;
  };

  test("consolidating carrier:x skips an observation that is also about practice:a", async () => {
    const p = await prompt("carrier:x", { privateSubjectTypes: ["practice"] });
    expect(p).toContain("shared obs");
    expect(p).not.toContain("practice-private obs");
  });
  test("consolidating practice:a includes that observation", async () => {
    const p = await prompt("practice:a", { privateSubjectTypes: ["practice"] });
    expect(p).toContain("practice-private obs");
  });
  test("with no privateSubjectTypes, observations are unchanged", async () => {
    const p = await prompt("carrier:x", {});
    expect(p).toContain("shared obs");
    expect(p).toContain("practice-private obs");
  });
  test("a composite that is not a private type skips a member that is", async () => {
    const host = fakeHost({ registry, privateSubjectTypes: ["practice"] });
    const store = createStore(handle, host);
    await store.getOrCreateSubject("carrier:x", "X");
    await store.getOrCreateSubject("practice:a", "A");
    await store.getOrCreateSubject("group:g", "G");
    await store.setMembers("group:g", ["carrier:x", "practice:a"]);
    await store.insertObservation(obs("carrier:x", ["carrier:x"], "pays", "shared obs"));
    await store.insertObservation(obs("practice:a", ["practice:a"], "bills", "own obs"));
    await store.markDirty(["carrier:x", "practice:a", "group:g"]);
    const { fn, calls } = fakeComplete(["## Model\n\ncarrier dossier\n", "## Model\n\npractice dossier\n", "## Model\n\ngroup dossier\n"]);
    await createConsolidate(host, store).consolidate({ synth: fn, minObs: 1 });
    const g = calls.map((x) => x.messages[0]!.content).find((m) => m.startsWith("Subject: G\n"))!;
    expect(g).toContain("carrier dossier");
    expect(g).not.toContain("practice dossier");
  });
});

test("a note with an empty why has no why suffix in the synthesis prompt", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  // newest first: the empty-why note is the first line, so a newline follows it
  await store.insertContribution({ subjectKey: "person:ann", content: "no reason given", why: "", source: "contribution", principalId: null, ts: new Date(Date.now()) });
  await store.insertContribution({ subjectKey: "person:ann", content: "with a reason", why: "said so", source: "contribution", principalId: null, ts: new Date(Date.now() - 60_000) });
  await store.markDirty(["person:ann"]);
  const { fn, calls } = fakeComplete(["## Model\n\nok\n"]);
  await createConsolidate(host, store).consolidate({ synth: fn, minObs: 1 });
  const p = calls[0]!.messages[0]!.content;
  expect(p).toContain("no reason given\n");
  expect(p).toContain("with a reason — why: said so");
  expect(p.match(/why:/g)?.length).toBe(1);
});
