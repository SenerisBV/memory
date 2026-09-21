// Ported verbatim from src/lib/memory/anticipation.ts (byte-identical in
// both repos, zero host coupling).
const HEADING = /^##\s+where this is heading\s*$/im;

// Returns [startIndexOfBodyLine, endIndexExclusive] for the section body, or null.
function sectionBounds(lines: string[]): [number, number] | null {
  const start = lines.findIndex((l) => HEADING.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) { end = i; break; }
  }
  return [start + 1, end];
}

export function extractAnticipationSection(markdown: string): string {
  const lines = markdown.split("\n");
  const bounds = sectionBounds(lines);
  if (!bounds) return "";
  return lines.slice(bounds[0], bounds[1]).join("\n").trim();
}

// Drop bullet lines in the "Where this is heading" section that carry no
// [evidence: …] marker. Non-bullet lines and everything outside the section
// pass through unchanged.
export function filterGroundedAnticipations(markdown: string): string {
  const lines = markdown.split("\n");
  const bounds = sectionBounds(lines);
  if (!bounds) return markdown;
  const [from, to] = bounds;
  const kept: string[] = [];
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    const isBullet = /^\s*[-*]\s+/.test(line);
    if (isBullet && !/\[evidence:[^\]]*\]/i.test(line)) continue; // ungrounded bullet → drop
    kept.push(line);
  }
  return [...lines.slice(0, from), ...kept, ...lines.slice(to)].join("\n");
}
