# Build a workflow

Keywords: workflow builder, custom workflow, steps, pipeline, process, reorder, inputs, outputs

1. Open **Workflows** and choose **Build a workflow**.
2. Name it and describe its purpose.
3. Add steps. Each step picks a **task** (its kind decides the parameters) and an **agent**:
   - **Agent Task**: the agent writes a document from your instruction.
   - **Autonomous Objective**: the agent works on the goal in a bounded loop.
   - **Approval Gate**: the run stops until you approve the pinned outputs.
   - **Research-Report** and **Review-and-Publish**: the original V1 steps.
4. Pass outputs forward by ticking an earlier step under **Inputs**. A step only sees what you pass it.
5. Reorder with the arrows; remove steps you do not need.
6. **Check** runs every Registry rule without saving. **Save** creates a new version.
7. Start it from **Run it**, or from **Goals** with the workflow picker.

Workflows are linear. Branching and parallel steps are not supported; the autonomous objective step is the only loop.
