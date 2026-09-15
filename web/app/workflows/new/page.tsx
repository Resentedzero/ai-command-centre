"use client";

import { use } from "react";
import { WorkflowBuilder } from "../../../components/workflows/WorkflowBuilder";
import { readKeeperProposal } from "../../../lib/keeperProposal";
import b from "../../../components/agents/builder.module.css";

/** `?from=<workflow definition id>` versions that workflow; `?proposal=<key>` pre-fills from a Keeper proposal held in this tab. */
export default function NewWorkflowPage({ searchParams }: { searchParams: Promise<{ from?: string; proposal?: string }> }) {
  const { from, proposal } = use(searchParams);
  return (
    <main className={b.screen}>
      <WorkflowBuilder fromId={from} prefill={proposal ? readKeeperProposal(proposal, "workflow") : undefined} />
    </main>
  );
}
