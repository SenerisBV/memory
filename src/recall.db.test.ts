import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { handle, resetDb } from "../tests/setup";
import { fakeHost } from "../tests/fakes";
import { createProject } from "./project";
import { createRecall } from "./recall";
import { DEFAULT_REGISTRY } from "./registry";
import { createStore } from "./store";

beforeEach(resetDb);

const obs = (subjectKey: string, predicate: string, value: string, ts: Date) => ({
  subjectKey, about: [subjectKey], predicate, value, valueNum: null, unit: null, ts, source: "test", sourceGrade: "C3",
  naturalKey: null, provenancePath: null, visibility: "fleet", kind: "general", topics: ["general"],
});

test("projection renders newest first with the subject's label, in the legacy line format", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.insertObservation(obs("person:ann", "pays-rent", "1540", new Date("2026-08-01T10:00:00Z")));
  await store.insertObservation(obs("person:ann", "owns", "a bike", new Date("2026-08-02T10:00:00Z")));
  const md = await createProject(host, store).projectDossier("person:ann");
  expect(md).toBe([
    "# Ann", "",
    "_Evidence projection — assembled from observations and contributions, newest first. Not synthesized; every line traces to a source._", "",
    "## Observations", "",
    "- **2026-08-02 10:00** _(C3)_ — Ann · owns: a bike",
    "- **2026-08-01 10:00** _(C3)_ — Ann · pays-rent: 1540",
    "",
  ].join("\n"));
  expect(await createProject(host, store).projectDossier("person:nobody")).toBeNull();
});

// The cap is the difference between RENDERING a dossier and AUDITING one. The
// adoption rehearsal diffed a 477-row subject through the default 200 and went
// blind to three of the five changes it was checking for; this parameter is
// what lets a comparison read every row. Asserted in both directions, because
// a limit that is silently ignored looks exactly like a limit set high enough
// not to bite.
test("the projection's evidence cap is a parameter", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  const project = createProject(host, store).projectDossier;
  await store.getOrCreateSubject("person:ann", "Ann");
  for (let i = 1; i <= 3; i += 1) {
    await store.insertObservation(obs("person:ann", `p${i}`, `v${i}`, new Date(`2026-08-0${i}T10:00:00Z`)));
  }
  const countLines = (md: string | null) => (md ?? "").split("\n").filter((l) => l.startsWith("- **")).length;
  expect(countLines(await project("person:ann", { limit: 2 }))).toBe(2);
  expect(countLines(await project("person:ann"))).toBe(3);
});

test("recall prefers the synthesized file, falls back to projection, honours ignore and the lens, and logs which layer answered", async () => {
  const host = fakeHost({ lens: { recallFilter: (_a, c) => c.replace("1540", "[redacted]") } });
  const store = createStore(handle, host);
  const recall = createRecall(host, store);
  await store.getOrCreateSubject("person:ann", "Ann");
  expect(await recall.recall("person:ann", { name: "n", intro: "About Ann:" })).toBeNull();
  expect(host.events.at(-1)?.payload?.outcome).toBe("empty");

  await store.insertObservation(obs("person:ann", "pays-rent", "1540", new Date("2026-08-01T10:00:00Z")));
  const projected = await recall.recall("person:ann", { name: "n", intro: "About Ann:" });
  expect(projected?.body.startsWith("About Ann:\n\n")).toBe(true);
  expect(projected?.body).toContain("[redacted]");
  expect(host.events.at(-1)?.payload?.outcome).toBe("projected");

  mkdirSync(join(host.dossierRoot, "subjects"), { recursive: true });
  writeFileSync(join(host.dossierRoot, "subjects", "person-ann.md"), "# Ann\n\n## Model\n\nPays 1540.\n");
  await handle.db.update(handle.tables.subject).set({ profilePath: "subjects/person-ann.md", profileSynthAt: new Date() });
  const synthesized = await recall.recall("person:ann", { name: "n", intro: "About Ann:" });
  expect(synthesized?.body).toBe("About Ann:\n\n## Model\n\nPays [redacted].");
  expect(host.events.at(-1)?.payload?.outcome).toBe("synthesized");

  const long = await recall.recall("person:ann", { name: "n", intro: "i", maxChars: 10 });
  expect(long?.body.endsWith(" …")).toBe(true);
  expect(host.events.at(-1)?.payload?.clipped).toBe(true);

  await handle.db.update(handle.tables.subject).set({ attention: "ignore" });
  expect(await recall.recall("person:ann", { name: "n", intro: "i" })).toBeNull();
  expect(host.events.at(-1)?.payload?.outcome).toBe("ignored");
});

describe("privateScope", () => {
  const registry = { ...DEFAULT_REGISTRY, subjectTypes: [...DEFAULT_REGISTRY.subjectTypes,
    { name: "carrier", gloss: "a payer", mintedBy: "host" as const, composite: false },
    { name: "practice", gloss: "a practice", mintedBy: "host" as const, composite: false }] };
  const setup = async (over: { privateSubjectTypes?: string[] } = { privateSubjectTypes: ["practice"] }) => {
    const host = fakeHost({ registry, ...over });
    const store = createStore(handle, host);
    for (const [k, l] of [["carrier:x", "X"], ["practice:a", "A"], ["practice:b", "B"]] as const) await store.getOrCreateSubject(k, l);
    const note = (about: string[], content: string) => store.insertContribution({ subjectKey: about[0]!, about, content, why: "w", source: "contribution", principalId: null, ts: new Date() });
    await note(["carrier:x"], "shared note");
    await note(["carrier:x", "practice:a"], "note of a");
    await note(["carrier:x", "practice:b"], "note of b");
    await store.insertObservation({ ...obs("carrier:x", "denies", "obs of a", new Date()), about: ["carrier:x", "practice:a"] });
    return { host, store, recall: createRecall(host, store).recall, project: createProject(host, store).projectDossier };
  };

  test("recall without a scope leaves out notes and observations about a private subject", async () => {
    const { recall } = await setup();
    const body = (await recall("carrier:x", { name: "n", intro: "i" }))!.body;
    expect(body).toContain("shared note");
    expect(body).not.toContain("note of a");
    expect(body).not.toContain("obs of a");
  });
  test("recall with privateScope: [practice:a] includes a's note and observation, not b's", async () => {
    const { recall } = await setup();
    const body = (await recall("carrier:x", { name: "n", intro: "i", privateScope: ["practice:a"] }))!.body;
    expect(body).toContain("note of a");
    expect(body).toContain("obs of a");
    expect(body).not.toContain("note of b");
  });
  test("project takes the same scope", async () => {
    const { project } = await setup();
    expect(await project("carrier:x")).not.toContain("note of a");
    expect(await project("carrier:x", { privateScope: ["practice:a"] })).toContain("note of a");
  });
  test("the private subject itself sees its own notes without a scope", async () => {
    const { project } = await setup();
    const md = (await project("practice:a"))!;
    expect(md).toContain("note of a");
    expect(md).toContain("obs of a");
  });
  test("listContributions with privateScope: [practice:a] includes a's note and excludes b's", async () => {
    const { store } = await setup();
    const rows = await store.listContributions({ about: ["carrier:x"], privateScope: ["practice:a"] });
    expect(rows.map((r) => r.content).sort()).toEqual(["note of a", "shared note"]);
    expect((await store.listContributions({ about: ["carrier:x"] })).map((r) => r.content)).toEqual(["shared note"]);
  });
  test("with no privateSubjectTypes, nothing is excluded", async () => {
    const { recall, store } = await setup({});
    const body = (await recall("carrier:x", { name: "n", intro: "i" }))!.body;
    for (const t of ["shared note", "note of a", "note of b", "obs of a"]) expect(body).toContain(t);
    expect((await store.listContributions({ about: ["carrier:x"] })).length).toBe(3);
  });
});

test("a note with an empty why has no why line in the projection", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.insertContribution({ subjectKey: "person:ann", content: "no reason given", why: "", source: "contribution", principalId: null, ts: new Date() });
  await store.insertContribution({ subjectKey: "person:ann", content: "with a reason", why: "said so", source: "contribution", principalId: null, ts: new Date() });
  const md = (await createProject(host, store).projectDossier("person:ann"))!;
  expect(md).toContain("why: said so");
  expect(md).not.toContain("why: \n");
  expect(md.match(/why:/g)?.length).toBe(1);
});
