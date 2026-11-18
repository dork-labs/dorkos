---
id: 261118-135124
title: Releases are cut on a protected release/vX.Y.Z branch, so main keeps merging
status: proposed
created: 2026-11-18
spec: null
superseded-by: null
amends: [260919-174348]
---

# 261118-135124. Releases are cut on a protected release/vX.Y.Z branch, so main keeps merging

## Status

Proposed (operator decision, direct chat, 2026-11-16: "follow option B"; points (a) to (c) below agreed by the coordinator, 2026-11-18). Linear project "Release branches: cut releases without freezing main" (DOR-4636). PM and Security review it.

**Amends** [260919-174348](260919-174348-merges-are-fully-autonomous-machine-gates-are-the-only-gates.md), which stays Accepted: its "Nothing lands outside the merge queue" holds for `main` only. A PR into a `release/vX.Y.Z` branch lands without a queue, on the same required checks (decision 4). Its other rules stand: no human approval before any merge, ruleset 19893973 guards `main`, no admin merges.

## Context

A release is "whatever `main` holds". QA pins a `main` SHA, the release PR (VERSION, CHANGELOG, package versions) goes through the merge queue, and `release-cli.ts` publishes only a commit that is an ancestor of `main`. Anything that merges between the pin and the tag ships without QA having checked it: 0.135.9 (Nov 13) shipped #3713 and #3720 that way. So every release freezes the queue and disarms armed PRs. From Nov 12 to 18 that was 8 freezes, 1,208 minutes (about 3.4 hours a day, median 147 minutes each) and at least 32 held PRs. The one-off hotfix path (`release-branch-flag.md`, Oct 29) never landed, and DOR-3100's rule for it (only cherry-picks of commits already on `main`) was never enforced by a tool.

## Decision

We will cut every release, routine or hotfix, on its own protected branch, and stop freezing `main`.

1. **Branch name.** Exactly `release/vX.Y.Z`: a literal `v`, then three decimal integers with no leading zeros and no pre-release or build suffix (regex `^release/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`). The `X.Y.Z` is the version being published. The `release/*` ruleset covers every ref under `refs/heads/release/`, so no look-alike branch is unprotected; the tools accept only names that match the regex.
2. **Cut.** When QA pins `main` at SHA `P`, the release lane creates `release/vX.Y.Z` at `P`. `main` keeps merging. A hotfix to a shipped `vX.Y.Z` cuts `release/vX.Y.(Z+1)` from the tag `vX.Y.Z` instead.
3. **The release commit lands on the branch by PR.** VERSION, CHANGELOG, package versions, the shipped fragment deletions, the docs changelog, the blog post and the media archive go in one PR into `release/vX.Y.Z`, from a head branch named `release-commit/vX.Y.Z`, with the subject `chore(release): vX.Y.Z`. The release commit is release metadata only: no code, test, config-migration, config-schema, feature-catalog or agent-release-notes change, however small. Those land on `main` by a normal PR before the cut, or are cherry-picked after it. Cherry-picks land before the release commit; a pick after it means redoing the release commit, so its fragment reaches that version's CHANGELOG. QA's release check, Security's label and the PM's OK all name that branch's head SHA.
4. **Every PR into `release/*` passes the same gates as `main`, plus one.**
   - (a) It gets the full sweep, the same as a merge group: no affected-only scoping, no docs-only skip, every test shard and the browser tests. CI decides this from the PR's base ref matching the regex in 1, so a PR-only skip can never fire on a release branch.
   - (b) The `release/*` ruleset requires the same checks as `main`: every context in `ci/required-checks.json` (11 on 2026-11-18). That file stays the one list; when `main`'s set changes, the `release/*` set changes with it. The ruleset also blocks force-push and deletion, requires a PR and linear history, and has an empty bypass list. It lives at the org level, because the agents' admin token can edit a repo-level ruleset, bypass list included. PRs into `release/*` merge by rebase, never squash or a merge commit, so each commit on the branch has one parent and keeps its own message, including its `(cherry picked from commit <sha>)` line. There is no merge queue on `release/*` (few PRs, one writer); the required checks on the PR are the gate. Turning a queue on later needs a `merge_group` leg for these checks first. The ruleset also requires `security-gate` and `release-branch-contents` as workflows pinned to `main`, so a PR cannot edit the check that grades it.
   - (c) A new required check, `release-branch-contents`, enforces DOR-3100's rule. Every commit on the branch after its cut point is either a cherry-pick of a commit already on `main` (a `(cherry picked from commit <sha>)` line naming a commit that is an ancestor of `main`, whose patch-id equals that commit's), or the release commit, which may touch only the release files listed in 3. For the release commit, Security (2026-11-18) sets three hard limits: in each `package.json` only the `version` field may change (any change to dependencies, scripts, `bin`, `exports`, `files` or `publishConfig`, or to a lockfile, fails); it may not touch `.github/`, `scripts/` or any workflow or tool file, because the tag push runs `desktop-release.yml` from the tag's commit, which is on the release branch; and nothing outside the listed files. Anything else fails closed. It runs on PRs into `release/*` only, and the publish job runs the same check again over the whole branch. There is no override.
5. **Fixes go to `main` first.** A bug found during a release is fixed by a normal PR to `main`, then cherry-picked onto the branch by a PR (`git cherry-pick -x`). Never fix on the branch only. A pick that needs a hand-fixed conflict changes its patch-id and fails `release-branch-contents` on purpose. The remedy is a fresh PR to `main` that applies cleanly to the branch, then a clean pick, or a fresh cut from `main`.
6. **Publish only the exact SHA that was checked.** The publish refuses unless the commit is the tip of `release/vX.Y.Z` and equals the SHA named by QA's release check and the PM's OK. Routine mode also requires the branch's merge-base with `main` to be QA's pin `P`; hotfix mode requires it to be a published `vX.Y.Z` tag. Any later commit, a cherry-pick included, fails closed until QA checks the new head (it may check only the cherry-picks) and the PM names it again. Per Security (DOR-4638, 2026-11-17 and 18): the publish runs in a GitHub Actions job dispatched on `main`, so its workflow file comes from `main`. A required `expected_sha` input, shown to the approver, names the tip; the job checks out that exact SHA as data (never the branch by name), refuses unless the branch tip equals it, and checks again just before publishing. The `npm-release` environment's deployment branches are `main` only, never `release/*`. A person approves every publish from an account the agents' token cannot act as: the job reads the run's approvals and refuses unless the approver's login equals one hardcoded in `main`'s workflow file (changing it takes a PR Security reads), the state is approved, and the approver is not the dispatcher. Commit statuses are not used as proof, since any agent can forge one. npm uses trusted publishing, with no long-lived token. The tag push then runs the desktop release as today. The main-ancestor publish path stays unchanged and is the fallback until the pilot passes.
7. **Back-merge.** After publish, one normal PR to `main` brings back VERSION, CHANGELOG, package versions and the docs changelog, and deletes only the fragments that shipped. Fragments added to `main` after `P` stay. It merges before the next cut. The tag stays on the release branch's commit, not on `main`.
8. **The freeze retires after the pilot.** The first release cut on or after Nov 23 (DOR-4644) runs on this flow. Until it passes, the queue freeze stays the fallback; after it, a routine release never freezes `main`.

## Consequences

### Positive

- `main` keeps merging during a release: the target is 0 freeze minutes and 0 held PRs.
- What ships is exactly what QA checked: the branch has its own head, and the publish refuses any other SHA.
- Hotfixes get a real path with the same checks as a routine release, and DOR-3100's cherry-pick rule is finally enforced by a check, not by memory.

### Negative

- More moving parts: a branch per release, a back-merge PR, and a second ruleset that has to track `main`'s required set.
- Release tags are no longer on `main`. Anything that assumes they are (`git describe`, the main-ancestor proof in `release-cli.ts`, "is the tag on main" checks) has to be reviewed.
- `main`'s VERSION lags the newest release until the back-merge merges.
- A cherry-pick that needs a conflict fix has a different patch-id and fails `release-branch-contents`; the fix is a fresh PR to `main` that applies cleanly, then a clean pick.
- Every publish waits for one click from a person (Security's rule), until agents have their own GitHub identities.
- A release-branch PR runs the full sweep, which costs more CI time than a scoped feature PR.
