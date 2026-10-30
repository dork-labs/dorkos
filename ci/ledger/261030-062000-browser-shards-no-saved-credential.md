---
id: 261030-062000
title: The browser shards check out without a saved credential
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-shard, wf.browser-test.first-run]
prs: [3216]
ratchet-release: []
field-changes: []
---

`browser-shard` and `first-run` now check out with `persist-credentials: false`,
as `test-shard` already does (ledger 261027-034745). Nothing in either job pushes
or fetches after checkout.

Why: the checkout action saves its credential into the checkout's own git
settings, as an include. The browser specs make git repositories inside this
checkout (`apps/e2e/.temp/fixtures/…`), and DOR-3343's audited git runner reads
every settings file from a folder up, refusing an include. With the credential
saved, every fixture project read as "not a project" and #3216's queue build
went red: account eligibility, start work and inbox decisions all build their
projects there, and the room sheet on a phone most likely follows from the same
refusal. A person's own clone carries no such include, so the specs pass
locally; only the CI checkout differed.

This is a hygiene change: it claims no speed or flake improvement. Revert only
if a later step in either job needs authenticated git, and then pass the token to
that step alone.
