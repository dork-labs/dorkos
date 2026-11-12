---
id: 261112-190000
title: 'Browser jobs install Chromium OS packages from a cache, without an Ubuntu server'
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-smoke
  - wf.browser-test.browser-shard
  - wf.browser-test.first-run
prs: []
hypothesis:
  metric: 'gate.wf.browser-test.browser-smoke.failure_rate'
  baseline: 0.073
  baseline_source: 'ci-steward snapshots 2026-11-05..11-11 (QA shared-cause report, steward-rates.txt): browser-smoke pull_request 88/1206 failed. Cluster C2 (Ubuntu apt in the Chromium install step) is 45 of the 269 failed browser/harness/desktop job executions in that window; 44 of 46 Chromium-step failures show Ign/Err against archive or security.ubuntu.com, the other 2 crawled.'
  target: 0.05
  after_days: 14
ratchet-release: []
field-changes: []
---

On 2026-11-09 and 2026-11-11 archive.ubuntu.com and security.ubuntu.com timed out on every
request or crawled at 8–58 kB/s. Every browser job installs Chromium's OS packages with
`playwright install --with-deps` / `install-deps`, which is `apt-get update` plus `apt-get
install`, so 45 jobs failed in that step without reaching a test (34 passed on rerun). The PR
smoke step from #3528 was weaker than the shard step: a 5-minute cap, no retry, and always
`--with-deps`. #3628 fixed the same outage for test.yml and cli-smoke by dropping apt, which
Chromium's fonts do not allow; its ledger (261111-163545) records that the Azure mirror failed
to resolve too, so mirror failover would not have helped here either.

Hypothesis: with the packages cached and installed without `apt-get update`, an Ubuntu outage
stops failing browser jobs once a scheduled run has saved the cache for the current image.

What changed (scripts/playwright-apt-debs.sh, used by browser-smoke, browser-shard and
first-run):

- Plan, no network: `playwright install-deps --dry-run chromium` (Playwright 1.65 simulates
  `apt-get install -s` against the image's own apt lists) names the missing packages, and
  `apt-get install --print-uris` gives each one's exact file (name_version_arch.deb), size and
  hash. The cache key is `playwright-apt-v1-<ImageOS>-<arch>-<sha256 of that manifest>`, so a
  new package version or a new image is a new key.
- Cache hit: each .deb is checked against the manifest's hash, then installed with
  `apt-get install --no-download -o Dir::Cache::archives=<cache>`, which checks it again
  against the image's signed index and fetches nothing. No `apt-get update`, never `dpkg -i`.
- Miss: `apt-get install --download-only` fetches exactly the manifest's files (no
  `apt-get update`), then the same check and install. Only if that fails does it fall back to
  the old `playwright install-deps`. The browser itself downloads only on its own cache miss.
- Save: one step, browser-shard shard 1, `if: schedule && ref == main && miss && debs checked`.
  Pull requests and queue builds use `actions/cache/restore` and never save.
- browser-smoke gets the shard settings: 10-minute cap, two attempts, browser download only on
  a browser cache miss.
- Every action in browser-test.yml is pinned by full commit SHA. No permission changed.

Known trade-off: a miss installs the versions the image's lists name rather than whatever
`apt-get update` would find newer in -updates/-security. Today's packages are all fonts from
the `noble` release pocket; the image is rebuilt weekly and the key follows it.

At 14 days, read the Chromium step logs as well as the rate: target zero Ubuntu fetches on a
cache hit, and no browser job failed by apt while the cache was warm. Revert or revisit if the
plan falls back on every run (Playwright's dry-run output changed), if a cache hit still calls
an Ubuntu host, or if the cache is never saved (the scheduled shard 1 never reports
`debs-ready`). The guard that pins this, `scripts/__tests__/playwright-apt-debs.test.ts`, runs in
scripts-test `harness`, which does not run for a browser-test.yml-only change (the C3 class in
the same report).
