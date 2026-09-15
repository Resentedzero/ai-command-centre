"use client";

import { use } from "react";
import { AgentBuilder } from "../../../components/agents/AgentBuilder";
import { readKeeperProposal } from "../../../lib/keeperProposal";
import b from "../../../components/agents/builder.module.css";

/** `?from=<agent id>` versions that agent; `?proposal=<key>` pre-fills from a Keeper proposal held in this tab. */
export default function NewAgentPage({ searchParams }: { searchParams: Promise<{ from?: string; proposal?: string }> }) {
  const { from, proposal } = use(searchParams);
  return (
    <main className={b.screen}>
      <AgentBuilder fromId={from} prefill={proposal ? readKeeperProposal(proposal, "agent") : undefined} />
    </main>
  );
}
