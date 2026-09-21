import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompleteFn, LogEvent, MemoryHost } from "../src/host";
import { DEFAULT_REGISTRY } from "../src/registry";
import { TEST_URL } from "./setup";

/** A CompleteFn that answers from a queue, in order, and records every call. */
export function fakeComplete(answers: string[]) {
  const calls: Parameters<CompleteFn>[0][] = [];
  const fn: CompleteFn = async (opts) => {
    calls.push(opts);
    const text = answers.shift();
    if (text === undefined) throw new Error(`fakeComplete: no answer left for tier=${opts.tier} source=${opts.source ?? "?"}`);
    return { text };
  };
  return { fn, calls };
}

export function fakeHost(over: Partial<MemoryHost> = {}): MemoryHost & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  return {
    agentId: "tester",
    synthesizer: "tester",
    complete: async () => ({ text: "[]" }),
    registry: DEFAULT_REGISTRY,
    dossierRoot: mkdtempSync(join(tmpdir(), "memory-")),
    log: (e) => { events.push(e); },
    db: { url: TEST_URL },
    events,
    ...over,
  };
}
