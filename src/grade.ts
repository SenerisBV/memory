// Ported verbatim from src/lib/memory/grade.ts (byte-identical in both
// repos, zero host coupling).
//
// Admiralty-style source grading. A grade is a reliability letter (A best …
// F worst) followed by a credibility digit (1 best … 6 worst), e.g. "C3".
// Grades are stamped at write time and may only be DOWNGRADED past a
// source's default ceiling, never inflated — the extractor can say "less
// sure", never "more sure", than the source type warrants.
const RELIABILITY = "ABCDEF";
const CREDIBILITY = "123456";

export function isValidGrade(grade: string): boolean {
  return (
    typeof grade === "string" &&
    grade.length === 2 &&
    RELIABILITY.includes(grade[0]!) &&
    CREDIBILITY.includes(grade[1]!)
  );
}

// Lower is better. Invalid grades sort worst (99).
export function gradeRank(grade: string): number {
  if (!isValidGrade(grade)) return 99;
  return RELIABILITY.indexOf(grade[0]!) * 6 + CREDIBILITY.indexOf(grade[1]!);
}

// Returns the more pessimistic (higher-rank) of proposed vs ceiling — so a
// model may downgrade below the ceiling but can never beat it.
export function clampGrade(proposed: string, ceiling: string): string {
  const safeProposed = isValidGrade(proposed) ? proposed : "F6";
  const safeCeiling = isValidGrade(ceiling) ? ceiling : "F6";
  return gradeRank(safeProposed) >= gradeRank(safeCeiling) ? safeProposed : safeCeiling;
}

// Default ceiling per source type. Deliberate principal contributions are
// trusted; statements in conversation/email are mid; pure inference is
// "cannot judge".
const SOURCE_CEILINGS: Record<string, string> = {
  contribution: "A2",
  "office-visit": "C3",
  email: "C3",
  "principal-writing": "C2",
  decision: "B2",
  inferred: "F6",
  research: "C2",
};

export function gradeForSource(source: string): string {
  return SOURCE_CEILINGS[source] ?? "F6";
}
