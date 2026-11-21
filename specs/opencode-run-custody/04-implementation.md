# OpenCode run custody implementation journal

**Issue** DOR-4500

**Author** Codex

**Branch** `codex/dor-4500-opencode-run-custody`

**Progress** 3 of 13 tasks complete

## Task 1.1 — Source census completed

The coordinator claimed Execute and reviewed the source-only inventory. The [task plan](03-tasks.md) records one completed task. Tasks 1.2 through 4.2 remain pending. Candidate plan commit `1378b631d8933f57237b2b83b3c9b75d1e550669` and published source commit `8ee317547876f16ded66d271016c515e88e14fe0` were pinned. All 50 published blob and content pins in the census matched on review. The cited launch implementation also matches the plan worktree at that commit. No model, native binary, daemon, credentials or test process was exercised for this task.

### Launch and clock inventory

| Caller                                                                                                                                                                                                                                                                                                                                | Actual start and admission                                                                                                                                                                                                                                                                                                                  | Existing clocks and scope                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Server conformance](../../apps/server/src/services/runtimes/opencode/__tests__/conformance.test.ts) and [manager](../../apps/server/src/services/runtimes/opencode/server-manager.ts)                                                                                                                                                | The file-owned manager starts `serve` on live use. Mock mode spawns nothing. Free live requires `DORKOS_OPENCODE_LIVE=1` and intended local configuration. The paid route requires `DORKOS_OPENCODE_LIVE_PAID=1` and `OPENROUTER_API_KEY`. The free label alone does not constrain inherited OpenCode configuration.                        | Readiness is 15,000 ms and TERM grace is 3,000 ms. Preserve the existing outer test deadlines. Native custody can be proven without using a model.                                         |
| [Package grants](../../apps/server/src/services/runtimes/opencode/__tests__/package-grants.binary.test.ts) and [project plugin tests](../../apps/server/src/services/runtimes/opencode/__tests__/project-plugin-guard.binary.test.ts)                                                                                                 | The pinned binary gate admits file-owned managers. The plugin fixture also runs a raw CLI control and can reach the manager through a non-turn `getClient`. Both use local fixtures.                                                                                                                                                        | Keep the raw control's 100-second wait and existing 120- and 150-second test budgets. A policy refusal without a process is insufficient proof.                                            |
| [Raw pinned CLI helper](../../apps/server/src/services/runtimes/opencode/__tests__/pinned-opencode.ts), [credits](../../apps/server/src/services/runtimes/opencode/__tests__/credits-mode.binary.test.ts) and [folder-secret control](../../apps/server/src/services/runtimes/opencode/__tests__/folder-secret-canary.binary.test.ts) | The pinned helper spawns the CLI, ends stdin and waits for close after cleanup. The tests use synthetic local credentials or endpoints.                                                                                                                                                                                                     | Preserve 40- and 60-second observation ceilings respectively and real identity and close evidence. Pinned optional binaries cover Darwin arm64 and Linux x64.                              |
| [Child-process eval](../../packages/evals/src/runner/isolation/child-process-launcher.ts) and [harness server](../../packages/evals/src/runner/harness-server.ts)                                                                                                                                                                     | The eval launcher starts DorkOS Node, which can own an OpenCode sidecar. Test mode uses a fake runtime. The explicit OpenCode eval path requires `DORKOS_EVALS_PAID_PROVIDER=1` and `OPENROUTER_API_KEY`. The lower-level launcher and explicit binary seam allow offline fixture proof.                                                    | 5,000 ms reap cap. The separate post-launch health deadline is 60,000 ms by default or the caller's override.                                                                              |
| [Docker launcher](../../packages/evals/src/runner/isolation/docker-launcher.ts), [proxy](../../packages/evals/src/runner/isolation/netns-proxy.ts) and [eval suite](../../packages/evals/src/runner/run-suite.ts)                                                                                                                     | The lower-level launcher owns a daemon container and the proxy starts separate exec streams. The public suite rejects the OpenCode/Docker combination ahead of daemon probing and credentials. The availability check requires a reachable daemon and a local image. The direct lower-level launch still uses ordinary image/auth behavior. | 10,000 ms per availability probe and 10,000 ms for cleanup with 5 seconds of stop grace inside. Existing create/start has no extra 10-second limit. Preserve the subsequent health window. |
| [Harness smoke](../../scripts/harness-smoke/run.ts) and [gate](../../scripts/harness-smoke/gate.ts)                                                                                                                                                                                                                                   | Project and user probes use the same synchronous OpenCode launch. OpenCode has no free model probe. The armed probe requires `DORKOS_HARNESS_SMOKE=1` and `OPENROUTER_API_KEY` before executable lookup.                                                                                                                                    | Maintain 45,000 ms free and 300,000 ms armed probe budgets, immediate stdin end and bounded output. Use an owned local process fixture for custody proof.                                  |

The SDK client constructor starts no process. The production singleton and the [computer guest systemd lifetime](../../apps/server/src/services/computers/guest/guest-recipe.ts) retain their separate ownership. [Dependency checks](../../apps/server/src/services/runtimes/opencode/providers/check-dependencies.ts) use bounded version and authorization probes. [Provisioning](../../apps/server/src/services/runtimes/opencode/providers/provision.ts) can start npm on version drift. Source shows an exit/error join but no timer for that npm path. The census did not run these operations.

### Downstream evidence still owed

- Exercise both root and direct server Vitest configurations with genuine run-main and worker lifelines. Installed fork and global setup source establishes a route. It does not establish exit behavior on a live host.
- Prove the source and emitted eval entry paths and smoke entry find the declared assets. The existing source-tsx eval invocation and smoke harness build are configuration evidence.
- Confirm actual Linux x64 and Darwin arm64 process and descendant cleanup under owner loss. The workflows and pinned packages identify candidate hosts.
- Prove the source-built Windows Job helper and the default provisioned `.cmd` path or equivalent executable resolution. Keep Windows x64 and arm64 and eligible Node 22 ia32 host rows explicit. Existing x64 product build and Windows TypeScript jobs establish provision routes. ARM64 execution, Node 22 ia32 helper coverage and eligible native caller proof are still owed.
- Prove authenticated exact-daemon continuity for eligible Unix, SSH, TLS and Windows named-pipe transports, including supported proxy and reopened cleanup behavior. Existing Docker source supports testing the selected transport and supplies no local daemon receipt.

Task 1.2 can proceed through the inert protocol boundary after coordinator release. Later host proof remains part of [the frozen specification](02-specification.md). DOR-4754 local-only evidence stays separate and any shared-file writes must be sequenced.

## Task 1.2 — Inert custody protocol completed

Worker `/root/decompose_2402` implemented the private Node subpath. The coordinator reviewed the spec, the package export, the declarations, the implementation and every caller under `REVIEW.md`. The port returns a child once its injected backend has registered cleanup and supplied a positive native spawn fact. A failed start preserves its structured outcome and cleanup result. Receipt serialization exposes only the outcome kind.

The protocol keeps main and scope lifelines independent. Each stdio lane admits 64 KiB frames and 256 KiB of outstanding data. A blocked writer keeps one additional frame before admission. An orderly close delivers accepted writes before EOF, and cleanup reports lost unread data. The coordinator reproduced two original ordering defects before the worker corrected them. The final package-local run passed all 14 tests with one worker and zero retries. The touched declarations and test passed scoped TypeScript checking. ESLint passed on the five implementation, declaration and test files, and Node resolved the private package export.

The tested backend is in memory. Native process identity, platform cleanup, authenticated transport and normal caller integration remain tasks 2.1 through 4.2. The isolated package run verifies this task's contract. The affected build and package suite remain part of the delivery gate.

## Task 2.4 — OpenCode manager and pinned spawn port completed

Worker `/root/decompose_2402` added the optional manager port and pinned helper. The coordinator traced the full diff and callers under `REVIEW.md`. The default manager still starts the child synchronously at its existing spawn boundary. The injected path shares the 15-second readiness deadline across acquisition and startup. It checks latched spawn and terminal facts and waits for owned cleanup. A shutdown with unconfirmed cleanup preserves the generated session plugin files and reports the failure without including backend details.

The pinned test helper checks the selected binary at PRE, matches the actual spawn identity and verifies POST at native close. It preserves the existing direct pinned API. The verification suite used offline ports and synthetic identities. It passed 65 cases, with the existing CI-only binary presence case skipped. The server package typecheck passed with the repository's 8 GiB heap setting. Scoped lint and formatting passed.

Task 3.1 owns the actual conformance and binary caller adoption after the platform and run-main prerequisites. Platform backends still owe native process and integrity evidence, including the existing three-second TERM grace within host cleanup confirmation.

## Task 2.3 — Broker and inbox foundation

Worker `/root/decompose_2402` added the generation-bound broker and POSIX inbox. The coordinator reviewed the code and ran the broker and real temporary-filesystem tests. A fresh busy or expired request receives a terminal reply without starting an endpoint. The broker also bounds each scan batch and confirms its own retirement or reports uncertainty.

The focused run passed 14 cases and skipped the Windows-only case on this host. Server typechecking passed. Task 2.3 remains in progress. It still needs the actual server Vitest setup, authenticated endpoint integration, root and direct-server close-delivery evidence, and Windows owner-private support.

### Server Vitest registration

The server project now provides an owner-private OpenCode custody inbox from the actual Vitest main. The root load wait and the server contract setup are preserved. Worker requests use authenticated metadata and install cancellation before returning a scope. Incomplete close joins report uncertainty. Failed setup registration retires the inbox before returning its error.

The coordinator reviewed the changed files and ran the root suite and direct server project. The root run passed 21 cases with one Windows-only skip. The dedicated direct-server case and both server typechecks passed. These runs exercised real Vitest metadata, local files and synthetic endpoints. Physical owner EOF, actual watch rerun, Windows ownership and platform backend composition remain open. Task 2.3 stays in progress.

### macOS custody lifecycle evidence

The coordinator exercised the actual Vitest main and worker with a synthetic guardian and authenticated local socket in a disposable worktree. Under both root and direct server configuration, worker scope closure arrived while the main writer stayed open. In both main-loss runs, the owned Vitest main exited, the guardian received main EOF while the worker was still alive, and both auxiliary processes subsequently terminated.

A real root watch rerun used the same run ID with a new generation and endpoint. The old inbox was gone. The new generation consumed a stale authenticated request without responding, then accepted a current request. Both Vitest test runs passed and the fixture source was restored. The first main-loss attempt reached the EOF observations and failed in the process-record parser. The reviewed successor resolved that observer failure. All receipts were archived, and the proof worktree was removed.

The proof covers custody close delivery on this macOS host. Task 2.3 remains in progress. The real platform endpoint and Windows owner-private evidence are still due.

### POSIX guardian and separate owner evidence

The private POSIX backend holds the main lifeline in the guardian's parent and uses a separate authenticated worker channel. The detached anchor owns the target group. Startup, output closure and cleanup carry separate observations.

All 13 focused tests passed, and the test-utils package typecheck and scoped lint passed. An arm64 macOS observer built from the checked-in source and passed artifact validation. A real owned Node fixture verified its live target, anchor and guardian, drained both output streams, and confirmed that all three exited and the socket directory was removed.

Two additional macOS runs held the main and worker in distinct processes. Closing the worker scope cleaned the target group while the main stayed live. Ending the owned main cleaned the target group while the worker stayed live. An unrelated owned Node process answered fresh challenges in both runs. The exact target, anchor and guardian were independently observed gone. The fixtures used no native agent runtime or model.

The rest of the POSIX lifecycle matrix, Linux and Windows proof, and native caller integration are still open.

### Explicit POSIX Vitest composition

The opt-in test setup connects the Vitest main and its workers to the POSIX backend. Each active generation owns its short socket directory. The main selects and validates the reviewed Darwin observer. The worker accepts its socket route from the authenticated reply.

If a guardian closes before scope authentication, the broker keeps the owned handle for cleanup and replaces its ready reply with a correlated refusal. The replacement checks the exact previously published bytes in the owned inbox. Cancellation and expiry still prevent late publication.

The four focused suites passed 28 cases, with the existing Windows-specific case skipped on macOS. Server and test-utils typechecks, scoped lint and the file-size check passed. The real root and direct Vitest integration runs, default live-caller wiring and Windows backend remain open.

### macOS Node proof through both Vitest entry points

The coordinator ran one real owned Node target through the root Vitest configuration and one through the direct server configuration in a disposable worktree. The proof replaced only the custody setup slot. Each run checked the separate main, worker, guardian, anchor and target identities. Both output streams reached EOF, the target closed with verified integrity, and the owned inbox and socket directory were removed. The coordinator retained the receipts and removed the clean proof worktree.

The follow-up used the default stock setup at `2e7819484ea435642c437024c636547adbb6911e`, with no setup overlay. The root and direct server entry points each passed their owned Node case. The worker independently observed the main, worker, guardian, anchor and target, and the wrapper matched the main to its own child handle. Both streams reached EOF, native close verified the executable and target bytes, and stock teardown removed the exact inbox and socket directory. The coordinator archived the receipts and removed the disposable worktree.

## Task 3.1 — Credits fixture uses authenticated custody

The server Vitest setup now provides the POSIX backend. Its guardian starts only after an authenticated claim. The six existing credits binary cases use the pinned executable with an owned worker scope. They retain their original platform gate and observation budget. Each case keeps its own folder and request observations. Teardown closes the loopback listeners and retains the fixture folder if native or scope cleanup is still pending or uncertain.

All 49 focused tests passed, with the two existing conditional cases skipped. They covered the real server-project metadata route and the pinned helper's startup, join and uncertainty classifications. Both server typechecks, scoped lint and formatting passed. The credits binary cases, the remaining server callers, and the Linux and Windows native proof are still open.

### Folder read canary

The four existing pinned cases now acquire authenticated custody and keep their original observation and case budgets. Each case retains its own folder and evidence. Both CLI output streams are bounded, and the fake model attributes its evidence to the exact issued tool call. A protected case requires an attributable denial. The readable control still requires the canary bytes. An uncertain or pending cleanup keeps the fixture folder.

Both server typechecks, scoped lint and formatting passed. The four binary cases still need a real run to confirm the pinned CLI's denial and tool-result shapes. The coordinator has not counted this source checkpoint as native verification.

### Explicit shutdown and pinned OpenCode replay

An authenticated POSIX shutdown now lets the output readers drain while the anchor stops within the original deadline. The worker waits for the native close observer before publishing a clean join. A broken worker connection still retires the output sockets immediately. The tests check output EOF, the native close result and group cleanup independently.

The 25 focused cases and the test-utils package typecheck, lint and formatting passed. The stock direct Vitest configuration passed all three real Node cases at the shutdown checkpoint. Explicit shutdown produced both final output lines, framed EOF, verified native close and clean group cleanup. Worker loss produced two lane errors. Holding the observer through the cleanup deadline produced framed EOF with unobserved native close and a cleanup-uncertain result. Each run independently observed five distinct process identities. The exact owned processes, inbox and sockets were gone after teardown. The coordinator archived the receipts before removing the proof worktree.

The isolated pinned OpenCode replay at the same checkpoint passed 9 of 11 cases, up from 4 of 11. All seven credits cases passed with loopback fixtures. The two remaining file cases, .env.ci and prod.env, lacked a denial attributable to their specific reads. The no-disclosure assertions in both cases passed. The remaining attribution evidence and platform and caller coverage keep this task open.

### Attributable native read denials

The pinned OpenCode 1.19.3 reports a rule-based refusal in its permission error for the specific read. The fixture now requires that exact message and its serialized read-denial rules in the tool response for the issued call. A protected read must still return no canary, and both output lanes must reach EOF. Unrelated messages, unissued or repeated reads, and generic errors do not establish refusal.

All 24 cases passed in the isolated replay. That includes all 11 subjects across the two pinned-binary suites and 13 matcher controls. Both previously failing protected paths now require the actual correlated refusal and pass. Both server typechecks, scoped lint and formatting passed. The coordinator archived the receipts and removed the owned replay directories. Linux, Windows and the remaining callers still need their own proof.

### Owning a pinned manager startup and shutdown

The package-grants fixture acquires one test-owned scope per manager startup. The manager's startup signal can cancel acquisition. After the child returns, the fixture keeps the owner until it observes native close, drains both streams and joins the scope. A failed or unresolved join retains the fixture folder.

All 58 focused tests passed. They covered manager startup, owned scope lifetime and the broker, including a pending scope close that outlives the manager's wait. Both server typechecks, scoped ESLint and formatting passed. The package-grants binary cases still need native verification.

### Pinned OpenCode cleanup on macOS

The pinned OpenCode 1.19.3 manager reached readiness and joined its sidecar during a normal stop, without running a model turn. A separate test observed the same readiness in a nested Vitest worker, then verified the owned group was gone after the nested Vitest parent exited. The cleanup record came from the guardian after it waited for the anchor. The test required the normal teardown and the worker fallback to remain unused.

The two native cases ran separately on macOS arm64. The default server checks passed 28 cases with two opt-in cases skipped. The collection checks found the outer test in the regular suite and the single worker fixture in the nested suite. Linux, Windows, the separate silent-worker condition and the remaining test, eval and smoke entry points are still open.
