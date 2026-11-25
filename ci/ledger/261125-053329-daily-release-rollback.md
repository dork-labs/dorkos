---
id: 261125-053329
title: The daily release rolls back with one command, forward from the last good pin
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.daily-release.hold
prs: []
ratchet-release: []
field-changes: []
---

Row 10 of the daily-release design (DOR-5123, §6), the rollback half.
`gh workflow run daily-release.yml -f action=rollback -f bad_version=X.Y.Z` refuses unless X.Y.Z
is the newest plain version on npm. It then finds P_prev, the commit the release before it was
cut at (the merge base of that release's tag with main, which must be exactly one release commit
ahead), asks `scripts/release-gate.sh` to ship P_prev (`daily-release.sh pin`: the gate has no
time window), and plans `release/vX.Y.(Z+1)` at P_prev through the same cut path, with
`release-commit.ts --rollback X.Y.Z`: that release's notes again under "Rolled back X.Y.Z.".
npm's OIDC cannot move dist-tags and tokens are off, so it rolls forward.

The hold is an open issue labelled `release-hold`, which the new `hold` job opens with
`GITHUB_TOKEN` (issues write only) before the cut, because writing the `DAILY_RELEASE_HOLD`
variable needs an admin token. `decide` waits every new cut while one is open; closing it lets
the cuts resume. Like every write here it runs only while `DAILY_RELEASE_LIVE` is on.

It runs only on a bad release, so no PR or queue metric moves: hygiene. Revert it if a dry-run
rollback names a P_prev or version a person would not, and rehearse it once before go-live.
