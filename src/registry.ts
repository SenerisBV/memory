// Host data. The library is opaque on names: nothing outside this file's
// DEFAULT_REGISTRY names a type or a topic, and the default exists only so a
// fresh host has something on day one. `general` is the one string the
// library itself relies on (the classifier's fallback).

export interface SubjectType {
  /** The key prefix, e.g. "person" in "person:alice". [a-z][a-z0-9-]* */
  name: string;
  /** Shown to the extractor. Prompt text, not a comment. */
  gloss: string;
  /** Who may mint keys of this type. "model" lets extraction propose new
   *  subjects; "host" means only the host names them. */
  mintedBy: "host" | "model";
  /** A composite synthesizes over its members' dossiers plus its own rows. */
  composite: boolean;
}

export interface Topic {
  name: string;
  gloss: string;
}

export interface Registry {
  subjectTypes: readonly SubjectType[];
  topics: readonly Topic[];
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export const GENERAL_TOPIC = "general";
export const MAX_TOPICS = 3;

export const DEFAULT_REGISTRY: Registry = {
  subjectTypes: [
    { name: "person", gloss: "a human being the host serves or knows: a principal, a partner, a child, a friend, a colleague", mintedBy: "host", composite: false },
    { name: "group", gloss: "a set of people who act together: a household, a team, a family", mintedBy: "host", composite: true },
    { name: "organization", gloss: "a company, school, insurer, agency or institution", mintedBy: "host", composite: false },
    { name: "pursuit", gloss: "something being worked toward or dealt with over time: a trip, a purchase, a project, a recurring chore", mintedBy: "model", composite: false },
    { name: "thing", gloss: "a durable object with its own history: a bike, a machine, a vehicle, a device", mintedBy: "model", composite: false },
    { name: "composite", gloss: "a roll-up the host defines over other subjects", mintedBy: "host", composite: true },
  ],
  topics: [
    { name: "money", gloss: "spending, budgets, income, rent, premiums, savings — anything denominated in money" },
    { name: "health", gloss: "physical or mental health: symptoms, sleep, exercise, appointments, coverage" },
    { name: "family", gloss: "immediate family logistics: school, childcare, birthdays" },
    { name: "people", gloss: "people outside the immediate family, as individuals" },
    { name: "home", gloss: "the dwelling and its upkeep: appliances, repairs, furniture, garden, cleaning, moving" },
    { name: "gear", gloss: "durable equipment and its purchase" },
    { name: "travel", gloss: "trips, routes, holidays" },
    { name: "work", gloss: "employment, clients, contracts, recurring work meetings" },
    { name: "leisure", gloss: "books, films, music, eating out, hobbies" },
    { name: "meta", gloss: "the assistant itself: how it should behave, what it can do, where things are kept" },
    { name: GENERAL_TOPIC, gloss: "nothing above fits" },
  ],
};

// Frozen: DEFAULT_REGISTRY is shared by every host that does not replace it,
// and `readonly` is a compile-time promise only. A host that pushed one type
// onto `subjectTypes` would change what every other construction in the
// process declares — silently, and only for the ones built afterwards.
// `push` on a frozen array throws in a module (always strict), so the mistake
// is loud where it is made.
Object.freeze(DEFAULT_REGISTRY);
Object.freeze(DEFAULT_REGISTRY.subjectTypes);
Object.freeze(DEFAULT_REGISTRY.topics);

const TYPE_NAME = /^[a-z][a-z0-9-]*$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function parseKey(key: string): { type: string; slug: string } | null {
  const i = key.indexOf(":");
  if (i <= 0 || i === key.length - 1) return null;
  const type = key.slice(0, i);
  const slug = key.slice(i + 1);
  if (!TYPE_NAME.test(type) || !SLUG.test(slug)) return null;
  return { type, slug };
}

export function subjectType(registry: Registry, key: string): SubjectType | null {
  const parsed = parseKey(key);
  if (!parsed) return null;
  return registry.subjectTypes.find((t) => t.name === parsed.type) ?? null;
}

export function assertDeclaredKey(registry: Registry, key: string): void {
  const parsed = parseKey(key);
  if (!parsed) throw new RegistryError(`"${key}" is not a typed key (<type>:<slug>)`);
  if (!registry.subjectTypes.some((t) => t.name === parsed.type)) {
    throw new RegistryError(`"${key}": subject type "${parsed.type}" is not declared in the registry`);
  }
}

export function canModelMint(registry: Registry, typeName: string): boolean {
  return registry.subjectTypes.some((t) => t.name === typeName && t.mintedBy === "model");
}

export function normalizeTopics(registry: Registry, topics: unknown): string[] {
  if (!Array.isArray(topics)) return [GENERAL_TOPIC];
  const known = new Set(registry.topics.map((t) => t.name));
  const out = topics.filter((t): t is string => typeof t === "string" && known.has(t)).slice(0, MAX_TOPICS);
  return out.length > 0 ? out : [GENERAL_TOPIC];
}

export function withTypes(registry: Registry, extra: SubjectType[]): Registry {
  for (const t of extra) {
    if (!TYPE_NAME.test(t.name)) throw new RegistryError(`type name "${t.name}" must match ${TYPE_NAME}`);
    if (registry.subjectTypes.some((e) => e.name === t.name)) throw new RegistryError(`type "${t.name}" is already declared`);
  }
  return { subjectTypes: [...registry.subjectTypes, ...extra], topics: registry.topics };
}
