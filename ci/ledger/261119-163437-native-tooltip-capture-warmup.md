---
id: 261119-163437
title: Warm the native tooltip witness capture before measuring hover
kind: incident-fix
status: proposed
actor: agent
gates: [wf.desktop-smoke.packaged-runtime]
prs: []
hypothesis:
  metric: gate.wf.desktop-smoke.packaged-runtime.failure_rate
  slo: main-green
  baseline: 0.1025641026
  baseline_source: 'ci-steward-data at 9076461643b9c41316f78d06cee334ca3698d83f, snapshots/2026-11-18.json: 4 failures / 39 completed non-cancelled pull_request and push runs'
  target: 0.05
  after_days: 7
ratchet-release: []
field-changes: []
---

The native tooltip witness assumes its first measured hover can obtain a still within the
product's 150 ms budget. That budget deliberately declines a slow capture: the live page
stays visible and the button gets a plain title instead of custom tooltip content. The
witness then reports that the page never stepped aside, although this fallback is allowed.

Main run 44547839822 failed twice on the first light-idle case. The same tree passed on
release PR run 44521017917. Diagnostic run 44562694321 passed and measured the first
preparation at 105.5 ms, against 40.8, 38.5 and 25.7 ms later. The old failures did not
record capture timing, so a cold capture missing the budget is the supported explanation,
not a retrospectively measured duration.

Warm one capture through the real preload bridge and decode its JPEG before the measured
cases. Fail setup after five seconds or on an unusable image; revoke the temporary URL,
and assert the live page stayed visible with no prepared still left behind. Then run all
four with-still scenes and both no-still scenes unchanged. No product budget, assertion,
retry, shard, required check or workflow timeout changes.

Acceptance requires three consecutive Desktop Smoke passes at one fix head. Revisit if
setup cannot produce a still, any measured case still fails, or the gate's failure rate
does not improve. The baseline includes other Desktop Smoke failures, which can confound
the seven-day result; never treat that verdict as proof of the tooltip's behavior.
