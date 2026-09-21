import { describe, expect, test } from "bun:test";
import { parseVerdicts, renderLiveRows, renderCandidates, createReconcile, guardVerdict, extractNumbers } from "./reconcile";
import type { ReconcileCandidate, LiveRow } from "./reconcile";
import type { MemoryHost } from "./host";

function fakeHost(agentId: string): MemoryHost {
  return { agentId } as unknown as MemoryHost;
}

const candidates: ReconcileCandidate[] = [
  { subject: "alex", predicate: "has", value: "fixed costs: rent €1540, health insurance €240" },
  { subject: "alex", predicate: "confirmed", value: "health insurance is 240 per month" },
  { subject: "alex", predicate: "committed", value: "paying Meridian health insurance €205.00 per period" },
];

const live: LiveRow[] = [
  { id: "obs_a", predicate: "budgets", value: "health insurance target €240 per period",
    valueNum: 240, unit: "eur", ts: new Date("2026-08-13T10:00:00Z") },
];

describe("renderLiveRows", () => {
  test("emits one line per row, id first, newest-readable date", () => {
    expect(renderLiveRows(live)).toBe(
      "obs_a | 2026-08-13 | budgets: health insurance target €240 per period | 240 eur",
    );
  });

  test("omits the numeric tail when valueNum is null", () => {
    const rows: LiveRow[] = [{ id: "obs_b", predicate: "has", value: "a cargo bike", valueNum: null, unit: null, ts: new Date("2026-07-20T09:00:00Z") }];
    expect(renderLiveRows(rows)).toBe("obs_b | 2026-07-20 | has: a cargo bike");
  });

  test("returns a stated empty marker rather than an empty string", () => {
    expect(renderLiveRows([])).toBe("(no observations on file for this subject)");
  });
});

describe("renderCandidates", () => {
  test("labels candidates c0..cN so within-batch targets are addressable", () => {
    expect(renderCandidates(candidates.slice(0, 2))).toBe(
      "c0 | has: fixed costs: rent €1540, health insurance €240\n" +
      "c1 | confirmed: health insurance is 240 per month",
    );
  });
});

describe("extractNumbers", () => {
  test("strips a thousands separator", () => {
    expect(extractNumbers("rent €1,540 per period")).toEqual([1540]);
  });

  test("keeps a trailing-zero decimal comparably", () => {
    expect(extractNumbers("premium €268.00 per period")).toEqual([268.0]);
  });

  test("parses a plain decimal", () => {
    expect(extractNumbers("fee €9.25 per period")).toEqual([9.25]);
  });

  test("skips a leading tilde", () => {
    expect(extractNumbers("two payments of ~€196.25")).toEqual([196.25]);
  });

  test("finds both numbers when more than one is present", () => {
    expect(extractNumbers("savings target €1,000, saved €2,000")).toEqual([1000, 2000]);
  });

  test("splits an en-dash range into its two endpoints, not a midpoint", () => {
    expect(extractNumbers("eats out approximately 5–6 days per week")).toEqual([5, 6]);
  });

  test("finds nothing in a number-free fact", () => {
    expect(extractNumbers("mini-fridge to store food")).toEqual([]);
  });

  // Round 1 fix: the guard rejected every negative number outright until the
  // sign was captured — which would have nulled the one production row that
  // legitimately carries a valueNum, "-2.0 kg".
  test("captures a leading minus sign after whitespace", () => {
    expect(extractNumbers("lost -2 kg since June")).toEqual([-2]);
  });

  test("captures a leading minus sign after a currency symbol", () => {
    expect(extractNumbers("budget variance of -92.50 eur")).toEqual([-92.5]);
  });

  test("does NOT turn a hyphen range separator into a sign", () => {
    expect(extractNumbers("5-6 days per week")).toEqual([5, 6]);
  });

  test("does NOT turn a hyphen after a letter into a sign", () => {
    expect(extractNumbers("20th-19th")).toEqual([20, 19]);
  });

  test("an en-dash range never carries a sign regardless of context", () => {
    expect(extractNumbers("5–6 days per week")).toEqual([5, 6]);
  });

  test("a hyphenated predicate does not interfere with a real decimal elsewhere in the string", () => {
    expect(extractNumbers("has-health-insurance: premium €268.00")).toEqual([268.0]);
  });
});

describe("parseVerdicts", () => {
  test("parses a well-formed array", () => {
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "has-fixed-cost", value: "rent €1540", valueNum: 1540, unit: "eur", why: "split" },
      { index: 1, verdict: "restates", targetId: "c0", why: "same batch, same fact" },
      { index: 2, verdict: "corrects", targetId: "obs_a", predicate: "budgets", value: "€205.00 actual", valueNum: 205.0, unit: "eur", why: "actual, not target" },
    ]);
    const out = parseVerdicts(text, candidates);
    expect(out.map((r) => r.verdict)).toEqual(["record", "restates", "corrects"]);
    expect(out[0]!.valueNum).toBe(1540);
    expect(out[2]!.targetId).toBe("obs_a");
  });

  test("a candidate with no verdict defaults to record, carrying its own fields", () => {
    const text = JSON.stringify([{ index: 0, verdict: "restates", targetId: "obs_a", why: "dupe" }]);
    const out = parseVerdicts(text, candidates);
    expect(out).toHaveLength(3);
    expect(out[1]!.verdict).toBe("record");
    expect(out[1]!.predicate).toBe("confirmed");
    expect(out[1]!.value).toBe("health insurance is 240 per month");
  });

  // Regression, 2026-08-19. Found by reading the replay's `record` verdicts:
  // EVERY monetary figure in the corpus was being deleted. RECONCILE_SYSTEM
  // tells the model to "put the bare number in valueNum" while rewriting
  // `value` to one concise fact, so the model correctly moves the number OUT
  // of the prose — and the old check then looked for it only in the REWRITTEN
  // value, found nothing, and nulled it. The number vanished from both fields.
  // Measured on the live corpus: "€6,240 per month" -> "take-home income" with
  // valueNum null; "€268.00 per month (health €205.00, life €63)" fanned out to
  // "health insurance" / "life insurance", all three figures gone.
  //
  // The fix checks the ORIGINAL candidate value as well, which is where the
  // operator's own number lives. Both original protections still hold — see
  // the two rejection tests below.
  test("a valueNum the model moved out of a rewritten value survives", () => {
    const cands = [{ subject: "the household", predicate: "take-home-income", value: "€6,240 per month" }];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "take-home-income", value: "monthly take-home income", valueNum: 6240, unit: "eur", why: "normalised" },
    ]);
    const out = parseVerdicts(text, cands);
    expect(out[0]!.valueNum).toBe(6240);
    expect(out[0]!.unit).toBe("eur");
  });

  test("a compound value fanned out keeps each sibling's own figure", () => {
    const cands = [{ subject: "the household", predicate: "insurance-cost", value: "€268.00 per month (health €205.00, life €63)" }];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "insurance-cost", value: "health insurance", valueNum: 205.0, unit: "eur", why: "split" },
      { index: 0, verdict: "record", predicate: "insurance-cost", value: "life insurance", valueNum: 63, unit: "eur", why: "split" },
    ]);
    const out = parseVerdicts(text, cands);
    expect(out.map((r) => r.valueNum)).toEqual([205.0, 63]);
  });

  test("STILL rejects a number that appears in neither the rewrite nor the original", () => {
    // The original defect: `valueNum: 0` on a fact containing no number at all.
    const cands = [{ subject: "the household", predicate: "plans-to-buy", value: "mini-fridge to store food" }];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "plans-to-buy", value: "a mini-fridge", valueNum: 0, unit: "eur", why: "x" },
    ]);
    const out = parseVerdicts(text, cands);
    expect(out[0]!.valueNum).toBeNull();
    expect(out[0]!.unit).toBeNull();
  });

  test("STILL rejects an invented PRECISION the operator never stated", () => {
    // "approximately 5-6 days" carries 5 and 6, never 5.5.
    const cands = [{ subject: "the household", predicate: "eats-out-frequency", value: "eats out approximately 5-6 days per week" }];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "eats-out-frequency", value: "5-6 days per week", valueNum: 5.5, unit: "days", why: "x" },
    ]);
    const out = parseVerdicts(text, cands);
    expect(out[0]!.valueNum).toBeNull();
  });

  test("unparseable output yields all-record, never an empty array", () => {
    const out = parseVerdicts("the model apologised instead of answering", candidates);
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.verdict === "record")).toBe(true);
  });

  test("an unknown verdict string falls back to record", () => {
    const text = JSON.stringify([{ index: 0, verdict: "merge", targetId: "obs_a", why: "invented" }]);
    expect(parseVerdicts(text, candidates)[0]!.verdict).toBe("record");
  });

  test("restates with no targetId falls back to record", () => {
    const text = JSON.stringify([{ index: 1, verdict: "restates", why: "no target named" }]);
    expect(parseVerdicts(text, candidates)[1]!.verdict).toBe("record");
  });

  test("corrects targeting a within-batch candidate falls back to record", () => {
    const text = JSON.stringify([{ index: 2, verdict: "corrects", targetId: "c0", why: "illegal target" }]);
    expect(parseVerdicts(text, candidates)[2]!.verdict).toBe("record");
  });

  test("restates targeting a LATER candidate falls back to record", () => {
    const text = JSON.stringify([{ index: 0, verdict: "restates", targetId: "c2", why: "forward reference" }]);
    expect(parseVerdicts(text, candidates)[0]!.verdict).toBe("record");
  });

  test("restates targeting an EARLIER candidate is kept", () => {
    const text = JSON.stringify([{ index: 1, verdict: "restates", targetId: "c0", why: "same batch" }]);
    expect(parseVerdicts(text, candidates)[1]!.verdict).toBe("restates");
  });

  test("salvages complete objects from a truncated array", () => {
    const text = '[{"index":0,"verdict":"record","predicate":"has","value":"rent","why":"ok"},{"index":1,"verdict":"rest';
    const out = parseVerdicts(text, candidates);
    expect(out[0]!.verdict).toBe("record");
    expect(out[1]!.verdict).toBe("record");
    expect(out).toHaveLength(3);
  });

  // Fix round 1, C2(b): RECONCILE_SYSTEM instructs the model to fan a
  // compound value out into multiple entries "with the same index" — one
  // per fact. The pre-fix-round-1 implementation did `out[index] = {...}`,
  // an overwrite: only the LAST of several same-index entries survived,
  // destroying the others before observations.ts's apply loop ever saw
  // them. This proves accumulation: both index-0 entries must be present,
  // in the order the model emitted them, and the result may be LONGER than
  // `candidates`.
  test("multiple entries at the same index accumulate rather than overwrite (compound-value fan-out)", () => {
    const twoCandidates: ReconcileCandidate[] = [
      { subject: "alex", predicate: "has", value: "rent 1540, health 300" },
      { subject: "alex", predicate: "wants", value: "vacation" },
    ];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "has-rent", value: "rent", valueNum: 1540, unit: "eur", why: "split 1/2" },
      { index: 0, verdict: "record", predicate: "has-health", value: "health insurance", valueNum: 240, unit: "eur", why: "split 2/2" },
      { index: 1, verdict: "record", predicate: "wants", value: "vacation", why: "unchanged" },
    ]);
    const out = parseVerdicts(text, twoCandidates);
    expect(out).toHaveLength(3);
    expect(out[0]!.index).toBe(0);
    expect(out[0]!.predicate).toBe("has-rent");
    expect(out[1]!.index).toBe(0);
    expect(out[1]!.predicate).toBe("has-health");
    expect(out[2]!.index).toBe(1);
    expect(out[2]!.predicate).toBe("wants");
  });

  test("an index with no valid entry still gets the defaultResult fallback, even when a later index fans out", () => {
    const twoCandidates: ReconcileCandidate[] = [
      { subject: "alex", predicate: "has", value: "a" },
      { subject: "alex", predicate: "has", value: "b1, b2" },
    ];
    const text = JSON.stringify([
      { index: 1, verdict: "record", predicate: "has-b1", value: "b1", why: "split 1/2" },
      { index: 1, verdict: "record", predicate: "has-b2", value: "b2", why: "split 2/2" },
      // index 0 never appears.
    ]);
    const out = parseVerdicts(text, twoCandidates);
    expect(out).toHaveLength(3);
    expect(out[0]!.index).toBe(0);
    expect(out[0]!.verdict).toBe("record");
    expect(out[0]!.predicate).toBe("has"); // defaultResult, carrying the candidate's own field
    expect(out[1]!.predicate).toBe("has-b1");
    expect(out[2]!.predicate).toBe("has-b2");
  });

  // Defect 4 in the 2026-08-15 memory-reconciliation findings: the model
  // returned `valueNum: 0` on a fact with no number at all, and separately
  // invented `5.5` on "approximately 5-6 days per week" — a precision the
  // operator never stated and ruled unqueryable noise. A rejected valueNum
  // takes its unit down with it: a unit without a number is meaningless.
  test("valueNum absent from the value text is REJECTED, along with its unit (mini-fridge, no number at all)", () => {
    const fridgeCandidates: ReconcileCandidate[] = [
      { subject: "alex", predicate: "plans-to-buy", value: "mini-fridge to store food" },
    ];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "plans-to-buy", value: "mini-fridge to store food",
        valueNum: 0, unit: "eur", why: "invented" },
    ]);
    const out = parseVerdicts(text, fridgeCandidates);
    expect(out[0]!.valueNum).toBeNull();
    expect(out[0]!.unit).toBeNull();
  });

  test("valueNum with an invented precision not present in a range is REJECTED (5-6 days, not 5.5)", () => {
    const rangeCandidates: ReconcileCandidate[] = [
      { subject: "alex", predicate: "eats-out", value: "eats out approximately 5–6 days per week" },
    ];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "eats-out", value: "eats out approximately 5–6 days per week",
        valueNum: 5.5, unit: "days", why: "averaged the range" },
    ]);
    const out = parseVerdicts(text, rangeCandidates);
    expect(out[0]!.valueNum).toBeNull();
    expect(out[0]!.unit).toBeNull();
  });

  test("a legitimate valueNum that does appear in the value text still passes through untouched", () => {
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "has-fixed-cost", value: "rent €1,540 per period",
        valueNum: 1540, unit: "eur", why: "matches text" },
    ]);
    const out = parseVerdicts(text, candidates);
    expect(out[0]!.valueNum).toBe(1540);
    expect(out[0]!.unit).toBe("eur");
  });

  test("a legitimate valueNum matches despite float representation noise (268.00 text vs 268.0 number)", () => {
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "has-premium", value: "premium €268.00 per period",
        valueNum: 268.0, unit: "eur", why: "matches text" },
    ]);
    const out = parseVerdicts(text, candidates);
    expect(out[0]!.valueNum).toBe(268.0);
    expect(out[0]!.unit).toBe("eur");
  });

  test("a legitimate valueNum matching either end of a stated range is accepted", () => {
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "savings", value: "savings target €1,000, saved €2,000",
        valueNum: 2000, unit: "eur", why: "matches the saved figure" },
    ]);
    const out = parseVerdicts(text, candidates);
    expect(out[0]!.valueNum).toBe(2000);
  });

  test("the defaultResult fail-open path (no verdict returned) is unaffected — both fields stay null as before", () => {
    // Only index 0 gets a verdict; indices 1 and 2 fall through to
    // defaultResult, which already hardcodes valueNum/unit to null.
    const text = JSON.stringify([{ index: 0, verdict: "restates", targetId: "obs_a", why: "dupe" }]);
    const out = parseVerdicts(text, candidates);
    expect(out[1]!.verdict).toBe("record");
    expect(out[1]!.valueNum).toBeNull();
    expect(out[1]!.unit).toBeNull();
  });

  // Round 1 fix: the guard rejected every negative outright, which would
  // have nulled the one production row that legitimately carries a
  // valueNum ("-2.0 kg"). Negatives are entirely plausible in this corpus —
  // weight change, budget variance, temperature.
  test("a legitimate negative valueNum (weight change) is KEPT", () => {
    const weightCandidates: ReconcileCandidate[] = [
      { subject: "alex", predicate: "weight-change", value: "lost -2 kg since June" },
    ];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "weight-change", value: "lost -2 kg since June",
        valueNum: -2, unit: "kg", why: "matches text" },
    ]);
    const out = parseVerdicts(text, weightCandidates);
    expect(out[0]!.valueNum).toBe(-2);
    expect(out[0]!.unit).toBe("kg");
  });

  test("a legitimate negative valueNum (budget variance) is KEPT", () => {
    const budgetCandidates: ReconcileCandidate[] = [
      { subject: "alex", predicate: "budget-variance", value: "budget variance of -92.50 eur" },
    ];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "budget-variance", value: "budget variance of -92.50 eur",
        valueNum: -92.5, unit: "eur", why: "matches text" },
    ]);
    const out = parseVerdicts(text, budgetCandidates);
    expect(out[0]!.valueNum).toBe(-92.5);
    expect(out[0]!.unit).toBe("eur");
  });

  test("a sign the text does not have is REJECTED (range is 5-6, not -5)", () => {
    const rangeCandidates: ReconcileCandidate[] = [
      { subject: "alex", predicate: "eats-out", value: "eats out 5–6 days per week" },
    ];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "eats-out", value: "eats out 5–6 days per week",
        valueNum: -5, unit: "days", why: "invented a sign" },
    ]);
    const out = parseVerdicts(text, rangeCandidates);
    expect(out[0]!.valueNum).toBeNull();
    expect(out[0]!.unit).toBeNull();
  });

  test("weight-change with no number in the value text is still REJECTED — the magnitude belongs in the text, not only the column", () => {
    const bareCandidates: ReconcileCandidate[] = [
      { subject: "alex", predicate: "weight-change", value: "weight-change" },
    ];
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "weight-change", value: "weight-change",
        valueNum: -2, unit: "kg", why: "no number in value text" },
    ]);
    const out = parseVerdicts(text, bareCandidates);
    expect(out[0]!.valueNum).toBeNull();
    expect(out[0]!.unit).toBeNull();
  });

  test("a hyphenated predicate carrying a real decimal still keeps it", () => {
    const text = JSON.stringify([
      { index: 0, verdict: "record", predicate: "has-health-insurance", value: "premium €268.00",
        valueNum: 268.0, unit: "eur", why: "matches text" },
    ]);
    const out = parseVerdicts(text, candidates);
    expect(out[0]!.valueNum).toBe(268.0);
    expect(out[0]!.unit).toBe("eur");
  });
});

describe("reconcileBatch", () => {
  test("returns one result per candidate, in index order", async () => {
    const complete = async () => ({
      text: JSON.stringify([
        { index: 0, verdict: "record", predicate: "has-rent", value: "rent", valueNum: 1540, unit: "eur", why: "split" },
        { index: 1, verdict: "restates", targetId: "c0", why: "same fact" },
        { index: 2, verdict: "record", predicate: "committed", value: "€205.00", valueNum: 205.0, unit: "eur", why: "actual" },
      ]),
    });
    const { reconcileBatch } = createReconcile(fakeHost("scribe"));
    const out = await reconcileBatch({ subjectLabel: "Alex", candidates, liveRows: live, complete });
    expect(out.map((r) => r.verdict)).toEqual(["record", "restates", "record"]);
  });

  test("a thrown model error yields all-record, not an exception", async () => {
    const complete = async () => { throw new Error("upstream 529"); };
    const { reconcileBatch } = createReconcile(fakeHost("scribe"));
    const out = await reconcileBatch({ subjectLabel: "Alex", candidates, liveRows: live, complete });
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.verdict === "record")).toBe(true);
    expect(out[0]!.predicate).toBe("has");
  });

  test("requests the memory tier, never low", async () => {
    let seenTier = "";
    const complete = async (opts: { tier: string }) => { seenTier = opts.tier; return { text: "[]" }; };
    const { reconcileBatch } = createReconcile(fakeHost("scribe"));
    await reconcileBatch({ subjectLabel: "Alex", candidates, liveRows: live, complete: complete as never });
    expect(seenTier).toBe("memory");
  });

  test("an empty candidate list makes no model call at all", async () => {
    let called = false;
    const complete = async () => { called = true; return { text: "[]" }; };
    const { reconcileBatch } = createReconcile(fakeHost("scribe"));
    const out = await reconcileBatch({ subjectLabel: "Alex", candidates: [], liveRows: live, complete: complete as never });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("a liveRow with an invalid Date fails open instead of throwing", async () => {
    const badRows: LiveRow[] = [{ id: "obs_x", predicate: "has", value: "a thing", valueNum: null, unit: null, ts: new Date("not-a-date") }];
    const complete = async () => ({ text: "[]" });
    const { reconcileBatch } = createReconcile(fakeHost("scribe"));
    const out = await reconcileBatch({ subjectLabel: "Alex", candidates, liveRows: badRows, complete: complete as never });
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.verdict === "record")).toBe(true);
  });

  test("final fix wave: the fail-open fallback survives a null candidate — the last safety net must not be the thing that throws", async () => {
    // The catch below is this module's LAST net. Reading `c.predicate` off a
    // null candidate made the net itself throw, converting a recoverable
    // model failure into exactly the lost batch it exists to prevent.
    const holed = [candidates[0]!, null as unknown as ReconcileCandidate];
    const complete = async () => { throw new Error("model unavailable"); };
    const { reconcileBatch } = createReconcile(fakeHost("scribe"));
    const out = await reconcileBatch({ subjectLabel: "Alex", candidates: holed, liveRows: live, complete: complete as never });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.verdict === "record")).toBe(true);
    expect(out[0]!.predicate).toBe("has");
    expect(out[1]!.predicate).toBe("");
  });
});

describe("guardVerdict", () => {
  const shown = new Map([
    ["obs_target", { kind: "targets", topics: ["money", "health"], value: "" }],
    ["obs_actual", { kind: "has", topics: ["money", "health"], value: "" }],
    ["obs_gear", { kind: "owns", topics: ["gear"], value: "" }],
  ]);
  // Batch classifications for c0/c1/c2, coherent with the c1 target used by
  // the "earlier within-batch label" test below.
  const batch = [
    { kind: "has", topics: ["money"], value: "" },
    { kind: "has", topics: ["money"], value: "" },
    { kind: "has", topics: ["money"], value: "" },
  ];
  const base = { shown, batch, index: 3 };

  test("allows `record` unconditionally — it names no target and destroys nothing", () => {
    expect(guardVerdict({ ...base, verdict: "record", targetId: null,
      candidate: { kind: "has", topics: ["money"], value: "" } })).toBeNull();
  });

  test("allows a same-modality, shared-topic merge", () => {
    expect(guardVerdict({ ...base, verdict: "restates", targetId: "obs_actual",
      candidate: { kind: "costs", topics: ["money"], value: "" } })).toBeNull();
  });

  test("BLOCKS intended vs actual — the target-versus-actual collapse", () => {
    expect(guardVerdict({ ...base, verdict: "corrects", targetId: "obs_target",
      candidate: { kind: "has", topics: ["money", "health"], value: "" } })).toMatch(/modality/);
  });

  test("BLOCKS a target sharing no topic with the candidate", () => {
    expect(guardVerdict({ ...base, verdict: "restates", targetId: "obs_gear",
      candidate: { kind: "has", topics: ["money"], value: "" } })).toMatch(/topic/);
  });

  test("BLOCKS a target that was never shown to the model", () => {
    expect(guardVerdict({ ...base, verdict: "restates", targetId: "obs_nonexistent",
      candidate: { kind: "has", topics: ["money"], value: "" } })).toMatch(/not shown/);
  });

  test("BLOCKS a destructive verdict with no target at all", () => {
    expect(guardVerdict({ ...base, verdict: "corrects", targetId: null,
      candidate: { kind: "has", topics: ["money"], value: "" } })).toMatch(/no target/);
  });

  test("BLOCKS `concerned-about` merging with either side — it is a third fact", () => {
    expect(guardVerdict({ ...base, verdict: "restates", targetId: "obs_target",
      candidate: { kind: "concerned-about", topics: ["money"], value: "" } })).toMatch(/modality/);
    expect(guardVerdict({ ...base, verdict: "restates", targetId: "obs_actual",
      candidate: { kind: "concerned-about", topics: ["money"], value: "" } })).toMatch(/modality/);
  });

  test("allows an earlier within-batch label, which the existing guard owns", () => {
    expect(guardVerdict({ ...base, verdict: "restates", targetId: "c1",
      candidate: { kind: "has", topics: ["money"], value: "" } })).toBeNull();
  });

  test("BLOCKS a within-batch label pointing at or after itself", () => {
    expect(guardVerdict({ ...base, verdict: "restates", targetId: "c3",
      candidate: { kind: "has", topics: ["money"], value: "" } })).toMatch(/earlier/);
    expect(guardVerdict({ ...base, verdict: "restates", targetId: "c9",
      candidate: { kind: "has", topics: ["money"], value: "" } })).toMatch(/earlier/);
  });

  // Fix round 1, CRITICAL a: a within-batch `restates` used to bypass every
  // coherence check after the direction test — modality and shared-topic
  // never ran against the sibling. This pins that the sibling path now goes
  // through the same checks as a stored target.
  test("BLOCKS a within-batch restates whose sibling is a different modality", () => {
    const siblingBatch = [{ kind: "concerned-about", topics: ["gear"], value: "" }];
    expect(guardVerdict({ shown, batch: siblingBatch, index: 3, verdict: "restates", targetId: "c0",
      candidate: { kind: "has", topics: ["gear"], value: "" } })).toMatch(/modality/);
  });

  // Fix round 1, CRITICAL b: `if (a !== b)` alone (dropping the neither
  // clause) still satisfies every test above, because both "third fact"
  // cases pair `neither` against `intended`/`actual`. These pin the clause
  // that specifically protects a variance row like "budget over by €92.50"
  // from merging into another worry, or two unrecognised kinds from merging
  // into each other.
  test("BLOCKS neither-vs-neither: two concerned-about rows are still two distinct facts", () => {
    const shown = new Map([["obs_worry", { kind: "concerned-about", topics: ["money"], value: "" }]]);
    expect(guardVerdict({ shown, batch: [], index: 3, verdict: "corrects", targetId: "obs_worry",
      candidate: { kind: "concerned-about", topics: ["money"], value: "" } })).toMatch(/modality/);
  });

  test("BLOCKS general-vs-general: two unrecognised kinds must not merge either", () => {
    const shown = new Map([["obs_x", { kind: "general", topics: ["money"], value: "" }]]);
    expect(guardVerdict({ shown, batch: [], index: 3, verdict: "restates", targetId: "obs_x",
      candidate: { kind: "general", topics: ["money"], value: "" } })).toMatch(/modality/);
  });

  // IMPORTANT c: "general" is the classifier's fallback bucket (~12% of rows
  // in a real pass). Two unrelated rows that both defaulted there must not
  // be treated as sharing a topic.
  test("BLOCKS a shared-topic check when the only shared topic is the general fallback", () => {
    const shown = new Map([["obs_g", { kind: "has", topics: ["general"], value: "" }]]);
    expect(guardVerdict({ shown, batch: [], index: 3, verdict: "restates", targetId: "obs_g",
      candidate: { kind: "costs", topics: ["general"], value: "" } })).toMatch(/topic/);
  });
});

describe("guardVerdict — numeric disagreement", () => {
  const shown = (id: string, kind: string, topics: string[], value: string) =>
    new Map([[id, { kind, topics, value }]]);

  test("blocks a restates whose numbers are disjoint from its target", () => {
    // The acceptance case: both rows are ACTUAL and share `money`, so the
    // modality and topic clauses both pass. Only the numbers separate them.
    const reason = guardVerdict({
      verdict: "restates",
      targetId: "row1",
      candidate: { kind: "has", topics: ["money", "health"], value: "Meridian health insurance, premium €268.00 per period" },
      shown: shown("row1", "has", ["health", "money"], "confirmed health insurance is €240/mo and life insurance €63/mo"),
      batch: [],
      index: 0,
    });
    expect(reason).toMatch(/numeric disagreement/);
  });

  test("allows a restates whose numbers overlap", () => {
    const reason = guardVerdict({
      verdict: "restates",
      targetId: "row1",
      candidate: { kind: "has", topics: ["money"], value: "€240 per month to a.s.r." },
      shown: shown("row1", "has", ["money"], "health insurance €240, life insurance €63"),
      batch: [],
      index: 0,
    });
    expect(reason).toBeNull();
  });

  test("allows a restates when either side carries no number", () => {
    const reason = guardVerdict({
      verdict: "restates",
      targetId: "row1",
      candidate: { kind: "has", topics: ["gear"], value: "owns a Lovens cargo bike" },
      shown: shown("row1", "has", ["gear"], "has a cargo bike, €1,900"),
      batch: [],
      index: 0,
    });
    expect(reason).toBeNull();
  });

  test("does NOT apply to corrects — a misread figure legitimately differs", () => {
    const reason = guardVerdict({
      verdict: "corrects",
      targetId: "row1",
      candidate: { kind: "has", topics: ["money"], value: "rent is €1,540 per month" },
      shown: shown("row1", "has", ["money"], "rent is €1,504 per month"),
      batch: [],
      index: 0,
    });
    expect(reason).toBeNull();
  });

  test("thousands separators do not split into two numbers", () => {
    // "€1,540" must parse {1540}, not {2, 308}; otherwise identical rent rows
    // would read as disjoint and be blocked.
    const reason = guardVerdict({
      verdict: "restates",
      targetId: "row1",
      candidate: { kind: "has", topics: ["money"], value: "rent €1,540 per month" },
      shown: shown("row1", "has", ["money"], "rent 1540 per month including utilities"),
      batch: [],
      index: 0,
    });
    expect(reason).toBeNull();
  });

  test("applies to a within-batch c<N> target too", () => {
    const reason = guardVerdict({
      verdict: "restates",
      targetId: "c0",
      candidate: { kind: "costs", topics: ["money"], value: "transport spend €1,120.40" },
      shown: new Map(),
      batch: [
        { kind: "costs", topics: ["money"], value: "groceries spend €560.40" },
        { kind: "costs", topics: ["money"], value: "transport spend €1,120.40" },
      ],
      index: 1,
    });
    expect(reason).toMatch(/numeric disagreement/);
  });
});
