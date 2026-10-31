# Proposal: merge queue groups merge on their last entry's build (HEADGREEN)

Status: draft. **No GitHub setting has been changed.** A person applies this, after Security's OK (below). Ledger: `ci/ledger/261031-091500-queue-headgreen.md`.

## What changes

One field in the `merge_queue` rule of ruleset 19893973 ("main: merge queue"): `grouping_strategy` goes from `ALLGREEN` to `HEADGREEN`.

| Parameter                           | Live (read 2026-10-31) | Proposed        |
| ----------------------------------- | ---------------------- | --------------- |
| `grouping_strategy`                 | `ALLGREEN`             | **`HEADGREEN`** |
| `max_entries_to_build`              | 5                      | 5 (same)        |
| `min_entries_to_merge`              | 3                      | 3 (same)        |
| `max_entries_to_merge`              | 10                     | 10 (same)       |
| `min_entries_to_merge_wait_minutes` | 5                      | 5 (same)        |
| `check_response_timeout_minutes`    | 120                    | 120 (same)      |
| `merge_method`                      | `SQUASH`               | `SQUASH` (same) |

The queue already batches: it builds 5 entries at a time and merges groups of 3 to 10. The first draft also lowered the minimum group size to 1. That is left out on purpose: it is a second change to the same gate, and two changes in one window confound each other's verdict. It can follow as its own entry once this one has a result.

## What it does, and what it does not do

GitHub's docs, on turning off "Only merge non-failing pull requests": failed pull requests "can be added to a group" as long as the last entry in the group passes, and this "can help with intermittent test failures".

- **It does not cut the number of builds.** Every entry still gets its own `merge_group` build, under either strategy. There is no capacity saving here.
- **It cuts flake ejections.** Each queue build is cumulative: entry N's tree is `main` plus entries 1 to N. Today, if entry 2's build flakes, entry 2 is ejected, even when entry 5's build, which contains entry 2's code, passes. Under HEADGREEN, the group merges on entry 5's green build, and entry 2's flake costs nothing.

## Hypothesis

`wasted-queue-builds` (queue builds ejected for failed checks whose PR later merged with no new commit, over all builds) drops from **0.0667** to **0.03** within 14 days. Baseline: `ci-steward-data` `latest.json`, window 2026-10-23 to 2026-10-29, n=135.

`queue-green` is NOT the metric: it counts builds with every required check green, and HEADGREEN changes which builds matter, not how many go green.

What could get worse, watched beside it: `main-green` (red episodes on `main`). Revert condition, written before the result: revert if `main` has a red episode traced to a PR that merged on a later entry's build, or if `wasted-queue-builds` has not dropped below 0.05 after 14 days.

## What could go wrong

1. **A commit on `main` that never had a green build of its own.** Squash merges put one commit per PR on `main`. Under HEADGREEN, PR 2's commit may sit on `main` with only a red build of its own, because PR 5's build (which contains it) was the one that passed. `main`'s tip is always green; a commit in the middle may not be. That matters for `git bisect` and for reverting one PR alone: reverting PR 2 lands a tree no build has tested. The main canary runs on `main` HEAD, so it still sees the tip.
2. **A real failure in an earlier entry, fixed by a later one.** If PR 2 breaks something and PR 4 happens to fix it, the group merges and PR 2's break is never reported. Rare, and `main` ends green either way.
3. **A red last entry, and no bisection.** GitHub's documented rule is the same under both strategies: a failing entry is removed, and the entries behind it are rebuilt without it. GitHub does not bisect a group. What its docs do NOT say is how the entries ahead of a red last entry are then grouped. Expected (not verified): they wait for the next green build that contains them. Check this on the first red group after applying, and say so in the ledger entry; if entries ahead are ejected with it, that is a revert.
4. **A check that judges only one entry.** See Security question 1. One was found and is fixed in this PR.

## Security's three questions

### 1. What HEADGREEN skips: no required check runs only per entry on `merge_group`

Under HEADGREEN, an earlier entry merges on the last entry's build. That is safe only if every required check, on `merge_group`, judges the whole cumulative tree (or the diff from `merge_group.base_sha`, which is `main`), never one entry alone.

| Required context               | On `merge_group` it checks                                                                   | Safe under HEADGREEN                                |
| ------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `typecheck`                    | the whole tree; **file-size ratchet used `HEAD^1`** (typecheck.yml:338)                      | **after this PR's fix** (below)                     |
| `fragment-present`             | fragments against `base_sha` (changelog-fragment-check.yml:90-92)                            | yes                                                 |
| `no-fragment-under-skip-label` | skips on `merge_group` by design (it needs PR labels)                                        | yes, asserts nothing in the queue under either rule |
| `version-outranks-base`        | `github.sha` against `base_sha` (operating-skills-version-check.yml:154-156)                 | yes                                                 |
| `test`                         | full sweep; `HEAD^1` scoping is `pull_request` only (test.yml:529, 816)                      | yes                                                 |
| `browser-test`                 | full suite on the cumulative tree                                                            | yes                                                 |
| `lint`                         | full monorepo                                                                                | yes                                                 |
| `credential-free-build`        | affected set from `TURBO_SCM_BASE=merge_group.base_sha`                                      | yes                                                 |
| `db-check`                     | whole tree                                                                                   | yes                                                 |
| `openapi-fresh`                | regenerates unconditionally off `pull_request`                                               | yes                                                 |
| `fixtures`                     | every step; its `HEAD^1` scope only gates the separate `harness` job, false on `merge_group` | yes                                                 |
| `security-gate` (org ruleset)  | walks the chain from `head_sha` to `base_sha`, checks every member PR (question 2)           | yes                                                 |

**The one per-entry check: the file-size ratchet's `--base`.** In the queue, `HEAD^1` is the previous entry's queue commit, not `main`. So the part that refuses a hand-raised `scripts/max-lines/baseline.json` saw only the newest entry. Under HEADGREEN, an earlier entry's raise would be judged only in its own build, which is no longer awaited. The PR run already catches it (there `HEAD^1` is `main`), so the queue gap was narrow, but it is closed here: on `merge_group` the ratchet now compares against `github.event.merge_group.base_sha`. The rest of the ratchet (no file grows, no new file over 500) reads the whole tree and was already covered.

No required job reads a PR number from the `gh-readonly-queue/.../pr-N` ref or reads labels on `merge_group`.

### 2. `security-gate.mjs` still fails closed when a group merges on a later entry's result

`groupMembers` (`.github/scripts/security-gate.mjs:47`) starts at the event's `head_sha` and walks each entry's `baseCommit` back to `base_sha`. So the LAST entry's `security-gate` run checks the approval of every PR ahead of it in the build, each against its own queued diff, and throws on the first one without a `security-review` success on its exact head. HEADGREEN therefore cannot skip a security check: the build the group merges on is the build that checks everyone.

The existing fixture only had the unapproved PR at the head. This PR adds one where the head is approved and an EARLIER entry is not, judged from the last entry's event alone: `merge_group judged on its last entry still fails closed on an earlier unapproved entry` in `.github/scripts/security-gate.test.mjs`.

### 3. The patch touches only `merge_queue` parameters

Diff of the live ruleset (read-only, `gh api repos/dork-labs/dorkos/rulesets/19893973`, 2026-10-31) against the body below, both sorted with `jq -S`:

```diff
@@ -20,7 +20,7 @@
     {
       "parameters": {
         "check_response_timeout_minutes": 120,
-        "grouping_strategy": "ALLGREEN",
+        "grouping_strategy": "HEADGREEN",
         "max_entries_to_build": 5,
         "max_entries_to_merge": 10,
         "merge_method": "SQUASH",
```

Nothing else differs: same `bypass_actors`, same `required_status_checks`, same `deletion` and `non_fast_forward` rules, same conditions and enforcement. There is no review rule to change. The body is built FROM the live ruleset at apply time, so a change somebody else made in between is carried, not overwritten; the diff step below shows it before anything is sent.

## To apply (run by Dorian, after Security's OK)

Our agents' token must not get admin; this is a person's step. Four commands, one per line:

```bash
gh api repos/dork-labs/dorkos/rulesets/19893973 > /tmp/ruleset-live.json
jq '{name, target, enforcement, conditions, bypass_actors, rules: (.rules | map(if .type == "merge_queue" then .parameters.grouping_strategy = "HEADGREEN" else . end))}' /tmp/ruleset-live.json > /tmp/ruleset-new.json
diff <(jq -S '{name, target, enforcement, conditions, bypass_actors, rules}' /tmp/ruleset-live.json) <(jq -S . /tmp/ruleset-new.json)
gh api -X PUT repos/dork-labs/dorkos/rulesets/19893973 --input /tmp/ruleset-new.json
```

Run the third command and check it shows only the `grouping_strategy` line before running the fourth. Then set the ledger entry's `status:` to `active` and note the date: the 14-day window starts then.

## To roll back

The same four commands with `"ALLGREEN"` in place of `"HEADGREEN"`. It takes effect for the next group the queue forms; nothing already merged changes. Then set the ledger entry to `reverted`.
