-- V1.1 Agent Builder: an Agent Definition's execution profile (preferred logical tier,
-- a provider restriction, loop defaults within the operator's ceilings). Additive:
-- existing versions read as an empty profile, which changes nothing about how they run.
-- Like every Definition column it is written once, by the Registry, and never updated.
ALTER TABLE "agent_definitions" ADD COLUMN "execution_profile" jsonb DEFAULT '{}'::jsonb NOT NULL;
