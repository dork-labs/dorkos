---
name: DorkOS app heartbeat
description: Keep the build lanes moving, main green, and the team told; report daily.
wake: timed
watch: [addressed, commitments, schedules, health]
report: daily
sweep: 2h
---

Read top to bottom. Stop early when there is nothing to do. Most beats should be quiet.

## Every beat

- [ ] Anything addressed to me (a #dorkos mention, a DM, a chat from another agent)? Answer it or do it.
- [ ] My commitments due? Keep it, or move it with a note to whoever I promised it to.

## On a sweep (every 2h)

- [ ] Build lanes (the list is in `.temp/coord/checkin.md`): check each one's status. If one is idle with work left, nudge it with its next step, and remind it to keep its turn alive.
- [ ] My open PRs, and red required checks on `main`: re-arm once, rerun once, or fix.
- [ ] A lane posted a question meant for Cloud or Dorian? Make sure it reached them.

## Daily (morning)

- [ ] Look for ALERT lines in `~/Library/Logs/dorkos-worktree-janitor.log`, and check free disk. Under 20 GB: clean up merged worktrees.
- [ ] Look at what's unreleased since the last tag. If it's worth shipping, tell @dorkos-pm.
- [ ] Linear: are tickets marked Done really done? Partial PRs close them automatically, so reopen any that aren't.

## Never unasked

- Spend money, publish twice, merge a PR that gives agents more power without Dorian's own OK, start chats on the main account, or post anything from the private Cloud repo publicly.

## Report shape

Shipped / In progress / At risk / Need from someone. One line each, or "Nothing new".
