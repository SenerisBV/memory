import type { CompleteFn, MemoryHost } from "./host";
import { OBSERVATION_EXTRACT_SCHEMA, extractSystemPrompt } from "./prompts";
import type { Store } from "./store";

export type AboutEntry = string | { type: string; label: string };

/** Who a write is on behalf of. Optional everywhere; `authorAgent` stays the host. */
export type Actor = { kind: "person" | "agent"; id: string; label?: string };

export interface ObservationInput {
  about: AboutEntry[];
  predicate: string;
  value: string;
  valueNum?: number | null;
  unit?: string | null;
  naturalKey?: string | null;
  /** Grade the extractor proposes; clamped to the source ceiling at write time. */
  grade?: string;
  actor?: Actor;
}

function isAboutEntry(x: unknown): x is AboutEntry {
  if (typeof x === "string") return x.trim().length > 0;
  return !!x && typeof x === "object" && typeof (x as { type?: unknown }).type === "string" && typeof (x as { label?: unknown }).label === "string";
}

/** `defaultAbout`: the subject a host files a subject-less observation under.
 *  Absent, such an observation is dropped (there is nothing to file it under);
 *  present, it is kept as `about: [defaultAbout]`. A host that ran the
 *  extractor FOR a known subject (one pass per subject) loses a
 *  fact otherwise, merely because the model left `about` empty. */
export function coerceObservations(raw: unknown[], defaultAbout?: string): ObservationInput[] {
  const out: ObservationInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    let about = Array.isArray(o.about) ? o.about.filter(isAboutEntry) : [];
    if (about.length === 0 && defaultAbout) about = [defaultAbout];
    const predicate = typeof o.predicate === "string" ? o.predicate.trim() : "";
    const value = typeof o.value === "string" ? o.value.trim() : "";
    if (about.length === 0 || !predicate || !value) continue;
    const obs: ObservationInput = { about, predicate, value };
    if (typeof o.naturalKey === "string" && o.naturalKey) obs.naturalKey = o.naturalKey;
    if (typeof o.grade === "string") obs.grade = o.grade;
    out.push(obs);
  }
  return out;
}

export function createExtract(host: MemoryHost, store: Store) {
  async function extractObservations(text: string, opts: { complete?: CompleteFn; traceId?: string; defaultAbout?: string } = {}): Promise<ObservationInput[]> {
    const run = opts.complete ?? host.complete;
    const known = await store.knownSubjects();
    const system = host.lens?.extractionPrompts?.system ?? extractSystemPrompt(host.registry, known);
    const jsonSchema = host.lens?.extractionPrompts?.schema ?? (OBSERVATION_EXTRACT_SCHEMA as unknown as Record<string, unknown>);
    // NOT try/caught, deliberately: a call that could not be made must not
    // look like a text with nothing in it (the fleet learned this on
    // 2026-08-31 — 22 "succeeded" captures during an outage).
    const res = await run({ tier: "low", system, messages: [{ role: "user", content: text.slice(0, 12_000) }], jsonSchema, maxTokens: 4000, source: "memory-extract", traceId: opts.traceId });
    return coerceObservations(parseObservationArray(res.text), opts.defaultAbout?.trim() || undefined);
  }
  return { extractObservations };
}

// Parse the model's observation list. The happy path is a single JSON.parse of
// the `[...]` block. If that fails (most commonly a mid-array truncation — no
// closing "]"), salvage every COMPLETE top-level `{...}` object instead of
// dropping the whole batch to zero. Observation objects are flat (string-only
// subject/predicate/value/naturalKey), so a brace-free `{...}` match is safe.
export function parseObservationArray(text: string): unknown[] {
  const arr = text.match(/\[[\s\S]*\]/)?.[0];
  if (arr) {
    try {
      const p = JSON.parse(arr);
      if (Array.isArray(p)) return p;
    } catch {
      // fall through to object salvage
    }
  }
  const out: unknown[] = [];
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      out.push(JSON.parse(m[0]));
    } catch {
      // skip an unparseable fragment
    }
  }
  return out;
}

export type Extract = ReturnType<typeof createExtract>;
