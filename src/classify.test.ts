import { describe, expect, test } from "bun:test";
import { parseClassifications, classifySystemPrompt, createClassify } from "./classify";
import type { MemoryHost } from "./host";
import { DEFAULT_REGISTRY } from "./registry";

function fakeHost(): MemoryHost {
  return { agentId: "scribe", registry: DEFAULT_REGISTRY } as unknown as MemoryHost;
}

describe("classifySystemPrompt", () => {
  test("shows every topic with its gloss and every kind", () => {
    const prompt = classifySystemPrompt(DEFAULT_REGISTRY);
    expect(prompt).toContain("money:");
    expect(prompt).toContain("meta:");
    expect(prompt).toContain("committed-to");
    expect(prompt).toContain("PRIMARY");
  });
});

describe("parseClassifications", () => {
  test("maps entries onto their index", () => {
    const out = parseClassifications(DEFAULT_REGISTRY,
      JSON.stringify({ classifications: [
        { index: 0, topics: ["money", "health"], kind: "has" },
        { index: 1, topics: ["work"], kind: "attends" },
      ] }), 2);
    expect(out).toEqual([
      { kind: "has", topics: ["money", "health"] },
      { kind: "attends", topics: ["work"] },
    ]);
  });

  test("an omitted index defaults to general/general rather than shifting others", () => {
    const out = parseClassifications(DEFAULT_REGISTRY,
      JSON.stringify({ classifications: [{ index: 2, topics: ["gear"], kind: "owns" }] }), 3);
    expect(out.length).toBe(3);
    expect(out[0]).toEqual({ kind: "general", topics: ["general"] });
    expect(out[1]).toEqual({ kind: "general", topics: ["general"] });
    expect(out[2]).toEqual({ kind: "owns", topics: ["gear"] });
  });

  test("unknown topics and kinds are dropped, not written through", () => {
    const out = parseClassifications(DEFAULT_REGISTRY,
      JSON.stringify({ classifications: [{ index: 0, topics: ["money", "sportsball"], kind: "overspends" }] }), 1);
    expect(out[0]!.topics).toEqual(["money"]);
    expect(out[0]!.kind).toBe("general");
  });

  test("a row whose topics are ALL unknown falls back to general, never empty", () => {
    const out = parseClassifications(DEFAULT_REGISTRY,
      JSON.stringify({ classifications: [{ index: 0, topics: ["sportsball"], kind: "has" }] }), 1);
    expect(out[0]!.topics).toEqual(["general"]);
  });

  test("topics are capped at three, order preserved (primary first)", () => {
    const out = parseClassifications(DEFAULT_REGISTRY,
      JSON.stringify({ classifications: [{ index: 0, topics: ["money", "health", "family", "work"], kind: "has" }] }), 1);
    expect(out[0]!.topics).toEqual(["money", "health", "family"]);
  });

  test("unparseable text yields all-defaults, not a throw", () => {
    const out = parseClassifications(DEFAULT_REGISTRY, "the model said something else entirely", 2);
    expect(out).toEqual([
      { kind: "general", topics: ["general"] },
      { kind: "general", topics: ["general"] },
    ]);
  });
});

describe("classifyBatch", () => {
  test("returns one classification per item", async () => {
    const complete = async () => ({ text: JSON.stringify({ classifications: [
      { index: 0, topics: ["money"], kind: "costs" },
      { index: 1, topics: ["travel", "family"], kind: "plans" },
    ] }) });
    const out = await createClassify(fakeHost()).classifyBatch({
      items: [{ predicate: "pays-rent", value: "rent €1,540" }, { predicate: "plans", value: "bikepacking trip" }],
      complete,
    });
    expect(out).toEqual([
      { kind: "costs", topics: ["money"] },
      { kind: "plans", topics: ["travel", "family"] },
    ]);
  });

  test("a thrown completion fails SAFE to general, one per item, and does not propagate", async () => {
    const complete = async () => { throw new Error("mlx is down"); };
    const out = await createClassify(fakeHost()).classifyBatch({
      items: [{ predicate: "a", value: "b" }, { predicate: "c", value: "d" }],
      complete,
    });
    expect(out).toEqual([
      { kind: "general", topics: ["general"] },
      { kind: "general", topics: ["general"] },
    ]);
  });

  test("an empty item list makes no completion call", async () => {
    let calls = 0;
    const complete = async () => { calls++; return { text: "[]" }; };
    const out = await createClassify(fakeHost()).classifyBatch({ items: [], complete });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
