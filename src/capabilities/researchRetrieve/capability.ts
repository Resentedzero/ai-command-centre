/**
 * `RESEARCH_RETRIEVE_CAPABILITY` — the frozen, provider-agnostic Capability
 * contract for `research.retrieve` (Unit 8 brief interface, verbatim).
 *
 * This is the Capability's CONTRACT only: an id, a human-readable
 * description, a static risk tag, and a cost profile — the shape Policy
 * (Unit 3), Budget (Unit 2), and the seed data (`src/definitions/seed.ts`)
 * reason about. Nothing here says anything about how the capability is
 * actually fulfilled: no function names, no mention of what kind of service
 * backs it, no configuration detail. That is a separate file's
 * responsibility, kept entirely out of this one (verified by a structural
 * test in `tests/capabilities/researchRetrieve.integration.test.ts`) so a
 * reviewer can swap the fulfilling implementation for a fixture, or for a
 * real external service later, without ever touching this file.
 *
 * `id: "research.retrieve"` is the Capability's logical/business identifier
 * — NOT the `capabilities` table's primary key (that column is a
 * DB-generated uuid, per `src/db/schema.ts`). The seeding code
 * (`src/definitions/seed.ts`) stores this string in the `capabilities.name`
 * column, since the MVP schema has no separate "slug"/"key" column.
 */
export const RESEARCH_RETRIEVE_CAPABILITY = {
  id: "research.retrieve",
  description: "Retrieve information relevant to a query",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "metered_api" as const },
};
