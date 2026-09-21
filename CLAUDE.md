# @seneris/memory — working rules

A memory library with no agent in it.

- Nothing under `src/` imports a host's agent runtime. A test enforces it
  (`src/guards.test.ts`).
- No host names in `src/` — agents, people, businesses. A test enforces it, and
  the list itself is deliberately NOT in the repo: a ban list is a name list.
  See `tests/guardNames.ts`; supply the real one through `MEMORY_GUARD_NAMES`
  in `.env.test`, which is gitignored.
- **No real figures anywhere.** Amounts, premiums, balances, identifiers and
  dates in fixtures, comments and prompt examples are synthetic. A number that
  came off a live store does not belong in a public repository, and the name
  guard does not catch numbers — it never did. This is the failure mode that
  actually happened here: the guard was green while the prompt in
  `src/reconcile.ts` carried a real monthly income.
- Tests run only against `memory_test`: `bun run test`, never bare `bun test`.
  `tests/db-guard.ts` exits on anything else.
- `drizzle-kit push` is forbidden. `bun run db:generate`, read the SQL, then
  `bun run db:migrate`.
- The schema name is a host parameter (default `memory`). `src/schema.ts`'s
  static export is for drizzle-kit only; runtime code uses
  `openDb(url, schemaName).tables`.
- `src/adoptLegacy.ts` copies a pre-existing store into this schema. It reads
  the source read-only, and only from a dump or at the adoption step — never
  with write intent against a live store.
