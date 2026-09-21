import { beforeEach, expect, test } from "bun:test";

import { handle, resetDb } from "../tests/setup";
import { fakeComplete, fakeHost } from "../tests/fakes";
import { coerceObservations, createExtract } from "./extract";
import { createStore } from "./store";

beforeEach(resetDb);

test("coerceObservations keeps well-formed entries and drops the rest, in order", () => {
  const out = coerceObservations([
    { about: ["person:ann"], predicate: "pays-rent", value: "1540", naturalKey: "k" },
    { about: [], predicate: "p", value: "v" },                       // no subject
    { about: [{ type: "thing", label: "Bakfiets" }, "person:ann"], predicate: "bought", value: "a cargo bike" },
    { predicate: "p", value: "v" },                                   // no about
    { about: ["person:ann"], predicate: "", value: "v" },             // empty predicate
    "junk",
  ]);
  expect(out).toEqual([
    { about: ["person:ann"], predicate: "pays-rent", value: "1540", naturalKey: "k" },
    { about: [{ type: "thing", label: "Bakfiets" }, "person:ann"], predicate: "bought", value: "a cargo bike" },
  ]);
});

test("the extractor runs once per text, sees the known subjects, and is not try/caught", async () => {
  const host = fakeHost();
  const store = createStore(handle, host);
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.getOrCreateSubject("group:home", "Home");
  const { fn, calls } = fakeComplete([JSON.stringify([{ about: ["person:ann", "group:home"], predicate: "has-class", value: "art on Wednesdays" }])]);
  const out = await createExtract(host, store).extractObservations("Ann has art class on Wednesdays", { complete: fn });
  expect(out.length).toBe(1);
  expect(calls.length).toBe(1);
  expect(calls[0]!.system).toContain("person:ann — Ann");
  expect(calls[0]!.system).toContain("group:home — Home");
  expect(calls[0]!.system).toContain("pursuit:");
  expect(calls[0]!.tier).toBe("low");
  const failing = fakeComplete([]);
  await expect(createExtract(host, store).extractObservations("x", { complete: failing.fn })).rejects.toThrow(/no answer left/);
});

test("the lens may replace the system prompt wholesale", async () => {
  const host = fakeHost({ lens: { extractionPrompts: { system: "CUSTOM" } } });
  const store = createStore(handle, host);
  const { fn, calls } = fakeComplete(["[]"]);
  await createExtract(host, store).extractObservations("x", { complete: fn });
  expect(calls[0]!.system).toBe("CUSTOM");
});
