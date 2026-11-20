---
id: 261120-223425
title: Browser tests boot on the system font and never wait on Google Fonts
kind: experiment
status: proposed
actor: agent
gates: [wf.browser-test.browser-shard, wf.browser-test.browser-smoke, wf.browser-test.browser-test]
prs: []
hypothesis:
  metric: gate.wf.browser-test.browser-shard.failure_rate@merge_group
  baseline: null
  baseline_source: 'Counted by hand, not a rate: queue browser-test page-load-timeout reds on specs the PR did not touch. On 2026-11-20, 6 shards in 4 runs (44819122089, 44820403175, 44819123250, 44819309504) ejected 4 PRs (#4071 twice, #4069, #4026); every one has a fonts.googleapis.com stylesheet stalled 19.6 to 45.2 s in its Playwright trace.'
  target: 0
  after_days: 3
ratchet-release: []
field-changes: []
---

DOR-4871. The client's default font (`inter`) inserts a Google Fonts
stylesheet at startup. `page.goto` waits for `load`, `load` waits for that
stylesheet, and on Nov 20 21:36-21:38Z Google stalled it for 20-45 s. Whatever
spec was loading a page then timed out, and the queue ejected PRs that touched
nothing near it.

The fix is in the e2e harness only. `playwright.config.ts` seeds
`dorkos-font-family=system` into every context's `storageState`, next to the
boot-cache flag, so every spec in every project boots on the font pairing that
has no external stylesheet. The shared `test` in `apps/e2e/fixtures/index.ts`
also routes `fonts.googleapis.com` to an empty stylesheet and aborts
`fonts.gstatic.com` on every context, for anything that still asks. No
`goto` wait changed and no product code changed.

Ruled out: the Vite ws proxy ECONNRESET lines in the same logs are noise (they
are in green runs too); there was no dependency re-optimisation, HMR reload or
OOM in the failing shards.

Target counts only page-load timeouts on specs the PR did not touch, over 3 days
of queue runs. The gate's whole failure rate is the nearest catalogue id and
carries other causes. Revert if a browser spec is found to depend on the web
font (a layout or screenshot assertion that changes on `system`) and cannot be
fixed in the spec, or if queue page-load-timeout reds continue at the same rate
with no Google Fonts request in their traces, which would mean the cause was
elsewhere.
