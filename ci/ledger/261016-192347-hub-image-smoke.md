---
id: 261016-192347
title: The hub image boots in CI against a stand-in for Cloud
kind: experiment
status: proposed
actor: agent
gates: [wf.cli-smoke-test.hub-smoke-test]
prs: []
hypothesis:
  metric: gate.wf.cli-smoke-test.hub-smoke-test.duration_p90
  slo: headroom
  baseline: 1.3
  baseline_source: 'No runs yet for the new job. Its sibling wf.cli-smoke-test.integration-test, which builds the same Docker stages from the same tarball, took 54 to 76 seconds over its last 7 green runs on main (gh run list --workflow cli-smoke-test.yml, 2026-10-16). The hub checks themselves took about 15 seconds locally against a built CLI.'
  target: 3
  after_days: 14
ratchet-release: []
field-changes: []
---

A new, non-required job in `cli-smoke-test.yml`, on the same path filter as its siblings. It builds the `hub-smoke` Docker stage, the hub image plus `scripts/hub-smoke/run.mjs`, and boots it against a stand-in for DorkOS Cloud. It checks that the hub refuses to boot without its instance key, answers the health check while pooled and refuses everything else, takes and confirms an assignment, and then admits only front-door traffic. The spec's acceptance line for A3 (DOR-2935) is "the image boots in CI with provisioning settings", and nothing else would catch a Dockerfile change that breaks the image Cloud boots.

The bet is that it stays as cheap as `integration-test`: p90 under 3 minutes against a 10-minute limit. Revisit if p90 passes 6 minutes (60% of the limit), or if it fails on PRs that did not touch the hub, which would mean it is flaky rather than catching something.
