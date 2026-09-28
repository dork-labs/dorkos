---
id: 260928-162613
title: check-vocab-gate.ts covers docs/**/*.mdx prose
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

DOR-2508's connections-health audit found `docs/connections/**` had drifted from the
shipped product (a stale Notifications control path, the in-chat request card
missing from the write-up, a threat-model claim that was false for two of the
four routes) and that `docs/**/*.mdx` carried the four nouns ADR 260804-021140
retired — "integration", "connector", "adapter", "provider" — with nothing to
catch the next one, because `check-vocab-gate.ts`'s own header had docs/ marked
"prose, not a render path, swept by hand".

`check-vocab-gate.ts` now also scans `.mdx` files under `docs/` (a line-based
pass after blanking fenced code, inline code and link/href targets — MDX isn't
TypeScript, so it can't use the parser walk `scanSource` uses), scoped to wave 4
only: wave 1's "connection" is ordinary prose everywhere a docs page talks about
a network connection (SSE, tunnels, the reverse-proxy guide), and sweeping that
wave is a separate, unscoped effort this change does not take on. `docs/api/**`
(generated from `openapi.json`) and the two compiled changelog files are
excluded, the same carve-outs `check-banned-words.sh` already documented for
wave 2.

A code review on the first pass of this change caught two real defects before
either landed: the fence tracker mis-parsed a fenced block that Prettier
collapses onto one line (`docs/contributing/testing.mdx`'s shape) and a
multi-line fence whose closer trails real content instead of opening its own
line (`docs/self-hosting/deployment.mdx`'s shape) — both would have blanked
every remaining line in the file as "still fenced." Fixed with a same-line
open+close case treated as inline code, and closers tracked by character AND
length so a shorter nested fence of the same character never closes an outer
one. The review also asked for line-scoped `vocab-allow` markers (the same
convention `check-banned-words.sh` already honors) in place of file-wide
`allowlist.json` passes wherever a page mixes user-facing and developer
content, reworking most of an initial 24-entry sweep down to 4 directory/file
entries for genuinely developer-only sections (`docs/integrations/`,
`docs/marketplace/publishing.mdx`, `docs/contributing/architecture.mdx`,
`docs/guides/flow/`) plus reworded copy or inline markers everywhere else. All
of that — the sweep itself, the false/stale lines the audit found — is content
work, not a pipeline change; this entry covers only the gate extension
mechanism (docs scanning, fence detection, the marker convention).

No new workflow step, job or required check: the docs scan rides the existing
`Retired-vocabulary gate` step in `typecheck` (renamed to say so) and the
existing real-repo canary in `scripts/__tests__/check-vocab-gate.test.ts`
(`runVocabGate(repoRoot)` now walks both `apps/{client,site,server}/src` and
`docs/`). That suite also gained fixture and mutation-style tests for the new
mechanism: fence detection (including both defects above as pinned regressions
plus a 4-backtick/3-backtick nested-fence case), the `vocab-allow` marker, and
two tests that drive a seeded docs violation through `runVocabGate` itself
(never `scanMdx` directly) specifically so a future change that disables or
drops the docs half of that function fails a test — verified by hand: deleting
that loop reds exactly those two tests, restoring it goes green again.
`kind: hygiene` — this closes a coverage gap the tool already existed to
close, it does not change what "passing" means for any surface that was
already scanned. Revert if the docs scan produces false positives faster than
the allowlist and the marker convention can absorb them (nothing observed in
this change: the real-repo canary and a full
`pnpm exec tsx scripts/check-vocab-gate.ts .` both run clean).
