// Ported from the fleet's src/lib/memory/recall.ts, collapsed from four
// exports (buildGrainSection plus three per-grain wrappers) down to one
// `recall(key, opts)`: the grain concept is gone here, callers pass an
// already-canonical key and their own name/intro/priority. Host-facing
// edits: `@/lib/knowledge/paths`'s `knowledgeRoot` -> `host.dossierRoot`;
// the direct dossier select -> `store.getSubject(key)`; the local
// `projectDossier(grain, key)` -> `createProject(host, store).projectDossier(key)`;
// `resolveCanonicalKey` is gone (the key passed in is already canonical —
// callers resolve aliases through the store if they hold a local key); the
// local `applyLens(_agent, content)` no-op is replaced by
// `host.lens?.recallFilter`, defaulting to the exact same pass-through when
// unset.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ATTENTION, RECALL_MAX_CHARS } from "./constants";
import { stripLeadingH1 } from "./keys";
import { createProject } from "./project";
import type { MemoryHost } from "./host";
import type { Store } from "./store";

// EventLog.source for every recall row. Exported so a health report can filter
// on it without restating the literal.
export const RECALL_LOG_SOURCE = "memory-recall";

/** Payload shape of a `memory-recall` log row. Readers should treat every
 * field as optional at runtime — rows written before a field existed will not
 * have it. */
export interface RecallLog {
  key: string;
  /** The section name this recall would occupy, e.g. "operator_model". */
  name: string;
  /** `synthesized` — the A-layer dossier file answered.
   *  `projected`   — no readable dossier file; the B-layer projection stood in.
   *  `empty`       — no evidence at all; no section produced.
   *  `ignored`     — attention="ignore"; deliberately withheld. */
  outcome: "synthesized" | "projected" | "empty" | "ignored";
  /** Body length before clipping, after the lens. 0 for empty/ignored. */
  chars: number;
  clipped: boolean;
  /** SubjectRow.profileSynthAt — null means never consolidated. */
  synthAt: string | null;
}

export interface RecallSection {
  kind: "user";
  name: string;
  priority: number;
  body: string;
}

export function createRecall(host: MemoryHost, store: Store) {
  const { projectDossier } = createProject(host, store);

  function applyLens(content: string): string {
    return host.lens?.recallFilter ? host.lens.recallFilter(host.agentId, content) : content;
  }

  // One row per recall attempt, mirroring the per-retrieval logging pattern
  // knowledge search already used elsewhere (one row per retrieval, shape
  // in the payload) — the same instrumentation the knowledge base has had
  // all along and memory never got. `source` is a distinct string rather
  // than "memory" (which consolidation already uses) so a health report can
  // separate what memory WROTE from what memory was actually READ for.
  //
  // Deliberately fire-and-forget with a swallowed rejection, unlike
  // consolidate.ts's bare `await host.log(...)`. Consolidation is a nightly
  // background job where a logging failure can safely surface; this runs
  // inside prompt assembly on every single turn, and a dead EventLog write
  // must never cost the caller a reply. Every host's `log()` already
  // documents itself as non-throwing — this is belt-and-braces on the one
  // path where the cost of being wrong is a broken conversation.
  function logRecall(payload: RecallLog): void {
    void Promise.resolve(
      host.log({
        kind: "INFO",
        source: RECALL_LOG_SOURCE,
        message: `recall ${payload.outcome}: ${payload.key} (${payload.name})`,
        payload: { ...payload },
      }),
    ).catch(() => {});
  }

  async function recall(
    key: string,
    opts: { name: string; intro: string; priority?: number; maxChars?: number },
  ): Promise<RecallSection | null> {
    const maxChars = opts.maxChars ?? RECALL_MAX_CHARS;
    // profileSynthAt is selected purely for the log line. It is written by
    // consolidate.ts and, until now, read by nothing — so "how old is what
    // we just recalled?" was unanswerable. It rides along here rather than
    // needing a TTL sweeper to make it visible.
    const subject = await store.getSubject(key);
    const base = { key, name: opts.name, synthAt: subject?.profileSynthAt?.toISOString() ?? null };

    if (subject?.attention === ATTENTION.IGNORE) {
      logRecall({ ...base, outcome: "ignored", chars: 0, clipped: false });
      return null; // never surface ignored subjects
    }

    // Which layer actually answered. "synthesized" = the A-layer file
    // consolidation produced; "projected" = the B-layer evidence projection
    // standing in because no dossier file exists (or could not be read).
    // Distinguishing these is the point: a store where this is always
    // "projected" is a store whose synthesizer output nobody consumes.
    let layer: "synthesized" | "projected" = "projected";
    let body = "";
    if (subject?.profilePath) {
      try {
        const raw = await readFile(join(host.dossierRoot, subject.profilePath), "utf8");
        body = stripLeadingH1(raw).trim();
        if (body) layer = "synthesized";
      } catch { body = ""; }
    }
    if (!body) {
      const projected = await projectDossier(key);
      body = projected ? stripLeadingH1(projected).trim() : "";
    }
    if (!body) {
      logRecall({ ...base, outcome: "empty", chars: 0, clipped: false });
      return null;
    }
    body = applyLens(body);
    // Measured after the lens, before the clip: `chars` is what recall WANTED
    // to say, so `chars > maxChars` on a clipped row shows how much was lost.
    const chars = body.length;
    const clipped = chars > maxChars;
    if (clipped) body = body.slice(0, maxChars).trimEnd() + " …";
    logRecall({ ...base, outcome: layer, chars, clipped });
    return { kind: "user", name: opts.name, priority: opts.priority ?? 12, body: `${opts.intro}\n\n${body}` };
  }

  return { recall };
}

export type Recall = ReturnType<typeof createRecall>;
