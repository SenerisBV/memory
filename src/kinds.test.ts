import { describe, expect, test } from "bun:test";
import { KINDS, modality, DEFAULT_KIND } from "./kinds";

describe("KINDS", () => {
  test("22 kinds, and `general` is the fallback", () => {
    expect(KINDS.length).toBe(22);
    expect(KINDS).toContain(DEFAULT_KIND);
  });
});

describe("modality", () => {
  test("intended covers the aspirational kinds", () => {
    for (const k of ["targets", "committed-to", "plans", "wants", "needs", "decided", "prefers", "considering", "values", "interested-in"]) {
      expect(modality(k)).toBe("intended");
    }
  });

  test("actual covers the observed kinds", () => {
    for (const k of ["costs", "has", "owns", "earns", "acquired", "completed", "uses", "attends"]) {
      expect(modality(k)).toBe("actual");
    }
  });

  test("concerned-about is neither, so it can never merge with either side", () => {
    expect(modality("concerned-about")).toBe("neither");
  });

  test("an unknown or minted kind is `neither` — it must not merge by accident", () => {
    expect(modality("overspends")).toBe("neither");
    expect(modality("general")).toBe("neither");
  });

  test("waiting-on and instructs are intended — both are forward-looking, added after the phase-1 backfill's tripwire caught the gap", () => {
    expect(modality("waiting-on")).toBe("intended");
    expect(modality("instructs")).toBe("intended");
  });
});
