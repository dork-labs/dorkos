---
slug: opencode-run-custody
id: 261117-015113
created: 2026-11-16
status: ideation
linearIssue: DOR-4500
---

# Stop an OpenCode test process when its run ends

**Slug:** opencode-run-custody  
**Author:** Codex  
**Date:** 2026-11-16 (America/Chicago)

## 1) Intent & Assumptions

- **Task brief:** [DOR-4500](https://linear.app/dorkspace/issue/DOR-4500/opencode-test-sidecar-outlives-its-run-by-hours-the-harness-should) asks that OpenCode processes started by tests, evals and harness smoke stop when their run ends, including failure, timeout and parent SIGINT/SIGTERM. Its done-when also requires a killed run to leave no OpenCode process behind, proven by a test observing the parent's exit.
- **Historical report:** on November 15 in #dorkos-app, while investigating machine load, an OpenCode sidecar from an old #3759 worktree under `/private/tmp` was reported still alive **17 hours** later at about **7% CPU**. No agent claimed it. PM asked for P3. These are the issue's reported observations, not measurements made during this investigation.
- **Maturity:** a concrete bug brief with source discovery, ready to shape into a specification. No actual orphan reproduction has run in this work.
- **Purpose:** a founder's computer should not keep doing abandoned verification work after its owner has ended the run. This is internal developer reliability work; it makes no new public product or security claim.

**Assumptions and constraints**

- Custody applies only to resources the run started and can identify as its own. Never find and stop processes by a shared name, worktree-looking path or stale PID alone.
- Normal `finally`/`afterAll` cleanup remains valuable. It cannot execute inside a parent already killed by SIGKILL; that case needs custody outside that parent's lifetime.
- Reuse existing graceful shutdown and binary integrity checks. Do not change runtime permission levels, account choice, payer gates, model selection, global profiles or provisioned binaries.
- Every existing paid opt-in and matching key gate must run before any new custody helper process or network call. Importing a supervisor module must be inert. No ownership convenience may move acquisition ahead of those gates.
- Test/eval custody must not silently change whether production background work survives. Any shared spawn change needs an explicit lifetime boundary and production impact decision in SPECIFY.
- This IDEATE pass authorizes no implementation, native execution, process signaling, model calls or paid flags. Lifecycle proof should need no model request or credential spending.
- The existing coordinator worktree is the authorized intent-stage location. Its older HEAD is `93bec904c41d2ed9709ff5892c46928f4f001fd2`; code findings below come from pinned main `5496062c1c7d817a5395d4834afa25f7188f92ac`, not an assumption that the coordinator contains current code.

**Out of scope**

- An OS sandbox, arbitrary escaped-descendant containment, or a guarantee against machine loss or every supervisor failure.
- Sweeping unrelated processes, profiles, worktrees or containers.
- Changing production agent behavior or adding a general host process controller without a separate decision in SPECIFY.
- Treating desktop/browser cleanup infrastructure as already proving OpenCode cleanup, or Windows behavior as verified by macOS/Linux results.

## 2) Pre-reading Log

- `AGENTS.md`, `meta/VISION.md`, `meta/PRINCIPLES.md`, `meta/VOICE.md`, `meta/ROADMAP.md`: ownership, developer quality and claim-only-what-works apply. No product positioning or roadmap claim changes are needed.
- Flow `skills/ideating-features/SKILL.md` and `templates/docs/ideation.md`: retain the brief's concrete evidence, map the code, compare options and hand technical decisions to SPECIFY.
- Actual Linear DOR-4500 and all comments were read before discovery: no comments or duplicate relation were present at that read. Subsequent workflow state is owned by the coordinator, not asserted from that older snapshot.
- Systematic-debugging guidance: separate the historical report, source observations and untested hypotheses; reproduce before claiming the defect fixed.
- Dependency-source guidance: installed `@opencode-ai/sdk@1.19.3` `dist/server.js` and `dist/process.js` were inspected read-only. No dependency fetch or install was needed. SDK observations are identified separately from repository source.

### Source reference convention

Every repository-code link below names immutable main commit `5496062c1c7d817a5395d4834afa25f7188f92ac`. The same relevant OpenCode/eval/smoke lifecycle surfaces were compared with earlier pin `9ca9c0a1ae404ffb0325618250f2b6b4486558b4` and were unchanged. Recheck against the eventual implementation base before changing code.

## 3) Codebase Map

### Start and cleanup paths

| Path                                                                                                   | Existing lifecycle                                                                                                                                                                                            | Boundary to investigate                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production [OpenCode manager][manager]                                                                 | `boot()` directly spawns `opencode serve`. Startup failure, recycle and shutdown stop and await the child; teardown escalates TERM to KILL. The [server shutdown path][shutdown] calls the singleton manager. | No outside owner watches this process when the owning Node process dies. Keep production behavior separate from run-specific custody.                                                                                                                         |
| [Live OpenCode conformance][conformance]                                                               | A file-owned manager is created for live mode; `afterAll` calls `shutdown()`. Mock mode starts no sidecar.                                                                                                    | Ordinary test cleanup differs from a forcibly terminated worker that never reaches the hook.                                                                                                                                                                  |
| [Package-grants binary test][packages] and [project-plugin binary test][plugin]                        | Each uses a real manager and `afterAll` shutdown. The plugin test also wraps native spawns for integrity checks.                                                                                              | A run-level hard death can bypass the hook. Integrity observation alone is not shutdown custody.                                                                                                                                                              |
| [Pinned CLI helper][pinned], used by credits-mode, folder-secret-canary and the project-plugin control | `runPinnedOpenCode()` kills its child in `finally` and awaits close plus unchanged-binary verification. `guardedOpenCodeSpawn()` disables updates and returns a verification promise.                         | The helper handles normal callback failure; its parent cannot run `finally` after being killed. The guarded spawn itself does not provide parent-death cleanup.                                                                                               |
| [Eval child-process launcher][eval-child]                                                              | Starts a detached server process group. `kill()` signals that group and waits for the server exit, with a bounded reap wait. The server starts its own OpenCode manager.                                      | No hard-owner-death backstop. The early return once the server leader has exited can omit remaining descendants; reproduce this owned case before changing it.                                                                                                |
| [Eval orchestration][eval-run] and [interrupt registry][interrupt]                                     | `runEval` registers disposal for SIGINT/SIGTERM and has normal cleanup. Credentialed server boot failures call launched-server cleanup.                                                                       | These are cooperative paths. An interrupted or stuck disposer and a killed owner need independently observable cleanup outcomes.                                                                                                                              |
| [Docker eval launcher][docker]                                                                         | Its owned container is stopped on retained failure or removed otherwise; its proxy closes. Interrupt disposal and the later sweep are existing mechanisms.                                                    | Killing the Docker CLI or host harness does not itself prove the container stopped. Treat exact container identity, stop confirmation and hard-owner death as a separate lifecycle boundary. A sweep is recovery, not proof that no process was left running. |
| [Harness smoke runner][smoke] and [OpenCode command definition][smoke-command]                         | `runProbe()` uses `spawnSync` with a timeout. OpenCode's model command is `opencode run`; its configured free-probe branch is `none`.                                                                         | This is a real CLI-run path, not a repository-created `serve` instance. Direct-child timeout handling does not establish cleanup after owner death or cleanup of descendants.                                                                                 |

The ordinary server's SIGINT/SIGTERM handlers use [signal shutdown][signals]; a second signal exits immediately. A production server in a test/eval therefore does not inherit a proof that all its runtime children have finished just because a server-level exit was observed.

### Other boundaries and exclusions

- `createOpencodeClient()` creates a client, not a process. Repository executable calls to SDK `createOpencodeServer()`/`createOpencodeTui()` were not found in the inspected TypeScript/JavaScript paths. DorkOS's manager deliberately uses its own spawn.
- Installed SDK 1.19.3's spawning helpers own a child and expose close/abort/startup-timeout stop paths. They do not supply the repository's missing run-owner-death custody, and changing SDK version is not a proposed fix.
- OpenCode version/auth probes and npm provisioning are bounded command paths, not persistent sidecar starts. Inventory them when selecting the ownership seam, without conflating them with `serve`.
- The [computer guest recipe][guest] starts OpenCode through an owned guest's systemd service; [computer runtime access][computer] builds a client for that endpoint. That is a VM/service lifetime, separate from the reported host test sidecar. No guest redesign is selected here.
- Browser/e2e test-mode surfaces are not evidence that a real OpenCode binary ran. Any newly discovered real startup path must join this inventory before implementation is considered complete.

### Existing cleanup infrastructure

| Existing mechanism                               | Reusable idea                                                                                                                               | Limit                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [Desktop orphan watchdog][desktop-watch]         | An explicit parent identity can survive wrapper layers; PID/start-time corroboration avoids confusing a recycled PID with its former owner. | Development desktop-server path only. It is not registered by OpenCode tests/evals/smoke and does not prove their cleanup.                  |
| [Shared process liveness][liveness]              | Distinguishes known identity from bare PID existence where corroboration is available.                                                      | Observation is not child custody or authority to stop an unrelated process; platform fallback retains uncertainty.                          |
| [Browser supervisor worker][browser-worker]      | IPC disconnect initiates owned-resource close, and concurrent close callers share completion.                                               | Browser-specific ownership and protocol; not a drop-in OpenCode supervisor.                                                                 |
| [Darwin owned-process research][darwin-research] | Documents ownership, reaping and proof limits explicitly.                                                                                   | Its own README labels native custody and descendant completeness unverified. Do not turn dormant research into a claimed cleanup guarantee. |

**Potential blast radius:** native binary helpers, live conformance, eval isolation/interrupt/disposal and harness smoke command execution. Their child identities, stdout/stderr handling, startup readiness, exit status, cleanup races and artifact retention must remain accurate. Any change to shared server spawn ownership needs an explicit production-versus-test boundary in SPECIFY.

## 4) Root Cause Analysis

**Reported versus expected:** the historical report says a run's OpenCode sidecar survived for 17 hours; the desired outcome is that the run's owned OpenCode work stops when the run ends, with direct evidence after a killed parent exits.

**Source observations:** teardown is spread across callback `finally`, test hooks, server shutdown, eval signal disposal and container cleanup. Each has a legitimate normal path. The examined host OpenCode test paths do not show an independent custodian whose lifetime survives hard death of the run owner. Evals already own a process group, but only the living harness invokes its kill function.

**Hypotheses, not reproduced causes:**

1. A forcibly ended test worker bypassed its `afterAll`/`finally` cleanup, leaving the sidecar alive. Source supports a possible path, but does not identify what happened to the old #3759 run.
2. A server leader exited before eval disposal, and the launcher's exited-leader shortcut left a descendant. This needs a controlled leader-exits-first fixture.
3. A direct CLI timeout or parent death left a wrapper's descendant outside the direct-child cleanup being observed. The actual OpenCode wrapper/descendant shape must be measured, not guessed.
4. A Docker run lost its host owner before container disposal. This is a separate candidate boundary, not an explanation established for the reported `/private/tmp` host process.

**Reproduction status:** no original-run log, owned PID receipt or new reproduction was collected in this IDEATE pass. No process was started or signaled. Source discovery does not prove the historical root cause or establish that a proposed mechanism works.

**Related changes:** the existing pinned helper's normal `finally` kill and post-close hash checks address ordinary cleanup and binary integrity, not hard parent death. DOR-4415 changes when plugin absence is observed, not process custody. The discovered desktop/browser mechanisms are separate boundaries. No inspected source fix establishes DOR-4500's done-when as already met; this is not a duplicate determination for the coordinator.

## 5) Research

No new external research or native experiment was performed. These options are design candidates for SPECIFY:

| Option                                                         | Benefit                                                                                                                                                 | Gap or cost                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add more hooks and signal handlers in each runner              | Small changes; improves cooperative shutdown and error cleanup.                                                                                         | Cannot execute in a SIGKILLed parent. Repeating handlers does not meet the killed-run requirement.                                                                                      |
| Share an owned-run custodian with an exclusive parent lifeline | Can register custody before startup is exposed, observe owner loss outside that owner and join cleanup. Gives tests/evals/smoke one lifecycle contract. | Must define custodian acquisition, its own lifetime, direct-child/wrapper handling, late startup, escalation, reaping and exact authority. The mechanism is not yet selected or proven. |
| Use an OS/container-specific lifetime primitive                | May match a platform's real process or container ownership boundary.                                                                                    | Requires separate implementation and proof per platform. A process group or container is not automatically an OS sandbox or a complete arbitrary-descendant boundary.                   |
| Sweep after a run                                              | Existing eval sweeps can recover known resources.                                                                                                       | Does not stop work at owner death; historical naming/path/PID searches risk acting on unrelated work. Not sufficient as the primary design.                                             |

**Recommended direction:** specify the smallest shared owned-run custody contract that covers the real host starts above while retaining existing graceful cleanup. It should register ownership before publishing a child, identify the exact resources it owns, stop them on scope end or owner loss, await an observable terminal outcome, and report uncertainty instead of declaring everything gone. Evaluate an exclusive parent-lifeline custodian first. Decide concrete modules, spawn seams and platform mechanisms during SPECIFY, not in this document.

Smoke currently uses `spawnSync` with supplied input, which closes stdin. That stdin cannot also be a live-parent lifeline. Async launch migration versus a separate lifetime channel remains an open design choice for SPECIFY.

Treat eval server descendants and Docker's owned container as explicit boundary cases. Do not silently restrict the issue to one binary helper while leaving live conformance or smoke unowned. Equally, do not make a broad production process-management rewrite the default. Preserve current signal behavior, startup/error diagnostics, output streams and evidence retention.

### Proof direction for SPECIFY

1. An independent outer observer starts one owned run fixture and records its exact child identities and communication channels. Require a positively observed live owned child before inducing failure; zero started subjects cannot pass.
2. Exercise normal return, thrown failure, operation timeout, parent SIGINT, parent SIGTERM and parent SIGKILL. Include early parent death while startup is pending, so custody is not registered too late.
3. Add a TERM-resistant child to require escalation, a wrapper/owned-descendant case and a server-leader-exits-first case. Confirm the actual descendant set being claimed. Do not infer an arbitrary escaped-descendant guarantee from a controlled fixture.
4. Observe actual owned child exit/reaping and cleanup completion. A closed port, invoked disposer or elapsed sleep alone is insufficient. Any observation deadline is a failure bound, not a way to certify absence before work settles.
5. Run the actual pinned OpenCode lifecycle over isolated HOME/XDG and throwaway data with offline/fake-local settings. Starting `serve` and proving death should not need a model request. Preserve binary hashes, expected subject counts and raw outer/parent/child outcomes; never use real model keys or paid flags for this proof. The existing pinned-spawn observer must continue observing the actual OpenCode binary and PID with its hash if acquisition moves into another process. Observing a Node wrapper, accepting zero native subjects, or verifying only the requested path is insufficient.
6. Establish green first, then remove the parent-lifeline backstop in a controlled copy. The intended owned-child-death assertion must fail for a genuinely live owned child. The independent outer observer still owns its final cleanup. Restore the source and obtain fresh green evidence.
7. Keep Docker proof separate: exact owned container identity, observed running state before owner death, then confirmed stop/removal. Retained failure evidence must not require a running container. Missing Docker availability is unverified, not a host-process pass.
8. Keep platform results separate. Current pinned OpenCode native coverage is macOS arm64 and Linux x64; those results do not prove Windows process-tree cleanup. SPECIFY must decide the Windows mechanism and executable proof or retain an explicit unverified limit. Parent SIGKILL cannot invoke an in-parent handler; supervisor loss, machine loss and escaped descendants remain outside any claim until separately addressed.

Native/process experiments are future work, with normal resource admission and owned cleanup. This ideation records no native, model, Docker or platform-success result.

## 6) Decisions

| #   | Resolved constraint                                                                                                                      | Basis                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Scope is OpenCode work started by tests, evals and harness smoke, including the killed-run proof requirement.                            | DOR-4500 brief and done-when.                            |
| 2   | Preserve cooperative cleanup; distinguish it from cleanup after hard owner death.                                                        | Source observations and the issue's failure modes.       |
| 3   | Proof uses owned processes, positive live-child observations and an independent outer observer; it does not spend on a model.            | Coordinator's discovery brief and evidence requirements. |
| 4   | Use the authorized coordinator worktree for this intent artifact; keep pinned current-main code references separate from its older base. | Explicit worktree instruction for this run.              |

No implementation design, package placement, OS primitive, cleanup bound or Windows/Docker completeness claim is resolved here. The async-smoke-versus-separate-channel choice and the mechanism that owns a Docker-daemon container after host-owner death are likewise unresolved.

**Next step: SPECIFY.** The coordinator should choose the lifetime and authority contract, map every start path onto it, define behavior when acquisition or cleanup is uncertain, settle the Docker and Windows boundaries, and turn the proof direction into exact executable acceptance cases. Recheck current source before that design; do not promote these hypotheses into guarantees.

[manager]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/apps/server/src/services/runtimes/opencode/server-manager.ts#L447
[shutdown]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/apps/server/src/startup/shutdown-runtimes.ts#L10
[conformance]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/apps/server/src/services/runtimes/opencode/__tests__/conformance.test.ts#L398
[packages]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/apps/server/src/services/runtimes/opencode/__tests__/package-grants.binary.test.ts#L198
[plugin]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/apps/server/src/services/runtimes/opencode/__tests__/project-plugin-guard.binary.test.ts#L131
[pinned]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/apps/server/src/services/runtimes/opencode/__tests__/pinned-opencode.ts#L119
[eval-child]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/packages/evals/src/runner/isolation/child-process-launcher.ts#L277
[eval-run]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/packages/evals/src/runner/run-eval.ts#L398
[interrupt]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/packages/evals/src/runner/interrupt.ts#L21
[docker]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/packages/evals/src/runner/isolation/docker-launcher.ts#L479
[smoke]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/scripts/harness-smoke/run.ts#L292
[smoke-command]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/scripts/harness-smoke/harnesses.ts#L733
[signals]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/apps/server/src/lib/shutdown-signal.ts#L36
[guest]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/apps/server/src/services/computers/guest/guest-recipe.ts#L150
[computer]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/apps/server/src/services/runtimes/opencode/computer/provider.ts#L154
[desktop-watch]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/apps/desktop/src/orphan-watchdog.ts#L112
[liveness]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/packages/shared/src/process-liveness.ts#L1
[browser-worker]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/packages/browser/src/runtime/darwin-supervisor-worker.ts#L38
[darwin-research]: https://github.com/dork-labs/dorkos/blob/5496062c1c7d817a5395d4834afa25f7188f92ac/scripts/browser-control-prototype/runtime-policy/owned-process-darwin/README.md#L1
