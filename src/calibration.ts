// The seam a host uses to measure its own model against what actually
// happened. A prediction and its outcome go in as an ordinary observation, so
// they age, consolidate and get recalled like everything else — there is no
// second store and no separate reporting path to keep alive.
//
// Written at grade B2 on purpose: an outcome recorded after the fact is a
// direct observation of what occurred, not an inference, and it should outrank
// the transcript line that produced the prediction. `record.recordObservations`
// clamps against the source's own ceiling, so this is a request, not a
// guarantee.
import type { MemoryHost } from "./host";
import type { createRecord } from "./record";

export interface PredictionOutcomeInput {
  /** One subject: an existing key, or an alias this agent has registered. A
   *  bare string cannot propose a new subject — only the extractor's
   *  `{type, label}` form can, and calibration never mints one. */
  about: string;
  predicted: string;
  actual: string;
  note?: string;
}

/** `_host` is unused: everything this needs is already inside `record`, which
 *  was built from the same host. It stays in the signature because every other
 *  factory in the library reads `create*(host, …)`, and a single odd one out
 *  is a thing a caller has to remember. */
export function createCalibration(_host: MemoryHost, record: ReturnType<typeof createRecord>) {
  /** Not wrapped in try/catch. A calibration write that could not be made must
   *  not look like one that recorded nothing — the whole point of the seam is
   *  that its silence is meaningful. */
  async function recordPredictionOutcome(input: PredictionOutcomeInput) {
    return record.recordObservations({
      source: "decision",
      observations: [
        {
          about: [input.about],
          predicate: "prediction-outcome",
          value: `predicted: ${input.predicted} | actual: ${input.actual}${input.note ? " | " + input.note : ""}`,
          grade: "B2",
        },
      ],
    });
  }

  return { recordPredictionOutcome };
}

export type Calibration = ReturnType<typeof createCalibration>;
