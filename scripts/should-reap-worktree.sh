#!/usr/bin/env bash
# Decide whether one branch (and the worktree holding it, if any) may be deleted.
#
# Why this exists: nothing in this repo ever deleted anything. On 2026-08-01 the
# tree held 193 local branches, 414 branches on origin and 116 worktrees, against
# 5 open pull requests — 3.5 GB per provisioned worktree, so the worktrees alone
# were most of a disk. Every cleanup path was a human-triggered offer nobody was
# present to accept: `/flow:done` offers worktree removal only if the work ran
# through /flow AND the worktree was recorded AND the branch is already merged,
# but `main` merges through a queue and merge-tail.yml arms auto-merge on a
# 10-minute tick, so the merge lands long after the session that opened the PR
# has ended. The adversarial review workflow, which produced 47 of those 107
# removed worktrees — the largest single category — said nothing about cleanup at
# all. Figures and method: research/20260801_worktree-and-branch-sweep.md.
#
# It is a separate script with fixtures, rather than jq inline in the janitor,
# for the reason should-arm-automerge.sh is: this gate DELETES WORK. The failure
# that matters is not a crash, it is reaping something whose only copy was local,
# which is invisible until someone goes looking for it. Every KEEP branch is
# pinned by scripts/test-should-reap-worktree.sh.
#
# The rule is affirmative: a branch is reaped only when losing it is provably
# lossless. There are exactly two ways to prove that, and everything else is a
# KEEP:
#
#   1. Its pull request MERGED and its tip is still the commit that merged, so
#      the content is in main. A squash merge rewrites history, which is why the
#      pre-squash commits look local-only and why `localOnlyCommits` cannot be
#      the test here — but the tip must still MATCH, or someone pushed work after
#      the merge and that work is not in main.
#
#   2. Every commit it holds is already reachable from some origin ref AND no
#      branch of that name exists on origin, so the ref is a duplicate local
#      handle on published history. This is the review scratch case (rv708,
#      review-549, probe) — the largest population by far, and the one no skill
#      ever cleaned up.
#
#      Both halves are load-bearing. "Every commit is on origin" alone also
#      describes a pushed branch that has not opened a pull request yet, which is
#      live work: `ci-browser-suite-gate` (DOR-656) is pushed, PR-less, and the
#      only home of a CI gate that is not in main. The first version of this gate
#      said REAP for it. Review scratch is distinguishable precisely because it
#      is a local checkout of somebody else's branch, so nothing on origin
#      carries its name.
#
# A branch with no pull request AND commits of its own is KEPT, always. That is
# how `investigate-site-dev-cpu` survived the 2026-08-01 sweep: one commit, never
# pushed, no PR, and the only copy of a real fix.
#
# Usage:
#   scripts/should-reap-worktree.sh <entry.json>
#   ... | scripts/should-reap-worktree.sh -
#
# Prints exactly one line:
#   REAP              delete this branch (and its worktree, if any)
#   KEEP <reason>     leave it alone; <reason> is a stable machine-readable slug
#
# Exit status is 0 for a readable verdict, and 2 whenever no verdict could be
# reached — input that is not one JSON object, or a payload whose types abort the
# jq program (`{"prState":5}`). Both print `KEEP unreadable-payload` first, so a
# refusal can never be mistaken for a quiet REAP.
#
# Expected input. Every field below is REQUIRED and must have the type shown; a
# missing or wrongly-typed one is `KEEP unreadable-payload`, never a default.
# Unknown extra keys are ignored.
#   {
#     "branch": "feat-composer-craft",                              (string, may be "")
#     "branchSha": "e3c1854043e731d1d91f4ffaa15da2f3b6842799",      (string)
#     "prState": "MERGED",                                          (string)
#     "prHeadSha": "e3c1854043e731d1d91f4ffaa15da2f3b6842799",      (string, optional)
#     "localOnlyCommits": 4,                                        (number, -1 = unmeasurable)
#     "dirtyFiles": 0,                                              (number, -1 = unmeasurable)
#     "ignoredFiles": 0,                                            (number, -1 = unmeasurable)
#     "isCurrent": false,                                           (boolean)
#     "recentlyActive": false,                                      (boolean)
#     "isProtected": false,                                         (boolean)
#     "existsOnOrigin": false                                       (boolean)
#   }
#
# `recentlyActive` is whether the worktree was touched recently enough that
# another session may be working in it. A worktree with no worktree at all (a
# bare local branch) passes false. A caller that cannot measure the timestamp
# must pass true.
#
# `ignoredFiles` is the count of git-ignored paths in the worktree that the
# caller judged NOT regenerable. It exists because the gate reasons about commits
# while the janitor deletes directories: `git status --porcelain` never lists
# ignored files and `git worktree remove --force` deletes them anyway. In this
# repo that covers a session handoff under `.temp/` and the dev database under
# `apps/server/.temp/.dork/`. Counting build output here would keep every
# provisioned worktree forever, so the exclusion list lives with the caller.
#
# `isDetached` is deliberately NOT in this list: the gate never reads it. A
# branchless worktree reaches rule 2 because its caller passes prState "NONE" and
# an empty branch, not because of a flag. It stays out of the contract rather
# than sitting in it as decoration.
#
# `prState` is MERGED | OPEN | CLOSED | NONE. NONE means no pull request has ever
# carried this branch — not that one could not be found. A caller that cannot
# reach GitHub must NOT pass NONE; pass UNKNOWN (or anything else) and the gate
# refuses, because "I could not ask" and "nobody ever proposed it" are different
# facts and only one of them is safe.
#
# `localOnlyCommits` is `git rev-list --count <ref> --not --remotes=origin` — the
# commits reachable from this ref and from no origin ref. It is the whole basis
# of rule 2, so a caller that computes it against a stale remote-tracking state
# gets a more permissive gate than it thinks. Fetch before you count.
#
# `isDetached` marks a worktree with no branch (a review checkout). Rule 1 cannot
# apply to it — there is no branch to match against a PR — so it is reaped only
# under rule 2, where the SHA is the only handle and provability is the point.
#
# `existsOnOrigin` is whether `git ls-remote --heads origin <branch>` finds it.
# A caller that cannot reach origin must pass true (the conservative value), not
# false: false is the half of rule 2 that permits deletion.

set -uo pipefail

src=${1:-}
if [[ -z "$src" ]]; then
  echo "usage: $0 <entry.json>|-" >&2
  exit 2
fi
if [[ "$src" == "-" ]]; then payload=$(cat); else payload=$(cat "$src" 2>/dev/null); fi

if ! jq -e . >/dev/null 2>&1 <<<"$payload"; then
  echo "KEEP unreadable-payload"
  exit 2
fi

# Exactly one object, or nothing. A concatenated stream would otherwise print one
# verdict per document, and a caller written as `grep -q REAP` instead of `==`
# would read a REAP meant for a different entry.
if [[ $(jq -s 'length' <<<"$payload" 2>/dev/null) != "1" ]]; then
  echo "KEEP unreadable-payload"
  exit 2
fi

verdict=$(jq -r '
  # EVERY required field must be present and of the right type. Absent is not
  # zero and not false.
  #
  # This is the correction for a hole that shipped in the first version: `//`
  # treats null and false as empty, so `(.localOnlyCommits // 0)` read a missing
  # key, an explicit null, AND a boolean false as "0 commits of its own", and
  # `(.existsOnOrigin // false)` supplied the permissive half of rule 2 on the
  # callers behalf. `{"prState":"NONE"}` — a payload asserting nothing at all —
  # answered REAP. Every default pointed at delete.
  #
  # Validate first, decide second, so a serializer that drops a field gets a
  # refusal instead of the answer it did not ask for.
  def isnum(f): (f|type) == "number";
  def isbool(f): (f|type) == "boolean";
  def isstr(f): (f|type) == "string";

  if ((isnum(.localOnlyCommits) | not)
      or (isnum(.dirtyFiles) | not)
      or (isnum(.ignoredFiles) | not)
      or (isbool(.existsOnOrigin) | not)
      or (isbool(.isCurrent) | not)
      or (isbool(.recentlyActive) | not)
      or (isbool(.isProtected) | not)
      or (isstr(.prState) | not)
      or (isstr(.branchSha) | not))                 then "KEEP unreadable-payload"
  else

  (.localOnlyCommits) as $localOnly
  | (.dirtyFiles)          as $dirty
  | (.ignoredFiles)        as $ignored
  | (.prState | ascii_upcase) as $pr
  | (.branchSha)           as $sha
  | (if isstr(.prHeadSha) then .prHeadSha else "" end) as $prSha

  # A negative count is a caller reporting that it could not measure. The
  # producers emit -1 rather than 0 when git fails, because 0 is the value that
  # unlocks rule 2.
  | if $localOnly < 0 or $dirty < 0 or $ignored < 0 then "KEEP unreadable-payload"

  # Order matters below: the states a human is standing in come before anything
  # that could look finished.
  elif .isProtected                                 then "KEEP protected-branch"
  elif .isCurrent                                   then "KEEP current-worktree"

  # Somebody else is probably standing in it. This repo is routinely worked by
  # several agents at once, and a worktree that was JUST created is the most
  # reapable-looking thing there is: no commits of its own, no pull request, no
  # branch on origin — rule 2 exactly. Caught live on 2026-08-03, when a peer
  # session created `adr-review-v0-57` mid-run and the plan listed it for
  # deletion 46 seconds later, at zero commits ahead of origin/main.
  #
  # `isCurrent` only protects the one worktree the janitor is standing in, which
  # is no help against a co-tenant. Losing a day of cleanup latency is the cheap
  # side of this trade.
  #
  # (No apostrophes in this block: the whole program is single-quoted in bash,
  # and one contraction here turned every verdict into exit 2.)
  # Ordered after the content checks on purpose: when a worktree is BOTH busy and
  # dirty, "uncommitted-changes" is the reason an operator can act on, and
  # "come back tomorrow" is not. Both refuse, so the ordering is about the
  # message, not the safety.
  elif $dirty > 0                                   then "KEEP uncommitted-changes"

  # The gate reasons about commits; the janitor deletes DIRECTORIES. Ignored
  # content is invisible to `git status --porcelain` and destroyed by
  # `git worktree remove --force`, and not all of it is regenerable — a session
  # handoff under .temp/, the dev SQLite under apps/server/.temp/.dork/. The
  # caller counts only what it cannot rebuild; anything left is work.
  elif $ignored > 0                                 then "KEEP ignored-content"

  # Somebody else is probably standing in it. This repo is routinely worked by
  # several agents at once, and a worktree that was JUST created is the most
  # reapable-looking thing there is: no commits of its own, no pull request, no
  # branch on origin — rule 2 exactly. Caught live on 2026-08-03, when a peer
  # session created `adr-review-v0-57` mid-run and the plan listed it for
  # deletion 46 seconds later, at zero commits ahead of origin/main.
  #
  # `isCurrent` only protects the one worktree the janitor is standing in, which
  # is no help against a co-tenant. Losing a day of cleanup latency is the cheap
  # side of this trade.
  #
  # (No apostrophes in this block: the whole program is single-quoted in bash,
  # and one contraction here turned every verdict into exit 2.)
  elif .recentlyActive                              then "KEEP recently-active"

  # An open or closed-unmerged PR belongs to a decision a human has not finished.
  # Closed is NOT abandoned-and-safe: it is work someone stopped, and the branch
  # is the only record of it.
  elif $pr == "OPEN"                                then "KEEP pr-open"
  elif $pr == "CLOSED"                              then "KEEP pr-closed-unmerged"

  # Rule 1. The tip must still be the commit that merged. A later push means
  # work that main has never seen.
  elif $pr == "MERGED" and $sha != "" and $sha == $prSha then "REAP"
  elif $pr == "MERGED" and $sha == ""               then "KEEP unreadable-payload"
  elif $pr == "MERGED" and $sha != $prSha           then "KEEP commits-after-merge"

  # Rule 2. Everything here is on origin already AND origin carries no branch of
  # this name, so the ref is a local duplicate of published history and deleting
  # it loses no commit. This is the review-scratch population.
  elif $pr == "NONE" and $localOnly == 0 and (.existsOnOrigin | not)
                                                    then "REAP"

  # Pushed, but nobody has proposed it. Lossless to delete locally and still
  # wrong: this is how work-in-progress looks between the first push and the
  # pull request.
  elif $pr == "NONE" and $localOnly == 0            then "KEEP pushed-no-pr"
  elif $pr == "NONE"                                then "KEEP unpushed-commits"

  # Anything else — UNKNOWN, an unreachable API, a typo — is not a fact we can
  # act on.
  else "KEEP pr-state-unknown"
  end
  end
' <<<"$payload" 2>/dev/null)

if [[ -z "$verdict" ]]; then
  echo "KEEP unreadable-payload"
  exit 2
fi

echo "$verdict"
