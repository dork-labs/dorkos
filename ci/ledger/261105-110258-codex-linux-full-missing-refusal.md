---
id: 261105-110258
title: Prove explicit Linux Full refusal before native launch with missing protected targets
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox]
prs: [3480]
ratchet-release: []
field-changes: []
---

Security approved the explicit Linux Full refusal while DOR-3906 handles
server-owned placeholders separately. Add a native test requiring error/done,
no process acquisition or binding, no Codex spawn (therefore no bubblewrap
child from that turn), and an unchanged throwaway host-tree snapshot. The
selected permission stays Full; no automatic downgrade. Production checks
before process acquisition and again while recording the actual load masks.

Every mask and the existing Full host-file assertion remain unchanged. No
fixture is filled with placeholders to force Full success. Older native rows
which expect Full to start from incomplete homes now conflict with this
explicit fallback and remain unproven/red; this entry does not clear them.
No existing test is skipped; the new refusal row runs only on Linux.
No retry, time cap, required context or native bypass changes.
Remove the fallback only with reviewed DOR-3906 proof; revert this row if it
permits a process launch or host mutation in the refusal case. Linux run pending.
