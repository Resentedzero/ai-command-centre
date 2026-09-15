"use client";

import { use } from "react";
import { ArtifactsScreen } from "../ArtifactsScreen";

/** `?full=1` opens the whole inline content (linked from a truncated approval preview); `?agent=` keeps the vault being browsed. */
export default function ArtifactPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ agent?: string; full?: string }>;
}) {
  const { id } = use(params);
  const { agent, full } = use(searchParams);
  return <ArtifactsScreen id={id} agentParam={agent} full={full === "1"} />;
}
