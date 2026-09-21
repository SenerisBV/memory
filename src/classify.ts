// Observation classification — the first of the two calls in the taxonomy
// design. Runs BEFORE reconciliation and sees no live rows: it decides only
// what an observation IS, not how it relates to anything already stored.
//
// Like reconcile.ts, this module holds no Prisma access.
import type { CompleteFn, MemoryHost } from "./host";
import type { Registry } from "./registry";
import { GENERAL_TOPIC, normalizeTopics } from "./registry";
import { KINDS, DEFAULT_KIND } from "./kinds";

export interface Classified {
  kind: string;
  topics: string[];
}

export function classifySystemPrompt(registry: Registry): string {
  return `Classify each observation about a subject on two INDEPENDENT axes.

topic — what it is ABOUT:
${registry.topics.map((t) => `  ${t.name}: ${t.gloss}`).join("\n")}

kind — how the subject relates to it, or what sort of assertion it is. One of:
  ${KINDS.join(", ")}

The axes are independent. Use \`general\` only when nothing else genuinely fits — prefer committing to a topic.

Assign ALL topics that a person searching their own memory would expect to find this under.
Most observations have exactly one. Assign a second or third ONLY when the observation is
genuinely, substantively about that topic too — not merely adjacent to it.
List the PRIMARY topic first: the one the observation is most fundamentally about.
Never list more than three. Return ONLY a JSON object.`;
}

export function classifySchema(registry: Registry) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["classifications"],
    properties: {
      classifications: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "topics", "kind"],
          properties: {
            index: { type: "integer" },
            topics: { type: "array", items: { type: "string", enum: registry.topics.map((t) => t.name) } },
            kind: { type: "string", enum: [...KINDS] },
          },
        },
      },
    },
  } as const;
}

const KNOWN_KINDS = new Set<string>(KINDS);

function defaultClassification(): Classified {
  return { kind: DEFAULT_KIND, topics: [GENERAL_TOPIC] };
}

/** Pull the JSON object out of the model's text, tolerating a prose wrapper. */
function salvage(text: string): unknown[] {
  const attempt = (s: string): unknown[] | null => {
    try {
      const v = JSON.parse(s) as unknown;
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") {
        const c = (v as Record<string, unknown>).classifications;
        if (Array.isArray(c)) return c;
      }
    } catch { /* fall through */ }
    return null;
  };
  const direct = attempt(text);
  if (direct) return direct;
  const obj = /\{[\s\S]*\}/.exec(text);
  if (obj) { const v = attempt(obj[0]); if (v) return v; }
  const arr = /\[[\s\S]*\]/.exec(text);
  if (arr) { const v = attempt(arr[0]); if (v) return v; }
  return [];
}

/**
 * Always returns exactly `count` entries. A missing index takes the default
 * rather than shifting its neighbours — position IS identity here, and a
 * silent shift would file every later observation under the wrong topic.
 * Roughly 12% of rows come back unclassified in a given pass, so this path is
 * ordinary, not exceptional.
 */
export function parseClassifications(registry: Registry, text: string, count: number): Classified[] {
  const out: Classified[] = Array.from({ length: count }, defaultClassification);

  for (const raw of salvage(text)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const index = typeof o.index === "number" && Number.isInteger(o.index) ? o.index : -1;
    if (index < 0 || index >= count) continue;

    const kind = typeof o.kind === "string" && KNOWN_KINDS.has(o.kind) ? o.kind : DEFAULT_KIND;

    // Order is preserved: topics[0] is the primary and retrieval keys on it.
    out[index] = { kind, topics: normalizeTopics(registry, o.topics) };
  }

  return out;
}

export interface ClassifyBatchInput {
  items: { predicate: string; value: string }[];
  complete?: CompleteFn;
  traceId?: string;
}

export function createClassify(host: MemoryHost) {
  async function classifyBatch(input: ClassifyBatchInput): Promise<Classified[]> {
    if (input.items.length === 0) return [];
    const run: CompleteFn = input.complete ?? host.complete;

    // Whole body inside the try, for the same reason reconcile.ts does it:
    // this module's purpose is to fail safe, and nothing that can throw
    // belongs outside the handler that catches throws.
    try {
      const userContent =
        input.items.map((it, i) => `${i}. ${it.predicate}: ${it.value.slice(0, 110)}`).join("\n") +
        "\n\nOne object per numbered line: {index, topics, kind}.";

      const res = await run({
        tier: "classify",
        system: classifySystemPrompt(host.registry),
        messages: [{ role: "user", content: userContent }],
        jsonSchema: classifySchema(host.registry) as unknown as Record<string, unknown>,
        maxTokens: 8000,
        source: "memory-classify",
        traceId: input.traceId,
      });
      return parseClassifications(host.registry, res.text, input.items.length);
    } catch {
      // Classification cannot fail OPEN the way reconciliation does: an
      // observation with no topic still has to be findable. It fails SAFE to
      // general/general, which keeps the row queryable and un-mergeable.
      return input.items.map(defaultClassification);
    }
  }

  return { classifyBatch };
}
