// Ported verbatim from src/lib/memory/prompts.ts (byte-identical in both
// repos). Plan 4R Task 4 hard invariant: memory prompts are behavior —
// verbatim moves only, zero content changes.
import type { Registry } from "./registry";

export const DOSSIER_SYNTH_SYSTEM = `You maintain a long-term dossier of a subject, written as Markdown.

You are given: the prior dossier (may be empty), evidence (typed observations, newest-first, each tagged with its reliability grade and its [author/source] — the observer and how they learned it), and deliberate contributions (things flagged as important — weight these heavily). Evidence may come from several observers. When DIFFERENT observers disagree, prefer recent, higher-graded evidence and name the disagreement plainly. When the SAME observer has recorded a fact more than once, resolve it silently: take the most recent, highest-graded version and state it as fact.

Write the new dossier with EXACTLY these two sections:

## Model
A grounded synthesis of what is known — patterns, preferences, commitments, recurring concerns. Prefer recent, higher-graded evidence. State things plainly; do not invent.

Identifiers and reference numbers are the exception to everything below: BSNs, IBANs, account/policy/registration numbers, dates of birth. Reproduce them IN FULL, digit for digit, wherever the evidence or a contribution carries them. Never replace one with a summary, a count, or a citation pointing at where it lives — a fact whose entire value IS its digits is destroyed by paraphrase, and nothing downstream can recover it. If the evidence holds four numbers, write all four.

This section is a portrait, not a record of how it was assembled. Never write about the evidence itself. Phrases like "another observation shows", "a separate note records", "the evidence suggests", or "likely an earlier figure" are forbidden — pick the best-supported version and state it. Do NOT emit [evidence: ...] citation markers in this section; they belong only in "Where this is heading". A budget target and an actual amount are different facts, not a conflict — report both as such.

## Where this is heading
Extrapolation: where the subject seems to be going, including directions they may not have named. Each bullet MUST end with a citation marker '[evidence: <predicate:value or contribution>]' naming the specific signal it extrapolates from. A bullet you cannot ground in cited evidence MUST be omitted. Hold these loosely — they are vectors, not predictions. Bold calls are welcome when grounded.

Output ONLY the Markdown, starting directly with the ## Model heading. Do NOT emit a top-level # title — it is added automatically.`;

export interface KnownSubject { key: string; label: string }

/** The extractor's system prompt, built from the registry so no type or
 *  topic name lives here. `subjects` is the read-before-write list. */
export function extractSystemPrompt(registry: Registry, subjects: KnownSubject[]): string {
  const types = registry.subjectTypes.map((t) => `  ${t.name}: ${t.gloss}${t.mintedBy === "model" ? " (you may propose new ones)" : ""}`).join("\n");
  const known = subjects.length ? subjects.map((s) => `  ${s.key} — ${s.label}`).join("\n") : "  (none yet)";
  return `You extract durable, factual observations from text. Each observation is ABOUT one or more subjects.

Subject types:
${types}

Known subjects (prefer these; never invent a duplicate of one):
${known}

Return a JSON array. Each element is {about, predicate, value, naturalKey?}:
- about: an array of subjects the fact bears on, the main one first. Each entry is either an existing key from the list above, or {type, label} to propose a new subject of a type marked "you may propose new ones".
- predicate: a short kebab-case relation (e.g. "pays-rent", "plans-purchase", "decided").
- value: the fact, concrete, with numbers and names carried verbatim.
- naturalKey: include when the fact would repeat as the same predicate/value (a recurring cost, a standing arrangement).
Extract facts only; no speculation, no summaries. Output ONLY the JSON array.`;
}

export const OBSERVATION_EXTRACT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      about: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", properties: { type: { type: "string" }, label: { type: "string" } }, required: ["type", "label"] }] }, minItems: 1 },
      predicate: { type: "string" },
      value: { type: "string" },
      naturalKey: { type: "string" },
    },
    required: ["about", "predicate", "value"],
  },
} as const;

export const COMPOSITE_SYNTH_SYSTEM = `You maintain a long-term dossier that reads ACROSS a set of subjects, written as Markdown with two sections:
## Across the set — what holds across the members, tensions between them, what one implies for another.
## Where this is heading — extrapolations, each ending with '[evidence: <member or predicate:value>]'. A bullet you cannot ground MUST be omitted.
Output ONLY the Markdown, starting with the first ## heading.`;
