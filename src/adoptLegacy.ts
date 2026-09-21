// The fleet's legacy store, copied into the library's schema. Runs ONCE, in
// one transaction, refuses to run twice, deletes nothing, and leaves the
// legacy tables where they are. This file is exempt from the no-fleet-names
// guard because it is about the fleet by nature.
//
// Three things the copy is careful about, each of which cost a bug:
//
// 1. IDS ARE CARRIED, NOT REGENERATED. `Subject.id` and `Alias.id` are cuids
//    from drizzle's `$defaultFn`, which is APP-side: a raw INSERT gets no
//    default at all and would fail the NOT NULL. So every table's insert
//    names `id` explicitly and takes the legacy one. That also means a copied
//    row can still be traced back to the row it came from, which is the whole
//    point of a rehearsal you can diff.
//
// 2. EVERY COPY IS `INSERT ... SELECT`, server-side. Nothing round-trips
//    through JS. drizzle's `db.execute(sql.raw(...))` bypasses the column
//    decoders and hands back `timestamp (3)` as a STRING, so a row loop would
//    be re-quoting timestamps it never really parsed. Copying inside the
//    database removes the question.
//
// 3. THE DUPLICATE RULE IS ONE PAIR PER FACT, NOT A CROSS JOIN. See
//    `duplicates` below.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import { openDb } from "./db";
import { memorySchemaName } from "./schema";

export type LegacyKeyMap = (oldKey: string) => string;

/** The legacy store addressed subjects by an untyped canonical key: bare
 *  names for people, one bare name each for the household and the portfolio,
 *  and an `effort:` namespace for everything being worked on. The library
 *  requires `type:slug`. */
export const DEFAULT_LEGACY_KEY_MAP: LegacyKeyMap = (k) => {
  const i = k.indexOf(":");
  if (i > 0) {
    const ns = k.slice(0, i), rest = k.slice(i + 1);
    return ns === "effort" ? `pursuit:${rest}` : `${ns}:${rest}`;
  }
  if (k === "household") return "group:household";
  if (k === "portfolio") return "composite:portfolio";
  return `person:${k}`;
};

export interface Counts {
  dossiers: number; observations: number; liveObservations: number;
  aliases: number; contributions: number; checksum: string;
}

export interface AdoptResult {
  before: Counts;
  after: Counts;
  /** Rows moved to superseded by the `duplicates` rule. */
  superseded: number;
  /** Legacy alias rows the new table's `(authorAgent, localKey)` uniqueness
   *  refused. Non-zero means two legacy grains collapsed onto one local key
   *  for one agent, and a human has to decide which one wins. */
  aliasesSkipped: number;
  keyMap: Record<string, string>;
}

const IDENT = /^[a-z][a-z0-9_]*$/;
const q = (s: string) => `"${s}"`;

/** Only the three shapes this file actually passes: a string, a string array,
 *  and null. Timestamps and numbers are never re-rendered from JS here — see
 *  the header — so there is no branch for them to rot in. */
function literal(v: string | string[] | null): string {
  if (v === null) return "NULL";
  if (Array.isArray(v)) return `ARRAY[${v.map(literal).join(",")}]::text[]`;
  return `'${v.replace(/'/g, "''")}'`;
}

export async function adoptLegacyStore(opts: {
  url: string;
  schema?: string;
  legacySchema: string;
  keyMap?: LegacyKeyMap;
  /** The one known duplicate pattern: the same (predicate, value) recorded
   *  live under both keys. ONE pair per distinct fact — the newest live row
   *  on each side — because `Observation_supersededById_key` is UNIQUE: a
   *  single survivor cannot supersede two rows, and the real store has facts
   *  with two copies on one side and one on the other. A cross join would
   *  either violate that index or double-count. Any further same-side copies
   *  are left live and untouched; collapsing duplicates WITHIN a subject is
   *  reconciliation's job, not the copy's. */
  duplicates?: { keepKey: string; dropKey: string };
}): Promise<AdoptResult> {
  const schema = opts.schema ?? memorySchemaName;
  const legacy = opts.legacySchema;
  for (const name of [schema, legacy]) if (!IDENT.test(name)) throw new Error(`schema name "${name}" is not an identifier`);
  // Same schema on both sides would make the copy read its own output: the
  // legacy and new table names differ, so nothing would collide and nothing
  // would throw — it would just quietly mean something other than a copy.
  if (schema === legacy) throw new Error(`refusing to adopt "${legacy}" into itself`);
  const map = opts.keyMap ?? DEFAULT_LEGACY_KEY_MAP;
  const handle = openDb(opts.url, schema);
  const { db } = handle;
  const L = (t: string) => `${q(legacy)}.${q(t)}`;
  const N = (t: string) => `${q(schema)}.${q(t)}`;
  /** Every read and write of the copy goes through the ONE runner the
   *  transaction hands out. Counting the result on a second pool connection
   *  would be counting a store the transaction has not committed yet — and,
   *  worse, it would put the two invariants below outside the transaction,
   *  where a failed checksum throws over an already-committed copy. That
   *  leaves a half-adopted store which `already adopted` then refuses to let
   *  anyone re-run. A one-shot migration has to be able to fail cleanly. */
  type Runner = Pick<typeof db, "execute">;

  const count = async (r: Runner, from: string) =>
    Number(((await r.execute(sql.raw(`SELECT count(*) AS n FROM ${from}`))).rows[0] as { n: string }).n);

  async function counts(r: Runner, side: "legacy" | "new"): Promise<Counts> {
    const obs = side === "legacy" ? L("MemoryObservation") : N("Observation");
    const pairs = (await r.execute(sql.raw(`SELECT predicate || ' ' || value AS p FROM ${obs} ORDER BY 1`))).rows as { p: string }[];
    return {
      dossiers: await count(r, side === "legacy" ? L("MemoryDossier") : N("Subject")),
      observations: await count(r, obs),
      liveObservations: await count(r, `${obs} WHERE "supersededById" IS NULL`),
      aliases: await count(r, side === "legacy" ? L("MemoryAlias") : N("Alias")),
      contributions: await count(r, side === "legacy" ? L("MemoryContribution") : N("Contribution")),
      checksum: createHash("sha256").update(pairs.map((r2) => r2.p).join("\n")).digest("hex"),
    };
  }

  try {
    let result: AdoptResult | undefined;
    await db.transaction(async (tx) => {
      const run = (text: string) => tx.execute(sql.raw(text));
      const before = await counts(tx, "legacy");

      // All four tables, not just Subject: a half-finished copy is still a copy,
      // and running again on top of one would double rows silently.
      for (const t of ["Subject", "Observation", "Alias", "Contribution"]) {
        const n = await count(tx, N(t));
        if (n > 0) throw new Error(`already adopted: ${N(t)} holds ${n} rows`);
      }

      const dossierKeys = ((await run(`SELECT "canonicalKey" AS k FROM ${L("MemoryDossier")}`)).rows as { k: string }[]).map((r) => r.k);
      const keyMap: Record<string, string> = {};
      for (const k of dossierKeys) keyMap[k] = map(k);
      for (const t of ["MemoryObservation", "MemoryAlias", "MemoryContribution"]) {
        const keys = (await run(`SELECT DISTINCT "canonicalKey" AS k FROM ${L(t)}`)).rows as { k: string }[];
        for (const { k } of keys) if (!(k in keyMap)) throw new Error(`${t} references canonicalKey "${k}" with no dossier`);
      }
      if (new Set(Object.values(keyMap)).size !== Object.keys(keyMap).length) throw new Error("key map is not injective");
      const mapValues = Object.entries(keyMap).map(([a, b]) => `(${literal(a)}, ${literal(b)})`).join(",");

      let superseded = 0;
      let aliasesSkipped = 0;

      await run(`INSERT INTO ${N("Subject")} (id, key, label, attention, "profileDirty", "profilePath", "profileSynthAt", "createdAt", "updatedAt")
        SELECT d.id, m.new, d.label, d.attention, d."profileDirty", d."profilePath", d."profileSynthAt", d."createdAt", d."updatedAt"
        FROM ${L("MemoryDossier")} d JOIN (VALUES ${mapValues}) AS m(old, new) ON m.old = d."canonicalKey"`);

      // A group rolls up the people. The legacy store had no membership at
      // all — the household dossier was just another key — so this is the one
      // fact the copy INVENTS, and it invents the only thing it can defend:
      // every person in the store.
      const persons = Object.values(keyMap).filter((k) => k.startsWith("person:"));
      for (const g of Object.values(keyMap).filter((k) => k.startsWith("group:"))) {
        await run(`UPDATE ${N("Subject")} SET members = ${literal(persons)} WHERE key = ${literal(g)}`);
      }

      await run(`INSERT INTO ${N("Observation")} (id, "authorAgent", "subjectKey", about, predicate, value, "valueNum", unit, ts, source, "sourceGrade", "naturalKey", "provenancePath", "createdAt", visibility, "supersededAt", "supersededById", kind, topics)
        SELECT o.id, o."authorAgent", m.new, ARRAY[m.new], o.predicate, o.value, o."valueNum", o.unit, o.ts, o.source, o."sourceGrade", o."naturalKey", o."provenancePath", o."createdAt", o.visibility, o."supersededAt", o."supersededById", o.kind, o.topics
        FROM ${L("MemoryObservation")} o JOIN (VALUES ${mapValues}) AS m(old, new) ON m.old = o."canonicalKey"`);

      // The legacy alias is unique on (authorAgent, grain, key); the new one
      // on (authorAgent, localKey). Dropping `grain` can therefore collide.
      // It does not today — the two rows have different authors — but a
      // silent DO NOTHING would hide it, so the skipped rows are counted.
      const aliasRows = await run(`INSERT INTO ${N("Alias")} (id, "authorAgent", "localKey", "subjectKey", "createdAt")
        SELECT a.id, a."authorAgent", a.key, m.new, a."createdAt"
        FROM ${L("MemoryAlias")} a JOIN (VALUES ${mapValues}) AS m(old, new) ON m.old = a."canonicalKey"
        ON CONFLICT ("authorAgent", "localKey") DO NOTHING
        RETURNING id`);
      aliasesSkipped = before.aliases - aliasRows.rows.length;

      await run(`INSERT INTO ${N("Contribution")} (id, "authorAgent", "subjectKey", "principalId", content, why, source, ts, "createdAt")
        SELECT c.id, c."authorAgent", m.new, c."principalId", c.content, c.why, c.source, c.ts, c."createdAt"
        FROM ${L("MemoryContribution")} c JOIN (VALUES ${mapValues}) AS m(old, new) ON m.old = c."canonicalKey"`);

      if (opts.duplicates) {
        const { keepKey, dropKey } = opts.duplicates;
        const keep = literal(keepKey), drop = literal(dropKey);
        // One survivor and one victim per distinct (predicate, value), chosen
        // by (ts DESC, id DESC) so the choice is reproducible rather than
        // whatever the heap hands back.
        const pairs = (await run(
          `WITH dup AS (
             SELECT predicate, value FROM ${N("Observation")}
             WHERE "subjectKey" IN (${keep}, ${drop}) AND "supersededById" IS NULL
             GROUP BY 1, 2 HAVING count(DISTINCT "subjectKey") > 1
           ),
           k AS (
             SELECT DISTINCT ON (o.predicate, o.value) o.id, o.predicate, o.value
             FROM ${N("Observation")} o JOIN dup USING (predicate, value)
             WHERE o."subjectKey" = ${keep} AND o."supersededById" IS NULL
             ORDER BY o.predicate, o.value, o.ts DESC, o.id DESC
           ),
           d AS (
             SELECT DISTINCT ON (o.predicate, o.value) o.id, o.predicate, o.value
             FROM ${N("Observation")} o JOIN dup USING (predicate, value)
             WHERE o."subjectKey" = ${drop} AND o."supersededById" IS NULL
             ORDER BY o.predicate, o.value, o.ts DESC, o.id DESC
           )
           SELECT k.id AS keep_id, d.id AS drop_id FROM k JOIN d USING (predicate, value) ORDER BY k.id`,
        )).rows as { keep_id: string; drop_id: string }[];
        for (const p of pairs) {
          await run(`UPDATE ${N("Observation")} SET "supersededById" = ${literal(p.keep_id)}, "supersededAt" = now(), "naturalKey" = NULL WHERE id = ${literal(p.drop_id)}`);
          await run(`UPDATE ${N("Observation")} SET about = about || ${literal(dropKey)}::text WHERE id = ${literal(p.keep_id)} AND NOT (about @> ARRAY[${literal(dropKey)}])`);
          superseded += 1;
        }
      }

      const after = await counts(tx, "new");
      if (after.observations !== before.observations) throw new Error(`row count changed: ${before.observations} -> ${after.observations}`);
      if (after.checksum !== before.checksum) throw new Error("checksum changed");
      result = { before, after, superseded, aliasesSkipped, keyMap };
    });

    // Unreachable unless drizzle resolves a transaction whose body threw.
    if (!result) throw new Error("adoptLegacyStore: the transaction committed without a result");
    return result;
  } finally {
    await handle.close();
  }
}
