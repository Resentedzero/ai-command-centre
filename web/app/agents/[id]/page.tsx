"use client";

import { use } from "react";
import { AgentsScreen } from "../AgentsScreen";

/** `params` is a Promise in this Next.js version, read with React's `use` in a client page. */
export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <AgentsScreen id={id} />;
}
