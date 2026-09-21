// The public surface. One constructor, one handle, one store — every module
// below is wired here and nowhere else, so a host imports this file and
// nothing deeper.
//
// The shape is deliberately flat rather than nested by module: a host calls
// `m.record(...)`, not `m.record.recordObservations(...)`. `subjects` is the
// one grouping, because subject administration is a genuinely different job
// from writing and reading memory.
//
// `createMemory` OPENS a connection pool. The caller owns it and must
// `close()` — a library must not decide how long a host's process lives.
import { createCalibration } from "./calibration";
import { createConsolidate } from "./consolidate";
import { openDb } from "./db";
import { createExtract, type Extract } from "./extract";
import { healthOf, type HealthReport } from "./health";
import type { MemoryHost } from "./host";
import { createProject } from "./project";
import { createRecall } from "./recall";
import { createRecord } from "./record";
import { createStore, type Store } from "./store";

/**
 * The surface, written out member by member rather than inferred from the
 * constructor. `createMemory` ends with `satisfies Memory`, so this interface
 * is the thing the compiler checks the wiring against: drop a wire, rename a
 * member, or point one at the wrong function and the typecheck fails here
 * instead of at some host months later. An inferred `ReturnType<>` cannot do
 * that — it agrees with whatever the constructor happens to return, including
 * a mistake.
 */
export interface Memory {
  extract: Extract["extractObservations"];
  record: ReturnType<typeof createRecord>["recordObservations"];
  contribute: ReturnType<typeof createRecord>["recordContribution"];
  consolidate: ReturnType<typeof createConsolidate>["consolidate"];
  recall: ReturnType<typeof createRecall>["recall"];
  project: ReturnType<typeof createProject>["projectDossier"];
  subjects: Pick<Store, "getOrCreateSubject" | "getSubject" | "setMembers" | "putAlias" | "resolveLocalKey" | "knownSubjects">;
  health(opts: { writeCadenceDays: number; consolidateCadenceDays: number; now?: Date }): Promise<HealthReport>;
  calibrate: ReturnType<typeof createCalibration>["recordPredictionOutcome"];
  close(): Promise<void>;
}

export function createMemory(host: MemoryHost): Memory {
  const handle = openDb(host.db.url, host.db.schema);
  const store = createStore(handle, host);
  const record = createRecord(host, store);
  return {
    extract: createExtract(host, store).extractObservations,
    record: record.recordObservations,
    contribute: record.recordContribution,
    consolidate: createConsolidate(host, store).consolidate,
    recall: createRecall(host, store).recall,
    project: createProject(host, store).projectDossier,
    subjects: {
      getOrCreateSubject: store.getOrCreateSubject,
      getSubject: store.getSubject,
      setMembers: store.setMembers,
      putAlias: store.putAlias,
      resolveLocalKey: store.resolveLocalKey,
      knownSubjects: store.knownSubjects,
    },
    /** Both cadences come from the host. There is no default: a library that
     *  guesses how often its host writes reports a false alarm or, worse, a
     *  false all-clear. */
    health: (opts: { writeCadenceDays: number; consolidateCadenceDays: number; now?: Date }): Promise<HealthReport> =>
      healthOf(store, opts),
    calibrate: createCalibration(host, record).recordPredictionOutcome,
    close: () => handle.close(),
  } satisfies Memory;
}

export { migrate } from "./migrate";
export { DEFAULT_REGISTRY, withTypes, RegistryError } from "./registry";
export { computeHealth } from "./health";
export type { MemoryHost, CompleteFn, LogEvent, Lens } from "./host";
export type { Registry, SubjectType, Topic } from "./registry";
export type { ObservationInput, AboutEntry } from "./extract";
export type { HealthReport, HealthFlag } from "./health";
