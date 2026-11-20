---
id: 261119-140000
title: Verdicts anchor a ledger entry with no prs on the PR that added its file
kind: hygiene
status: proposed
actor: agent
gates: [wf.ci-steward.collect]
prs: []
ratchet-release: []
field-changes: []
---

Authors almost never come back to set `status: active` and fill `prs:` once
their PR merges: about 219 of 269 entries on main were `proposed` with
`prs: []`, so the verdict engine skipped them and the data branch held only 19
verdicts. But an entry lands on main in the same PR that ships its change, so
an entry on main is live and its anchor is the PR that added its file.

The steward now resolves that PR for every entry with no `prs:` of its own:
the merged PR into the default branch of the oldest commit touching the file,
cached once per entry at `ledger-prs/<id>.json` on the data branch (at most 50
fresh lookups, two requests each, per run). Verdicts read an effective view in
which such an entry takes that PR and a `proposed` one reads as `active`;
`withdrawn` and `reverted` are kept, and explicit `prs:` always win. A failed
lookup skips the entry for that run and never throws.

The ledger files are never rewritten and `ledger-check` still validates what
was authored, so no gate, required check or ledger rule changes. Nothing
measurable should move except the count of computed verdicts. Revert if a
resolved anchor is ever not the PR that shipped the entry's change.
