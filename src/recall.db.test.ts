import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { handle, resetDb } from "../tests/setup";
import { fakeHost } from "../tests/fakes";
import { createProject } from "./project";
import { createRecall } from "./recall";
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
