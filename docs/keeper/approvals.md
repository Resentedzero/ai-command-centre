# Why something is waiting for approval

Keywords: approval, waiting, stuck, approve, reject, gate, publisher, always approve, expired

An action waits for you when Policy returns REQUIRE_APPROVAL. Common reasons:

- the agent's key for that capability is **ALWAYS_APPROVE** (the Publisher's publish key is);
- the step is an **Approval Gate**;
- an autonomous agent chose to **ask you**;
- the tool binding is unverified.

The approval shows exactly what would happen, including a preview and hash of the content involved. **Approve** lets exactly that action run; the recorded snapshot and pinned hash must still match. **Reject** fails the step. An approval expires after its time limit, which counts as a rejection.

Approval waits never count toward an autonomous agent's active time.
