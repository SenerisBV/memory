// Ported verbatim from src/lib/memory/anticipation.test.ts (byte-identical
// in both repos, zero host coupling — pure logic).
import { describe, expect, test } from "bun:test";
import { extractAnticipationSection, filterGroundedAnticipations } from "./anticipation";

const doc = [
  "# A Subject", "", "## Model", "- values honest writing", "",
  "## Where this is heading", "- moving toward water/hydrology work [evidence: returning-to:water ×3]", "- will quit everything tomorrow", "",
].join("\n");

describe("anticipation", () => {
  test("extracts the heading-section body", () => {
    expect(extractAnticipationSection(doc)).toContain("water/hydrology");
    expect(extractAnticipationSection(doc)).not.toContain("values honest writing");
  });
  test("drops ungrounded bullets, keeps grounded ones", () => {
    const out = filterGroundedAnticipations(doc);
    expect(out).toContain("water/hydrology");
    expect(out).not.toContain("will quit everything tomorrow");
    expect(out).toContain("## Model"); // untouched outside the section
  });
  test("no anticipation section is a no-op", () => {
    const plain = "# X\n\n## Model\n- a\n";
    expect(filterGroundedAnticipations(plain)).toBe(plain);
  });
});
