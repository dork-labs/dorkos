---
name: vision-drift-check
description: 'Weekly DorkOS scheduled skill: look for retired phrasing and stale positioning across the site, READMEs, docs, app copy and operating skills, check meta/ROADMAP.md against what shipped, and report what drifted from meta/VOICE.md. Reports only; never edits, commits or opens PRs.'
disable-model-invocation: true
schedule:
  cron: '0 14 * * 1'
  timezone: UTC
  max-runtime: 20m
---

# vision-drift-check

The hard gates (`scripts/check-banned-words.sh`, `scripts/check-vocab-gate.ts`) fail the build on words that are wrong everywhere. This job catches the softer drift they cannot: "open source" in a headline, "local first" on the site, a roadmap item described as working, a north-star file that fell behind what shipped. It runs every Monday at 14:00 UTC and **only reports**.

The source of truth for every judgment is the north-star set: `meta/VOICE.md` (words and claims), `meta/ROADMAP.md` (what is built and what may be claimed), `meta/VISION.md` and `meta/PRINCIPLES.md`.

## Run

1. Work in a throwaway copy of `main`, never the shared checkout: `git fetch origin`, pin `BASE=$(git rev-parse origin/main)`, clear any copy a killed run left behind (`git worktree remove --force "$TMPDIR/vision-drift" 2>/dev/null; git worktree prune`), then `git worktree add --detach "$TMPDIR/vision-drift" "$BASE"` and run every step below from there. Remove it with `git worktree remove "$TMPDIR/vision-drift"` when the report is written. The gates need `node_modules`; run `pnpm install --frozen-lockfile --prefer-offline --ignore-scripts` in the copy first.
2. Run the two hard gates and note whether they pass:

   ```bash
   bash scripts/check-banned-words.sh
   pnpm check:vocab-gate
   ```

3. Run the candidate scan:

   ```bash
   bash scripts/check-vision-drift.sh
   ```

4. **Judge each candidate line** against `meta/VOICE.md` and `meta/ROADMAP.md`. Most hits are fine in context (a license section may say "MIT license"; a comparison page may describe a rival's "side by side" view). Keep only real drift.
5. **Check the roadmap against reality.** For each ticket the scan lists, read its state in Linear (team DOR, read-only, through the flow `linear-adapter` skill, or `composio execute LINEAR_* --account dorkos`: the `trackerAccount` in `.agents/flow/config.local.json`, never `artblocks`). Flag a ticket that is Done while `meta/ROADMAP.md` still lists it as before launch or roadmap, and a "Built today" claim whose feature was removed.
6. **Check `meta/` stays clean:** only the north-star set and current canon at the top level, every file listed in `meta/INDEX.md`, no new file that restates the word lists or the demo-claim gate instead of linking to them.

## Report

End the run with one short report, in plain words:

- **Gates:** pass or fail, with the first failing line if any.
- **Drift found:** each real problem as `path:line`, what it says, and what `meta/VOICE.md` or `meta/ROADMAP.md` says instead. Group by surface (site, README and npm, docs, app, operating skills, meta).
- **Roadmap out of date:** tickets whose state disagrees with `meta/ROADMAP.md`.
- **Nothing found** is a fine report. Say so in one line.

If there is real drift, send the owner one short note with the counts and the top three items through the DorkOS tool whose name ends in `relay_notify_user`. Do not post in rooms, comment on tickets, edit files, commit or open pull requests: a person or a builder session decides what to change.

## Approving it

DorkOS finds the `schedule:` block above and lists this job on the **Schedules** page as **Waiting for approval**. It does not run until the operator approves it. It runs Bash and reads Linear, so approve it with **Approve at Full autonomy**; with plain Approve every run ends Blocked (`docs/guides/task-scheduler.mdx`).
