// Ported verbatim from src/lib/memory/keys.ts (byte-identical in both
// repos, zero host coupling — pure string helpers). Task 3 duplicated
// `slugifyEntity`/`stripLeadingH1` locally into research/{context,
// writeback}.ts as a temporary measure; this task deletes that duplication
// (see research/context.ts and research/writeback.ts's updated imports).

const LEADING_ARTICLE = /^(the|a|an)\s+/i;

// Mirrors daydream slugifySubject: lowercase, strip diacritics + leading
// article + apostrophes, collapse to kebab, cap at 48 chars.
export function slugifyEntity(term: string): string {
  return term
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(LEADING_ARTICLE, "")
    .replace(/[''.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// Stable dedup identity. Joins non-empty parts with ":"; null when nothing
// identifying is present (caller then inserts instead of upserting).
export function buildNaturalKey(parts: (string | null | undefined)[]): string | null {
  const clean = parts.map((p) => (p ?? "").trim()).filter((p) => p.length > 0);
  return clean.length > 0 ? clean.join(":") : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Typed keys. EVERY key is "<type>:<slug>", and only a type declared in the
// host's registry may namespace one (registry.ts's assertDeclaredKey). The
// old rule — stable ids bare, model-derived keys prefixed — protected one
// invariant: a model word-choice must never land in a human-chosen subject.
// The typed form keeps that (slugifyEntity emits only [a-z0-9-], so a slug
// can never contain ":" and no model output can forge or escape a prefix)
// and adds a second: the type is readable off the key, so no column has to
// carry it.
export function typedKey(type: string, freeText: string): string {
  const slug = slugifyEntity(freeText);
  if (!slug) throw new Error(`typedKey: "${freeText}" contains nothing sluggable; cannot build a ${type} key`);
  return `${type}:${slug}`;
}

// Paths under the host's dossierRoot. A key's ":" becomes "-" through
// slugifyEntity, so "person:ann" → subjects/person-ann.md.
export function subjectFile(key: string): string {
  return `subjects/${slugifyEntity(key)}.md`;
}
export function anticipationsFile(key: string): string {
  return `subjects/${slugifyEntity(key)}.anticipations.md`;
}

// Strip a single leading Markdown H1 title line (`# Title`) if present. Does
// NOT match H2+ (`## Section`) — those are section headings we must preserve.
export function stripLeadingH1(markdown: string): string {
  return markdown.replace(/^#\s+[^\n]*\n+/, "");
}
