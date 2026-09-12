/**
 * `PUBLISH_REPORT_CAPABILITY` — the frozen, provider-agnostic Capability
 * contract for `publish.report` (Unit 9 brief interface, verbatim).
 *
 * Exactly like Unit 8's `RESEARCH_RETRIEVE_CAPABILITY` (see that file's own
 * header for the fuller rationale), this is the Capability's CONTRACT only:
 * an id, a human-readable description, a static risk tag, and a cost
 * profile — the shape Policy (Unit 3), Budget (Unit 2), and the seed data
 * (`src/definitions/seed.ts`) reason about. Nothing here says anything about
 * how the capability is actually fulfilled: no function names, no mention of
 * a filesystem, a path, or any other concrete implementation detail. That is
 * kept entirely in a separate, sibling file (verified by a structural test
 * in `tests/capabilities/publishReport.integration.test.ts`, mirroring Unit
 * 8's own structural test for `researchRetrieve`), so a reviewer can swap
 * the fulfilling implementation for a fixture, or for a real external
 * publishing target later, without ever touching this file.
 *
 * `staticRiskTag: "highest"` (brief-specified, verbatim): this Capability
 * gates a real external-facing side effect (writing content to a durable
 * location outside the governance chain's own bookkeeping) — the highest
 * static risk tag this codebase defines, appropriate for a PUBLISH-permission
 * action regardless of how "real" the concrete fulfilling implementation
 * turns out to be. This CONTRACT's risk tag does not get to know or care
 * about that distinction.
 *
 * `id: "publish.report"` is the Capability's logical/business identifier —
 * NOT the `capabilities` table's primary key (a DB-generated uuid). The
 * seeding code (`src/definitions/seed.ts`) stores this string in the
 * `capabilities.name` column, same convention as Unit 8's capability.
 */
export const PUBLISH_REPORT_CAPABILITY = {
  id: "publish.report",
  description: "Write a report artifact's content to a local proof-of-governance output location",
  staticRiskTag: "highest" as const,
  costProfile: { costClass: "external_side_effect" as const },
};
