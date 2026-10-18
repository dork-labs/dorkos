---
id: 261018-175703
title: The packaged Community proof also runs for the shared space-page module
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.community-packaged]
prs: []
ratchet-release: []
field-changes: []
---

`@dorkos/shared/space-page` now holds what the space's web page and the space
server share: reading a short web address, the sentences a removed message
shows, and the owner-replacement wording (server-merge step 7e prep). The
packaged proof's browser driver relies on them, but the scope rule matched only
`packages/shared/src/` paths naming "community", so a pull request changing
only that folder would have skipped the proof and met it first in the merge
queue. `scripts/community-packaged-scope.sh` now lists the folder, with a
fixture for it and a near miss beside it.

Hygiene, not an experiment: the share of pull requests that run the proof
moves only for ones that touch this folder. Revert if the folder is retired.
