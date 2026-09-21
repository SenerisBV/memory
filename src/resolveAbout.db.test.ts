import { beforeEach, expect, test } from "bun:test";

import { handle, resetDb } from "../tests/setup";
import { fakeHost } from "../tests/fakes";
import { RegistryError } from "./registry";
import { createResolveAbout } from "./resolveAbout";
import { createStore } from "./store";

beforeEach(resetDb);
const host = fakeHost();
const store = createStore(handle, host);
const resolve = createResolveAbout(host, store);

test("a string entry is trimmed before it is parsed", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  expect((await resolve([" person:ann "])).keys).toEqual(["person:ann"]);
});

test("existing keys pass through; an alias resolves; an undeclared key is refused", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  await store.putAlias("42", "person:ann");
  expect((await resolve(["person:ann", "42"])).keys).toEqual(["person:ann"]);
  await expect(resolve(["business:acme"])).rejects.toThrow(RegistryError);
  await expect(resolve(["person:unknown"])).rejects.toThrow(/not a known subject/);
});

test("a proposed subject matches an existing label before it is minted", async () => {
  await store.getOrCreateSubject("person:robin", "Robin");
  const r = await resolve([{ type: "person", label: "robin" }]);
  expect(r.keys).toEqual(["person:robin"]);
  expect(r.minted).toEqual([]);
});

test('a proposed subject matches an ALIAS before it is minted: "Sam" resolves to person:robin', async () => {
  // Spec §5: a proposal is "matched against existing labels and aliases
  // (slug-equal, then alias) before a new row is created; 'Sam' resolves to
  // person:robin". The label lookup misses ("Sam" is not "Robin") and
  // so does the slug lookup ("person:sam" does not exist) — the alias table
  // is the only thing that can close this, and the proposal path never
  // consulted it.
  await store.getOrCreateSubject("person:robin", "Robin");
  await store.putAlias("sam", "person:robin");
  const r = await resolve([{ type: "person", label: "Sam" }]);
  expect(r.keys).toEqual(["person:robin"]);
  expect(r.minted).toEqual([]);
});

test("with NO alias registered, the same host-minted proposal is still dropped", async () => {
  // The other half of the pair above: the ALIAS is what resolves "Sam", not
  // some looser label match that would also fire without one. Person is
  // host-minted, so the proposal is dropped and logged rather than minted.
  await store.getOrCreateSubject("person:robin", "Robin");
  const r = await resolve([{ type: "person", label: "Sam" }]);
  expect(r.keys).toEqual([]);
  expect(r.minted).toEqual([]);
  expect(host.events.some((e) => e.message.includes("Sam"))).toBe(true);
});

test("a model-mintable type is minted once and then found", async () => {
  const a = await resolve([{ type: "pursuit", label: "Arizona Trip" }]);
  expect(a.keys).toEqual(["pursuit:arizona-trip"]);
  expect(a.minted).toEqual([{ key: "pursuit:arizona-trip", label: "Arizona Trip" }]);
  const b = await resolve([{ type: "pursuit", label: "arizona trip" }]);
  expect(b.keys).toEqual(["pursuit:arizona-trip"]);
  expect(b.minted).toEqual([]);
  expect((await store.getSubject("pursuit:arizona-trip"))?.attention).toBe("track");
});

test("a host-minted type proposed with an unknown label is dropped, not minted, and logged", async () => {
  const r = await resolve([{ type: "person", label: "Nobody" }, { type: "pursuit", label: "Chores" }]);
  expect(r.keys).toEqual(["pursuit:chores"]);
  expect(host.events.some((e) => e.message.includes("Nobody"))).toBe(true);
});

test("duplicates collapse and order is kept", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const r = await resolve(["person:ann", { type: "pursuit", label: "Chores" }, "person:ann", "pursuit:chores"]);
  expect(r.keys).toEqual(["person:ann", "pursuit:chores"]);
});

test("resolveAbout drops an entry with an empty type or label, per entry, without throwing the batch", async () => {
  await store.getOrCreateSubject("person:ann", "Ann");
  const r = await resolve([{ type: "", label: "x" }, "person:ann"]);
  expect(r.keys).toEqual(["person:ann"]);
  expect(r.minted).toEqual([]);
  expect(host.events.some((e) => e.message.includes("empty type or label"))).toBe(true);
});

test("an undeclared type is dropped before it can reach findSubjectByLabel's LIKE pattern", async () => {
  // "%" as a type would turn findSubjectByLabel's `${type}:%` pattern into
  // "%:%", matching ANY typed key (including person:ann) — and the byLabel
  // early-return would push it onto keys without assertDeclaredKey ever
  // running. The registry gate must reject the type before that lookup.
  await store.getOrCreateSubject("person:ann", "Ann");
  const r = await resolve([{ type: "%", label: "Ann" }, "person:ann"]);
  expect(r.keys).toEqual(["person:ann"]);
  expect(r.minted).toEqual([]);
  expect(host.events.some((e) => e.message.includes("undeclared type"))).toBe(true);
});

test("bySlug is checked before canModelMint: an existing subject is found even though its label differs", async () => {
  await store.getOrCreateSubject("person:bob", "Robert");
  const r = await resolve([{ type: "person", label: "Bob" }]);
  // "Bob" does not label-match "Robert", but typedKey("person", "Bob") is
  // "person:bob", which already exists — found by slug, never minted (person
  // is host-minted, so if bySlug ran AFTER canModelMint this would be
  // dropped instead of found).
  expect(r.keys).toEqual(["person:bob"]);
  expect(r.minted).toEqual([]);
});

test("an unsluggable proposed label is dropped, not minted, and logged", async () => {
  const r = await resolve([{ type: "pursuit", label: "…" }]);
  expect(r.keys).toEqual([]);
  expect(r.minted).toEqual([]);
  expect(host.events.some((e) => e.message.includes("unsluggable"))).toBe(true);
});

test("a label that slugs to a different key is still found by the label-match branch", async () => {
  // The stored key ("person:sam") is NOT typedKey("person", "Robin Jones")
  // ("person:robin-jones"), so only the case-insensitive label lookup —
  // not the slug fallback — can find it. If findSubjectByLabel is bypassed,
  // typedKey produces "person:robin-jones", which does not exist, and
  // person is host-minted, so the proposal would be dropped instead.
  await store.getOrCreateSubject("person:sam", "Robin Jones");
  const r = await resolve([{ type: "person", label: "robin jones" }]);
  expect(r.keys).toEqual(["person:sam"]);
  expect(r.minted).toEqual([]);
});
