# Security gate promotion

Status: **not enforced**. The build PR stays on `hold` with auto-merge off.
Only the coordinator changes GitHub rulesets, after Security's review and merge.

## Required workflow source

Use an organization-level **Require workflows to pass before merging** rule,
targeting only this repository's `main` branch. Configure the source as:

| Setting             | Value                                             |
| ------------------- | ------------------------------------------------- |
| Source repository   | `dork-labs/dorkos`                                |
| Workflow path       | `.github/workflows/security-gate.yml`             |
| Source ref          | `refs/heads/main`                                 |
| Events              | `pull_request` and `merge_group`                  |
| Initial enforcement | Evaluate, then Active only after the proofs below |

Do not substitute a named status-check requirement for `security-gate`. A
candidate can edit its own YAML to emit a passing job with that name. The
required-workflow source must be selected from main by GitHub, before candidate
YAML can run. Verifiers additionally check out the event's immutable base SHA;
their token is read-only. Only the trusted `pull_request_target` initializer
has status/comment write permission. That initializer lives in
`security-review-initialize.yml`, a separate workflow with a separate identity;
it cannot satisfy the required verifier workflow by succeeding at initialization.

GitHub documents required workflows as an organization/enterprise ruleset
feature. Confirm this organization's access to that setting; if unavailable,
leave promotion blocked and ask Security for another trusted enforcement design.
Do not upgrade a plan or change permissions as part of this work.

References: [required workflows and supported events](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging),
[workflow source fields](https://docs.github.com/en/enterprise-cloud@latest/rest/repos/rules).

## CI Steward gap

`ci/required-checks.json` now keeps required workflow sources separately from
named contexts. The schema and offline census validate their source repository,
main ref, workflow existence, triggers and jobs. Generated docs, collector timing
and canary coverage include these sources.

Run `pnpm ci:census --live` before promotion. It reads organization rulesets,
checks repository identity, source repository ID/path/ref (no SHA override),
active enforcement, exact repository/main scope and a visible empty bypass list.
Missing rules, API errors and hidden bypass lists refuse. The daily collector
uses the same comparison and reports drift as unhealthy. Until activation it
correctly reports the required org rule missing. Offline census never claims
live enforcement. No admin token is added to Actions; if its token cannot read
the evidence, the health check reports that blocker. The coordinator runs the
promotion check with existing read authority.

## Bootstrap and proof

1. Security reviews the build PR's final SHA. Its base lacks the new script and
   fixture files, so its base-source gate fails closed rather than running the
   candidate's copy. The initializer is available only after code lands on main.
   Do not add a head-source fallback or self-post approval to clear bootstrap.
2. Run the local fixture with `node --test .github/scripts/security-gate.test.mjs`.
   It creates a temporary branch that changes both workflow and script to exit
   successfully, then models main's workflow selection and executes the base verifier.
   Without approval, queue verification must fail. This is a local trust-boundary
   fixture, not a claim that a hosted required-workflow rule is already active.
3. After merge, use Evaluate mode and a controlled PR to confirm GitHub selects
   the main-sourced workflow even when candidate YAML/script both say `exit 0`.
   The unapproved queue head must fail. Record run URLs, workflow source ref/SHA,
   base SHA and candidate SHA. Reopen an existing PR to trigger the new rule when
   needed; do not push an empty commit.
4. Capture a real multi-entry `merge_group` event plus queue API responses.
   **The MergeQueueEntry.baseCommit/headCommit chain and rebuild timing remain
   unproven until this live capture.** Every queued PR's exact head must be
   checked; one missing approval or moved head must refuse the whole group.
5. Only after census support and both hosted proofs pass does the coordinator
   activate the main-pinned required-workflow rule. Verify its persisted source
   settings and a real refusal. Never weaken a missing-data refusal to promote it.

## PRs opened before initialization

Only when `security-review` is absent, the read-only verifier may pass as
`no security paths (computed)` after checking a complete nonsensitive diff. It
never writes a status. An explicit pending/failure remains blocking. PR checks
paginate the full files endpoint and match its count against `changed_files`;
3,000 or more files refuse. Merge groups use the queue entry's immutable base commit SHA and
its synthetic queued head commit SHA in `base...queuedHead`, never the current PR files list.
The current head/base and queue snapshot are still rechecked before passing.
Both sides of renames are checked. The compare endpoint returns files only on
its first page, capped at 300; at that cap completeness is unknown and the gate
refuses, even if a status exists. See [GitHub's compare endpoint](https://docs.github.com/en/rest/commits/commits#compare-two-commits).
API failures, malformed lists, duplicates and PR count mismatches refuse.

The immutable synthetic diff proves path classification, not the original source
PR SHA used to build a squash queue entry. `pullRequest.headRefOid` is live.
**Binding sensitive approvals to the original queued source SHA remains unproven;
promotion stays blocked until that binding and the multi-entry chain have live
evidence.** This fallback does not claim to establish that separate binding.
