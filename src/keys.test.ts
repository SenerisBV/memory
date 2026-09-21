// Originally ported verbatim from src/lib/memory/keys.test.ts (byte-identical
// in both repos, zero host coupling — pure logic).
import { describe, expect, test } from "bun:test";
import { buildNaturalKey, slugifyEntity, stripLeadingH1, subjectFile, anticipationsFile, typedKey } from "./keys";

describe("keys", () => {
  test("slugifyEntity normalizes and strips articles", () => {
    expect(slugifyEntity("The Post-Executive Org")).toBe("post-executive-org");
    expect(slugifyEntity("Alex's taste")).toBe("alexs-taste");
  });
  test("buildNaturalKey joins non-empty parts, null if all empty", () => {
    expect(buildNaturalKey(["preference", "preambles"])).toBe("preference:preambles");
    expect(buildNaturalKey([null, undefined, ""])).toBeNull();
  });
});

describe("stripLeadingH1", () => {
  test("strips a leading H1 title", () => {
    expect(stripLeadingH1("# Alex\n\n## Model\n- a")).toBe("## Model\n- a");
  });
  test("preserves a leading H2 section heading", () => {
    expect(stripLeadingH1("## Model\n- a")).toBe("## Model\n- a");
    expect(stripLeadingH1("## Across the set\n- a")).toBe("## Across the set\n- a");
  });
});

test("typedKey namespaces model text and refuses the unsluggable", () => {
  expect(typedKey("pursuit", "Arizona Trip!")).toBe("pursuit:arizona-trip");
  expect(typedKey("thing", "The Bakfiets")).toBe("thing:bakfiets");
  expect(() => typedKey("thing", "…")).toThrow(/nothing sluggable/);
});
test("subjectFile maps the key's colon to a dash", () => {
  expect(subjectFile("person:alex")).toBe("subjects/person-alex.md");
  expect(anticipationsFile("group:household")).toBe("subjects/group-household.anticipations.md");
});
