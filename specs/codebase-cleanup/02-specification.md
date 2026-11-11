---
slug: codebase-cleanup
number: 261111-174805
created: 2026-11-11
status: specified
---

# Codebase cleanup: smaller, simpler, faster

## Summary

Make changes faster to check and the repo easier to maintain. Remove unused code,
low-value tests and stale documents while keeping the checks that catch real bugs.

This specification defines six phases, numbered 0–5. It does not implement them.
Execution needs a separate go-ahead. Phases 2–4 wait for the Nov 17 cut.

## Baseline and targets

These are the plan's reported figures for main `78baefc5ac` on November 11, 2026.
They have not been remeasured for this specification. Phase 0 records repeatable
commands and refreshes them before any deletion.

| Measure                                 | Now                                  | Target                                 |
| --------------------------------------- | ------------------------------------ | -------------------------------------- |
| Test workflow per merge                 | ~29 min (6 shards)                   | ≤ 12 min                               |
| Test code                               | 1.56M lines, 5,318 files, ~64k cases | −40% lines (expect 30–50% fewer cases) |
| Product code                            | 1.54M lines                          | knip at 0 issues, then ratchet         |
| Docs, specs, plans, research, decisions | ~3,900 files                         | Only current docs in the repo          |
| Oldest supported upgrade                | v0.44 (config migrations)            | v0.115 (20 minors behind 0.135)        |
| knip in CI                              | no                                   | yes, can only go down                  |

Speed and bug-catching value decide what stays. Removing half the tests is a
sanity check, not a quota. The line target is about 936,000 test lines against the
reported baseline. Never delete a useful test just to reach it.

## Scope and guardrails

- Work only in the public repo. Keep private code, account details, internal agent
  names and chat identifiers out of committed files.
- Use one cleanup lane, separate from work for the Nov 17 cut. Phases 0–1 touch
  only areas no active release PR touches. Recheck overlap before each PR.
- Check open Linear projects and related issues before deleting anything
  unfinished. If the tracker cannot be checked, defer that candidate.
- Put in-progress code on a dated ignore list. Every entry names its path, reason,
  owner, tracking issue and review date. Broad or ownerless ignores do not qualify.
- A security reviewer signs off any deletion on a security path, including tests.
  Existing review gates remain in force.
- Ship small PRs within the WIP limit of eight. Pure deletions get light review;
  that does not waive security review or checks for changed behavior.
- Each PR records before/after numbers, exact commands, source revisions, tool
  versions and any skips. Use the same counting scope and comparable runners.
- Pipeline changes follow [the CI guide](../../contributing/ci.md), including a
  ledger entry with one hypothesis, baseline, target and review date. Reuse
  existing gates before adding new ones. Never weaken required checks to save time.
- Use temporary data for upgrade checks. Never change a live installation or
  publish real user data as evidence. Paid checks need their own explicit approval.

## Test keep/drop rules

### A test is a deletion candidate when it

- Only checks mocks or call order, catches no behavior bug and breaks on refactors.
- Mocks code owned by this repo, or mocks the thing it claims to test.
- Checks constants, trivial getters, compiler-checked types, rendering without
  assertions, exact copy strings or large snapshots.
- Repeats behavior covered at a cheaper level. Keep the cheapest test that still
  catches the bug.
- Adds no unique per-test coverage or mutation detection. A mutation check changes
  product code on purpose; a useful test detects that change. Use Stryker to
  calibrate this rule, not to make deletion decisions alone.

### These test classes always stay

- Security, permissions and authentication.
- Migrations and upgrades.
- Regression tests for real bugs.
- Contracts and boundaries: HTTP, inter-process calls (IPC), databases and the
  Model Context Protocol (MCP).
- Real behavior exercised through the public API.

A protected test wins over a deletion rule. Coverage overlap alone is not enough:
record what bug-catching value survives before removing a candidate. Exact bytes
required by a public contract are behavior, not a copy-only assertion.

Phase 2 explicitly retires old upgrade behavior. Tests solely for those retired
paths can leave with them after the version-floor rejection and supported-upgrade
checks pass. Other protected tests stay. A security-path deletion still needs
security sign-off.

### Rules for new and changed tests

Test behavior through the public API. Mock only at process edges: network, clock,
filesystem and model calls. Add one regression test per bug and prove it fails
before the fix. Avoid snapshots and copy-string checks. Extend an existing test
before adding a file. Keep these rules aligned in `AGENTS.md` and the
test-driven-development skill wherever that skill is maintained in the repo.

Reviewers ask: “Would this fail if the behavior broke? Does it survive a refactor?”

## Phases

### Phase 0: Measure and guardrails

**Starts:** November 11. **Due:** November 20, 2026.

First PRs:

1. Record the knip baseline, including production entry points and justified
   ignores. Knip finds unused files, exports and dependencies. Add
   `knip --production` to CI as a can-only-go-down check.
2. Produce per-test duration and flake reports. Distinguish first-run failures,
   retry passes and skips; do not hide failures by increasing retries.
3. Add the testing rules above to `AGENTS.md` and the TDD skill (test-driven
   development), plus the two reviewer questions.

Run a bounded Stryker per-test pilot on shared, relay and server core. Record the
exact server-core scope, settings, elapsed time and resource use. Use the results
to judge the deletion filters before applying them broadly.

**Before/after measures:** Compare the reported baseline with measured test and
product lines, files, cases, workflow duration and shard timings. Record knip
findings by kind, per-test timings, retry-pass rate, pilot mutation results and
measurement cost. Missing data is labeled unknown, never zero.

**Done when:** Reports are reproducible, the pilot has results for all three
scopes, testing rules are in place, and the production knip check rejects a new
unexplained issue. Existing findings have a counted baseline; temporary ignores
have owners and review dates. No suite pruning happens in this phase.

### Phase 1: Dead code

**Starts:** November 11, after Phase 0 measurements for each affected area.
**Due:** November 20, 2026.

First PRs:

1. Confirm no current consumer, then remove the root `dorkos-0.56.0.tgz`, the
   malformed root file beginning `hat-is-in-it)` and stale root `VERSION`
   (reported as `0.127.1`). Resolve the malformed filename exactly before deletion.
2. Remove confirmed knip findings in small, separate batches. Check open projects
   first and record unfinished work on the dated ignore list.
3. Remove unused dependencies and run `pnpm dedupe`. Review the lockfile change
   separately from source deletions.

**Before/after measures:** Count root strays, product lines and files, knip
findings, ignored findings, direct dependencies and duplicate dependency versions.
Record affected check results for every batch.

**Done when:** The three named strays are resolved, confirmed unused code and
dependencies are gone, and dedupe is complete. Production knip has zero unexplained
issues. Every remaining in-progress exception is narrow, dated and owned. No
active release work or protected behavior was removed.

### Phase 2: Old-version support

**Gate:** After the Nov 17 cut. **Due:** November 27, 2026.

Set the minimum upgrade-from version to `0.115`. Remove config migrators for
`0.44`–`0.89`, plus compatibility paths and flags for features older than `0.115`
and their retired-path tests. Inventory candidates rather than deleting by age
alone. Installs older than `0.115` must stop with a clear two-step upgrade path:
first use a verified bridge release, then upgrade to the current release. Verify
which bridge supports the old install before naming it in instructions. Never
silently apply an unsupported migration.

Combine the reported 172 Drizzle database migrations into one baseline. First
compare it with the full migration history, including hand-written data and schema
fixes. Prove that fresh creation and supported upgrades reach the same correct
schema and data. Run the real-data QA upgrade check from `0.115` and the latest
version on protected temporary copies. A security reviewer reviews this change.

Going forward, support 20 minor versions back. An `@deprecated` marker names its
removal version; lint flags it once that version has passed. Document how each
release advances the floor.

**Before/after measures:** Count config migrators, compatibility paths and flags,
retired tests, database migration files and expired deprecations. Record schema
and data comparison results, upgrade outcomes and elapsed times from both supported
versions, plus the below-floor refusal result.

**Done when:** The floor is enforced, the bridge route is verified, both supported
upgrade checks and the fresh-database comparison pass, hand-written fixes survive,
and security review is complete. No migration is deleted before that evidence.

### Phase 3: Docs

**Gate:** After the Nov 17 cut. **Due:** November 27, 2026.

Run lychee to check links in `docs/`. Add a script that flags references to removed
files or symbols. Delete or merge stale pages, keep one current doc per topic, and
generate API and CLI reference from source.

Review `specs/`, `plans/`, `research/`, `audits/` and `mockups/`. Shipped or abandoned
work leaves the repo; git history keeps it. Check open projects and replace live
references before removal. Keep current audit charters and active work. Keep live
decisions in `decisions/`; remove superseded ones after repairing inbound links.
The north-star set in `meta/` remains authoritative.

**Before/after measures:** Count files by directory, broken links, references to
removed symbols or paths, duplicate topics and hand-maintained reference pages.
Record tool exclusions and generation commands.

**Done when:** Current pages have valid links, stale references are resolved, each
topic has one current home, generated reference is reproducible, and removed
planning material is neither active nor needed by a live document.

### Phase 4: Tests

**Gate:** After the Nov 17 cut and Phase 0 calibration. **Due:** December 4, 2026.

Prune in this order: duplicate Playwright tests, mock-only unit tests, then snapshots
and trivial tests. Record a reason and surviving coverage for every deletion
batch. Keep all protected classes under the rules above.

Ensure PR checks use `turbo --affected` and the merge queue runs the full suite.
The CI guide already describes this split: verify the current behavior and fix
only proven gaps. Set per-package test runtime and file-count budgets that can
only decrease. Add lint that rejects `vi.mock` of modules owned by this repo;
preserve valid mocks at process edges.

**Before/after measures:** Compare workflow wall time, each shard's time, test
lines, files, cases, per-package runtime, retry-pass rate, skips and the bounded
mutation samples. Show which remaining test detects each covered behavior.

**Done when:** The merge test workflow is at most 12 minutes on comparable runs,
test lines fall 40% against the measured baseline, and retained checks still catch
the protected behaviors. Record the expected 30–50% case reduction as an outcome,
not a gate. If useful coverage prevents the line target, report the shortfall for
review instead of deleting it. Budgets and the internal-mock lint rule reject new
violations; the full merge-queue suite remains required.

### Phase 5: Keep it from growing back

**Depends on:** The earlier phases' measured baselines. **Due:** December 4, 2026.

Keep knip and test budgets in CI. Add size-limit checks for the client and desktop
bundles. Use dependency-cruiser to reject cycles and package-boundary violations.
Reuse existing checks where possible. Set each limit from measured outputs, with
no unmeasured allowance. Add a monthly cleanup check to grooming.

**Before/after measures:** Record each check's presence, counted findings, runtime,
per-package limits, client and desktop bundle bytes, cycles and boundary violations.
Compare seeded-violation failures with clean runs after the temporary probes leave.

**Done when:** All four check families run in CI, clean builds pass, controlled
violations fail, and limits cannot rise without an explicit reviewed change. The
monthly review has an owner and a checklist for expired ignores and deprecations.

## Schedule and delivery

All dates below are in 2026. The specification is due November 12 at midday Central
Time. The six tasks in `03-tasks.json` are ready for one tracking child per phase;
this docs step does not create tracker entries or start execution.

| Deliverable                   | Due                   |
| ----------------------------- | --------------------- |
| Ticket and specification      | Thursday, November 12 |
| Phases 0–1 merged             | Friday, November 20   |
| Phases 2–3 complete           | Friday, November 27   |
| Phase 4 and ratchets complete | Friday, December 4    |

Follow capture, triage, specify, decompose, execute, verify and close. Triage is
Must, not urgent. Phases 2–4 wait for the Nov 17 cut even if earlier work finishes
early. This schedule does not change the product launch date.

## Verification and evidence

Every implementation PR includes its phase's before/after measures, deletion
reasons, protected-class review and affected check results. Record machine and
runner conditions so a speed claim can be compared fairly. Build required package
outputs before knip; stale distributions must not drive deletions.

Use targeted checks locally. Full suites run through the repo's package-aware
commands and the merge queue. Do not change paid-test flags or credential handling.
Keep raw reports outside tracked product files; commit only safe summaries and the
configuration needed to reproduce them.

## Risks

- **Lost hand-written database fixes.** A generated Drizzle baseline may preserve
  schema but lose data repairs. Compare full history, fresh databases and both
  supported upgrade paths before deleting history.
- **Stryker cost on this Mac.** Mutation runs can consume hours and crowd out other
  work. Bound the three pilot scopes and record resource use before expanding.
- **Hidden coverage loss.** Duplicate-looking tests can catch different bugs. Keep
  protected classes and require surviving behavior evidence, not overlap alone.
- **Unfinished work mistaken for dead code.** Check open projects, public package
  entry points and active PRs; defer uncertain paths with an owner and review date.
- **Misleading speed gains.** Runner load, retries or fewer executed tests can make
  a workflow look faster. Report comparable timing and executed, skipped and failed
  counts together.
- **Broken upgrade or document routes.** Verify the bridge release and repair live
  links before removing their old targets. Git history alone is not a usable route.
