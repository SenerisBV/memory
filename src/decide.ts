// Write-free reconciliation pipeline: classify, group by primary topic,
// retrieve per group, reconcile per group, apply the guard. See
// the topic-scoped retrieval design note.
//
// This module holds NO Prisma access, for the same reason reconcile.ts does
// not: the caller injects a row-fetching closure, which is what lets the whole
// pipeline be tested without a database AND lets the replay harness drive the
// exact code production runs. The replay's own liveRows accumulator — the
// thing that made its dry-run unable to measure production — is deleted in
// favour of this.
import type { Classified } from "./classify";
import { DEFAULT_KIND } from "./kinds";
import { guardVerdict, type ReconcileResult } from "./reconcile";
import { GENERAL_TOPIC } from "./registry";

/** Live rows shown to the reconciler per group. Ruled 80 on 2026-08-16 and
 *  re-affirmed 2026-08-17: the spec's precision table reads "<=100 -> 0 wrong
 *  restatements", so 80 sits inside the measured-safe bucket with margin,
 *  where 100 sits on its edge — and that bucket was measured on UNSCOPED
 *  prompts, never on topic-scoped ones. The replay settles 80 vs 100. */
export const RETRIEVAL_CAP = 80;

export interface CandidateGroup {
  /** The primary topic every candidate in this group shares. */
  topic: string;
  /** Batch indices of the candidates, ascending. Local `c<N>` labels are the
   *  POSITION in this array; `indices[n]` maps back to the batch. */
  indices: number[];
}

/**
 * Partition candidates by their primary topic (`topics[0]`).
 *
 * Groups come back sorted by topic name and indices ascending within a group.
 * Both orderings are load-bearing rather than cosmetic: group order is
 * model-call order, and this project has produced three separate defects from
 * unstable ordering (replay defect 1, the classifier harness keying by row
 * position, and the production `ts`-only sort).
 */
export function groupByPrimaryTopic(classified: Classified[]): CandidateGroup[] {
  const byTopic = new Map<string, number[]>();
  classified.forEach((c, i) => {
    const topic = c.topics?.[0] ?? "general";
    const existing = byTopic.get(topic);
    if (existing) existing.push(i);
    else byTopic.set(topic, [i]);
  });
  return [...byTopic.keys()]
    .sort()
    .map((topic) => ({ topic, indices: byTopic.get(topic)! }));
}

export interface DecideLiveRow {
  id: string;
  /** Every subject this row is evidence for. Retrieval spans the batch's
   *  whole subject union, so a row shown to the reconciler is not necessarily
   *  about the candidate it returns a verdict on — the caller needs this to
   *  refuse a destructive verdict across that gap. */
  about: string[];
  predicate: string;
  value: string;
  valueNum: number | null;
  unit: string | null;
  ts: Date;
  authorAgent: string;
  visibility: string;
  kind: string;
  topics: string[];
}

export interface FetchLiveRowsArgs {
  /** The group's primary topic, or `null` for the unscoped `general` window. */
  topic: string | null;
  limit: number;
  /** Every subject the batch is about (resolved keys), so retrieval spans
   *  every subject in `about`, not just a single subject's rows. */
  about: string[];
}

export interface FetchLiveRowsResult {
  /** Already ordered `ts DESC, id DESC` and already capped at `limit`. */
  rows: DecideLiveRow[];
  /** How many rows matched BEFORE the cap, so the caller can report what the
   *  cap discarded. This is what settles the 80-vs-100 question. */
  matched: number;
}

export interface GroupReport {
  topic: string;
  candidates: number;
  matched: number;
  shown: number;
  discarded: number;
  failedOpen: boolean;
  blocked: number;
}

export interface DecideCandidate {
  predicate?: string | null;
  value?: string | null;
  valueNum?: number | null;
  unit?: string | null;
}

export interface DecideInput {
  subjectLabel: string;
  about: string[];
  candidates: DecideCandidate[];
  classify: (items: { predicate: string; value: string }[]) => Promise<Classified[]>;
  reconcile: (args: {
    subjectLabel: string;
    candidates: DecideCandidate[];
    liveRows: DecideLiveRow[];
  }) => Promise<ReconcileResult[]>;
  fetchLiveRows: (args: FetchLiveRowsArgs) => Promise<FetchLiveRowsResult>;
  cap?: number;
}

export interface DecideResult {
  classified: Classified[];
  /** Batch-indexed, guard already applied and downgrades already made. */
  verdicts: ReconcileResult[];
  /** Union of the rows shown across every group, keyed by id. The caller
   *  needs this to decide which targets may legally be superseded and whose
   *  visibility a new row inherits. */
  shown: Map<string, DecideLiveRow>;
  /** Guard-downgrade reasons, keyed by the verdict object itself. */
  notes: Map<ReconcileResult, string>;
  groups: GroupReport[];
}

/**
 * Classify, group, retrieve, reconcile and guard — everything that decides
 * WHAT to write, and nothing that writes.
 *
 * Splitting this out of `recordObservations` is what lets the replay harness
 * exercise production behaviour: its dry-run previously hand-rolled a
 * `liveRows` accumulator and called `reconcileBatch` directly, so it measured
 * a pipeline production does not run.
 *
 * The split is behaviour-preserving because the guard pass reads only values
 * computed BEFORE the write loop — the classifications, the shown-rows map and
 * the verdict itself — and touches none of the write loop's cross-verdict
 * state (`alreadySuperseded`, `derivedKeysThisBatch`, the counters).
 */
export async function decide(input: DecideInput): Promise<DecideResult> {
  const cap = input.cap ?? RETRIEVAL_CAP;
  const candidates = input.candidates;

  if (candidates.length === 0) {
    return { classified: [], verdicts: [], shown: new Map(), notes: new Map(), groups: [] };
  }

  // Classification precedes retrieval because the topic is what selects which
  // live rows to compare against. A single combined call cannot filter on a
  // value it has not produced yet.
  const rawClassified = await input.classify(
    candidates.map((c) => ({ predicate: c.predicate ?? "", value: c.value ?? "" })),
  );

  // `classify` is an injected seam — the replay harness and the tests supply
  // their own — so one entry per candidate is a property of the default
  // implementation (parseClassifications pre-fills to `count` and discards
  // out-of-range indices), not of the type. Normalize here so every index
  // derived from `classified` is a valid index into `candidates`: a short
  // reply would otherwise drop candidates out of every group silently, and a
  // long one would index past the end. The fallback is the same general/general
  // that classification already fails safe to — a row that stays findable and
  // un-mergeable, never a fabricated blank candidate.
  const classified = candidates.map((_, i) =>
    rawClassified[i] ?? { kind: DEFAULT_KIND, topics: [GENERAL_TOPIC] },
  );

  const withValues = classified.map((c, i) => ({
    kind: c.kind,
    topics: c.topics,
    value: (candidates[i]?.value ?? "").trim(),
  }));

  const shown = new Map<string, DecideLiveRow>();
  const notes = new Map<ReconcileResult, string>();
  const groups: GroupReport[] = [];
  const verdicts: ReconcileResult[] = [];

  // Sequential, not parallel: one local oMLX server holds a single 32G model,
  // so concurrent calls would queue at best and thrash memory at worst.
  for (const group of groupByPrimaryTopic(classified)) {
    // Safe: `group.indices` are indices into `classified`, which is normalized
    // above to exactly `candidates.length`.
    const groupCandidates = group.indices.map((i) => candidates[i]!);

    // The `general` group can never merge — guardVerdict excludes "general"
    // from the shared-topic test — but reconcile also rewrites predicates,
    // extracts valueNum/unit and fans compound values out, and those must not
    // be lost. Since the merge is blocked either way, the only thing the
    // context affects is rewrite quality, and richer normalized context
    // measured substantially better (FINDINGS defect 2).
    const topicFilter = group.topic === "general" ? null : group.topic;
    const { rows: allRows, matched } = await input.fetchLiveRows({ topic: topicFilter, limit: cap, about: input.about });
    // The contract says `rows` arrives already capped, but `fetchLiveRows` is
    // an injected seam. Enforce it here rather than trusting it: an
    // over-returning caller would otherwise blow the reconcile context AND
    // report discarded: 0, which is the number the 80-vs-100 decision rests on.
    const rows = allRows.slice(0, cap);
    for (const r of rows) shown.set(r.id, r);

    // Scoped to THIS call's rows, not the table. guardVerdict's "was this row
    // shown to the model in this call" test is only meaningful if the map
    // follows the subset — and topic-scoping is what makes the subset real.
    const shownForGroup = new Map(
      rows.map((r) => [r.id, { kind: r.kind, topics: r.topics, value: r.value }]),
    );
    const batchForGroup = group.indices.map((i) => withValues[i] ?? {
      kind: DEFAULT_KIND, topics: [GENERAL_TOPIC], value: "",
    });

    let local: ReconcileResult[];
    let failedOpen = false;
    try {
      local = await input.reconcile({
        subjectLabel: input.subjectLabel,
        candidates: groupCandidates,
        liveRows: rows,
      });
      // A local index outside this group is a malformed reply, not a fan-out.
      // Reinterpreting it as a batch index would attribute one candidate's
      // verdict to an unrelated candidate in another group. `reconcile` is an
      // injected seam, so in-range is a property of parseVerdicts, not of the
      // type — same reason `classified` is normalized above.
      for (const v of local) {
        if (!Number.isInteger(v.index) || v.index < 0 || v.index >= groupCandidates.length) {
          throw new Error(`reconciler verdict index ${v.index} outside group ${group.topic}`);
        }
      }

      // Coverage, not length: a compound value legitimately fans out into
      // several verdicts sharing one index. What must hold is that every
      // candidate appears at least once.
      const covered = new Set(local.map((v) => v.index));
      for (let i = 0; i < groupCandidates.length; i++) {
        if (!covered.has(i)) throw new Error(`reconciler verdicts missing candidate index ${i}`);
      }
    } catch {
      // Fail open, per group. Before topic-scoping one bad reply cost the
      // whole batch; now it costs one topic. Gemma returned unparseable JSON
      // on 5 of 40 unscoped 15-candidate replies, and these calls are far
      // smaller.
      failedOpen = true;
      local = groupCandidates.map((c, i) => ({
        index: i, verdict: "record" as const, targetId: null,
        predicate: (c.predicate ?? "").trim(), value: (c.value ?? "").trim(),
        valueNum: c.valueNum ?? null, unit: c.unit ?? null,
        why: "reconciler unavailable; recorded unreconciled",
      }));
    }

    let blocked = 0;
    for (const v of local) {
      // Remap the local c<N> index back to the batch up front, and mutate the
      // REMAPPED object from here on. `notes` is keyed by object identity and
      // the caller only ever sees the remapped object, so guarding the
      // original and then spreading it would strand every note.
      //
      // The guard itself still gets the LOCAL index: `c<N>` labels are
      // positions within this group's call, and that is what its direction
      // check and its `batch[n]` lookup are both defined against.
      const remapped: ReconcileResult = { ...v, index: group.indices[v.index]! };

      // `c<N>` targets are group-local POSITIONS too, and they were left
      // local while `index` was remapped — so a verdict leaving decide mixed
      // two coordinate systems, and a caller comparing `label < v.index` was
      // comparing a position in this group against a position in the batch.
      // Rewrite the label as well, so everything leaving this function is
      // batch-indexed and the caller has one system to reason in.
      //
      // An out-of-range label is left exactly as it came: it is malformed
      // rather than local, there is nothing to translate it to, and the
      // caller's own validation is what refuses it.
      const localLabel = /^c\d+$/.test(v.targetId ?? "") ? Number((v.targetId as string).slice(1)) : null;
      if (localLabel !== null) {
        const batchTarget = group.indices[localLabel];
        if (batchTarget !== undefined) remapped.targetId = `c${batchTarget}`;
      }

      if (v.verdict !== "record") {
        const candidate = batchForGroup[v.index] ?? {
          kind: DEFAULT_KIND, topics: [GENERAL_TOPIC], value: "",
        };
        const reason = guardVerdict({
          verdict: v.verdict,
          targetId: v.targetId,
          candidate,
          shown: shownForGroup,
          batch: batchForGroup,
          index: v.index,
        });
        if (reason) {
          notes.set(remapped, `${v.verdict} DOWNGRADED to record by the taxonomy guard: ${reason}`);
          remapped.verdict = "record";
          blocked++;
          // targetId is deliberately NOT cleared: the caller inherits a
          // target's visibility off targetId regardless of verdict, and
          // clearing it would let a guard-blocked corrects on an
          // author-visible target write fleet-visible.
        }
      }
      verdicts.push(remapped);
    }

    groups.push({
      topic: group.topic,
      candidates: groupCandidates.length,
      matched,
      shown: rows.length,
      discarded: Math.max(0, matched - rows.length),
      failedOpen,
      blocked,
    });
  }

  return { classified, verdicts, shown, notes, groups };
}
