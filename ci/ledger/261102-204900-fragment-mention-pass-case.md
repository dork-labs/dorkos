---
id: 261102-204900
title: Pin that escaped @mentions pass the fragment lint, and escape the one on main
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Follows 261101-180834. That check judges only fragments a PR touches, and `261101-122500-tab-and-space-count-only-mentions.md` landed four hours before it, with a bare `@mentions` that would have pinged a real account at release (DOR-3697). It is reworded, and a sweep of all 40 fragments on main finds no other.

The analyzer suite had a fail case only. It now also proves that code spans, fenced code, emails and versions pass `--validate`. The test is new; the gate is unchanged. No required check, retry, shard or timeout changes.

Revert if the pass case forbids a fix the fail case needs.
