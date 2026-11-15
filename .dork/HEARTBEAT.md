---
name: DorkOS app heartbeat
description: Keep the build lanes moving, main green, and the team told; report daily.
wake: timed
watch: [addressed, commitments, schedules, health]
report: daily
sweep: 2h
---

Read top to bottom. Stop early when there is nothing to do. Most beats should be quiet.

**Stall-alert noise, until DOR-3904 ships (PM 11-11):** close a stall alert, with no checking turn, if the lane's last message says it's done or standing by. Ignore "tool failed" lines that are only a search with no match. End those beats quiet.

## Every beat

- [ ] Anything addressed to me (a #dorkos mention, a DM, a chat from another agent)? Answer it or do it.
- [ ] My commitments due? Keep it, or move it with a note to whoever I promised it to.
- [ ] **Approved lanes started?** (PM 11-12, after three approved lanes never started.) Read `.temp/coord/approved-lanes.md`. For each lane past its start date with no chat that is running or finished, start it this beat, or tell @dorkos-pm this beat why not. A newly approved lane gets its row there the same turn.
- [ ] **No idle P0 or P1** (PM 11-02, until DOR-3673's idle alarm ships): for each open P0/P1 item (FIX-QUEUE 00* rows, red or held P0 PRs), check that a chat is **running** on it (`running_chats`, then `chat_read` with status). If none is, wake its lane with the exact next step, or start one on Claude4, Claude5 or Codex (never Main or claude-ab1). Then post the lane link in #dorkos. A lane whose turn ended is not "running".

## On a sweep (every 2h)

- [ ] Build lanes (the list is in `.temp/coord/checkin.md`): check each one's status. If one is idle with work left, nudge it with its next step, and remind it to keep its turn alive.
- [ ] A lane freed up? It pulls the highest-ranked unstarted Must in `.temp/coord/FIX-QUEUE.md`, unless the PM named something else (PM rule, 10-25).
- [ ] My open PRs, and red required checks on `main`: re-arm once, rerun once, or fix.
- [ ] A PR of mine merged or closed? Remove its lane's worktree, plus any Docker container or image the lane built (`docker ps -a`, `docker images`), unless it's running or another container still uses it (PM 11-12).
- [ ] Any PR on `hold` for over 24h (`gh pr list --label hold`)? Name its gate and @ that gate's owner in #dorkos. Never lift a `hold` that waits on Security yourself; only its owner does (PM, 10-30). A freeze's holds die silently (#3082 sat a week, 10-25).
- [ ] A lane posted a question meant for Cloud or Dorian? Make sure it reached them.

## Daily (morning)

- [ ] Look for ALERT lines in `~/Library/Logs/dorkos-worktree-janitor.log`, and check free disk. Under 20 GB: clean up merged worktrees.
- [ ] Look at what's unreleased since the last tag. If it's worth shipping, tell @dorkos-pm.
- [ ] Linear: are tickets marked Done really done? Partial PRs close them automatically, so reopen any that aren't.
- [ ] Any FIX-QUEUE F1–F3 item still in Todo after 24h? Flag it in the report with the reason (PM rule, 10-25).

## Never unasked

- Spend money, publish twice, merge a PR that gives agents more power without Dorian's own OK, start chats on the main account, or post anything from the private Cloud repo publicly.

## Report shape

Shipped / In progress / At risk / Need from someone. One line each, or "Nothing new".
