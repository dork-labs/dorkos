---
id: 261115-230512
title: Reuse the same raw source snapshot for the credential-name guard
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: []
ratchet-release: []
field-changes: []
---

DOR-4489 reuses the server source text already loaded for the lexical guard.
The managed-credential-name assertion previously reread those same files
serially inside its test. Both scans now use one raw snapshot: code-only
call matching still strips prose, while credential-name matching still sees
strings and comments. All 53 cases, the source-count floor, the exact allowed
module and the default 5000 ms test budget remain unchanged.

This is test-source maintenance, not an aggregate CI performance experiment.
The observed full local verification failure was at 5006 ms under concurrent
load; it does not establish a per-gate failure rate or a causal timing gain.
The 2026-11-14 CI snapshot reports collector-health failures and no metric for
this individual test. No metric baseline or improvement is invented here.

The earlier lexical snapshot was introduced in 4f9debd7005 and later switched
to the shared stripper in c5fee30123c. This change preserves that lexical
corpus and shares its input with the distinct raw-text assertion.

Validation inserts an exclusive temporary production module containing a raw
credential-name string, then a separate comment-only probe. Each must fail
with that extra module named, and removing the exact probe must restore all
53 cases. Revert or repair if either probe escapes detection, the lexer
corpus changes, or the file enumeration/allowed module assertion narrows.
No workflow, retry, timeout, shard, floor, quarantine or judge changes.
