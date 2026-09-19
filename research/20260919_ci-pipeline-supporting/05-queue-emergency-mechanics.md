---
title: 'GitHub merge queue and Actions capacity: mechanics for an emergency lane'
date: 2026-09-19
type: implementation
status: active
tags: [ci, merge-queue, github-actions, emergency-lane, rulesets, runners]
searches_performed: 17
sources_count: 30
---

# GitHub merge queue emergency mechanics (dork-labs/dorkos)

Legend: **[V]** = verified from a quoted source (GitHub docs, the live GraphQL schema, a changelog, or measured locally and recorded in repo/memory). **[R]** = recalled, inferred, or reported only by third parties or community threads; treat as uncertain. **[V-local]** = verified in this repo's files or the operator's memory notes (point-in-time; re-check before relying on it).

Context: ruleset 19893973 "main: merge queue", SQUASH, ALLGREEN, `max_entries_to_build` 5, `max_entries_to_merge` 5, `check_response_timeout_minutes` 120, bypass actor = RepositoryRole admin (actor_id 5), `bypass_mode: always`. Org plan: Team.

## Research summary

GitHub's native tools for an emergency are thin. There is **jump** (front of queue, but it forces a full rebuild of every in-flight group, and the jumped PR still has to pass PR-level required checks and then its own merge_group checks). There is **admin bypass** (a direct merge through the REST merge endpoint, which skips the queue and the checks). And there is **dequeue**. GitHub has no native pause, freeze or priority. The only path that lands a fix in minutes is the admin direct merge. Jump is bounded by the merge_group suite duration (the longest required check, credential-free-build, runs 33-55 min in the queue per `research/20260919_ci-pipeline-01-inventory.md`). A direct merge will very likely invalidate and rebuild the in-flight groups, which is the behavior you want when the fix repairs the queue.

---

## Q1. Jumping the queue

**Mechanism**

- The GraphQL `enqueuePullRequest` mutation takes `EnqueuePullRequestInput { clientMutationId, expectedHeadOid, jump: Boolean ("Add the pull request to the front of the queue."), pullRequestId }` [V, live public schema `docs.github.com/public/fpt/schema.docs.graphql`, fetched 2026-09-19]. `MergeQueueEntry` exposes `jump: Boolean!` ("Whether this pull request should jump the queue") and `solo: Boolean!` ("Does this pull request need to be deployed on its own") [V, schema].
- **There is no `solo` input on `EnqueuePullRequestInput`** [V, schema]. Solo is tied to the "Request a solo merge" permission. It is not reachable through the public enqueue mutation, and it is probably UI-only [R].

**Who may jump**

- "Jumping to the front of the queue is now only available to admins by default in repos on GitHub Enterprise, but can be granted to individual users and teams using a custom repository role." Previously any write user could jump [V, [GA changelog 2023-07-12](https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/)].
- "Jump the merge queue" and "Request a solo merge" are repository permissions for custom roles. GitHub pitches them for on-call "break-glass or shift-based privilege" [V, [changelog 2024-08-29](https://github.blog/changelog/2024-08-29-add-repository-permissions-to-custom-organization-roles/)].
- Community discussion [#65496](https://github.com/orgs/community/discussions/65496) (opened 2023-08-30, follow-ups Jan and Jul 2025) reports that in practice only repo admins can jump, and that the docs still don't say so. No staff answer [V that it is reported; the behavior itself is R].
- Custom repository roles are an Enterprise Cloud feature [R]. **On Team, assume jump = repo admin only.** A classic PAT with `repo` scope acts with its owner's role, so an admin's PAT (for example the operator's) can jump and a non-admin bot's cannot [R].

**What happens to in-flight groups**

- "Jumping to the top of a merge queue will cause a **full rebuild of all in-progress pull requests**, as the reordering of the queue introduces a break in the commit graph. Heavily utilizing this feature can slow down the velocity of merges" [V, [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)]. With build=5, up to 5 in-flight entries are discarded and rebuilt on top of the jumped PR.
- Whether GitHub **cancels the Actions runs** of the destroyed groups is not documented [R/gap]. `test.yml:183-188` notes that queue refs are unique, so the repo's own `concurrency:` blocks never cancel them. If GitHub does not cancel them, a jump wastes up to 5 × ~19 jobs of runner capacity on orphaned runs. Measure this once.

**Does the jumped PR still need PR-level required checks?**

- Yes. `jump` is a flag on enqueue, and enqueue requires merge requirements to be met: "GitHub adds the pull request to the queue when requirements are met" [V, [Merging a PR with a merge queue](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/merging-a-pull-request-with-a-merge-queue)]. Measured here: PR #1246 was refused by `enqueuePullRequest` with "required status checks have not succeeded: expected" [V-local, `.github/workflows/test.yml:141-145`]. There is no documented way to force-enqueue a PR with failing checks ([cli/cli#8145](https://github.com/cli/cli/discussions/8145), unresolved since 2023-10) [V that it is unresolved].
- Once enqueued, the jumped PR runs **its own merge_group checks** (main + itself) and cannot merge until they pass ALLGREEN [V, schema text for ALLGREEN]. **So the minimum time to land via jump is PR checks + the full merge_group suite, which is tens of minutes here, not minutes.**

**Own group alone?**

- No, not by default. It takes position 1 with a merge_group ref of main + itself. Later entries rebuild on top of it, and with `max_entries_to_merge` 5 it can be merged in the same batch as entries behind it that also go green [R, inferred from queue model + docs example]. Isolation is what `solo` is for, and solo is not settable through the public API [V schema].

## Q2. Bypassing the queue entirely

- Docs: an administrator can "Directly merge the pull request by checking **Merge without waiting for requirements to be met (bypass branch protections)**" [V, merging-with-a-merge-queue doc].
- `gh pr merge` manual: "To bypass a merge queue and merge directly, pass the `--admin` flag." [V, [cli manual](https://cli.github.com/manual/gh_pr_merge)].
- **Gotchas with `gh --admin`:**
  - [cli/cli#8746](https://github.com/cli/cli/issues/8746) (2024-02-23, gh 2.44.1): `--admin` failed with "Changes must be made through the merge queue" while a CODEOWNER review was pending. Still open [V that it was reported].
  - [cli/cli#13388](https://github.com/cli/cli/issues/13388) (2026-05-09): `gh pr merge` pre-flight refuses on `mergeStateStatus: BLOCKED` even when ruleset bypass would allow it, while **`gh api repos/{o}/{r}/pulls/{n}/merge -X PUT -f merge_method=squash` succeeds and engages the bypass** [V that it was reported].
  - **Recommended emergency primitive: the REST merge endpoint with an admin credential.** Keep `gh pr merge --admin` only as a fallback.
  - UI quirks: [#171458](https://github.com/orgs/community/discussions/171458) (2025-08) says the "Merge without waiting" box disappears after a PR has been removed from the queue. [#196766](https://github.com/orgs/community/discussions/196766) (2026-05/06) says it went missing when a queue rule was in a ruleset (evaluate mode), and the OP later reported it working [V that both were reported, R as behavior].
- **bypass_mode:** "For pull requests only" means the actor "is now required to open a pull request to make changes… The actor can then choose to bypass any branch protections and merge that pull request." "Always" also allows direct pushes [V, [Creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)]. **An emergency lane that always goes through a PR needs only `pull_request` mode.** `always` exists here for the old release push (memory 2026-08-24), and the inventory says releases now land through the queue. Narrowing to `pull_request` would remove the direct-push hole without costing the lane anything [R, a recommendation].
- **Classic branch protection is a second gate.** In memory (2026-08-24), classic protection on `main` has `enforce_admins` on with 6 required checks, and ruleset bypass does not lift it. The release had to toggle `DELETE/POST .../branches/main/protection/enforce_admins` [V-local, memory `project_v0640_release.md`; 26 days old, re-check with `gh api repos/dork-labs/dorkos/branches/main/protection`]. If it is still on, an admin REST merge of a PR whose classic-required checks are red is refused. **The lane has to handle this layer explicitly.**
- **In-flight groups when main moves outside the queue:** the GitHub docs do not state this explicitly [gap]. What is known:
  - GitHub publishes `merge_group` `destroyed` "when a merge group is destroyed for any reason, including when it's merged or invalidated" [V, GA changelog].
  - Local incident: a release commit pushed straight to `main` with unformatted files **ejected every queued PR at the prettier gate** (hotfix #1260, DOR-1510) [V-local, memory]. That shows in-flight/queued entries were rebuilt against the new `main`.
  - Trunk documents the same behavior for its own queue: "The merge queue will restart everything currently testing to account for the new head" [V for Trunk].
  - Conclusion [R, high confidence]: a direct merge invalidates all in-flight groups and they rebuild on the new head, which **includes the fix**. That is the desired effect when the fix repairs a broken required check.
- Squash: the REST merge uses `merge_method=squash`, which the repo must allow. The ruleset's `merge_method: SQUASH` governs only queue merges [R].
- A merge made with `GITHUB_TOKEN` does not trigger `push: main` workflows (the documented GITHUB_TOKEN rule) [V docs; also V-local memory]. Use a PAT or App token if post-merge push workflows must fire.

## Q3. Dequeue, disable auto-merge, permissions

- `dequeuePullRequest(input: DequeuePullRequestInput { id: ID! (PR node id), clientMutationId })`, described as "Remove a pull request from the merge queue." [V, schema; also V-local in `.agents/skills/creating-pull-requests/SKILL.md:487-511`, introspected 2026-08-27].
- Removal reasons in the docs include "User requesting a removal via the API or merge queue interface" [V, reusable `merge-queue-removal-reasons`].
- **`disablePullRequestAutoMerge` does not dequeue.** `gh pr merge --disable-auto` does NOT dequeue, and a queued PR reports `autoMergeRequest: null` [V-local, measured 2026-07-28, memory `project_merge_queue_cutover_20260728.md`]. Detect queue membership with GraphQL `mergeQueueEntry` (as `merge-tail.yml:169-184` does).
- Permissions:
  - Enqueue: "A user with write access to the repository can add the pull request to the queue" [V docs].
  - Dequeue and disable auto-merge: write access [R].
  - Jump: admin on Team [R, see Q1].
  - A PAT inherits its owner's role. For a fine-grained PAT expect Pull requests: write + Contents: write [R].
- **`GITHUB_TOKEN` must never enqueue.** A group enqueued by `github-actions` gets zero check runs and jams position 1 until the timeout [V-local, measured 2026-07-28]. This is consistent with current docs: the GITHUB_TOKEN exceptions cover `workflow_dispatch`, `repository_dispatch` and `pull_request` opened/synchronize/reopened, not `merge_group` [V, [trigger-a-workflow doc](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)].

## Q4. Which workflow definition runs

- "Each workflow run will use the version of the workflow that is present in the associated commit SHA or Git ref of the event." [V, [Workflows concept doc](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows)].
- `merge_group`: GITHUB_SHA = "SHA of the merge group", GITHUB_REF = "Ref of the merge group" [V, [events doc](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)]. That commit contains main + the PRs ahead + this PR, **so the PR's own workflow edits apply in its merge group** (and in every group built on top of it) [V by composition].
- `pull_request`: GITHUB_SHA = "Last merge commit on the GITHUB_REF branch", GITHUB_REF = `refs/pull/N/merge`. The PR's edits apply (merged with base). "Workflows will not run on pull_request activity if the pull request has a merge conflict." [V].
- `pull_request_target` and `schedule` use the last commit on the default branch [V]. A `workflow_dispatch` workflow must exist on the default branch to be dispatchable [V].
- Implication: a CI-fix PR heals its own PR run and merge_group run. It also heals the PRs queued behind it once they rebuild on top of it. Scheduled automation (`merge-tail`) only changes after the fix is on `main`.

## Q5. Changing queue settings via API

- `PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}`: all body fields optional. The `merge_queue` rule params include `check_response_timeout_minutes` ("After this much time has elapsed, checks that have not reported a conclusion will be assumed to have failed"), `grouping_strategy`, `max_entries_to_build` ("Limit the number of queued pull requests requesting checks and workflow runs at the same time"), `max_entries_to_merge`, `merge_method`, `min_entries_to_merge`, `min_entries_to_merge_wait_minutes` [V, [REST rules docs](https://docs.github.com/en/rest/repos/rules)].
- Permission: repo admin (fine-grained: Administration write). The docs page does not spell out the fine-grained permission [R].
- **Effect on in-flight groups: undocumented** [gap]. No source says whether a settings change destroys or rebuilds groups. Do not use ruleset edits as the emergency lever until you have observed the effect once, off-peak.
- Community reports put the timeout ceiling at 360 min ([#162380](https://github.com/orgs/community/discussions/162380)) [V that it is reported].

## Q6. Actions capacity (Team plan)

- Standard GitHub-hosted runners, **Team: 60 concurrent jobs, 5 concurrent macOS jobs**. Free 20/5, Pro 40/5, Enterprise 500/50. Larger runners on Team/Enterprise: 1000 concurrent, macOS 5/50, GPU 100. "The maximum concurrent macOS jobs is shared across standard GitHub-hosted runners and GitHub-hosted larger runners." [V, [Actions limits](https://docs.github.com/en/actions/reference/limits)]. Measured locally: 52 concurrent on 2026-09-15, no job waited over 1.3 min [V-local, memory].
- **No job-priority mechanism exists.** Dispatch is best-effort and not strict FIFO. Community [#162492](https://github.com/orgs/community/discussions/162492) (July-Aug 2026 comments, no staff answer) [V that it is reported]. Within a `concurrency` group, runs are FIFO, and the new `queue: max` allows up to 100 pending (default `single`), though "ordering is not guaranteed" [V, [concurrency doc](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)].
- Scheduled workflows at the cap: their jobs queue with everything else, and nothing documents priority for them [R]. Separately, "The schedule event can be delayed during periods of high loads… High load times include the start of every hour", queued jobs "may be dropped" under enough load, and public-repo schedules auto-disable after 60 days of inactivity [V, events doc]. `merge-tail` (`*/10`) inherits all of this.
- Design lever [R]: larger runners have a separate 1000-job ceiling. Pinning the emergency lane's few jobs to a larger-runner label would likely keep them from waiting behind a saturated standard pool (paid per-minute). Check whether larger-runner jobs count against the 60.

## Q7. Self-hosted runners on a public repo

- "We recommend that you only use self-hosted runners with private repositories. This is because forks of your public repository can potentially run dangerous code on your self-hosted runner machine by creating a pull request that executes the code in a workflow." [V, [manage-access doc](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access)].
- "By default, only private repositories can access runners in a runner group, but you can override this." "Organization owners using the GitHub Team plan can create additional organization-level runner groups." [V].
- Runner groups can be restricted to **Selected workflows**: "Only jobs directly defined within the selected workflows will have access to the runner group" [V, [changelog 2022-03-21](https://github.blog/changelog/2022-03-21-github-actions-restrict-self-hosted-runner-groups-to-specific-workflows/)]. Entries are workflow paths pinned to a ref, e.g. `org/repo/.github/workflows/x.yml@refs/heads/main` [R].
- There is **no event-type filter** on runner groups [R]. The effective equivalent is to pin the group to a workflow file `@refs/heads/main` whose `on:` is only `schedule`/`workflow_dispatch`. A fork PR runs at `refs/pull/N/merge` and should not match the pin [R, plausible; verify]. Add ephemeral/JIT runners and keep fork-PR approval required [R].

## Q8. Timeouts and ALLGREEN failure handling

- Timeout: checks that have not reported within `check_response_timeout_minutes` "will be assumed to have failed" [V REST docs]. The PR is removed ("Timed out awaiting a successful CI result based off the configured timeout setting") [V reusable]. At 120 min, a jammed head blocks the queue for up to 2 h (the local 2026-07-28 jam lasted 35 min at the timeout then in force [V-local]).
- ALLGREEN: "the merge commit created by merge queue for each PR in the group must pass all required checks to merge". HEADGREEN: "only the commit at the head of the merge group… must pass" (failing entries "are allowed to merge if they are with a passing entry") [V, schema].
- On failure, GitHub **ejects the failing PR and rebuilds everything behind it without it**: "the merge queue automatically removes pull request #1… recreates the temporary branch… `main/pr-2` to only contain changes from the target branch and pull request #2" [V docs example]. **There is no bisection:** each entry already has its own cumulative merge_group ref, so the failing entry is identified directly. Entries ahead of it with green refs can still merge; entries behind it are rebuilt [R for the "ahead merges" part]. A shared-cause failure (e.g. a broken required check on main) therefore ejects entries **one after another**, each costing a full rebuild of the entries behind it. That is the cascade the emergency lane must stop.

## Q9. Industry patterns for priority, pause and break-glass

- **GitHub native:** jump (admin; full rebuild), a `solo` entry flag, custom-role "Jump the merge queue" / "Request a solo merge" for on-call break-glass (Enterprise), and admin bypass merge. **No pause/freeze/priority levels** [V as far as the docs go; absence R].
- **Trunk:** priority levels with `/trunk merge --priority=urgent`. "The urgent priority is the only level that will interrupt currently testing PRs": it starts testing at once and the others restart after it. The queue state can be set to **Paused** in settings. Emergency direct merges "bypass the queue entirely… the most disruptive action… The merge queue will restart everything currently testing". "Direct to queue" bypasses branch protection but still tests [V, [Trunk emergency PRs](https://docs.trunk.io/merge-queue/using-the-queue/emergency-pull-requests), [priority](https://docs.trunk.io/merge-queue/pr-prioritization)].
- **Mergify:** priority rules (low/medium/high or 1-10,000). It picks strictly by priority and then fills batches. **Freezes** block merging while CI keeps running, with label exceptions (e.g. `hotfix`) that are "Excluded does not mean unchecked". **Pause** halts merging and queue CI and cancels running queue checks (the Pause API replaced the Freeze API, `allow_checks_to_run`). For incidents it recommends an open-ended freeze that is deleted explicitly, plus a separate hotfix queue [V, [Mergify code-freeze guide](https://mergify.com/guides/merge-queue-code-freeze), [priority](https://docs.mergify.com/merge-queue/priority/), [freeze](https://docs.mergify.com/merge-protections/freeze/)].
- **Graphite:** "fast-track" jumps to the front but "will still wait to rebase and rerun CI". Also offers queue pauses [V snippet of [Graphite docs](https://graphite.com/docs/get-started-merge-queue); pause R].
- **Shopify (Shipit, 2019):** "During incidents, we locked the queue to prevent any further pull requests from merging to master, giving space for emergency fixes". `/shipit --emergency` "skips any checks and merges directly to master", "reserved for emergencies only and gives us auditability". Queued PRs keep passing CI, so they are ready when the queue unlocks [V, [Shopify Engineering](https://shopify.engineering/successfully-merging-work-1000-developers)].
- **Uber SubmitQueue:** speculation graph plus probabilistic/ML ranking of builds (short builds expedited past long conflicting ones). No documented human "emergency" lane was found [V for speculation, [paper](https://dl.acm.org/doi/pdf/10.1145/3302424.3303970); emergency lane is a gap]. Uber also has a "Bypassing Large Diffs in SubmitQueue" post (not read) [R].
- A "circuit breaker" is not a GitHub-documented term. The common shape is: **lock/freeze or pause the normal lane, open a single audited bypass, then release the queue.** The released entries then rebuild on the fixed head.

## Local repo evidence (read-only)

- Jump: **never used** anywhere in `.github/`, `scripts/`, `.claude/`, `.agents/` or `plans/` (no `jump` in any enqueue call) [V-local grep].
- Dequeue: documented as a manual recipe for `STUCK_UNMERGEABLE` entries, `.agents/skills/creating-pull-requests/SKILL.md:487-511` (dequeue then `gh pr merge --auto --squash`). `watch-prs.sh` stays read-only.
- Admin bypass: described only as "a direct push to main bypasses this… and every other gate too, which is already what an emergency bypass means here" (`test.yml:172-173`, `browser-test.yml:43-44`). The bypass actor itself is recorded only in memory (inventory `:269`). No script uses `--admin` or the REST merge endpoint.
- `merge-tail.yml` + `should-arm-automerge.sh`: they arm via `MERGE_TAIL_TOKEN` (a PAT), treat already-queued PRs as SKIP, and honor `hold`/`do-not-merge`/`wip`/`blocked` labels. **A hold label keeps a PR from being armed but does not remove an already-queued one.** The ADR `260728-112203` has no emergency/jump/bypass text.

## Implications for the emergency lane (for the designer)

1. **Minutes-scale landing = admin REST merge** (`PUT /pulls/N/merge`, squash, admin PAT), after the fix PR's own PR-level checks have been read by a person or agent. Handle classic `enforce_admins` if it is still on. Everything queued then rebuilds on the fixed head.
2. **Jump is the "queue is healthy but long" lane**, not the "queue is broken" lane. It costs a full rebuild of 5 groups and still waits for the full merge_group suite.
3. **Stop the cascade first:** GitHub has no pause. Emulate one by (a) having merge-tail stop arming (a repo variable or label check), and (b) dequeuing entries that are doomed by a shared cause, so each one doesn't burn a 5-group rebuild on its way out. A deliberately failing "freeze" required check would eject everything (Q8). Mergify-style "freeze but keep testing" is not reproducible natively.
4. Narrow `bypass_mode` to `pull_request` if the release no longer needs direct pushes.

## Research gaps

- Whether GitHub cancels Actions runs of destroyed/invalidated merge groups.
- Documented behavior of in-flight groups on (a) a direct merge to base and (b) a ruleset settings edit.
- The exact jump permission on Team (non-Enterprise) in 2026. The docs are silent and community reports say admin-only.
- Whether larger-runner jobs count against the 60-job standard cap.
- Whether classic `enforce_admins` is still on for `main` today.

## Search methodology

17 web searches/fetches plus a local grep of the saved full GraphQL schema. The most useful sources were the GitHub docs (merge queue, events, limits, runner groups, rulesets), the GA/roles changelogs, cli/cli issues, and the Trunk/Mergify/Shopify primary docs.
