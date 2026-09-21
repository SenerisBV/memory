// Ported verbatim from src/lib/memory/grade.test.ts (byte-identical in both
// repos, zero host coupling — pure logic).
import { describe, expect, test } from "bun:test";
import { clampGrade, gradeForSource, gradeRank, isValidGrade } from "./grade";

describe("grade", () => {
  test("rank orders A1 best, F6 worst", () => {
    expect(gradeRank("A1")).toBeLessThan(gradeRank("C3"));
    expect(gradeRank("C3")).toBeLessThan(gradeRank("F6"));
  });
  test("invalid grades are worst", () => {
    expect(isValidGrade("Z9")).toBe(false);
    expect(gradeRank("Z9")).toBe(99);
  });
  test("clampGrade keeps a worse proposed grade (downgrade allowed)", () => {
    expect(clampGrade("F6", "C3")).toBe("F6");
  });
  test("clampGrade clamps a better proposed grade down to the ceiling", () => {
    expect(clampGrade("A1", "C3")).toBe("C3");
  });
  test("gradeForSource: contributions trusted, inferences not", () => {
    expect(gradeRank(gradeForSource("contribution"))).toBeLessThan(gradeRank(gradeForSource("inferred")));
    expect(gradeForSource("unknown-source")).toBe("F6");
  });
  test("research source has a mid-high ceiling", () => {
    expect(gradeForSource("research")).toBe("C2");
  });
});
