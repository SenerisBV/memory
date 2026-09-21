// The consolidation half of the archivist split (design spec §2): recording
// is multi-writer, consolidation is not, and this repo owns the half the
// library itself enforces as single-writer. It is generic on purpose — it
// knows nothing about who wrote the observations it turns into dossiers, so
// any host of this library can run the same script: bun, configuration from
// the environment, a printed summary, a non-zero exit on failure.
//
//   MEMORY_STORE_URL=postgresql://localhost:5432/some_test \
//   MEMORY_SYNTHESIZER_ID=archivist \
//   MEMORY_DOSSIER_ROOT=./dossiers \
//     bun scripts/consolidate-store.ts
//
// Refuses a store URL that doesn't name a "_test" database unless --live is
// passed — the same gate examples/stranger.test.ts and tests/db-guard.ts
// apply to DATABASE_URL, reproduced here rather than imported from tests/
// because that module's top level acts on DATABASE_URL directly and would
// run its own (wrong) check the moment it was imported.
import { createMemory, DEFAULT_REGISTRY, migrate, type CompleteFn, type LogEvent } from "../src/index";

export function databaseNameOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

export function assertStoreUrl(url: string | undefined, argv: string[]): string {
  if (!url) throw new Error("REFUSING TO RUN: MEMORY_STORE_URL is not set.");
  const live = argv.includes("--live");
  const name = databaseNameOf(url);
  const isTest = name !== null && /_test$/.test(name);
  if (isTest) {
    if (live) throw new Error(`--live was passed but ${JSON.stringify(name)} is a _test database; drop the flag.`);
    return url;
  }
  if (!live) {
    throw new Error(
      `REFUSING TO RUN: database ${JSON.stringify(name ?? "(unparseable)")} does not end in "_test".\n` +
        `Pass --live to run consolidation against a real store.`,
    );
  }
  console.warn(`--live: consolidating ${url}.`);
  return url;
}

// complete() is a model call, and this repo has no business knowing which
// model any given consumer uses (README: "No adapters for a specific model
// provider"). So the model comes from configuration: MEMORY_COMPLETE_MODULE
// names a file whose default export is a CompleteFn, imported at runtime.
//
// Left unset, the runner still starts — most passes touch no dirty subject
// and never call complete at all, and an empty or quiet store must still
// report a clean "nothing to do" rather than fail on a model it never
// needed. But a pass that DOES need synthesis with nothing configured
// throws instead of guessing: a silent stand-in here would write a dossier
// nobody asked for, which is a worse failure than refusing to run at all.
async function completeFromEnv(modulePath: string | undefined): Promise<CompleteFn> {
  if (!modulePath) {
    return async () => {
      throw new Error(
        "consolidate-store: a subject needs synthesis but MEMORY_COMPLETE_MODULE is not set. " +
          "Point it at a module whose default export is a CompleteFn.",
      );
    };
  }
  const mod = (await import(modulePath)) as { default?: unknown };
  if (typeof mod.default !== "function") {
    throw new Error(`consolidate-store: MEMORY_COMPLETE_MODULE (${modulePath}) has no default export function.`);
  }
  return mod.default as CompleteFn;
}

async function main() {
  const url = assertStoreUrl(process.env.MEMORY_STORE_URL, process.argv.slice(2));
  const schema = process.env.MEMORY_SCHEMA;
  const synthesizer = process.env.MEMORY_SYNTHESIZER_ID;
  if (!synthesizer) throw new Error("REFUSING TO RUN: MEMORY_SYNTHESIZER_ID is not set.");
  const dossierRoot = process.env.MEMORY_DOSSIER_ROOT;
  if (!dossierRoot) throw new Error("REFUSING TO RUN: MEMORY_DOSSIER_ROOT is not set.");

  // Idempotent and takes no lock (migrate.ts), same as examples/stranger.ts's
  // own bootstrap — a store this runner has never seen before still works.
  await migrate({ url, schema });

  const complete = await completeFromEnv(process.env.MEMORY_COMPLETE_MODULE);
  const logs: LogEvent[] = [];
  const memory = createMemory({
    agentId: synthesizer,
    synthesizer,
    complete,
    registry: DEFAULT_REGISTRY,
    dossierRoot,
    log: (e) => {
      logs.push(e);
      console.error(`[${e.kind}] ${e.source}: ${e.message}`);
    },
    db: { url, schema },
  });

  try {
    const result = await memory.consolidate({});
    // consolidate() swallows a single subject's synth or reap failure so the
    // rest of the pass proceeds (it logs and leaves the subject dirty for
    // next time) — that is the right behaviour for the pass, but a wrapper
    // that still exits 0 would make those failures invisible to whatever is
    // watching this job. So: any ERROR logged during the pass fails the run.
    const errors = logs.filter((e) => e.kind === "ERROR");
    const summary = {
      at: new Date().toISOString(),
      store: databaseNameOf(url),
      schema: schema ?? "(default)",
      synthesizer,
      synthesized: result.synthesized,
      reaped: result.reaped,
      errors: errors.length,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (result.synthesized.length === 0 && result.reaped === 0 && errors.length === 0) {
      console.log("consolidated nothing: no dirty subject had enough evidence to synthesize.");
    }
    if (errors.length > 0) {
      console.error(`consolidate-store: ${errors.length} error(s) logged during this pass; see above. Exiting non-zero.`);
      process.exitCode = 1;
    }
  } finally {
    await memory.close();
  }
}

// Only run when invoked directly (bun scripts/consolidate-store.ts), not
// when imported by a test for its exported guard functions.
if (import.meta.main) {
  await main();
}
