# Implementation: Doe standalone engine

Spec: `specs/doe-engine/02-specification.md` · Tracking: `03-tasks.json` · Linear: DOR-2786.

## Progress

8 of 8 implementation tasks complete. PR delivery and merged completion remain gated on final-head review and repository checks.

## Implemented

- Foundation: standalone MIT package, explicit JSON model/tool/resource contracts, real SQLite model history/checkpoints/usage/outcomes. Opaque fields round-trip without display-log projection.
- Resources: ordered host instructions, on-demand skills, nested instructions before mutation, canonical filesystem grants and bounded local/web tools.
- Registry/MCP: attributed MIT BM25 discovery, fixed initial schema budget, deferred selection, pinned Pi MCP 1.0.4 stdio/HTTP with explicit environment, deadlines and physical connection cleanup.
- Engine: actual three-protocol Pi streams, queues, host approvals, cancellation, explicit credentials, compatible retries/fallbacks, split credential redaction and honest usage.
- Compaction: complete-turn/tool-group retention, provider/estimate provenance, lossless archives, atomic checkpoint rollback and effective current-system replay across repeated compaction/reopen.
- Builder: separate coding prompt/history/resources/registry, bounded results and explicit shell policy. POSIX owned process groups stop descendants on both abort and command completion; Windows uses a host isolated executor.
- Beat: fresh isolated context, decision skip and bounded quiet/raises, one complete tool batch, durable outcomes finalized only after owned cleanup and successful persistence. No scheduler or notification delivery.

## Independent review

Each task received specification review before code-quality review by a worker other than its author. Reviews corrected lossless JSON edge cases, deferred selection saturation, HTTP/FIFO cancellation, refreshed prompts and credentials, process descendant cleanup, denied approval handling and repeated checkpoint instruction replay.

Shared lifecycle reviews found and fixed three concrete false-success cases: parent settlement before owned child accounting, discarded late child persistence errors, and premature beat outcomes. A further cancellation review separated host cancellation from internal cleanup cancellation. The final shared delta at `817312962311c887d5a1333935a6876c52495018` passed independent specification and a separate quality pass. Real SQLite triggers preserve original storage errors and prevent quiet/completion; deterministic gates prove public and external abort during cleanup. Ordinary child failures remain recoverable and later session reuse works.

Review journal rounds through 31 are recorded by Flow. Fresh whole-branch review found one protocol defect: Pi Anthropic conversion stripped the root union from end_beat. The author added provider-visible root fields while preserving exact validation. Actual quiet and raised completions now pass all three wire formats. Independent specification and full-branch quality review at 7bd7d8c90615c3756ae274bf9c9252ac9ea620e2 found no remaining blocking issues. Final-head review follows commit curation.

## Verification evidence

Root and the independent reviewer each ran all 174 package tests at `7bd7d8c`; all passed. Combined package build, typecheck and lint also passed. Fixture guards now distinguish healthy RPC budgets from explicit started timeout/abort work and clean up FIFO guards.

## Delivery implemented

Public builder/beat exports, full README/NOTES/notices and a runnable inert local example are integrated. The new public API host-flow test passes actual local model/MCP requests: discovery, approval, builder write, complete history, close/reopen, compaction, continued chat and isolated beat. It checks fixed schema growth, scoped unique usage, opaque reasoning and configured MCP credential boundaries.

The explicit `test:pack` command builds and installs a production tarball in an owned temporary directory outside the repository, then checks files, dependency confinement, inert import/construction, all three actual SDK protocol exchanges and the packaged example. Its repeated final-source run passed: 136 production dependency names, Pi1.0.4, Anthropic SDK0.129.0, OpenAI SDK7.19.0 and 95 shipped files. No DorkOS product runtime dependency. It removes its consumer afterward. Package build/typecheck/lint and the root Vitest census passed. Full pnpm verify passed after the reviewed protocol correction, including 790 repository script tests and hook fixtures. Final curated-head verification runs before the PR. Independent delivery specification and whole-branch quality reviews are clean. No paid model requests or npm publication occurred.

## Host boundaries

Credentials, paths, resources, approvals, retries, tools, model billing, shell isolation, beat scheduling and notification delivery belong to the host. Estimated tokens are heuristics; missing cost is unknown. File grants do not isolate unrestricted shell or defend against an adversarial process replacing parent directories. Injected engines and isolated executors must finish their owned work after cancellation. Session locking is process-local; hosts coordinate independent processes.

## Workflow

All tracked implementation is in managed worktrees. Root composes the engine branch; foundation, resources and tools writers used dedicated checkouts. Dorian authorized canonical JSON, parallel agents and autonomous delivery. Main tracks origin/main; another session's unrelated skill edit is preserved. The originating author fixes reviewed defects; reviewers recheck pinned revisions. The separate CLI review launcher failed model eligibility before reviewing; Dorian's explicitly authorized independent subagent fallback completed the review without a fabricated token verdict. No paid paths are armed. DOR-2787 remains blocked until Part1 is merged and closed.

## Merge queue correction

The first merge queue run exposed the shared company-name guard: standalone license attribution must be explicitly allowed. The license author reproduced the failure and added only `packages/doe/LICENSE` to the existing exception list, with a standalone-license justification. All five company tests, shared typecheck and lint passed; existing lint warnings were unchanged. The PR was disarmed while this correction received fresh repository verification and independent review.

Fresh repository verification also exposed a pre-existing sidebar keyboard-test setup race: the test opened before asynchronous config enabled spaces. An independent reviewer reproduced it at both the base and Doe revisions and verified identical client/UI production trees. Adding the file’s existing `configAnswered()` precondition before opening preserved every keyboard/focus assertion and passed all 89 file tests; no production code changed.

The next verification run passed 18,547 client and 28,239 server tests, then exposed a second pre-existing test boundary: the retained-sandbox filesystem sweep test invoked an unbounded ambient Docker command. The unchanged base eval tree and existing DockerCli seam were confirmed independently. A test-local empty Docker result keeps real sandbox retention/deletion assertions intact; all 27 run-eval and dedicated sweep tests, evals typecheck and targeted lint passed. Production sweep behavior and timeouts were unchanged.
