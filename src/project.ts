import type { MemoryHost } from "./host";
import type { Store } from "./store";

/** The recall cap. A projection is read INTO a prompt, so it has to end
 *  somewhere; 200 is the number the fleet's projection used. */
export const PROJECTION_LIMIT = 200;

export function createProject(host: MemoryHost, store: Store) {
  /** `opts.limit` raises or lowers the evidence cap for THIS call only.
   *
   *  It exists because a capped projection is the wrong instrument for
   *  COMPARING two stores. The adoption rehearsal diffed a subject holding 477
   *  live rows through a 200-row window and could not see three of the five
   *  changes it was looking for — a check quietly measuring 42% of its own
   *  subject. Callers rendering for a reader keep the default; callers
   *  auditing pass a number large enough to hold everything.
   *
   *  The contributions cap is deliberately NOT parameterised. It is not what
   *  the audit was blind to (46 contributions, cap 50), and one knob that is
   *  actually used is worth more than two that are half-used. */
  async function projectDossier(key: string, opts: { limit?: number } = {}): Promise<string | null> {
    const [subject, observations, contributions] = await Promise.all([
      store.getSubject(key),
      store.evidence(key, { fleetOnly: false, limit: opts.limit ?? PROJECTION_LIMIT }),
      store.contributions(key, 50),
    ]);
    if (!subject || (observations.length === 0 && contributions.length === 0)) return null;
    const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
    const lines: string[] = [`# ${subject.label}`, "", "_Evidence projection — assembled from observations and contributions, newest first. Not synthesized; every line traces to a source._", ""];
    if (observations.length > 0) {
      lines.push("## Observations", "");
      for (const o of observations) lines.push(`- **${fmt(o.ts)}** _(${o.sourceGrade})_ — ${subject.label} · ${o.predicate}: ${o.value}`);
      lines.push("");
    }
    if (contributions.length > 0) {
      lines.push("## Contributions (deliberate)", "");
      for (const c of contributions) lines.push(`- **${fmt(c.ts)}** — ${c.content}  \n  ↳ why: ${c.why}`);
      lines.push("");
    }
    return lines.join("\n");
  }
  return { projectDossier };
}
