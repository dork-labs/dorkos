---
name: ci-quarantine
description: "Put a known-flaky test into, or take it out of, CI Steward's quarantine lane: it keeps running and reporting but cannot fail the merge queue. Use when a test that passes on retry keeps ejecting green PRs, when an entry is about to expire, or when a quarantined test is fixed and should block again."
disable-model-invocation: true
---

# /ci-quarantine

One in four merge-queue builds fails, and most of those failures are not bugs. A build that dies on a flake costs about thirty minutes of queue time for every PR behind it. The quarantine lane takes one named test out of the blocking path while it is being fixed.

**A quarantined test still runs, still retries and is still reported.** It only loses the power to fail the queue. Nothing is skipped, deleted or filtered out, so the day it stops flaking is visible in the same reports.

**It is debt, not a fix.** Every entry expires after 7 days, at most 10 can exist at once, and adding one writes a `proposed` ledger entry that says to fix or delete the test.

## Look before you add

```bash
git fetch --quiet origin ci-steward-data || true
pnpm ci:flaky
```

It lists every test that failed and then passed on the same merge-group tree, with counts and dates, and says which qualify. Read the status column before anything else:

- **QUALIFIES** — flaked on at least two different trees, recently enough that nothing suggests it was fixed. This is the only thing that may be added.
- **COOLING** — it flaked often and has now been quiet for longer than its own gap between flakes. That is the shape of a test somebody fixed; quarantining it spends a slot on nothing. The add path refuses it.
- **BELOW-THRESHOLD** — one bad runner. Not a classification.

**Right now, `--fetch` is the only path that returns anything.** `pnpm ci:flaky` reads per-test flake names out of the daily collector's snapshots, and the collector only starts recording them with this change — so until it has run for about a week, the plain command correctly reports nothing. `--fetch` reads the Actions artifacts directly instead (a few hundred API requests, several minutes); artifacts expire after seven days, so that window is what it can see.

`--json` saves the classification, and `quarantine add --evidence <that file>` reuses it instead of downloading everything twice.

**Copy the file and title, do not retype them.** They are matched byte for byte, so a title that differs by one character — or by Unicode normal form — silently matches nothing. That fails safe (the entry excuses nothing, and the fan-in names it as a quarantined test that did not run), but it wastes a slot.

## Add one

```bash
pnpm ci:quarantine add \
  --runner playwright \
  --file 'rooms/canvas/room-follow.spec.ts' \
  --title 'moves this window onto the document the person you follow is on' \
  --by 'your name' \
  --reason 'what races, and what the fix would be'
```

Copy `--file` and `--title` exactly as `pnpm ci:flaky` prints them; they are the identity the queue matches on. Nothing is published without `--publish` — a run without it prints the list that would be written and changes nothing.

It refuses a test with no flaky evidence, and it is right to. **A test that fails every time is a real bug.** Fix it, revert what broke it, or delete the test; the lane must never be the reason a break reached `main`.

With `--publish` it writes `quarantine.json` on the `ci-steward-data` branch and the lane is live on the next queue build. **No PR, no merge, no review** — which is why every guard is enforced when the list is read, and why the reason field is worth writing properly.

It also writes `ci/ledger/<id>-quarantine-*.md`, the entry that says to fix or delete the test — after the list goes out, so a failed publish never leaves debt recorded against a quarantine that does not exist. Commit it with your next PR.

Pass `--ledger <id>` to reuse an entry that already exists instead of scaffolding another: re-quarantining a test after a fix attempt belongs on the same debt item, and so does a real `--publish` after a dry run that already wrote one.

## Take one out

```bash
pnpm ci:quarantine list
pnpm ci:quarantine remove --runner playwright --file '<file>' --title '<title>' --publish
```

If the list is refused — one entry over the cap, one bad timestamp — you are not locked out of it. `remove` still works, because a refused list still parses, and that is the repair. If it does not parse at all, `pnpm ci:quarantine reset --publish` replaces it with an empty one. Never hand-edit the data branch.

Release a test as soon as it is fixed. `pnpm ci:status` shows the lane and flags anything about to expire; a quarantined test that passed in a queue build is named in that build's job summary as a candidate to release.

## What the queue does with it

- Each shard runs the suite, captures its exit code, and a gate asks whether every failure in the report is quarantined. One that is not fails the shard exactly as before.
- The gate reads three numbers out of the same reports: the runner's own failed-test count, its own per-test walk, and the failures that belong to no test — a file that throws on import never becomes a failed _test_, so it is counted separately and can never be excused. A non-zero exit is excused only when the count is exactly the set the lane absorbed, so a crash, a dead server or a timeout does not ride out on a quarantined flake from the same run.
- **The one hole, named:** a package whose process dies before writing any report at all is invisible to all three, and nothing downstream catches it. It is written up in `gateSuite`'s header and in `contributing/ci.md`.
- The whole lane is printed in the job summary of every queue build that read it.
- **Browser:** if a quarantined test does not run — missing from the reports, or collected and then skipped — the build fails. The lane must never be the reason a test silently stopped running.
- **Vitest:** the same check is file-level. If a quarantined test's file contributes nothing to any shard, the build fails; a quarantined vitest test that stops running while its file still collects other tests is not caught. Prefer a browser quarantine when you have the choice.
- If the list is missing, unreadable, invalid, over the cap, expired, dated in the future, or holds an entry that would outlive the ceiling measured from now, it is ignored entirely and every test blocks as normal.

## Do not

- Do not quarantine a test that fails deterministically. That is a bug report, not a lane entry.
- Do not edit `quarantine.json` by hand or push to `ci-steward-data`; use this command.
- Do not widen the cap or the expiry to fit more in. Both are thresholds in `ci/config.yaml` with a ratchet behind them, and a wider lane is a bigger blind spot. An entry that gives itself more than the ceiling does not get more time — every reader refuses the whole list, and nothing is quarantined at all.
