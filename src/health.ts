// The first exported function after the constructor (direction doc §1).
// `computeHealth` is pure: takes dates, returns flags. The wrappers that
// FETCH the dates — a host-side job for a legacy store, `healthOf`
// at the bottom of this file for the library's own — are thin on purpose, so
// the pure half is the thing that gets tested.
import type { Store } from "./store";

export interface HealthInput {
  now: Date;
  /** Raise when no author has written for longer than this. Derived from the
   *  host's declared cadence, never guessed (a wait shorter than the interval
   *  it measures reports a false negative). */
  writeCadenceDays: number;
  consolidateCadenceDays: number;
  lastWriteByAuthor: { author: string; at: Date | null }[];
  lastConsolidateAt: Date | null;
}

export interface HealthFlag {
  code: "no_writes" | "stale_consolidation" | "never_written" | "never_consolidated";
  message: string;
}

export interface HealthReport {
  ok: boolean;
  flags: HealthFlag[];
  lastWriteAt: Date | null;
  lastConsolidateAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isInvalidDate(d: Date | null): boolean {
  return d !== null && Number.isNaN(d.getTime());
}

export function computeHealth(input: HealthInput): HealthReport {
  if (input.lastWriteByAuthor.some((w) => isInvalidDate(w.at)) || isInvalidDate(input.lastConsolidateAt)) {
    throw new Error("computeHealth: invalid date in input");
  }

  const flags: HealthFlag[] = [];
  const writes = input.lastWriteByAuthor.map((w) => w.at).filter((d): d is Date => d !== null);
  const lastWriteAt = writes.length > 0 ? new Date(Math.max(...writes.map((d) => d.getTime()))) : null;

  if (lastWriteAt === null) {
    flags.push({ code: "never_written", message: "no observation has ever been written" });
  } else {
    const ageDays = (input.now.getTime() - lastWriteAt.getTime()) / DAY_MS;
    if (ageDays > input.writeCadenceDays) {
      flags.push({
        code: "no_writes",
        message: `no author has written for ${ageDays.toFixed(1)} days (cadence ${input.writeCadenceDays}); last write ${lastWriteAt.toISOString()}`,
      });
    }
  }

  if (input.lastConsolidateAt === null) {
    flags.push({ code: "never_consolidated", message: "consolidation has never run" });
  } else {
    const ageDays = (input.now.getTime() - input.lastConsolidateAt.getTime()) / DAY_MS;
    if (ageDays > input.consolidateCadenceDays) {
      flags.push({
        code: "stale_consolidation",
        message: `last consolidation ${ageDays.toFixed(1)} days ago (cadence ${input.consolidateCadenceDays})`,
      });
    }
  }

  return { ok: flags.length === 0, flags, lastWriteAt, lastConsolidateAt: input.lastConsolidateAt };
}

/**
 * The thin wrapper: fetch the two dates from a store, hand them to the pure
 * function above. Deliberately holds no policy of its own — the cadences come
 * from the host, which is the only party that knows how often it writes.
 */
export async function healthOf(
  store: Store,
  opts: { writeCadenceDays: number; consolidateCadenceDays: number; now?: Date },
): Promise<HealthReport> {
  const [lastWriteByAuthor, lastConsolidateAt] = await Promise.all([store.lastWriteByAuthor(), store.lastConsolidateAt()]);
  return computeHealth({
    now: opts.now ?? new Date(),
    writeCadenceDays: opts.writeCadenceDays,
    consolidateCadenceDays: opts.consolidateCadenceDays,
    lastWriteByAuthor,
    lastConsolidateAt,
  });
}
