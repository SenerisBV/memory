// The four tables, parameterised by schema name. The static export at the
// bottom is what drizzle-kit diffs (drizzle.config.ts points at this file and
// filters to "memory"); runtime code never imports it — it calls
// openDb(url, schemaName).tables so a host may choose another name.
//
// Column shapes are column-for-column with the fleet's legacy tables where
// the column survived, so the adoption copy is a projection, not a rewrite.
import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, pgSchema, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

export const memorySchemaName = "memory";

export function buildTables(schemaName: string) {
  const s = pgSchema(schemaName);
  const cuid = () => text("id").primaryKey().$defaultFn(createId);
  const ts3 = (name: string) => timestamp(name, { precision: 3 });

  const subject = s.table(
    "Subject",
    {
      id: cuid(),
      key: text("key").notNull(),
      label: text("label").notNull(),
      attention: text("attention").notNull().default("track"),
      members: text("members").array().notNull().default(sql`ARRAY[]::text[]`),
      profileDirty: boolean("profileDirty").notNull().default(false),
      profilePath: text("profilePath"),
      profileSynthAt: ts3("profileSynthAt"),
      createdAt: ts3("createdAt").notNull().default(sql`CURRENT_TIMESTAMP`),
      updatedAt: ts3("updatedAt").notNull().default(sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
    },
    (t) => [
      uniqueIndex("Subject_key_key").on(t.key),
      index("Subject_attention_idx").on(t.attention),
      check("Subject_key_typed_check", sql`${t.key} ~ '^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$'`),
    ],
  );

  const observation = s.table(
    "Observation",
    {
      id: cuid(),
      authorAgent: text("authorAgent").notNull(),
      subjectKey: text("subjectKey").notNull(),
      about: text("about").array().notNull(),
      predicate: text("predicate").notNull(),
      value: text("value").notNull(),
      valueNum: doublePrecision("valueNum"),
      unit: text("unit"),
      ts: ts3("ts").notNull().default(sql`CURRENT_TIMESTAMP`),
      source: text("source").notNull(),
      sourceGrade: text("sourceGrade").notNull().default("F6"),
      naturalKey: text("naturalKey"),
      provenancePath: text("provenancePath"),
      createdAt: ts3("createdAt").notNull().default(sql`CURRENT_TIMESTAMP`),
      visibility: text("visibility").notNull().default("fleet"),
      supersededAt: ts3("supersededAt"),
      supersededById: text("supersededById"),
      kind: text("kind").notNull().default("general"),
      topics: text("topics").array().notNull().default(sql`ARRAY['general'::text]`),
    },
    (t) => [
      uniqueIndex("Observation_authorAgent_subjectKey_naturalKey_key").on(t.authorAgent, t.subjectKey, t.naturalKey),
      index("Observation_subjectKey_ts_idx").on(t.subjectKey, t.ts),
      index("Observation_about_idx").using("gin", t.about),
      index("Observation_topics_idx").using("gin", t.topics),
      uniqueIndex("Observation_supersededById_key").on(t.supersededById),
      // array_length(about, 1) is NULL (not 0) for an empty array, and a
      // CHECK passes on NULL — so array_length cannot close the about = '{}'
      // gap. cardinality() returns 0 for an empty array, which does.
      check("Observation_about_primary_check", sql`cardinality(${t.about}) >= 1 AND ${t.about}[1] = ${t.subjectKey}`),
    ],
  );

  const contribution = s.table(
    "Contribution",
    {
      id: cuid(),
      authorAgent: text("authorAgent").notNull(),
      subjectKey: text("subjectKey").notNull(),
      principalId: text("principalId"),
      content: text("content").notNull(),
      why: text("why").notNull(),
      source: text("source").notNull().default("contribution"),
      ts: ts3("ts").notNull().default(sql`CURRENT_TIMESTAMP`),
      createdAt: ts3("createdAt").notNull().default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [index("Contribution_subjectKey_ts_idx").on(t.subjectKey, t.ts)],
  );

  const alias = s.table(
    "Alias",
    {
      id: cuid(),
      authorAgent: text("authorAgent").notNull(),
      localKey: text("localKey").notNull(),
      subjectKey: text("subjectKey").notNull(),
      createdAt: ts3("createdAt").notNull().default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
      uniqueIndex("Alias_authorAgent_localKey_key").on(t.authorAgent, t.localKey),
      index("Alias_subjectKey_idx").on(t.subjectKey),
    ],
  );

  return { schema: s, subject, observation, contribution, alias };
}

export type Tables = ReturnType<typeof buildTables>;

// drizzle-kit only. See the header.
export const { schema, subject, observation, contribution, alias } = buildTables(memorySchemaName);
