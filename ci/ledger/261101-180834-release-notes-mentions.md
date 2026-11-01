---
id: 261101-180834
title: Refuse bare @mentions in release notes and changelog fragments
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The v0.129.0 release notes used `@ana` and `@bo` as examples outside backticks. GitHub turned them into real mentions, which pinged strangers and listed them under the release.

`fragment-present` now refuses a bare mention in a fragment the PR touched, through `release_mentions.py`, and also runs that module's tests. `/system:release` runs the same file on the compiled section and on the notes. No required check, retry, shard or timeout changes.

Revert if the check refuses real text that GitHub would not ping for, and backticks are not a fair fix for it.
