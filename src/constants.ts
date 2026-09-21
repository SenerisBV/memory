export const ATTENTION = { IMPORTANT: "important", TRACK: "track", IGNORE: "ignore" } as const;
export type Attention = (typeof ATTENTION)[keyof typeof ATTENTION];
export const DEFAULT_MIN_OBS_FOR_PROFILE = 3;
export const MAX_OBS_PER_SYNTH = 80;
export const RECALL_MAX_CHARS = 1800;
export const SUPERSEDED_RETENTION_DAYS = 30;
/** How many known subjects the extractor is shown: the most recently active
 *  N plus every `important` one (spec §13's default). A constant with a test
 *  (extract.test.ts), not a guess. */
export const KNOWN_SUBJECTS_CAP = 40;
