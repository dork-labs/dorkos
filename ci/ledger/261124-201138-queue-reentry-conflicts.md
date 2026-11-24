---
id: 261124-201138
title: a PR waiting on auto-merge that conflicts with main gets told why nothing runs
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.queue-reentry.sweep
prs: []
ratchet-release: []
field-changes: []
---

A PR that conflicts with `main` starts no `pull_request` runs (GitHub has no merge commit to test), so it
gets no checks, no review and no Security verdict, `pr-gates` cannot pass, and nothing tells the author.
On 11-24 #4296 sat over two hours like that; an agent added `re-review` and nothing happened.

The change extends the queue-reentry sweep (entry 261124-152032): every open, non-draft PR into `main`
with auto-merge on whose mergeability is CONFLICTING gets one comment per head saying no checks or review
run until it merges with `main`, and to merge `main` (not rebase) and push. It uses the ejection note's
marker, so one head never gets both notes. Held PRs are skipped, UNKNOWN mergeability waits for a later
sweep, and it reads from the one paginated list query, plus one comments read per such PR. It never turns
auto-merge on or off.

No tracked metric covers this yet. On the first live dry run (11-24 20:10Z) it would have told #4293
and #4296. Check after 7 days, by hand from PR timelines: every PR with auto-merge on that conflicted with
`main` for more than 30 minutes got the note within 30 minutes of the conflict (target: all). Revert if
it comments on a PR that merges cleanly, or an author gets the same note twice on one head.
