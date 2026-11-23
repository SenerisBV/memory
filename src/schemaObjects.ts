// Declare it or lose it. On 2026-05-07 a fleet migration dropped two HNSW
// indexes and nothing noticed for three and a half months. Every index,
// check constraint and trigger the library creates is listed here; the db
// test checks both directions against the catalog.
import { sql } from "drizzle-orm";

import type { Handle } from "./db";

const INDEXES = [
  "Subject_pkey", "Subject_key_key", "Subject_attention_idx",
  "Observation_pkey", "Observation_authorAgent_subjectKey_naturalKey_key", "Observation_subjectKey_ts_idx",
  "Observation_about_idx", "Observation_topics_idx", "Observation_supersededById_key",
  "Contribution_pkey", "Contribution_subjectKey_ts_idx", "Contribution_about_idx",
  "Alias_pkey", "Alias_authorAgent_localKey_key", "Alias_subjectKey_idx",
] as const;

const CHECKS = ["Subject_key_typed_check", "Observation_about_primary_check"] as const;

/** 0005: an insert with an empty `about` gets `[subjectKey]`, so no note is invisible. */
const TRIGGERS = ["Contribution_about_default"] as const;

export function declaredObjects(schemaName: string): string[] {
  return [
    ...INDEXES.map((n) => `index:${schemaName}.${n}`),
    ...CHECKS.map((n) => `check:${schemaName}.${n}`),
    ...TRIGGERS.map((n) => `trigger:${schemaName}.${n}`),
  ];
}

export async function presentObjects(handle: Handle): Promise<string[]> {
  const r = await handle.db.execute(sql`
    SELECT 'index:' || schemaname || '.' || indexname AS obj FROM pg_indexes WHERE schemaname = ${handle.schemaName}
    UNION ALL
    SELECT 'check:' || n.nspname || '.' || c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'c' AND n.nspname = ${handle.schemaName}
    UNION ALL
    SELECT 'trigger:' || n.nspname || '.' || t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = ${handle.schemaName}
    ORDER BY 1`);
  return (r.rows as { obj: string }[]).map((x) => x.obj);
}

export async function assertSchemaObjects(handle: Handle): Promise<void> {
  const present = new Set(await presentObjects(handle));
  if (present.size === 0) throw new Error(`schema "${handle.schemaName}": catalog is empty — wrong database, or not migrated`);
  const missing = declaredObjects(handle.schemaName).filter((k) => !present.has(k));
  if (missing.length > 0) throw new Error(`schema "${handle.schemaName}": missing declared objects:\n  ${missing.join("\n  ")}`);
}
