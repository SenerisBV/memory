// Read-before-write reconciliation. See
// the reconciliation design note kept with the host that first ran this.
//
// This module deliberately holds NO Prisma access. Rows in, verdicts out —
// which is what makes the pure functions testable without a database and the
// orchestration testable with an injected `complete`.
import type { CompleteFn, MemoryHost } from "./host";
import { modality } from "./kinds";

export type Verdict = "record" | "restates" | "corrects";

export interface ReconcileCandidate {
  subject: string;
  predicate: string;
  value: string;
  naturalKey?: string | null;
}

export interface LiveRow {
  id: string;
  predicate: string;
  value: string;
  valueNum: number | null;
  unit: string | null;
  ts: Date;
}

export interface ReconcileResult {
  index: number;
  verdict: Verdict;
  /** A stored row id for `corrects`; a stored row id or an earlier `c<N>` for
   *  `restates`; null for `record`. */
  targetId: string | null;
  predicate: string;
  value: string;
  valueNum: number | null;
  unit: string | null;
  why: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Extract every number appearing in a free-text value string. Handles a
 *  thousands separator ("1,540" -> 1540), a leading `~`, a leading minus
 *  sign ("-92.50 eur" -> -92.5, ASCII `-` or Unicode minus `−`), and both
 *  plain hyphen and en-dash range separators ("5-6" / "5–6" -> [5, 6]).
 *
 *  A `-`/`−` immediately before a digit is only treated as a SIGN — not a
 *  hyphen or range separator — when the character before IT is the start of
 *  the string, whitespace, an opening bracket, or a currency symbol. This
 *  corpus is full of hyphenated predicates and en-dash ranges
 *  ("weight-change", "has-health-insurance", "20th-19th", "5–6 days"), and a
 *  bare `-` between two digits or after a letter is a separator, not a sign
 *  — so "5-6" still extracts `[5, 6]`, never `[5, -6]`.
 *
 *  Used to guard `valueNum` against a model-invented number, or an invented
 *  precision, that never appeared in the text it was extracted from. See
 *  defect 4 in the reconciliation findings note
 *  on a live corpus: `valueNum: 0` on "mini-fridge to store food" (no number in
 *  the text at all), `5.5` on "approximately 5-6 days per week" (a
 *  precision the operator never stated and ruled unqueryable noise), and —
 *  round 1 fix — every negative rejected outright until the sign was
 *  captured, which would have nulled the one production row that legitimately
 *  carries a valueNum ("-2.0 kg"). */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  const signContext = /[\s([{€$£¥]/;
  const re = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let numStr = m[0];
    const start = m.index;
    const prevChar = start > 0 ? text[start - 1] : undefined;
    if (prevChar === "-" || prevChar === "−") {
      const beforeSign = start > 1 ? text[start - 2] : undefined;
      const signIsLegit = beforeSign === undefined || signContext.test(beforeSign);
      if (signIsLegit) numStr = "-" + numStr;
    }
    const n = Number(numStr.replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export function renderLiveRows(rows: LiveRow[]): string {
  if (rows.length === 0) return "(no observations on file for this subject)";
  return rows
    .map((r) => {
      const num = r.valueNum !== null ? ` | ${r.valueNum}${r.unit ? ` ${r.unit}` : ""}` : "";
      return `${r.id} | ${day(r.ts)} | ${r.predicate}: ${r.value}${num}`;
    })
    .join("\n");
}

export function renderCandidates(candidates: ReconcileCandidate[]): string {
  return candidates.map((c, i) => `c${i} | ${c.predicate}: ${c.value}`).join("\n");
}

/** Fall back to `record` carrying the candidate's own fields. Every invalid,
 *  missing or unparseable verdict lands here. Duplicates are visible and
 *  fixable; silently dropped observations are neither — see the maxTokens:800
 *  truncation that emptied this store fleet-wide in July 2026. */
function defaultResult(c: ReconcileCandidate, index: number, why: string): ReconcileResult {
  return { index, verdict: "record", targetId: null, predicate: c.predicate, value: c.value, valueNum: null, unit: null, why };
}

/**
 * Fix round 1, C2: `RECONCILE_SYSTEM` tells the model to fan a compound value
 * out into several entries "with the same index" — one per fact. This used to
 * `out[index] = {...}`, an overwrite: a four-fact fan-out returned four
 * entries that clobbered each other, and only the LAST survived. The others
 * were destroyed before observations.ts's apply loop ever saw them.
 *
 * Now every valid parsed entry is kept, grouped by index, and flattened in
 * ascending index order — so the returned array may be LONGER than
 * `candidates` (a real fan-out), but every candidate index is guaranteed to
 * appear at least once (an index with no valid entry gets the `defaultResult`
 * fallback, same as before). Every existing per-entry guard (verdict shape,
 * within-batch target rules, etc.) is unchanged — only the assignment target
 * changed, from "overwrite this index" to "append to this index's bucket".
 */
export function parseVerdicts(text: string, candidates: ReconcileCandidate[]): ReconcileResult[] {
  const liveIdPattern = /^c\d+$/;
  const byIndex = new Map<number, ReconcileResult[]>();

  for (const raw of salvageObjects(text)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const index = typeof o.index === "number" ? o.index : -1;
    if (index < 0 || index >= candidates.length) continue;

    const candidate = candidates[index];
    if (!candidate) continue;

    const verdict = o.verdict;
    if (verdict !== "record" && verdict !== "restates" && verdict !== "corrects") continue;

    const targetId = typeof o.targetId === "string" && o.targetId.trim() ? o.targetId.trim() : null;
    const withinBatch = targetId !== null && liveIdPattern.test(targetId);

    // `restates` and `corrects` must name a target. `corrects` may only target
    // a STORED row — a candidate that appears to correct one of its own batch
    // siblings is a case the reconciler does not understand well enough to act
    // on. And a `restates` may only point BACKWARD, or the two could drop each
    // other and lose the fact entirely.
    if (verdict !== "record") {
      if (!targetId) continue;
      if (verdict === "corrects" && withinBatch) continue;
      if (withinBatch && Number(targetId.slice(1)) >= index) continue;
    }

    const predicate = typeof o.predicate === "string" && o.predicate.trim() ? o.predicate.trim() : candidate.predicate;
    const value = typeof o.value === "string" && o.value.trim() ? o.value.trim() : candidate.value;

    // A `valueNum` is only trusted if that number actually appears in text the
    // OPERATOR stated — otherwise the model has fabricated a number (or a
    // precision) they never gave. A rejected valueNum takes its unit with it:
    // a unit without a number is meaningless. See extractNumbers.
    //
    // Checked against the rewritten value AND the ORIGINAL candidate value,
    // and the original is the load-bearing half (fixed 2026-08-19). Checking
    // only the rewrite destroyed every monetary figure in the corpus: this
    // prompt tells the model to "put the bare number in valueNum" while
    // rewriting `value` to one concise fact, so a compliant model moves the
    // number OUT of the prose — and the old check then looked for it only in
    // the prose it had just left. Measured on the live corpus: "€6,240 per
    // month" became "take-home income" with valueNum null, and "€268.00 per
    // month (health €205.00, life €63)" fanned out to "health insurance" /
    // "life insurance" with all three figures gone. A guard written to stop
    // INVENTED numbers was deleting REAL ones.
    //
    // Both original protections survive, because a fabrication appears in
    // neither text: `valueNum: 0` on "mini-fridge to store food" still fails,
    // and `5.5` on "approximately 5-6 days per week" still fails (the original
    // carries 5 and 6, never 5.5).
    const rawValueNum = typeof o.valueNum === "number" && Number.isFinite(o.valueNum) ? o.valueNum : null;
    const statedNumbers = [...extractNumbers(value), ...extractNumbers(candidate.value ?? "")];
    const valueNum =
      rawValueNum !== null && statedNumbers.some((n) => Math.abs(n - rawValueNum) < 0.005)
        ? rawValueNum
        : null;

    const entry: ReconcileResult = {
      index,
      verdict,
      targetId: verdict === "record" ? null : targetId,
      predicate,
      value,
      valueNum,
      unit: valueNum !== null && typeof o.unit === "string" && o.unit.trim() ? o.unit.trim() : null,
      why: typeof o.why === "string" ? o.why : "",
    };

    const bucket = byIndex.get(index);
    if (bucket) bucket.push(entry);
    else byIndex.set(index, [entry]);
  }

  const out: ReconcileResult[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const bucket = byIndex.get(i);
    if (bucket && bucket.length > 0) {
      out.push(...bucket);
      continue;
    }
    const c = candidates[i];
    if (c) out.push(defaultResult(c, i, "no verdict returned"));
  }
  return out;
}

/** Happy path is one JSON.parse of the `[...]` block. On failure — most often a
 *  mid-array truncation — salvage every COMPLETE top-level object rather than
 *  dropping the batch to zero. Mirrors extract.ts's parseObservationArray, and
 *  exists for the same reason it does. */
function salvageObjects(text: string): unknown[] {
  const arr = text.match(/\[[\s\S]*\]/)?.[0];
  if (arr) {
    try {
      const p = JSON.parse(arr);
      if (Array.isArray(p)) return p;
    } catch {
      // fall through
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

export const RECONCILE_SYSTEM = `You reconcile newly extracted observations about a subject against what is already recorded about that subject.

You are given EXISTING rows (each with an id) and CANDIDATE observations (labelled c0, c1, …). For EVERY candidate, return exactly one verdict.

Verdicts:
- "record" — a new fact, a different facet of a known situation, or the same measurement genuinely observed again at a new time. This is the default. Use it whenever you are unsure.
- "restates" — says nothing the target does not already say. Requires "targetId": an existing row id, or an EARLIER candidate label (c0, c1, …). The candidate is discarded.
- "corrects" — the target row was WRONG, not merely older. Requires "targetId": an existing row id ONLY, never a candidate label. The target is retired and this candidate replaces it.

Judging restates vs record — the distinction that matters most:
- Candidates in this batch come from ONE conversation. Several candidates phrasing the same fact differently are restatements of each other; keep the clearest and mark the rest "restates" pointing at it.
- A different day, or a different source, usually means a genuine new observation. Prefer "record".
- A budget target and an actual amount are DIFFERENT FACTS, not a contradiction. So are an amount and the variance between them. Record all of them.
- Only use "corrects" when the earlier row is a mistake — a misread figure, a wrong name. A value that CHANGED over time is two records, not a correction.

Rewriting, applied to every candidate you "record" or "correct":
- predicate: reuse an existing predicate from the rows above when one fits. Only mint a new one when nothing fits. Prefer the existing spelling exactly.
- value: ONE fact per verdict. If a candidate packs several facts into one string ("rent 1540, health insurance 240, life insurance 63"), return the FIRST fact here and emit the others as additional entries with the same index — one entry per fact.
- NEVER drop a number, an amount, or an identifier when you rewrite. Keep it IN the value text, digit for digit. "€6,240 per month" may be rewritten but must still read "€6,240"; "take-home income" alone has thrown away the only thing that fact was for. When you split a compound value, each part keeps ITS OWN figure: "€268.00 per month (health €205.00, life €63)" becomes "health insurance €205.00" and "life insurance €63", never "health insurance" and "life insurance".
- valueNum + unit: whenever the fact carries a number, ALSO put the bare number in valueNum and its unit in unit ("eur", "kg", "min", "severity"). This mirrors the number, it does not move it — the digits stay in value as well. Leave both null when there is no number.
- why: one short clause. This is read by a human auditing your verdicts.

Return ONLY a JSON array.`;

export const RECONCILE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      index: { type: "integer" },
      verdict: { type: "string", enum: ["record", "restates", "corrects"] },
      targetId: { type: "string" },
      predicate: { type: "string" },
      value: { type: "string" },
      valueNum: { type: "number" },
      unit: { type: "string" },
      why: { type: "string" },
    },
    required: ["index", "verdict", "why"],
    additionalProperties: false,
  },
} as const;

export interface ReconcileBatchInput {
  subjectLabel: string;
  candidates: ReconcileCandidate[];
  liveRows: LiveRow[];
  complete?: CompleteFn;
  traceId?: string;
}

export function createReconcile(host: MemoryHost) {
  async function reconcileBatch(input: ReconcileBatchInput): Promise<ReconcileResult[]> {
    if (input.candidates.length === 0) return [];

    const run: CompleteFn = input.complete ?? host.complete;

    // userContent construction (renderLiveRows/renderCandidates) and the parse
    // are BOTH inside the try alongside the model call, deliberately. This
    // module's entire purpose is to fail open, and a Task 2 review found that
    // `parseVerdicts` could throw on a non-integer `index` (a model returning
    // 1.5 clears a `< candidates.length` bounds check but indexes to
    // undefined). That specific bug is now guarded inside parseVerdicts, but
    // the structural point stands: nothing that can throw should sit outside
    // the handler that catches throws. renderLiveRows(input.liveRows) hits the
    // same rule — a `LiveRow.ts` that is a bad Date (or, once a later task
    // spreads a serialized row where `ts` is a string, not even a Date at all)
    // throws inside `day()`'s `.toISOString()`, and that must fail open too.
    try {
      const userContent = [
        `Subject: ${input.subjectLabel}.`,
        "",
        "EXISTING rows already recorded for this subject:",
        renderLiveRows(input.liveRows),
        "",
        "CANDIDATE observations from one new conversation:",
        renderCandidates(input.candidates),
      ].join("\n");
      const res = await run({
        // NOT "low". `low` is the tier that produced 325 predicates for 852
        // rows and populated valueNum exactly once; judging restatement from
        // facet is a materially harder call than pulling facts out of a
        // transcript.
        tier: "memory",
        system: RECONCILE_SYSTEM,
        messages: [{ role: "user", content: userContent }],
        jsonSchema: RECONCILE_SCHEMA as unknown as Record<string, unknown>,
        // Roughly 150 tokens of verdict per candidate, and the largest historical
        // batch is 21 candidates — but compound values fan out to more entries
        // than candidates, so this leaves ~2x headroom. parseVerdicts salvages a
        // truncated array as a belt; this is the braces.
        maxTokens: 8000,
        source: "memory-reconcile",
        traceId: input.traceId,
      });
      return parseVerdicts(res.text, input.candidates);
    } catch {
      // Fail OPEN. A throw here would silently discard the batch — which is
      // exactly what the maxTokens:800 truncation did fleet-wide.
      //
      // FINAL FIX WAVE, IMPORTANT 3: this used to justify itself with "every
      // caller of recordObservations is already wrapped in
      // try/catch-return-0". That is FALSE — `calibration.ts:19` awaits it
      // bare — and a wrong premise in the justification for a deliberate
      // swallow is how the next person reasons into a bug. The real reason
      // stands on its own: the whole point of this module is that an
      // unavailable reconciler must cost a duplicate, never a hole.
      //
      // The optional chains are the fix wave's other half here: this fallback
      // is the LAST safety net in the module, and a null candidate in the
      // array made the net itself throw on `c.predicate` — turning a
      // recoverable model failure into a lost batch at the one point that
      // exists to prevent exactly that.
      return input.candidates.map((c, i) => ({
        index: i, verdict: "record" as const, targetId: null,
        predicate: c?.predicate ?? "", value: c?.value ?? "", valueNum: null, unit: null,
        why: "reconciler unavailable; recorded unreconciled",
      }));
    }
  }

  return { reconcileBatch };
}

export type Reconcile = ReturnType<typeof createReconcile>;

export interface GuardArgs {
  verdict: Verdict;
  targetId: string | null;
  /** `value` is carried so the numeric clause below can compare the two texts.
   *  Use the candidate's ORIGINAL value, not a rewritten one: the rewrite is
   *  the model's, and this guard exists precisely because the model's output
   *  is not trusted. */
  candidate: { kind: string; topics: string[]; value: string };
  /** The classified live rows SHOWN to the model in this call, keyed by id.
   *  Under topic-scoped retrieval this is the GROUP's rows, not the table. */
  shown: Map<string, { kind: string; topics: string[]; value: string }>;
  /** Classifications for THIS group's candidates, positionally, each carrying
   *  its candidate's value. A within-batch `c<N>` target is checked for
   *  coherence exactly like a stored one — without this the sibling path skips
   *  modality, topic and numbers entirely. */
  batch: { kind: string; topics: string[]; value: string }[];
  index: number;
}

/**
 * Structural precondition on the two destructive verdicts.
 *
 * Measured 2026-08-16: the local reconciler names an incoherent target in a
 * large share of its `restates`/`corrects` — 36% for Qwen at 10 trials. No
 * wording of the prompt fixed it, because target SELECTION is what fails, not
 * the model's grasp of the rule. So the taxonomy is spent on validating the
 * model's output rather than on instructing it.
 *
 * Returns a reason to BLOCK, or null to allow. A blocked verdict is downgraded
 * to `record` by the caller, never dropped: an unsure reconciler must produce a
 * duplicate, not a hole.
 *
 * This does NOT replace the existing liveById/ownLiveIds checks in
 * observations.ts. Those ask whether the target EXISTS and whether this agent
 * may retire it. This asks whether the merge is COHERENT. Both must pass.
 */
export function guardVerdict(args: GuardArgs): string | null {
  if (args.verdict === "record") return null;

  const { targetId } = args;
  if (!targetId) return "no target named";

  // Resolve the target from either source, then run the SAME coherence
  // checks below regardless of where it came from — a within-batch sibling
  // is not exempt from modality/topic just because parseVerdicts already
  // enforces direction on it.
  let target: { kind: string; topics: string[]; value: string } | undefined;

  if (/^c\d+$/.test(targetId)) {
    const n = Number(targetId.slice(1));
    // `^c\d+$` already guarantees n is a non-negative integer; `n < args.index`
    // is the only real direction test.
    if (!(n < args.index)) {
      return `within-batch target ${targetId} is not an earlier candidate than c${args.index}`;
    }
    target = args.batch[n];
    if (!target) return `within-batch target ${targetId} has no classification to check`;
  } else {
    target = args.shown.get(targetId);
    if (!target) return `target ${targetId} was not shown to the model in this call`;
  }

  const a = modality(args.candidate.kind);
  const b = modality(target.kind);
  if (a !== b || a === "neither") {
    return `modality mismatch: candidate [${args.candidate.kind}] is ${a}, target [${target.kind}] is ${b}`;
  }

  // "general" is the classifier's fallback bucket (~12% of rows in a real
  // pass); two unrelated rows that both defaulted there must not merge just
  // because they share that one wildcard-ish topic.
  const shares = args.candidate.topics.some((t) => t !== "general" && target!.topics.includes(t));
  if (!shares) {
    return `no shared topic: candidate [${args.candidate.topics.join("+")}] vs target [${target.topics.join("+")}]`;
  }

  // Numeric disagreement, added 2026-08-17. The modality clause above only
  // separates INTENDED from ACTUAL, and measurement showed that is not enough:
  // production spreads the "health insurance €240" fact across FIVE kinds
  // spanning both modalities (`targets`, `committed-to`, `decided`, `costs`,
  // `has`), so `has-health-insurance €268.00` merging `confirmed-health-
  // insurance €240` passes modality and topic cleanly. Eleven live rows
  // survived the guard as legal targets for that one candidate.
  //
  // RECONCILE_SYSTEM defines `restates` as "says nothing the target does not
  // already say", and separately rules that "a value that CHANGED over time is
  // two records, not a correction". So two rows carrying disjoint number sets
  // cannot be a restatement — semantically, not heuristically.
  //
  // `corrects` is exempt on purpose: the prompt permits it only when the
  // earlier row is "a misread figure", which legitimately differs.
  //
  // Silent when either side carries no number, which is most of the
  // non-money corpus. Measured over 198 same-subject pairs sharing a topic and
  // a modality: blocks 0/34 at jaccard >=0.90, 0/66 at 0.75-0.89, 1/98 below.
  if (args.verdict === "restates") {
    const candidateNums = extractNumbers(args.candidate.value);
    const targetNums = extractNumbers(target.value);
    if (candidateNums.length > 0 && targetNums.length > 0) {
      if (!candidateNums.some((n) => targetNums.includes(n))) {
        return `numeric disagreement: candidate {${candidateNums.join(", ")}} vs target {${targetNums.join(", ")}}`;
      }
    }
  }

  return null;
}
