---
id: 261120-223425
title: Browser tests serve Inter locally and never wait on Google Fonts
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

The fix is in the e2e harness only. `apps/e2e/fixtures/base.ts` installs
context-level routes on every test's context: a Google Fonts stylesheet that
asks for Inter gets `@font-face` rules pointing at a local path on
`fonts.gstatic.com`, answered with the variable Inter files from
`@fontsource-variable/inter` (pinned 5.3.0, OFL-1.1, e2e devDependency only).
Every other Google Fonts stylesheet is answered empty and every other font file
is aborted; nothing passes through. Text still renders in Inter with Inter's
metrics. `fixtures/index.ts` extends that base, and the 43 spec and helper files
that imported `test` straight from `@playwright/test` now import it from the
base. As a backstop for contexts no fixture reaches (`browser.newContext()` in
a spec), the config passes Chromium `--host-resolver-rules` that make both
Google Fonts hosts fail to resolve at once instead of stalling. The global-setup
warm-up page is stubbed too. No `goto` wait changed and no product code changed.

The first version of this change seeded `dorkos-font-family=system` into every
context instead. That was rejected because the system font's metrics changed
layout: run 44831381307 failed
`dashboard-sidebar/sidebar-model-showcase.spec.ts:197` (a row title truncated,
light and dark) and `workbench/file-tree-open.spec.ts:49`. The client's
`inter` URL also asks for JetBrains Mono, which is not served locally and falls
back to the platform monospace font.

Ruled out: the Vite ws proxy ECONNRESET lines in the same logs are noise (they
are in green runs too); there was no dependency re-optimisation, HMR reload or
OOM in the failing shards.

Target counts only page-load timeouts on specs the PR did not touch, over 3 days
of queue runs. The gate's whole failure rate is the nearest catalogue id and
carries other causes. Revert if a browser spec is found to depend on rendering
the local Inter does not reproduce (for example JetBrains Mono in code text) and
cannot be fixed in the spec, or if queue page-load-timeout reds continue at
the same rate with no Google Fonts request in their traces, which would mean
the cause was elsewhere.
