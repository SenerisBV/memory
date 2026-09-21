// Consolidation: turn a subject's rows into one readable dossier on disk.
//
// Ported from the runtime's src/memory/consolidate.ts. Three things changed
// on the way in. The synthesizer is host data (`host.synthesizer`) rather
// than a hard-coded agent name, because a library cannot know whose fleet it
// is running in. The dossier is a plain file under `host.dossierRoot` rather
// than a knowledge-compile call, so the library owes the host nothing but a
// directory. And the composite case is registry-driven (`subjectType().
// composite`) rather than one named roll-up subject.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { extractAnticipationSection, filterGroundedAnticipations } from "./anticipation";
import { ATTENTION, DEFAULT_MIN_OBS_FOR_PROFILE, MAX_OBS_PER_SYNTH } from "./constants";
import type { CompleteFn, MemoryHost } from "./host";
import { anticipationsFile, stripLeadingH1, subjectFile } from "./keys";
import { COMPOSITE_SYNTH_SYSTEM, DOSSIER_SYNTH_SYSTEM } from "./prompts";
import { subjectType } from "./registry";
import type { Store, SubjectRow } from "./store";

export type SynthFn = CompleteFn;

/** Render evidence for the synthesis prompt. When every row shares one author,
 *  source AND grade, state that once instead of tagging every line.
 *
 *  Measured 2026-08-15 on the fleet this came from: one person's dossier
 *  carried 27 evidence markers in 850 words, 28 occurrences of the identical
 *  `C3:<agent>/<source>` string — one per 31 words, none of them varying. A
 *  household dossier, with MORE rows (461), had 8 and no repeats, because its
 *  sources actually differ. A citation that never varies carries no
 *  information, and repeating it invites the synthesizer to echo it into the
 *  prose. */
export function renderEvidenceBlock(
  observations: { authorAgent: string; source: string; sourceGrade: string; label: string; predicate: string; value: string }[],
): string {
  // Guarded rather than length-checked: this repo runs `noUncheckedIndexedAccess`,
  // so `observations[0]` is `T | undefined` even after a length check.
  const first = observations[0];
  if (!first) return "";
  const uniform = observations.every(
    (o) => o.authorAgent === first.authorAgent && o.source === first.source && o.sourceGrade === first.sourceGrade,
  );
  if (uniform) {
    return [
      `All evidence below is [${first.authorAgent}/${first.source}], grade ${first.sourceGrade}.`,
      ...observations.map((o) => `- ${o.predicate}: ${o.value}`),
    ].join("\n");
  }
  return observations
    .map((o) => `- (${o.sourceGrade}) [${o.authorAgent}/${o.source}] ${o.label} · ${o.predicate}: ${o.value}`)
    .join("\n");
}

export function createConsolidate(host: MemoryHost, store: Store) {
  /** The logger is the host's, so it can throw. Nothing in a consolidation
   *  pass is important enough to lose because reporting it failed — in
   *  particular the reaper, which runs after the last log line. */
  async function safeLog(event: Parameters<MemoryHost["log"]>[0]): Promise<void> {
    try { await host.log(event); } catch { /* a logger that throws is not this pass's problem */ }
  }

  async function writeDossier(relative: string, title: string, body: string): Promise<void> {
    const path = join(host.dossierRoot, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `# ${title}\n\n${body.trim()}\n`, "utf8");
  }

  /** A dossier that cannot be read is the same as one that isn't there yet:
   *  the synthesizer is told "(none yet)" and writes a fresh one. Never throw
   *  here — a missing file must not cost the subject its whole pass.
   *
   *  But it is NOT the same thing, and the difference is invisible unless it
   *  is said out loud. A subject with a `profilePath` has been synthesized
   *  before; if that file will not open (deleted, unreadable, a dossierRoot
   *  pointed somewhere new) then the prior anticipations are not archived,
   *  the synthesizer loses all continuity, and `writeDossier` overwrites the
   *  file it could not read. Every one of those is silent. So: no path is
   *  ordinary and says nothing; a path that fails to read is an ERROR. */
  async function readDossier(s: SubjectRow): Promise<string> {
    if (!s.profilePath) return "";
    try {
      return (await readFile(join(host.dossierRoot, s.profilePath), "utf8")).trim();
    } catch (err) {
      await safeLog({ kind: "ERROR", source: "memory", message: `dossier read failed for ${s.key}: ${err instanceof Error ? err.message : String(err)}`, payload: { key: s.key, profilePath: s.profilePath } });
      return "";
    }
  }

  // Archive the prior "Where this is heading" section, dated, append-only, so
  // anticipation can be evaluated over time.
  async function archiveAnticipations(key: string, priorBody: string, now: Date): Promise<void> {
    const prior = extractAnticipationSection(priorBody);
    if (!prior) return;
    const path = join(host.dossierRoot, anticipationsFile(key));
    let existing = "";
    try { existing = await readFile(path, "utf8"); } catch { existing = ""; }
    const stamp = now.toISOString().slice(0, 10);
    const head = existing.trim() || `# Anticipations archive — ${key}`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${head}\n\n## ${stamp}\n\n${prior}\n`, "utf8");
  }

  async function synthesizeOne(s: SubjectRow, synth: SynthFn, minObs: number, now: Date, traceId?: string): Promise<{ key: string; bytes: number } | null> {
    const type = subjectType(host.registry, s.key);
    const isComposite = !!type?.composite && s.members.length > 0;
    // fleetOnly: a dossier is read by every agent, so it may only be built
    // from rows every agent may read.
    const rows = await store.evidence(s.key, { fleetOnly: true, limit: MAX_OBS_PER_SYNTH });
    const contributions = await store.contributions(s.key, 50);
    const memberDossiers: string[] = [];
    if (isComposite) {
      for (const m of s.members) {
        const ms = await store.getSubject(m);
        if (!ms || ms.attention === ATTENTION.IGNORE) continue;
        const body = await readDossier(ms);
        if (body) memberDossiers.push(`### ${ms.label}\n\n${stripLeadingH1(body)}`);
      }
    }
    if (rows.length + contributions.length + memberDossiers.length < minObs) return null;

    const relative = subjectFile(s.key);
    // Slug collision. `subjectFile` slugs the key and `slugifyEntity` caps the
    // slug at 48 characters, so two DISTINCT subjects can name the same file.
    // Undetected, the second synthesis overwrites the first subject's dossier
    // and then claims the path as its own: both keys read as synthesized, one
    // file exists, and it describes the wrong subject. There is no version of
    // that a reader can notice.
    //
    // Refusing is the right side of this repo's asymmetry — a subject left
    // dirty is retried and visibly un-synthesized; an overwritten dossier is
    // gone. Checked BEFORE the model call, because there is nothing useful to
    // do with the answer. Renaming the file is deliberately not attempted:
    // the collision means the key namespace and the path namespace disagree,
    // and that is the host's to resolve, loudly.
    const clash = await store.subjectByProfilePath(relative);
    if (clash && clash.key !== s.key) {
      await safeLog({
        kind: "ERROR", source: "memory", message: `dossier path collision: ${s.key} and ${clash.key} both slug to ${relative}`,
        payload: { path: relative, key: s.key, existingKey: clash.key }, traceId,
      });
      return null; // left dirty; nothing written
    }

    const priorBody = await readDossier(s);
    const evidenceBlock = renderEvidenceBlock(rows.map((r) => ({ authorAgent: r.authorAgent, source: r.source, sourceGrade: r.sourceGrade, label: s.label, predicate: r.predicate, value: r.value })));
    const contribBlock = contributions.map((c) => `- [${c.authorAgent}] ${c.content} — why: ${c.why}`).join("\n");
    const userMsg = [
      `Subject: ${s.label}`, "",
      ...(isComposite ? ["Members:", memberDossiers.join("\n\n") || "(none synthesized yet)", ""] : []),
      "Prior dossier:", priorBody || "(none yet)", "",
      "Evidence (newest first; each tagged [author/source]):", evidenceBlock || "(none)", "",
      "Deliberate contributions:", contribBlock || "(none)",
    ].join("\n");
    const res = await synth({ tier: "memory", system: isComposite ? COMPOSITE_SYNTH_SYSTEM : DOSSIER_SYNTH_SYSTEM, messages: [{ role: "user", content: userMsg }], maxTokens: 2000, source: "memory-synth", traceId });
    const grounded = filterGroundedAnticipations(res.text.trim());
    if (!grounded) return null; // empty synth — leave dirty, retry next pass
    if (priorBody) await archiveAnticipations(s.key, priorBody, now);
    await writeDossier(relative, s.label, stripLeadingH1(grounded));
    // The pass's clock, not the wall clock: `now` is what the archive stamp
    // and the reaper cutoff are read off, and a caller that pins it expects
    // one instant for the whole pass, not three.
    await store.setProfile(s.key, { profilePath: relative, profileSynthAt: now });
    return { key: s.key, bytes: Buffer.byteLength(grounded, "utf8") };
  }

  async function consolidate(opts: { minObs?: number; synth?: SynthFn; traceId?: string; now?: Date } = {}) {
    // Code-level backstop for the single-synthesizer invariant: one shared
    // dossier per subject, written by exactly one agent. Left to scheduling
    // alone it is only a disabled cron row away from two agents overwriting
    // each other's file, so the gate lives here, on the one function that
    // writes.
    if (host.agentId !== host.synthesizer) {
      throw new Error(`single-synthesizer: consolidation runs on "${host.synthesizer}" only; this host is "${host.agentId}"`);
    }
    const synth = opts.synth ?? host.complete;
    const minObs = opts.minObs ?? DEFAULT_MIN_OBS_FOR_PROFILE;
    // One clock for the whole pass: the archive's date stamp and the reaper's
    // cutoff are read off the same instant, and a caller can pin both.
    const now = opts.now ?? new Date();
    const dirty = await store.dirtySubjects();
    // Members before composites, so a composite reads this pass's member dossiers.
    const ordered = [...dirty.filter((s) => !subjectType(host.registry, s.key)?.composite), ...dirty.filter((s) => subjectType(host.registry, s.key)?.composite)];
    const synthesized: { key: string; bytes: number }[] = [];
    for (const s of ordered) {
      try {
        const r = await synthesizeOne(s, synth, minObs, now, opts.traceId);
        if (r) synthesized.push(r);
      } catch (err) {
        // One subject's failure must not end the pass — it stays dirty and is
        // retried next time.
        await safeLog({ kind: "ERROR", source: "memory", message: `dossier synth failed for ${s.key}: ${err instanceof Error ? err.message : String(err)}`, payload: { key: s.key }, traceId: opts.traceId });
      }
    }
    if (synthesized.length > 0) await safeLog({ kind: "INFO", source: "memory", message: `consolidated ${synthesized.length} subject(s)`, payload: { count: synthesized.length }, traceId: opts.traceId });
    // Rides consolidation rather than a separate cron — a reaper nobody schedules never runs. Runs last and isolated.
    let reaped = 0;
    try { reaped = await store.reapSuperseded(now); } catch (err) {
      await safeLog({ kind: "ERROR", source: "memory", message: `reapSuperseded failed: ${err instanceof Error ? err.message : String(err)}`, traceId: opts.traceId });
    }
    return { synthesized, reaped };
  }

  return { consolidate };
}
