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
wave 2. The sweep itself — 24 new `allowlist.json` entries for real domain uses
(the `/flow` engine's tracker-adapter pattern, OpenCode's model-provider picker,
a marketplace package's `adapter` facet, Relay's own adapter architecture,
"integration test" as a testing term) plus rewriting the handful of genuinely
stale or false lines the audit found — is content work, not a pipeline change;
this entry covers only the gate extension.

No new workflow step, job or required check: the docs scan rides the existing
`Retired-vocabulary gate` step in `typecheck` (renamed to say so) and the
existing real-repo canary in `scripts/__tests__/check-vocab-gate.test.ts`
(`runVocabGate(repoRoot)` now walks both `apps/{client,site,server}/src` and
`docs/`). `kind: hygiene` — this closes a coverage gap the tool already existed
to close, it does not change what "passing" means for any surface that was
already scanned. Revert if the docs scan produces false positives faster than
the allowlist can absorb them (nothing observed in this change: the real-repo
canary and a full `pnpm exec tsx scripts/check-vocab-gate.ts .` both run clean).
