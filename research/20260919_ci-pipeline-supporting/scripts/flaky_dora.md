- 30d: 247 failed_checks ejections on PRs that later merged; re-queued with NO new commit/force-push: 209 (85%), re-queued after a change: 37, other/unknown: 1. Ejection -> re-entry when unchanged: median 23m, p90 2.1h
- 7d: 35 failed_checks ejections on PRs that later merged; re-queued with NO new commit/force-push: 27 (77%), re-queued after a change: 8, other/unknown: 0. Ejection -> re-entry when unchanged: median 17m, p90 1.7h
- Queue entry -> merged: never ejected median 26m (p90 52m); ejected >=1 median 2.1h (p90 19.7h); ejected PRs' extra queue-hours total 818h

### DORA-style

- Releases (tag commits) last 30d: 8 (v0.63.0, v0.64.0, v0.65.0, v0.66.0, v0.73.0, v0.74.0, v0.75.0, v0.75.1); last 7d: 2. Last release v0.75.1 at 2026-09-14T22:51:20Z
- Days between releases (last 60d): median 3.1, max 11.5
- Merged -> in a release: n=717, median 36.9h, p75 2.9d, p90 5.2d, mean 2.0d. Merged since last release, not yet shipped: 62 PRs (oldest waiting 4.4d)
- Lead time first commit -> merged: median 2.0h, p90 8.4h; first commit -> released: median 40.8h, p90 5.3d
- Conventional-commit type mix (30d merged): fix=336, feat=195, docs=109, test=48, chore=38, ci=32, refactor=19, perf=1, style=1
- Reverts merged 30d: 0
- `fix`/`hotfix` PRs: 336 of 779 (43%); titles with 'hotfix': 1; fix PRs whose TITLE cites a PR merged <=7d earlier: 1 (median gap 4.5h)

#### Main-branch red episodes (push-to-main runs; workflow first failure -> next success)

| workflow           | episodes | restore median | restore max |
| ------------------ | -------- | -------------- | ----------- |
| typecheck          | 1        | 1.8h           | 1.8h        |
| test               | 6        | 90m            | 5.0h        |
| browser-test       | 1        | 3.6h           | 3.6h        |
| CLI Smoke Test     | 2        | 22m            | 35m         |
| Desktop Smoke      | 3        | 73m            | 1.9h        |
| docs-openapi-check | 2        | 10.4h          | 19.4h       |
| scripts-test       | 1        | 2.6h           | 2.6h        |
