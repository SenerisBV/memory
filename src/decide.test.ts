import { describe, expect, test } from "bun:test";
import { decide, groupByPrimaryTopic, RETRIEVAL_CAP, type DecideLiveRow } from "./decide";

describe("groupByPrimaryTopic", () => {
  test("groups candidates by topics[0] and keeps batch indices", () => {
    const groups = groupByPrimaryTopic([
      { kind: "costs", topics: ["money", "health"] },
      { kind: "owns", topics: ["gear"] },
      { kind: "targets", topics: ["money"] },
    ]);
    expect(groups).toEqual([
      { topic: "gear", indices: [1] },
      { topic: "money", indices: [0, 2] },
    ]);
  });

  test("orders groups by topic name, deterministically", () => {
    // Ordering has produced three separate defects in this project. Group
    // order decides model-call order, so it is pinned.
    const groups = groupByPrimaryTopic([
      { kind: "uses", topics: ["work"] },
      { kind: "has", topics: ["_fleet"] },
      { kind: "costs", topics: ["money"] },
    ]);
    expect(groups.map((g) => g.topic)).toEqual(["_fleet", "money", "work"]);
  });

  test("indices within a group stay in ascending batch order", () => {
    const groups = groupByPrimaryTopic([
      { kind: "costs", topics: ["money"] },
      { kind: "costs", topics: ["money"] },
      { kind: "costs", topics: ["money"] },
    ]);
    expect(groups[0]!.indices).toEqual([0, 1, 2]);
  });

  test("a missing or empty topics array falls back to general", () => {
    const groups = groupByPrimaryTopic([
      { kind: "general", topics: [] },
      { kind: "has", topics: ["money"] },
    ]);
    expect(groups).toEqual([
      { topic: "general", indices: [0] },
      { topic: "money", indices: [1] },
    ]);
  });

  test("the cap is 80", () => {
    expect(RETRIEVAL_CAP).toBe(80);
  });
});

const row = (over: Partial<DecideLiveRow> & { id: string }): DecideLiveRow => ({
  about: ["person:x"], predicate: "p", value: "v", valueNum: null, unit: null, ts: new Date("2026-08-13"),
  authorAgent: "scribe", visibility: "fleet", kind: "has", topics: ["money"], ...over,
});

describe("decide", () => {
  test("issues one reconcile call per primary-topic group, each seeing only its topic", async () => {
    const seen: { topic: string | null; limit: number; about: string[] }[] = [];
    const calls: DecideLiveRow[][] = [];
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [
        { predicate: "costs", value: "groceries €560" },
        { predicate: "owns", value: "a cargo bike" },
      ],
      classify: async () => [
        { kind: "costs", topics: ["money"] },
        { kind: "owns", topics: ["gear"] },
      ],
      fetchLiveRows: async (a) => {
        seen.push(a);
        return { rows: [row({ id: `${a.topic}-1` })], matched: 1 };
      },
      reconcile: async (a) => {
        calls.push(a.liveRows);
        return a.candidates.map((_, i) => ({
          index: i, verdict: "record" as const, targetId: null,
          predicate: "p", value: "v", valueNum: null, unit: null, why: "new",
        }));
      },
    });

    expect(seen).toEqual([
      { topic: "gear", limit: 80, about: ["person:x"] },
      { topic: "money", limit: 80, about: ["person:x"] },
    ]);
    expect(calls[0]![0]!.id).toBe("gear-1");
    expect(calls[1]![0]!.id).toBe("money-1");
    expect(result.groups.map((g) => g.topic)).toEqual(["gear", "money"]);
  });

  test("remaps per-group verdict indices back to batch indices", async () => {
    // The `gear` candidate is batch index 1 but local c0 in its own call.
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [
        { predicate: "costs", value: "groceries €560" },
        { predicate: "owns", value: "a cargo bike" },
      ],
      classify: async () => [
        { kind: "costs", topics: ["money"] },
        { kind: "owns", topics: ["gear"] },
      ],
      fetchLiveRows: async () => ({ rows: [], matched: 0 }),
      reconcile: async (a) => a.candidates.map((_, i) => ({
        index: i, verdict: "record" as const, targetId: null,
        predicate: "rewritten", value: "v", valueNum: null, unit: null, why: "new",
      })),
    });
    expect(result.verdicts.map((v) => v.index).sort()).toEqual([0, 1]);
  });

  test("the general group is retrieved UNSCOPED", async () => {
    const seen: (string | null)[] = [];
    await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [{ predicate: "noted", value: "something" }],
      classify: async () => [{ kind: "general", topics: ["general"] }],
      fetchLiveRows: async (a) => { seen.push(a.topic); return { rows: [], matched: 0 }; },
      reconcile: async (a) => a.candidates.map((_, i) => ({
        index: i, verdict: "record" as const, targetId: null,
        predicate: "p", value: "v", valueNum: null, unit: null, why: "new",
      })),
    });
    expect(seen).toEqual([null]);
  });

  test("one group failing open does not cost the other groups", async () => {
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [
        { predicate: "costs", value: "groceries €560" },
        { predicate: "owns", value: "a cargo bike" },
      ],
      classify: async () => [
        { kind: "costs", topics: ["money"] },
        { kind: "owns", topics: ["gear"] },
      ],
      fetchLiveRows: async () => ({ rows: [], matched: 0 }),
      reconcile: async (a) => {
        if (a.liveRows.length === 0 && (a.candidates[0]! as { value: string }).value === "a cargo bike") {
          throw new Error("unparseable JSON");
        }
        return a.candidates.map((_, i) => ({
          index: i, verdict: "record" as const, targetId: null,
          predicate: "reconciled", value: "v", valueNum: null, unit: null, why: "ok",
        }));
      },
    });
    const gear = result.groups.find((g) => g.topic === "gear")!;
    const money = result.groups.find((g) => g.topic === "money")!;
    expect(gear.failedOpen).toBe(true);
    expect(money.failedOpen).toBe(false);
    expect(result.verdicts.find((v) => v.index === 1)!.why).toMatch(/unreconciled/);
    expect(result.verdicts.find((v) => v.index === 0)!.predicate).toBe("reconciled");
  });

  test("a reconciler returning an out-of-range local index fails that group open, others unaffected", async () => {
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [
        { predicate: "costs", value: "groceries €560" },
        { predicate: "owns", value: "a cargo bike" },
      ],
      classify: async () => [
        { kind: "costs", topics: ["money"] },
        { kind: "owns", topics: ["gear"] },
      ],
      fetchLiveRows: async () => ({ rows: [], matched: 0 }),
      reconcile: async (a) => {
        // `gear` has exactly one candidate — local index 0 is the only valid
        // one. Coverage is satisfied (index 0 is present, EXTRA verdicts are
        // legal fan-out) — the stray at local index 5 is the only thing the
        // range check has to reject. Returning ONLY the stray (no index 0)
        // would make the pre-existing coverage check fail the group open on
        // its own, and this test would then pass whether or not the range
        // check exists at all.
        if (a.candidates.length === 1 && a.candidates[0]?.value === "a cargo bike") {
          return [
            {
              index: 0, verdict: "record" as const, targetId: null,
              predicate: "p", value: "v", valueNum: null, unit: null, why: "the real one",
            },
            {
              index: 5, verdict: "record" as const, targetId: null,
              predicate: "p", value: "v", valueNum: null, unit: null, why: "bogus",
            },
          ];
        }
        return a.candidates.map((_, i) => ({
          index: i, verdict: "record" as const, targetId: null,
          predicate: "reconciled", value: "v", valueNum: null, unit: null, why: "ok",
        }));
      },
    });
    const gear = result.groups.find((g) => g.topic === "gear")!;
    const money = result.groups.find((g) => g.topic === "money")!;
    expect(gear.failedOpen).toBe(true);
    // Not "the real one": if the range check merely dropped/ignored the
    // stray and kept the valid index-0 verdict, this would read "p" instead
    // of the fail-open placeholder — proving the whole GROUP fell back, not
    // just the stray entry.
    expect(result.verdicts.find((v) => v.index === 1)!.why).toMatch(/unreconciled/);
    expect(result.verdicts.find((v) => v.index === 1)!.predicate).not.toBe("p");
    expect(money.failedOpen).toBe(false);
    expect(result.verdicts.find((v) => v.index === 0)!.predicate).toBe("reconciled");
  });

  test("a group with missing candidate coverage fails open for that group", async () => {
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [
        { predicate: "costs", value: "a" },
        { predicate: "costs", value: "b" },
      ],
      classify: async () => [
        { kind: "costs", topics: ["money"] },
        { kind: "costs", topics: ["money"] },
      ],
      fetchLiveRows: async () => ({ rows: [], matched: 0 }),
      reconcile: async () => [{
        index: 0, verdict: "record" as const, targetId: null,
        predicate: "p", value: "v", valueNum: null, unit: null, why: "only one",
      }],
    });
    expect(result.groups[0]!.failedOpen).toBe(true);
    expect(result.verdicts).toHaveLength(2);
  });

  test("reports rows discarded by the cap", async () => {
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [{ predicate: "costs", value: "groceries €560" }],
      classify: async () => [{ kind: "costs", topics: ["money"] }],
      fetchLiveRows: async () => ({
        rows: Array.from({ length: 80 }, (_, i) => row({ id: `r${i}` })),
        matched: 204,
      }),
      reconcile: async (a) => a.candidates.map((_, i) => ({
        index: i, verdict: "record" as const, targetId: null,
        predicate: "p", value: "v", valueNum: null, unit: null, why: "new",
      })),
    });
    expect(result.groups[0]!).toMatchObject({ matched: 204, shown: 80, discarded: 124 });
  });

  test("caps rows defensively when fetchLiveRows over-returns", async () => {
    // The contract says `rows` arrives already capped, but `fetchLiveRows` is
    // an injected seam — an over-returning caller must not blow the reconcile
    // context, and `discarded` must still reflect the real overflow rather
    // than reading as zero.
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [{ predicate: "costs", value: "groceries €560" }],
      classify: async () => [{ kind: "costs", topics: ["money"] }],
      fetchLiveRows: async () => ({
        rows: Array.from({ length: 200 }, (_, i) => row({ id: `r${i}` })),
        matched: 204,
      }),
      reconcile: async (a) => {
        expect(a.liveRows.length).toBeLessThanOrEqual(80);
        return a.candidates.map((_, i) => ({
          index: i, verdict: "record" as const, targetId: null,
          predicate: "p", value: "v", valueNum: null, unit: null, why: "new",
        }));
      },
    });
    expect(result.groups[0]!).toMatchObject({ matched: 204, shown: 80, discarded: 124 });
  });

  test("applies the guard, scoped to the rows THIS group was shown", async () => {
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [{ predicate: "has-health-insurance", value: "premium €268.00 per period" }],
      classify: async () => [{ kind: "has", topics: ["money", "health"] }],
      fetchLiveRows: async () => ({
        rows: [row({ id: "r1", kind: "has", topics: ["money"], value: "health insurance €240/mo" })],
        matched: 1,
      }),
      reconcile: async () => [{
        index: 0, verdict: "restates" as const, targetId: "r1",
        predicate: "has-health-insurance", value: "premium €268.00 per period",
        valueNum: 268.0, unit: "eur", why: "same fact",
      }],
    });
    const v = result.verdicts[0]!;
    expect(v.verdict).toBe("record");
    expect(result.notes.get(v)).toMatch(/numeric disagreement/);
    expect(result.groups[0]!.blocked).toBe(1);
  });

  test("a target in ANOTHER group's rows is blocked as not shown", async () => {
    // `gear` is processed FIRST (alphabetical), so "gear-1" is already in the
    // union `shown` map by the time `money` (processed SECOND) runs. Having
    // the LATER group target the EARLIER group's row — rather than the
    // reverse — is what discriminates a per-group `shownForGroup` from the
    // union `shown`: an implementation that wrongly passed the union to
    // guardVerdict would find "gear-1" already present and let the restates
    // through, landing on a DIFFERENT block reason (or none at all) instead
    // of "was not shown". Asserting the reason string is what catches that.
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [
        { predicate: "costs", value: "groceries €560" },
        { predicate: "owns", value: "a cargo bike" },
      ],
      classify: async () => [
        { kind: "costs", topics: ["money"] },
        { kind: "owns", topics: ["gear"] },
      ],
      fetchLiveRows: async (a) => ({ rows: [row({ id: `${a.topic}-1`, topics: [a.topic!] })], matched: 1 }),
      reconcile: async (a) => {
        const isMoneyGroup = a.liveRows[0]?.id === "money-1";
        return a.candidates.map((_, i) => ({
          index: i,
          verdict: isMoneyGroup ? ("restates" as const) : ("record" as const),
          targetId: isMoneyGroup ? "gear-1" : null,
          predicate: "p", value: "v", valueNum: null, unit: null, why: "x",
        }));
      },
    });
    const moneyVerdict = result.verdicts.find((v) => v.index === 0)!;
    expect(moneyVerdict.verdict).toBe("record");
    expect(result.notes.get(moneyVerdict)).toMatch(/was not shown/);
  });

  test("shown is the union across groups", async () => {
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [
        { predicate: "costs", value: "a" },
        { predicate: "owns", value: "b" },
      ],
      classify: async () => [
        { kind: "costs", topics: ["money"] },
        { kind: "owns", topics: ["gear"] },
      ],
      fetchLiveRows: async (a) => ({ rows: [row({ id: `${a.topic}-1` })], matched: 1 }),
      reconcile: async (a) => a.candidates.map((_, i) => ({
        index: i, verdict: "record" as const, targetId: null,
        predicate: "p", value: "v", valueNum: null, unit: null, why: "new",
      })),
    });
    expect([...result.shown.keys()].sort()).toEqual(["gear-1", "money-1"]);
  });

  test("classify under-returning: the extra candidate falls back to general, retrieved unscoped, and its restates is guard-blocked", async () => {
    // A regression reverting the `rawClassified` normalization would keep
    // `classified` at length 1 here, dropping candidate 1 from every group
    // silently rather than routing it to `general`.
    const seenTopics: (string | null)[] = [];
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [
        { predicate: "costs", value: "groceries €560" },
        { predicate: "owns", value: "a cargo bike" },
      ],
      // Only ONE entry for TWO candidates — the injected seam under-returning.
      classify: async () => [{ kind: "costs", topics: ["money"] }],
      fetchLiveRows: async (a) => {
        seenTopics.push(a.topic);
        return {
          rows: [row({ id: a.topic ? `${a.topic}-1` : "general-1", topics: a.topic ? [a.topic] : ["general"] })],
          matched: 1,
        };
      },
      reconcile: async (a) => a.candidates.map((_, i) => ({
        index: i, verdict: "restates" as const, targetId: a.liveRows[0]!.id,
        predicate: "p", value: "v", valueNum: null, unit: null, why: "x",
      })),
    });
    expect(seenTopics).toContain(null);
    const fallbackGroup = result.groups.find((g) => g.topic === "general")!;
    expect(fallbackGroup.candidates).toBe(1);
    const fallbackVerdict = result.verdicts.find((v) => v.index === 1)!;
    expect(fallbackVerdict.verdict).toBe("record");
    expect(result.notes.get(fallbackVerdict)).toBeDefined();
  });

  test("classify over-returning: the extra entry is dropped, exactly the batch's candidates are reconciled", async () => {
    // A regression reverting the normalization could instead index off the
    // longer `rawClassified` array and produce a phantom `work` group
    // referencing a nonexistent third candidate.
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [
        { predicate: "costs", value: "groceries €560" },
        { predicate: "owns", value: "a cargo bike" },
      ],
      // THREE entries for TWO candidates — the injected seam over-returning.
      classify: async () => [
        { kind: "costs", topics: ["money"] },
        { kind: "owns", topics: ["gear"] },
        { kind: "uses", topics: ["work"] },
      ],
      fetchLiveRows: async () => ({ rows: [], matched: 0 }),
      reconcile: async (a) => a.candidates.map((_, i) => ({
        index: i, verdict: "record" as const, targetId: null,
        predicate: "p", value: "v", valueNum: null, unit: null, why: "new",
      })),
    });
    expect(result.classified).toHaveLength(2);
    expect(result.groups.map((g) => g.topic)).toEqual(["gear", "money"]);
    expect(result.groups.reduce((n, g) => n + g.candidates, 0)).toBe(2);
    expect(result.verdicts.map((v) => v.index).sort()).toEqual([0, 1]);
  });

  test("a c<N> target leaves decide in BATCH coordinates, not group-local ones", async () => {
    // `c<N>` labels are POSITIONS in a group's own reconcile call. `index` is
    // remapped to batch coordinates on the way out; `targetId` was not — so a
    // second group's "restates c0" left decide naming candidate 0 of the
    // BATCH: a different candidate, in a different topic group, potentially
    // about entirely different subjects. Everything leaving decide has to be
    // in one coordinate system, or the caller's `label < v.index` check
    // compares two.
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [
        { predicate: "owns", value: "a cargo bike" },      // 0 → gear
        { predicate: "costs", value: "rent 1540" },        // 1 → money
        { predicate: "owns", value: "a trailer" },         // 2 → gear
        { predicate: "costs", value: "rent 1540 again" },  // 3 → money
      ],
      classify: async () => [
        { kind: "owns", topics: ["gear"] },
        { kind: "costs", topics: ["money"] },
        { kind: "owns", topics: ["gear"] },
        { kind: "costs", topics: ["money"] },
      ],
      fetchLiveRows: async () => ({ rows: [], matched: 0 }),
      reconcile: async (a) => a.candidates.map((c, i) => ({
        index: i,
        verdict: (i === 1 ? "restates" : "record") as "restates" | "record",
        targetId: i === 1 ? "c0" : null,
        predicate: c.predicate ?? "", value: c.value ?? "", valueNum: null, unit: null, why: "t",
      })),
    });
    // Groups are gear [0, 2] then money [1, 3]. Inside the money group, local
    // c0 is BATCH candidate 1, and the restating candidate is local 1 = batch 3.
    const restating = result.verdicts.find((v) => v.index === 3)!;
    expect(restating.verdict).toBe("restates"); // the guard let it stand
    expect(restating.targetId).toBe("c1");
    // The gear group's indices are [0, 2], so ITS local c0 really is batch 0 —
    // the same rewrite, landing on the value it already had. That is what
    // made the defect invisible for the first group and only the first.
    const gearRestating = result.verdicts.find((v) => v.index === 2)!;
    expect(gearRestating.targetId).toBe("c0");
  });

  test("no candidates means no model calls at all", async () => {
    let called = 0;
    const result = await decide({
      subjectLabel: "Alex",
      about: ["person:x"],
      candidates: [],
      classify: async () => { called++; return []; },
      fetchLiveRows: async () => { called++; return { rows: [], matched: 0 }; },
      reconcile: async () => { called++; return []; },
    });
    expect(called).toBe(0);
    expect(result.verdicts).toEqual([]);
    expect(result.groups).toEqual([]);
  });
});
