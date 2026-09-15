"use client";

import { use } from "react";
import { WorkflowsScreen } from "../WorkflowsScreen";

/** `params` is a Promise in this Next.js version, read with React's `use` in a client page. */
export default function WorkflowRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <WorkflowsScreen id={id} />;
}
