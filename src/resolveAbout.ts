// Read-before-write for subjects (spec §2 decision 6). The extractor may
// name an existing key, an alias the host registered, or propose {type,
// label}. A proposal is matched by label (case-insensitive, within the type),
// then by ALIAS, then by slug before anything is created; only a
// model-mintable type may be minted, at attention "track". Fifteen "efforts"
// including "vacuum" and "ants" are why.
import type { AboutEntry } from "./extract";
import type { MemoryHost } from "./host";
import { slugifyEntity, typedKey } from "./keys";
import { assertDeclaredKey, canModelMint, parseKey } from "./registry";
import type { Store } from "./store";

export interface ResolvedAbout {
  keys: string[];
  minted: { key: string; label: string }[];
}

export function createResolveAbout(host: MemoryHost, store: Store) {
  /** The logger is the host's, so it can throw. A flaky logger must not cost
   *  the resolution it was only reporting on — the same reason consolidate.ts
   *  wraps every one of its own log calls. Every call here is an INFO about a
   *  DROPPED proposal, so losing one loses no data; letting it throw would
   *  lose the whole batch. */
  async function safeLog(event: Parameters<MemoryHost["log"]>[0]): Promise<void> {
    try { await host.log(event); } catch { /* a logger that throws is not this resolution's problem */ }
  }

  return async function resolveAbout(about: AboutEntry[]): Promise<ResolvedAbout> {
    const keys: string[] = [];
    const minted: { key: string; label: string }[] = [];
    const push = (k: string) => { if (!keys.includes(k)) keys.push(k); };

    /** The alias arm of the read-before-write rule. `resolveLocalKey` returns
     *  its INPUT when nothing is registered, so "something came back that is
     *  not what I asked for" is the only signal that an alias actually fired.
     *  The result must still parse as a key, be of the PROPOSED type (an
     *  alias pointing at a `pursuit` must not satisfy a `person` proposal),
     *  and name a subject that exists. */
    async function byAlias(type: string, local: string): Promise<string | null> {
      if (!local) return null;
      const resolved = await store.resolveLocalKey(local);
      if (resolved === local) return null;
      const parsed = parseKey(resolved);
      if (!parsed || parsed.type !== type) return null;
      return (await store.getSubject(resolved)) ? resolved : null;
    }

    for (const entry of about) {
      if (typeof entry === "string") {
        // Trimmed first: a key that arrives with surrounding whitespace is
        // the same key. Untrimmed it fails `parseKey`, falls through to the
        // alias lookup, matches nothing, and then throws "not a known
        // subject" for a subject that is right there.
        const raw = entry.trim();
        const resolved = parseKey(raw) ? raw : await store.resolveLocalKey(raw);
        assertDeclaredKey(host.registry, resolved);
        if (!(await store.getSubject(resolved))) throw new Error(`"${entry}" is not a known subject`);
        push(resolved);
        continue;
      }
      const type = entry.type.trim();
      const label = entry.label.trim();
      if (!type || !label) {
        await safeLog({ kind: "INFO", source: "memory-decide", message: `proposed subject dropped: empty type or label (type="${entry.type}", label="${entry.label}")` });
        continue;
      }
      // Gate BEFORE findSubjectByLabel: that lookup's `type` feeds a SQL LIKE
      // pattern (`${type}:%`), so an undeclared type — including one with
      // LIKE metacharacters like "%" — must never reach it. A proposal of
      // {type: "%", label: "Ann"} would otherwise match `person:ann` via
      // "%:%" without assertDeclaredKey ever running (the byLabel early
      // return skips it entirely).
      if (!host.registry.subjectTypes.some((t) => t.name === type)) {
        await safeLog({ kind: "INFO", source: "memory-decide", message: `proposed subject dropped: undeclared type "${type}"` });
        continue;
      }
      const byLabel = await store.findSubjectByLabel(type, label);
      if (byLabel) { push(byLabel.key); continue; }
      // Aliases, between the label match and the slug/mint decision. This is
      // the arm neither of the other two can reach: a short form the host has
      // registered is not the subject's stored LABEL, and it does not slug to
      // the subject's KEY either, so without this a familiar nickname mints a
      // second subject for a person who already has one. Both the raw label
      // and its slug are tried, because a host may register either spelling.
      const aliased = (await byAlias(type, label)) ?? (await byAlias(type, slugifyEntity(label)));
      if (aliased) { push(aliased); continue; }
      let key: string;
      try { key = typedKey(type, label); } catch { await safeLog({ kind: "INFO", source: "memory-decide", message: `proposed subject dropped: unsluggable label "${label}"` }); continue; }
      assertDeclaredKey(host.registry, key);
      const bySlug = await store.getSubject(key);
      if (bySlug) { push(key); continue; }
      if (!canModelMint(host.registry, type)) {
        await safeLog({ kind: "INFO", source: "memory-decide", message: `proposed subject dropped: "${label}" (${type}) is not a known subject and the host mints ${type}` });
        continue;
      }
      await store.getOrCreateSubject(key, label);
      minted.push({ key, label });
      push(key);
    }
    return { keys, minted };
  };
}
