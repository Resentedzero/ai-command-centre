# Deliverables, evidence and integrity

Keywords: deliverable, report, document, artifact, provenance, hash, integrity, verify, raw, evidence

Work products are immutable artifacts. Documents open in three views:

- **Document**: the readable deliverable.
- **Evidence**: who produced it (goal, task, agent version, run, invocation), when, its sha256 hash with **Verify integrity**, and its sources.
- **Raw**: the exact stored JSON.

Each deliverable records its **evidence basis**, written by the runtime rather than the model: which evidence-bearing capabilities actually ran, and whether any external research happened. A document built on fixture data or model knowledge says so.
