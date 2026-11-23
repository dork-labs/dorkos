---
id: 261122-133015
title: The release tag and npm publish steps run the QA-GO check themselves (DOR-5050)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The release tag, `publish:cli` and the two package publishes now refuse unless QA's ledger holds a GO for the exact tree (DOR-5050). Before, the check was an untracked script a release lane had to remember, and 0.140.1 skipped it. No CI job, gate or required check changes, and no metric should move: these are local release steps. Revert if a correct GO is refused and the rule, not the ledger, is wrong.
