// The host contract (README, "The host contract"). Every field is something every host has:
// an id, a way to call a model, a registry, a directory, a logger, a URL.
import type { Registry } from "./registry";

export type CompleteFn = (opts: {
  /** A label the host may route on ("low", "classify", "memory") or ignore. */
  tier: string;
  system: string;
  messages: { role: "user"; content: string }[];
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  source?: string;
  traceId?: string;
}) => Promise<{ text: string }>;

export interface LogEvent {
  kind: "INFO" | "ERROR";
  source: string;
  message: string;
  payload?: Record<string, unknown>;
  traceId?: string;
}

export interface Lens {
  /** Applied to every recalled body before it reaches a prompt. */
  recallFilter?: (agentId: string, content: string) => string;
  /** Replaces the extractor's system prompt and/or JSON schema wholesale. */
  extractionPrompts?: { system?: string; schema?: Record<string, unknown> };
}

export interface MemoryHost {
  /** Stamped on every row as authorAgent; scopes the alias lookup. */
  agentId: string;
  /** The one agentId allowed to consolidate a shared store. A host that owns
   *  its store passes its own agentId. */
  synthesizer: string;
  complete: CompleteFn;
  registry: Registry;
  /** Where subject dossiers land as markdown. Created if absent. */
  dossierRoot: string;
  log: (event: LogEvent) => void | Promise<void>;
  db: { url: string; schema?: string };
  lens?: Lens;
  /** How long a superseded row is kept before consolidate() reaps it. Absent =
   *  30 days. `null` = never reap: consolidate() deletes nothing and reports
   *  `reaped: 0`. A host whose store is its record of history passes null. */
  supersededRetentionDays?: number | null;
  /** Subject types whose notes and observations are private to that subject.
   *  When consolidating subject S, a row that is also about a subject of one
   *  of these types (other than S itself) is left out of S's evidence, so it
   *  never reaches a shared dossier. `project`, `recall` and
   *  `listContributions` apply the same rule, widened by the caller's
   *  `privateScope`. Each entry must be a type in `registry` (createMemory
   *  throws otherwise). Absent = nothing is excluded. */
  privateSubjectTypes?: string[];
}
