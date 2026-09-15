"use client";

import { use } from "react";
import { ArtifactsScreen } from "./ArtifactsScreen";

export default function ArtifactsPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const { agent } = use(searchParams);
  return <ArtifactsScreen agentParam={agent} />;
}
