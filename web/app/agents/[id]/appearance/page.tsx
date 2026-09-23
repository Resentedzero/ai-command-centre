"use client";

import { use } from "react";
import { AppearanceEditor } from "../../../../components/agents/AppearanceEditor";
import b from "../../../../components/agents/builder.module.css";

/** Change how an agent looks. Saves the appearance only: no Definition version, key or event. */
export default function AgentAppearancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <main className={b.screen}>
      <AppearanceEditor id={id} />
    </main>
  );
}
