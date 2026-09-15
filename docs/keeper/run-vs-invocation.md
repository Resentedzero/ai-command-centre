# Goal, workflow run, task, run and invocation

Keywords: run, invocation, goal, workflow run, task instance, difference, attempt, retry

- **Goal**: what you asked for.
- **Workflow run**: one execution of a workflow for that goal.
- **Task instance**: one step of that workflow run.
- **Run**: one attempt at a task instance by one agent version. A retry is a new run.
- **Invocation**: one action inside a run: a model call (llm), a tool call, or a deterministic step.

An autonomous objective is one run containing many invocations: decide, act, record, repeated, then the final write. Every invocation has its own governance record, context lineage and events.
