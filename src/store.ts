import { and, arrayOverlaps, asc, desc, eq, inArray, isNull, lt, max, ne, or, sql, type SQL } from "drizzle-orm";

import { ATTENTION, KNOWN_SUBJECTS_CAP, SUPERSEDED_RETENTION_DAYS } from "./constants";
import type { Handle } from "./db";
import type { MemoryHost } from "./host";
import { assertDeclaredKey } from "./registry";
import type { Tables } from "./schema";

export interface SubjectRow {
  id: string; key: string; label: string; attention: string; members: string[];
  profileDirty: boolean; profilePath: string | null; profileSynthAt: Date | null;
}

export interface LiveRow {
  id: string; subjectKey: string; about: string[]; predicate: string; value: string;
  valueNum: number | null; unit: string | null; ts: Date; authorAgent: string; visibility: string;
  kind: string; topics: string[]; source: string; sourceGrade: string;
}

export interface ObservationData {
  subjectKey: string; about: string[]; predicate: string; value: string; valueNum: number | null; unit: string | null;
  ts: Date; source: string; sourceGrade: string; naturalKey: string | null; provenancePath: string | null;
  visibility: string; kind: string; topics: string[];
}

// Moved in from agent-shared/scoping.ts (spec §7). Scopes AGENTS, not humans:
// "fleet" = every reader; "author" = only the writer. Deny by default: a
// missing reader throws rather than reading unfiltered.
export function visibilityCondition(tables: Tables, readerAgent: string): SQL {
  if (!readerAgent) throw new Error("visibilityCondition: refusing a scoped read with no reading agent");
  const o = tables.observation;
  return or(eq(o.visibility, "fleet"), and(eq(o.visibility, "author"), eq(o.authorAgent, readerAgent)))!;
}

/** For reads whose output becomes visible to every agent (consolidation). */
export function fleetOnlyCondition(tables: Tables): SQL {
  return eq(tables.observation.visibility, "fleet");
}

export function createStore(handle: Handle, host: MemoryHost) {
  const { db, tables } = handle;
  const { subject, observation, contribution, alias } = tables;
  const liveCols = {
    id: observation.id, subjectKey: observation.subjectKey, about: observation.about, predicate: observation.predicate,
    value: observation.value, valueNum: observation.valueNum, unit: observation.unit, ts: observation.ts,
    authorAgent: observation.authorAgent, visibility: observation.visibility, kind: observation.kind,
    topics: observation.topics, source: observation.source, sourceGrade: observation.sourceGrade,
  };

  async function getSubject(key: string): Promise<SubjectRow | null> {
    const [row] = await db.select().from(subject).where(eq(subject.key, key)).limit(1);
    return row ?? null;
  }

  async function getOrCreateSubject(key: string, label: string): Promise<SubjectRow> {
    assertDeclaredKey(host.registry, key);
    await db.insert(subject).values({ key, label }).onConflictDoNothing({ target: subject.key });
    const row = await getSubject(key);
    if (!row) throw new Error(`getOrCreateSubject: no row for "${key}" after insert`);
    return row;
  }

  async function knownSubjects(): Promise<{ key: string; label: string }[]> {
    const important = await db.select({ key: subject.key, label: subject.label }).from(subject)
      .where(eq(subject.attention, ATTENTION.IMPORTANT)).orderBy(asc(subject.key));
    const recent = await db.select({ key: subject.key, label: subject.label }).from(subject)
      .where(and(ne(subject.attention, ATTENTION.IGNORE), ne(subject.attention, ATTENTION.IMPORTANT)))
      .orderBy(desc(subject.updatedAt), asc(subject.key)).limit(KNOWN_SUBJECTS_CAP);
    return [...important, ...recent];
  }

  async function findSubjectByLabel(type: string, label: string): Promise<SubjectRow | null> {
    const [row] = await db.select().from(subject)
      .where(and(sql`${subject.key} LIKE ${type + ":%"}`, eq(sql`lower(${subject.label})`, label.toLowerCase())))
      .orderBy(asc(subject.key)).limit(1);
    return row ?? null;
  }

  /** Changing the membership changes what the composite's dossier is ABOUT,
   *  so it is dirtied in the same statement — otherwise a newly added member
   *  would not appear in the roll-up until some unrelated write to that
   *  member happened to dirty it. */
  async function setMembers(key: string, members: string[]): Promise<void> {
    for (const m of members) assertDeclaredKey(host.registry, m);
    const r = await db.update(subject).set({ members, profileDirty: true }).where(eq(subject.key, key)).returning({ id: subject.id });
    if (r.length === 0) throw new Error(`setMembers: no subject "${key}"`);
  }

  async function markDirty(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await db.update(subject).set({ profileDirty: true }).where(inArray(subject.key, keys));
    // A member's write dirties every composite that lists it.
    await db.update(subject).set({ profileDirty: true }).where(arrayOverlaps(subject.members, keys));
  }

  /** Every subject a consolidation pass should look at: dirty, and not
   *  ignored. `ne(attention, IGNORE)` is safe only because the column is NOT
   *  NULL — on a nullable one SQL's <> drops the NULL rows and the pass would
   *  silently skip them. Ordered by key so a pass is reproducible.
   *
   *  A read, not a claim of work: the caller decides what clears the flag. */
  async function dirtySubjects(): Promise<SubjectRow[]> {
    return db.select().from(subject)
      .where(and(eq(subject.profileDirty, true), ne(subject.attention, ATTENTION.IGNORE)))
      .orderBy(asc(subject.key));
  }

  /** Records where a dossier landed and when — and clears the dirty flag in
   *  the SAME statement, so a subject can never be left reading as
   *  synthesized-and-still-dirty (which would re-synthesize it forever) or
   *  clean-with-no-path. */
  async function setProfile(key: string, opts: { profilePath: string; profileSynthAt: Date }): Promise<void> {
    await db.update(subject)
      .set({ profilePath: opts.profilePath, profileSynthAt: opts.profileSynthAt, profileDirty: false })
      .where(eq(subject.key, key));
  }

  async function resolveLocalKey(localKey: string): Promise<string> {
    const [row] = await db.select({ subjectKey: alias.subjectKey }).from(alias)
      .where(and(eq(alias.authorAgent, host.agentId), eq(alias.localKey, localKey))).limit(1);
    return row?.subjectKey ?? localKey;
  }

  async function putAlias(localKey: string, key: string): Promise<void> {
    assertDeclaredKey(host.registry, key);
    await db.insert(alias).values({ authorAgent: host.agentId, localKey, subjectKey: key })
      .onConflictDoUpdate({ target: [alias.authorAgent, alias.localKey], set: { subjectKey: key } });
  }

  async function liveRowsAbout(keys: string[], opts: { topic: string | null; limit: number }): Promise<{ rows: LiveRow[]; matched: number }> {
    // No keys means no rows, and it has to be answered HERE: Postgres rejects
    // an empty array literal on `&&` ("cannot determine type of empty array"),
    // so the honest empty answer would otherwise arrive as a database error.
    if (keys.length === 0) return { rows: [], matched: 0 };
    const where = and(
      arrayOverlaps(observation.about, keys),
      isNull(observation.supersededById),
      visibilityCondition(tables, host.agentId),
      ...(opts.topic === null ? [] : [arrayOverlaps(observation.topics, [opts.topic])]),
    );
    const [rows, matched] = await Promise.all([
      db.select(liveCols).from(observation).where(where).orderBy(desc(observation.ts), desc(observation.id)).limit(opts.limit),
      db.$count(observation, where),
    ]);
    return { rows, matched };
  }

  async function evidence(key: string, opts: { fleetOnly: boolean; limit: number }): Promise<LiveRow[]> {
    return db.select(liveCols).from(observation)
      .where(and(arrayOverlaps(observation.about, [key]), isNull(observation.supersededById),
        opts.fleetOnly ? fleetOnlyCondition(tables) : visibilityCondition(tables, host.agentId)))
      .orderBy(desc(observation.ts), desc(observation.id)).limit(opts.limit);
  }

  /** The subject whose dossier already claims this relative path, if any.
   *  Two different keys can slug to the same file name (the slug is capped at
   *  48 characters), and the second write would silently overwrite the first
   *  subject's dossier. */
  async function subjectByProfilePath(path: string): Promise<SubjectRow | null> {
    const [row] = await db.select().from(subject).where(eq(subject.profilePath, path)).limit(1);
    return row ?? null;
  }

  async function contributions(key: string, limit: number) {
    return db.select({ authorAgent: contribution.authorAgent, content: contribution.content, why: contribution.why, ts: contribution.ts })
      .from(contribution).where(eq(contribution.subjectKey, key)).orderBy(desc(contribution.ts)).limit(limit);
  }

  /** Writes one observation, upserting when the caller supplied a natural key.
   *
   *  Returns the row's `about` as it stands AFTER the write, not as it was
   *  proposed. The two differ whenever the upsert lands on an existing row,
   *  and the caller needs the stored list to know whose dossier just went
   *  stale.
   *
   *  THE UNION IS ONE-DIRECTIONAL. A subject that is once attached to a
   *  naturalKey-bearing row is never removed from it by re-observation: the
   *  conflict clause only ever appends keys the proposed row adds. Narrowing
   *  `about` would silently withdraw evidence from a dossier with no
   *  supersession and no audit trail. The only thing that ever takes a fact
   *  out of a subject's dossier is `supersede`, which retires the whole row
   *  and leaves a chain behind. */
  async function insertObservation(data: ObservationData): Promise<{ id: string; about: string[] }> {
    const values = { ...data, authorAgent: host.agentId };
    if (data.naturalKey) {
      const [row] = await db.insert(observation).values(values)
        .onConflictDoUpdate({
          target: [observation.authorAgent, observation.subjectKey, observation.naturalKey],
          set: {
            // UNION, never assignment. A re-observation that names FEWER
            // subjects than the row already carries must not narrow it: the
            // row is evidence for every subject in `about`, and dropping one
            // silently removes that evidence from a subject's dossier with no
            // supersession and no audit trail. Existing order is preserved
            // (the CHECK requires about[1] = subjectKey, and the conflict
            // target fixes subjectKey, so the first element must stay first);
            // genuinely new keys are appended. EXCLUDED is the proposed row.
            about: sql`${observation.about} || ARRAY(SELECT unnest(EXCLUDED."about") EXCEPT SELECT unnest(${observation.about}))`,
            predicate: data.predicate, value: data.value, valueNum: data.valueNum, unit: data.unit,
            kind: data.kind, topics: data.topics, ts: data.ts, source: data.source, sourceGrade: data.sourceGrade,
            provenancePath: data.provenancePath,
            // escalate-only: an author row never becomes fleet by upsert; a fleet row does become author
            ...(data.visibility === "author" ? { visibility: "author" } : {}),
          },
        }).returning({ id: observation.id, about: observation.about });
      return row!;
    }
    const [row] = await db.insert(observation).values(values).returning({ id: observation.id, about: observation.about });
    return row!;
  }

  async function supersede(targetId: string, byId: string, at: Date): Promise<boolean> {
    // The tombstone releases its natural key (NULLS DISTINCT) so a later
    // re-derived key cannot land on it.
    const r = await db.update(observation).set({ supersededById: byId, supersededAt: at, naturalKey: null })
      .where(and(eq(observation.id, targetId), eq(observation.authorAgent, host.agentId), isNull(observation.supersededById)))
      .returning({ id: observation.id });
    return r.length > 0;
  }

  async function insertContribution(data: { subjectKey: string; content: string; why: string; source: string; principalId: string | null; ts: Date }): Promise<void> {
    await db.insert(contribution).values({ ...data, authorAgent: host.agentId });
  }

  /** The two reads health() is built on.
   *
   *  WHAT IT MEASURES: for each author, the most recent moment that author put
   *  anything into this store — the newer of its last Observation and its last
   *  Contribution. BOTH tables, because `contribute` is on the public surface
   *  and a host may legitimately write only contributions; reading Observation
   *  alone reported such a host as `never_written` forever, which is an alarm
   *  that fires on correct behaviour and therefore teaches its reader to
   *  ignore it. Anything else a host writes (subjects, aliases) is
   *  bookkeeping, not memory, and deliberately does not count.
   *
   *  Per AUTHOR, not a single store-wide maximum: one busy writer masks a
   *  silent one, and "nobody has written" and "this author stopped writing"
   *  are different failures. Superseded rows count — they are still writes,
   *  and excluding them would make a heavily-reconciled store look idle.
   *
   *  `createdAt`, not `ts`: this asks when the store was last WRITTEN TO, and
   *  `ts` is the row's own time, which a caller may backdate. A backfill of
   *  last year's facts is a write today.
   *
   *  Two grouped queries merged in JS, rather than one UNION ALL wrapped in an
   *  outer max(). The merge is trivial and the alternative is not free: an
   *  aggregate over a subquery has to be written as a raw sql template, and a
   *  raw template bypasses the column's decoder — measured in this task, it
   *  returns a timestamp(3) as a STRING while still typing as Date, which
   *  computeHealth then does date arithmetic on. Both `max()` calls below are
   *  drizzle's, so both are decoded by the column they came from. */
  async function lastWriteByAuthor(): Promise<{ author: string; at: Date | null }[]> {
    const [fromObservations, fromContributions] = await Promise.all([
      db.select({ author: observation.authorAgent, at: max(observation.createdAt) })
        .from(observation).groupBy(observation.authorAgent),
      db.select({ author: contribution.authorAgent, at: max(contribution.createdAt) })
        .from(contribution).groupBy(contribution.authorAgent),
    ]);

    const newest = new Map<string, Date | null>();
    for (const row of [...fromObservations, ...fromContributions]) {
      const prior = newest.get(row.author);
      // `prior === undefined` is "this author has not been seen", which is a
      // different thing from "seen, with a null date". A null must never beat
      // a real date, and a real date must never be lost to one.
      if (prior === undefined || (row.at !== null && (prior === null || row.at > prior))) {
        newest.set(row.author, row.at);
      }
    }
    // Sorted by author so a health report is reproducible run to run.
    return [...newest.entries()]
      .map(([author, at]) => ({ author, at }))
      .sort((a, b) => (a.author < b.author ? -1 : a.author > b.author ? 1 : 0));
  }

  /** Null when no subject has ever been synthesized — which computeHealth
   *  reports as `never_consolidated`, not as "fine". */
  async function lastConsolidateAt(): Promise<Date | null> {
    const [row] = await db.select({ at: max(subject.profileSynthAt) }).from(subject);
    return row?.at ?? null;
  }

  async function reapSuperseded(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - SUPERSEDED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const r = await db.delete(observation)
      .where(and(sql`${observation.supersededById} IS NOT NULL`, lt(observation.supersededAt, cutoff)))
      .returning({ id: observation.id });
    return r.length;
  }

  return {
    getSubject, getOrCreateSubject, knownSubjects, findSubjectByLabel, setMembers, markDirty,
    dirtySubjects, setProfile, subjectByProfilePath,
    resolveLocalKey, putAlias, liveRowsAbout, evidence, contributions, insertObservation, supersede,
    insertContribution, reapSuperseded, lastWriteByAuthor, lastConsolidateAt,
  };
}

export type Store = ReturnType<typeof createStore>;
