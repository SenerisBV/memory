// The adoption copy, exercised against a SYNTHETIC legacy store built in a
// scratch schema of memory_test. The real store is only ever read through a
// dump (scripts/rehearse-adoption.sh); nothing here touches it.
//
// The legacy DDL below is copied from the host schema being adopted:
// 0000_vengeful_ink.sql, qualified into "legacy_test". It is deliberately a
// COPY rather than an import: the point of the test is that adoptLegacy.ts
// reads the shape the fleet actually has, so the shape has to be stated here
// independently. If agent-shared ever changes it, this file has to be
// re-copied by hand — which is the moment to notice.
import { beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { handle, resetDb, TEST_URL } from "../tests/setup";
import { fakeHost } from "../tests/fakes";
import { adoptLegacyStore, DEFAULT_LEGACY_KEY_MAP } from "./adoptLegacy";
import { createStore } from "./store";

const LEGACY = "legacy_test";

const DDL = `
CREATE TABLE "${LEGACY}"."MemoryAlias" (
	"id" text PRIMARY KEY NOT NULL,
	"authorAgent" text NOT NULL,
	"grain" text NOT NULL,
	"key" text NOT NULL,
	"canonicalKey" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
CREATE TABLE "${LEGACY}"."MemoryContribution" (
	"id" text PRIMARY KEY NOT NULL,
	"authorAgent" text NOT NULL,
	"grain" text NOT NULL,
	"key" text NOT NULL,
	"canonicalKey" text NOT NULL,
	"principalId" text,
	"content" text NOT NULL,
	"why" text NOT NULL,
	"source" text DEFAULT 'founder' NOT NULL,
	"ts" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE "${LEGACY}"."MemoryDossier" (
	"id" text PRIMARY KEY NOT NULL,
	"canonicalKey" text NOT NULL,
	"label" text NOT NULL,
	"attention" text DEFAULT 'track' NOT NULL,
	"profileDirty" boolean DEFAULT false NOT NULL,
	"profilePath" text,
	"profileSynthAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
CREATE TABLE "${LEGACY}"."MemoryObservation" (
	"id" text PRIMARY KEY NOT NULL,
	"authorAgent" text NOT NULL,
	"grain" text NOT NULL,
	"key" text NOT NULL,
	"canonicalKey" text NOT NULL,
	"subject" text NOT NULL,
	"predicate" text NOT NULL,
	"value" text NOT NULL,
	"valueNum" double precision,
	"unit" text,
	"ts" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"source" text NOT NULL,
	"sourceGrade" text DEFAULT 'F6' NOT NULL,
	"naturalKey" text,
	"provenancePath" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"visibility" text DEFAULT 'fleet' NOT NULL,
	"supersededAt" timestamp (3),
	"supersededById" text,
	"kind" text DEFAULT 'general' NOT NULL,
	"topics" text[] DEFAULT ARRAY['general'::text] NOT NULL
);
CREATE UNIQUE INDEX "MemoryAlias_authorAgent_grain_key_key" ON "${LEGACY}"."MemoryAlias" USING btree ("authorAgent","grain","key");
CREATE INDEX "MemoryAlias_canonicalKey_idx" ON "${LEGACY}"."MemoryAlias" USING btree ("canonicalKey");
CREATE INDEX "MemoryContribution_canonicalKey_ts_idx" ON "${LEGACY}"."MemoryContribution" USING btree ("canonicalKey","ts");
CREATE UNIQUE INDEX "MemoryDossier_canonicalKey_key" ON "${LEGACY}"."MemoryDossier" USING btree ("canonicalKey");
CREATE INDEX "MemoryDossier_attention_idx" ON "${LEGACY}"."MemoryDossier" USING btree ("attention");
CREATE UNIQUE INDEX "MemoryObservation_authorAgent_canonicalKey_naturalKey_key" ON "${LEGACY}"."MemoryObservation" USING btree ("authorAgent","canonicalKey","naturalKey");
CREATE INDEX "MemoryObservation_canonicalKey_predicate_ts_idx" ON "${LEGACY}"."MemoryObservation" USING btree ("canonicalKey","predicate","ts");
CREATE INDEX "MemoryObservation_canonicalKey_ts_idx" ON "${LEGACY}"."MemoryObservation" USING btree ("canonicalKey","ts");
CREATE INDEX "MemoryObservation_canonicalKey_visibility_idx" ON "${LEGACY}"."MemoryObservation" USING btree ("canonicalKey","visibility");
CREATE UNIQUE INDEX "MemoryObservation_supersededById_key" ON "${LEGACY}"."MemoryObservation" USING btree ("supersededById");
CREATE INDEX "MemoryObservation_topics_idx" ON "${LEGACY}"."MemoryObservation" USING gin ("topics");
`;

const D = (id: string, key: string, label: string) =>
  `('${id}', '${key}', '${label}', 'track', false, NULL, NULL, '2026-07-01 09:00:00', '2026-07-01 09:00:00')`;

/** grain/key are the legacy addressing pair; canonicalKey is what adoption maps. */
const O = (id: string, canonicalKey: string, grain: string, key: string, subject: string, predicate: string, value: string, ts: string) =>
  `('${id}', 'scribe', '${grain}', '${key}', '${canonicalKey}', '${subject}', '${predicate}', '${value}', NULL, NULL, '${ts}', 'chat', 'C3', NULL, NULL, '${ts}', 'fleet', NULL, NULL, 'general', ARRAY['general'::text])`;

async function seedLegacy(): Promise<void> {
  const { db } = handle;
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${LEGACY}" CASCADE`));
  await db.execute(sql.raw(`CREATE SCHEMA "${LEGACY}"`));
  for (const statement of DDL.split(";")) {
    const s = statement.trim();
    if (s) await db.execute(sql.raw(s));
  }
  await db.execute(sql.raw(
    `INSERT INTO "${LEGACY}"."MemoryDossier" ("id","canonicalKey","label","attention","profileDirty","profilePath","profileSynthAt","createdAt","updatedAt") VALUES ` +
      [D("d1", "alex", "Alex"), D("d2", "robin", "Robin"), D("d3", "household", "Household"),
       D("d4", "effort:ants", "ants"), D("d5", "portfolio", "Portfolio")].join(","),
  ));
  await db.execute(sql.raw(
    `INSERT INTO "${LEGACY}"."MemoryObservation" ("id","authorAgent","grain","key","canonicalKey","subject","predicate","value","valueNum","unit","ts","source","sourceGrade","naturalKey","provenancePath","createdAt","visibility","supersededAt","supersededById","kind","topics") VALUES ` +
      [
        O("o1", "household", "household", "household", "Household", "pays", "rent on the 1st", "2026-07-02 10:00:00"),
        O("o2", "household", "household", "household", "Household", "heats-with", "a heat pump", "2026-07-03 10:00:00"),
        O("o3", "household", "household", "household", "Household", "eats", "dinner at seven", "2026-07-04 10:00:00"),
        O("o4", "alex", "principal", "alex", "Alex", "rides", "a cargo bike", "2026-07-05 10:00:00"),
        O("o5", "alex", "principal", "alex", "Alex", "reads", "at night", "2026-07-06 10:00:00"),
        // The one duplicate pair: the same fact recorded under both keys.
        O("o6", "household", "household", "household", "Household", "owns", "espresso machine", "2026-07-07 10:00:00"),
        O("o7", "alex", "principal", "alex", "Alex", "owns", "espresso machine", "2026-07-07 11:00:00"),
      ].join(","),
  ));
  await db.execute(sql.raw(
    `INSERT INTO "${LEGACY}"."MemoryAlias" ("id","authorAgent","grain","key","canonicalKey","createdAt","updatedAt") VALUES ` +
      `('a1','scribe','principal','alex','alex','2026-07-01 09:00:00','2026-07-01 09:00:00'),` +
      `('a2','ledger','operator','alex','alex','2026-07-01 09:00:00','2026-07-01 09:00:00')`,
  ));
  await db.execute(sql.raw(
    `INSERT INTO "${LEGACY}"."MemoryContribution" ("id","authorAgent","grain","key","canonicalKey","principalId","content","why","source","ts","createdAt") VALUES ` +
      `('c1','scribe','principal','alex','alex',NULL,'Prefers the morning','he said so','founder','2026-07-08 10:00:00','2026-07-08 10:00:00')`,
  ));
}

beforeEach(async () => {
  await resetDb();
  await seedLegacy();
});

const store = createStore(handle, fakeHost({ agentId: "scribe" }));

test("the default key map types every legacy key shape", () => {
  expect(DEFAULT_LEGACY_KEY_MAP("alex")).toBe("person:alex");
  expect(DEFAULT_LEGACY_KEY_MAP("effort:ants")).toBe("pursuit:ants");
  expect(DEFAULT_LEGACY_KEY_MAP("household")).toBe("group:household");
  expect(DEFAULT_LEGACY_KEY_MAP("portfolio")).toBe("composite:portfolio");
});

test("the legacy store is copied whole: nothing deleted, one duplicate superseded", async () => {
  const r = await adoptLegacyStore({
    url: TEST_URL, legacySchema: LEGACY,
    duplicates: { keepKey: "person:alex", dropKey: "group:household" },
  });

  expect(r.after.dossiers).toBe(5);
  expect((await store.getSubject("person:alex"))?.label).toBe("Alex");
  expect(await store.getSubject("pursuit:ants")).not.toBeNull();
  expect(await store.getSubject("composite:portfolio")).not.toBeNull();
  expect((await store.getSubject("group:household"))?.members.sort()).toEqual(["person:alex", "person:robin"]);

  expect(r.after.observations).toBe(r.before.observations);        // nothing deleted
  expect(r.superseded).toBe(1);                                    // the household copy of the duplicate
  expect(r.after.liveObservations).toBe(r.before.liveObservations - 1);
  expect(r.after.checksum).toBe(r.before.checksum);                // (predicate,value) multiset over ALL rows, superseded included

  const survivor = (await store.evidence("person:alex", { fleetOnly: true, limit: 50 })).find((x) => x.predicate === "owns")!;
  expect(survivor.about).toEqual(["person:alex", "group:household"]);

  expect(await store.resolveLocalKey("alex")).toBe("person:alex");      // as scribe
  expect((await store.contributions("person:alex", 10)).length).toBe(1);

  await expect(adoptLegacyStore({ url: TEST_URL, legacySchema: LEGACY })).rejects.toThrow(/already adopted/);
});

test("adopting a schema into itself is refused before anything is read", async () => {
  // Nothing would collide — the legacy and new table names differ — so this
  // would run to completion and mean something other than a copy.
  await expect(adoptLegacyStore({ url: TEST_URL, schema: LEGACY, legacySchema: LEGACY })).rejects.toThrow(/into itself/);
});

test("the copy keeps the legacy ids, so a row can still be traced to its origin", async () => {
  await adoptLegacyStore({ url: TEST_URL, legacySchema: LEGACY });
  const { db } = handle;
  const subjectIds = ((await db.execute(sql.raw(`SELECT id FROM "memory"."Subject" ORDER BY id`))).rows as { id: string }[]).map((r) => r.id);
  expect(subjectIds).toEqual(["d1", "d2", "d3", "d4", "d5"]);
  const aliasIds = ((await db.execute(sql.raw(`SELECT id FROM "memory"."Alias" ORDER BY id`))).rows as { id: string }[]).map((r) => r.id);
  expect(aliasIds).toEqual(["a1", "a2"]);
});

test("an observation whose canonicalKey has no dossier refuses the whole copy", async () => {
  const { db } = handle;
  await db.execute(sql.raw(
    `INSERT INTO "${LEGACY}"."MemoryObservation" ("id","authorAgent","grain","key","canonicalKey","subject","predicate","value","valueNum","unit","ts","source","sourceGrade","naturalKey","provenancePath","createdAt","visibility","supersededAt","supersededById","kind","topics") VALUES ` +
      O("o9", "orphan-key", "effort", "orphan-key", "Orphan", "needs", "a dossier", "2026-07-09 10:00:00"),
  ));
  await expect(adoptLegacyStore({ url: TEST_URL, legacySchema: LEGACY })).rejects.toThrow(/no dossier/);
  const [row] = (await db.execute(sql.raw(`SELECT count(*) AS n FROM "memory"."Subject"`))).rows as { n: string }[];
  expect(Number(row!.n)).toBe(0);
});
