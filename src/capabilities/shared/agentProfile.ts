/** The execution profile of the Agent Definition version a step binds, parsed fail-closed. */
import { and, eq } from "drizzle-orm";
import { agentDefinitions } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import { parseExecutionProfile, type ExecutionProfile } from "../../definitions/executionProfile.js";

export async function loadExecutionProfile(tx: DrizzleTransaction, agentDefinitionId: string, agentDefinitionVersion: number): Promise<ExecutionProfile> {
  const agent = await tx.query.agentDefinitions.findFirst({
    where: and(eq(agentDefinitions.id, agentDefinitionId), eq(agentDefinitions.version, agentDefinitionVersion)),
  });
  if (!agent) throw new Error(`loadExecutionProfile: no Agent Definition ${agentDefinitionId} v${agentDefinitionVersion} (fail closed).`);
  const parsed = parseExecutionProfile(agent.executionProfile);
  if (!parsed.ok) throw new Error(`loadExecutionProfile: ${agent.name} v${agent.version}: ${parsed.reason} (fail closed).`);
  return parsed.profile;
}
