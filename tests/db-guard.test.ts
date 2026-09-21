import { expect, test } from "bun:test";

import { databaseNameOf, isTestDatabaseUrl } from "./db-guard";

test("the database NAME decides, not the URL text", () => {
  expect(isTestDatabaseUrl("postgresql://u@localhost:5432/memory_test")).toBe(true);
  // "_test" in the user, host or query must not count.
  expect(isTestDatabaseUrl("postgresql://u_test@localhost:5432/memory")).toBe(false);
  expect(isTestDatabaseUrl("postgresql://u@localhost:5432/memory?x=_test")).toBe(false);
  expect(isTestDatabaseUrl("")).toBe(false);
  expect(isTestDatabaseUrl("not a url")).toBe(false);
});

test("databaseNameOf decodes the path", () => {
  expect(databaseNameOf("postgresql://u@h/memory%5Ftest")).toBe("memory_test");
  expect(databaseNameOf("nope")).toBeNull();
});
