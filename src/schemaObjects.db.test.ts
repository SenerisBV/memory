import { expect, test } from "bun:test";

import { handle } from "../tests/setup";
import { assertSchemaObjects, declaredObjects, presentObjects } from "./schemaObjects";

test("every declared object exists, and every existing object is declared", async () => {
  await assertSchemaObjects(handle);
  const present = await presentObjects(handle);
  expect(present.sort()).toEqual(declaredObjects("memory").sort());
});
