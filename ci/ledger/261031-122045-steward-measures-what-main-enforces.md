---
id: 261031-122045
title: The steward judges red by what main enforces, and one silent clone no longer turns it red
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Two measurement fixes in the daily collector. Neither changes a gate.

**A queue build is red only when a check main really requires failed.**
`ci/required-checks.json` lists `security-gate.yml` under `workflows`, and the
collector counted it as required. It is not enforced: no organization `workflows`
rule is active on `main` (Security and the PM, from
`repos/dork-labs/dorkos/rules/branches/main`), so a `security-gate` failure ejects
nothing. From 10-24 to 10-30, 82 of 188 red queue builds were red on `security-gate`
alone (`scripts/queue-red-why.py`), so queue-green read well below the truth.
Each `workflows` entry now has `enforced`. `security-gate` is `enforced: false`:
its failures stay in `failed_gates`, but it can't turn a build red or hold up
pr-feedback. **The intent in `ci/required-checks.json` differs from what's live on
purpose.** The census and `census --live` still check the organization rule for
drift exactly as before. When the rule goes live (planned after #3275), set
`enforced: true`: one line, no code change.

Older snapshots stay as they are. `refreshOlderDays` re-derives only `main` and
`repeat_ejections` from push runs. It never re-reads merge-group runs, so it can't
re-judge `queue_builds`. Days collected before this change keep the old outcome
until they leave the 28-day window (by 11-28).

**A stale local export is a failure only while no clone is fresh.** A clone's name
digests the hostname, and this Mac's hostname changes with the network:
`DC-MBP-M4-2.local` gives `clone-b07d4e241e`, `dc-mbp-m4-2.lan` gives
`clone-71ebf1f648` and `mac.lan` gives `clone-040654d45a`, all for the same
checkout and the one `ci-local-export` schedule. Every name it stops using goes
stale and turned the run red while another name exported that same morning
(10-24 to 10-28 on `clone-71ebf1f648`, 10-30 and 10-31 on `clone-040654d45a` and
`clone-2c3dde293a`). Now a stale clone is a warning while another clone is fresh.
With no fresh clone it's still a failure, and that now holds even after every
clone has aged into `retired`, so an export that really stopped stays loud. The
`retired` state is unchanged.

Revert the first part if the organization rule goes live and someone forgets to
flip `enforced`: then a real gate would be under-counted. Revert the second if
clone names become stable per machine (a follow-up). Then a silent clone means a
machine stopped, and should fail again.
