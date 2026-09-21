import { expect, test } from "bun:test";

import {
  DEFAULT_REGISTRY, GENERAL_TOPIC, RegistryError, assertDeclaredKey, canModelMint,
  normalizeTopics, parseKey, subjectType, withTypes,
  type SubjectType, type Topic,
} from "./registry";
import { guardNames } from "../tests/guardNames";

test("the default registry is generic: six types, no fleet names", () => {
  expect(DEFAULT_REGISTRY.subjectTypes.map((t) => t.name)).toEqual(["person", "group", "organization", "pursuit", "thing", "composite"]);
  const text = JSON.stringify(DEFAULT_REGISTRY).toLowerCase();
  for (const banned of guardNames()) expect(text).not.toContain(banned);
  expect(DEFAULT_REGISTRY.topics.some((t) => t.name === GENERAL_TOPIC)).toBe(true);
});

test("parseKey reads the type off the prefix and rejects the rest", () => {
  expect(parseKey("person:alex")).toEqual({ type: "person", slug: "alex" });
  expect(parseKey("pursuit:arizona-trip")).toEqual({ type: "pursuit", slug: "arizona-trip" });
  expect(parseKey("alex")).toBeNull();            // bare legacy key
  expect(parseKey("person:")).toBeNull();
  expect(parseKey(":x")).toBeNull();
  expect(parseKey("person:Has Caps")).toBeNull();     // slugs are [a-z0-9-]
});

test("an undeclared type prefix is refused", () => {
  expect(() => assertDeclaredKey(DEFAULT_REGISTRY, "business:acme")).toThrow(RegistryError);
  expect(() => assertDeclaredKey(DEFAULT_REGISTRY, "person:x")).not.toThrow();
  expect(subjectType(DEFAULT_REGISTRY, "thing:bakfiets")?.mintedBy).toBe("model");
});

test("only model-mintable types may be minted by the model", () => {
  expect(canModelMint(DEFAULT_REGISTRY, "pursuit")).toBe(true);
  expect(canModelMint(DEFAULT_REGISTRY, "person")).toBe(false);
  expect(canModelMint(DEFAULT_REGISTRY, "nope")).toBe(false);
});

test("topics not in the registry drop to general, capped at three, primary first", () => {
  expect(normalizeTopics(DEFAULT_REGISTRY, ["money", "bogus", "health", "home", "travel"])).toEqual(["money", "health", "home"]);
  expect(normalizeTopics(DEFAULT_REGISTRY, ["bogus"])).toEqual([GENERAL_TOPIC]);
  expect(normalizeTopics(DEFAULT_REGISTRY, undefined)).toEqual([GENERAL_TOPIC]);
  expect(normalizeTopics(DEFAULT_REGISTRY, "money")).toEqual([GENERAL_TOPIC]);
});

test("a host adds a type without replacing the rest", () => {
  const r = withTypes(DEFAULT_REGISTRY, [{ name: "business", gloss: "a company the host operates", mintedBy: "host", composite: false }]);
  expect(canModelMint(r, "business")).toBe(false);
  expect(() => assertDeclaredKey(r, "business:acme")).not.toThrow();
  expect(() => withTypes(r, [{ name: "person", gloss: "dup", mintedBy: "host", composite: false }])).toThrow(RegistryError);
});

test("DEFAULT_REGISTRY is frozen, arrays included", () => {
  expect(Object.isFrozen(DEFAULT_REGISTRY)).toBe(true);
  expect(() => (DEFAULT_REGISTRY.subjectTypes as SubjectType[]).push({ name: "x", gloss: "", mintedBy: "host", composite: false })).toThrow();
  expect(() => (DEFAULT_REGISTRY.topics as Topic[]).push({ name: "x", gloss: "" })).toThrow();
});
