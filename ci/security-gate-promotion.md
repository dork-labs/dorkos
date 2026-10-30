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

Each source carries `enforcement`, mirroring the rule (`disabled`, `evaluate` or
`active`). Only an `active` source blocks a merge, so queue-green and pr-feedback
count a source only once it is `active`; before that, its red runs are not red
builds. Promotion sets `active` in the same change that activates the rule.

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

## Dedicated approval helper (not provisioned)

`SECURITY_APPROVAL_BOT_USER_ID: '0'` is a fail-closed placeholder. After Dorian
creates the App, pin its numeric bot user ID in the main workflow, and the same
ID plus App ID in `tools/security-approve/Main.swift`, through a reviewed PR.
The latest sensitive-head status must have that exact `creator.id`; a similar
slug or a later user success grants nothing. Complete nonsensitive diffs retain
the trusted initializer's automatic classification.

Dorian creates **DorkOS Security Review** from
[`security-review-app.manifest.json`](security-review-app.manifest.json) via
[GitHub's manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
installs it on **dorkos only**, with statuses write and metadata read. Deliveries
are disabled and there are no events. The reserved `.invalid` webhook URL is an
inert required manifest field, not a service to deploy. This lane creates no App.

The approval program is compiled Swift, never Node or shell. It accepts only
`<pr> <40-hex-sha>`, verifies the public PR head, requests owner authentication
showing that exact PR/SHA, reads its one Keychain item, signs an RS256 App JWT,
verifies App/install identity, mints a repository-scoped installation token,
rechecks the head and writes the status. It prints only the SHA on success. A
post-write head race reports failure. No key file, key environment variable,
external signer, arbitrary repository or API URL is accepted. Redirects refuse.
The key is never printed or written as plaintext. The helper cannot broaden a
Keychain ACL: a refused read stays refused without an access prompt.

### Building, signing and provisioning (all as dorkos-approver)

The step-by-step setup is [`tools/security-approve/SETUP.md`](../tools/security-approve/SETUP.md).
Both programs refuse to run unless all of these hold, checked before they read any argument,
queue or Keychain:

- The process runs as the Standard user `dorkos-approver` (home `/Users/dorkos-approver`), not
  root, with real and effective user ids equal, and stdin is a terminal. Agents run as Dorian, so
  they can neither read that user's Keychain nor raise a prompt in its session.
- The program runs from exactly `/usr/local/libexec/dorkos-approve/` (no symlink, no copy), and
  the binary and every folder above it are owned by root and not group- or world-writable.
- The provisioner pins only the installed helper at that path, and refuses any Keychain outside
  `/Users/dorkos-approver/Library/Keychains/`. It never touches Dorian's login keychain.

The provisioner validates the helper against `cdhash H"<printed-hash>"`, asks for owner
authentication naming that hash, then reads the PEM from a terminal with echo disabled. Import
and conversion happen in memory. The new generic-password item is `ai.dorkos.security-review` /
`github-app-private-key`; existing items are never overwritten. Its trusted application
requirement is the exact cdhash, not the certificate, team or bundle identifier.

Nothing is built, signed or installed in Dorian's session, where agents control `PATH`, the
toolchain shims and `$TMPDIR`. As `dorkos-approver`, with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`
set outright, Dorian fetches the reviewed SHA into a 0700 folder, builds, signs ad-hoc with
hardened runtime (`codesign --force -s - --options runtime`), records the helper's CDHash,
installs through an `osascript … with administrator privileges` prompt in that session, and
checks the installed binary prints the same CDHash. There is no Developer ID, timestamp or
`security find-identity` step, and no Keychain prompt in Dorian's session. With no signing team,
the Keychain's partition gate is pinned to `cdhash:<helper>` alone with
`security set-generic-password-partition-list`, run by Dorian as the approver; this narrows the
item, it never broadens it. Every rebuild changes the hash; `--repin` plus the same partition
command re-point the item without exporting the key.

### Batch approval

Security queues `<pr> <40-hex-sha>` lines with `tools/security-approve/enqueue.sh` (at most 8),
only when its `reviews/pr-<n>*.md` names that SHA. The script keeps **Security's own list** in
Security's folder, appends there, and republishes the shared queue from it in one step (temp
file, then `mv`). The **list digest** is computed from Security's own list, never from the shared
file: the first 16 hex (64 bits, too long to grind in the hours before Dorian's run) of SHA-256
over the sorted, distinct, well-formed lines, shown as four groups of four. `enqueue.sh --digest`
refuses when the shared queue differs from Security's list, and otherwise prints one `#pr sha12`
line per PR plus the digest, which Security posts. The script copies each review into
`/Users/Shared/dorkos-approve/reviews/` because the approver cannot read Dorian's home. The queue
and the copies are agent-written and trusted for nothing. The review copy is a **hint** that
filters honest mistakes, not a control: any agent can write one.

`security-approve --batch` accepts only well-formed lines (others are counted, never shown) and
prints its digest of the shared queue first and again right above the prompt; Dorian stops
unless it and the PR numbers equal Security's post, so a line slipped in by anyone else is
visible. For every PR it shows title, full head SHA and the changed files,
flagging `!` never-batch paths and `*` paths the gate pattern marks sensitive (the helper carries a
verbatim copy, pinned to `.github/scripts/fixtures/security-path-pattern.regex` by tests on both
sides). Everything shown is built from GitHub with terminal control and bidi characters stripped.
The file list comes from immutable SHAs: `git/ref/heads/main` gives B, then `compare/B...<sha>`
(base commit must equal B); a force-push during the run cannot change it. It drops any PR that is
closed, not based on `main`, moved off the queued head, without a review hint, or already carrying
the bot's success. One owner authentication, one short line naming the count and the digest, covers the list; one
App token is minted. Each head is rechecked with that token right before and after its post, a
moved head is skipped, and the token is revoked (`DELETE /installation/token`) after the last post.

Never batched, each needing `security-approve <pr> <sha>` with its own confirmation and its file
list shown: any change or rename under `.github/` (workflows, gate scripts, `CODEOWNERS`), any
`CODEOWNERS` file, `tools/security-approve/**`, `ci/security-*`, `ci/required-checks.json`,
`packages/ci-steward/src/rulesets.ts`, `scripts/security-paths-check.mjs`, and any comparison at
GitHub's 300-file cap or with duplicate names. Single mode uses the same base, diff, hint, head
checks and revoke.

### Platform dependency and proof

Exact trusted-application requirements require Apple's exported
`SecTrustedApplicationCreateFromRequirement` SPI, isolated in `ExactAccess.c`.
It is absent from the public headers, and the legacy file-based Keychain ACL APIs
are deprecated. The provisioner dynamically resolves that function and fails
closed if absent; it never falls back to a designated requirement. This is a
material compatibility dependency requiring Security review, not a claim of
support on every future macOS version. The approval reader itself uses Security
framework APIs and does not need this SPI. Source:
[Apple's requirement constructor](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/SecTrustedApplicationPriv.h).

Run `tools/security-approve/tests/test-policy.sh` locally: canned output, a fake GitHub and
private temp files only (policy, single and batch flows, enqueue).
Real helper/ACL tests (`tests/run.sh` and `tests/test-keychain.sh`) are CI macOS
runner only and refuse other environments. Never run `security`, `codesign`, the
helper or a Keychain probe from an agent session on the operator Mac—even with
a disposable Keychain. Dorian alone performs attended production provisioning.
The CI suite runs mock-signer tests,
builds both production executables, proves zero identity placeholders refuse,
and runs two disposable Keychain cases. The ad-hoc case gives both readers the
same identifier and deliberately shared designated requirement, but different
hashes. The certificate case creates a one-day self-signed signing-test identity
inside the temporary Keychain and signs both readers with that same certificate.
It uses a test-only native signing API with the explicitly selected disposable
identity, because the codesign CLI filters out untrusted certificates. No trust
settings are changed and no real identity is used. The generated signing-test
key/P12 exist only in the private temporary directory and are deleted; they are
not App keys. App keys never go to disk or an environment variable.

In both cases, both reader hashes are admitted by the separate partition gate,
so the exact-hash decrypt ACL is the deciding restriction. The approved binary
reads, the different binary is refused, the stripped copy cannot read (macOS
kills it before the read on arm64), and a final positive control reads. The test
removes its Keychain and files. It never reads login items. The certificate case
proves that a shared signing certificate does not confer the read grant. The ad-hoc case then
runs the production partition step (pinned to the helper's cdhash alone): the helper reads and
the other binary is refused. Real provisioning remains Dorian's attended proof.

No real App/key/approval has been exercised. Hosted required-workflow
`merge_group`, multi-entry queue-chain and signed production provisioning proofs
remain pending. Keep this PR on hold with auto-merge off.

The provisioner reads `codesign -d --entitlements - --xml --verbose=4`, refuses any
`[Dict]`/`[Key]` text-format entitlements outright (current macOS prints that without `--xml`),
checks displayed signature flags for hardened runtime and refuses
any get-task-allow, allow-dyld-environment-variables, disable-library-validation
or allow-unsigned-executable-memory entitlement, even with a false value. It
binds that display to the requested exact cdhash; the existing strict signature
validation then checks the same hash before ACL creation or repinning. Pure unit
tests feed canned display output and never inspect/sign a binary or touch a Keychain. The CI
macOS runner also signs runtime helpers carrying each injection entitlement and proves the real
display is refused.
Pin the real App/bot IDs before promotion; zero placeholders intentionally refuse.
