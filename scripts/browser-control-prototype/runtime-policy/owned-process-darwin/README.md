# Darwin owned-process helper research

This experiment checks process ownership before testing it on real processes. It does not enable production recovery. The original helper compiled, but it has not run. The new guardian source has not compiled or run. No process identity or private signaling API has been called.

Frozen reviewed plan v2 SHA-256: `17f06f26a4a34d7988e0b5941de2e916eab938cf2ccf161a2a24e03210cfdd4a`. V1 remains unchanged in the parent's ignored Flow temporary directory. Published XNU pin: `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`; this is not a verified installed-kernel match.

## Released checks

```sh
node --test scripts/browser-control-prototype/runtime-policy/owned-process-darwin/__tests__/*.test.mjs
```

Tests use fake transports and injected clocks only. Mutation tests execute Node tests against private copied source, removing the post-reap fence, challenge binding and exact signal cap independently; these are portable regressions, not native process observations.

Historical preflight used existing `xcrun`/clang and SDK headers/stubs. New compilation and all native execution remain held. The preflight source compiles and links in a private temporary root, then removes the root. It never executes the result, loads a private signaling API, queries processes, or installs tools. Missing tools/build availability are UNVERIFIED with zero native subjects. SDK declarations/stub exports are distinguished from installed-runtime export/behavior observations, which remain UNVERIFIED even after a successful link.

## Developer reference: source and custody boundary

`Ownership` mints opaque certificates from acquired portable fixture records. Duplicate unreaped PIDs, unknown/changed lifetime identities, lost continuity and reaped certificates refuse transport access. A newly owned same-PID replacement has a distinct certificate; historical ownership cannot authorize it. Exec version is not treated as lifetime death.

`AckOracle` uses exclusive channel identity and fresh run/cohort/attempt/spawn-generation/PID/token-digest/challenge/counter bindings. Only a valid armed ACK followed by recorded API success and a matching next-counter ACK can certify delivery. Late, duplicate, extra/accessor-field, forged-binding and cross-fixture messages reject. The fixture binary is trusted; the oracle does not contain a compromised fixture.

`PortableExperiment` registers run cleanup before exposing acquisition, registers per-acquisition receipt/custody slots before invoking the injected transport, and closes partially acquired fixtures even after startup failure. All limits are frozen in `policy.mjs`. Startup, signal/observation and cleanup waits are bounded; failure stops new acquisition. Cooperative close remains attempted without depending on an observation succeeding. Portable receipt counts never become native counts or complete-inventory proof.

The C bridge keeps native direct-child custody opaque and unreaped, verifies direct-child waitability and matching private unique ID before its benign SIGUSR1 candidate call, and refuses imported PIDs/reaped handles. All native calls are compiled source only. It deliberately preserves stale token version for the future exec-refusal control. `research_construct` is a constructed-private selector, not a kernel-issued token or extra authority. The native fixture exposes explicit self-token query and strict bounded TSV arm/delivery records, exits on lifeline EOF and self-expires after 15 seconds. It is not a production descendant monitor.

The new guardian source is dormant. It has no execution release. Its private CLI is `runner-native.mjs`; importing it starts nothing. Task 4.3 remains OPEN.

Each guardian resolves its own installed symbols before fixture acquisition or identity queries. The runner records cleanup custody before starting that guardian. Private frames bind the cohort, cumulative budget and captured file identities. A changed file or directory refuses acquisition. These named-file checks do not prove atomic loaded-image identity against a hostile local writer.

The controlled parent can fork one child only. It transfers an exclusive channel and cannot fork again or reap that child. Both share the original expiry. The guardian checks two actual child-PID fills while the parent remains live and challenged. It also registers a public `NOTE_EXIT` event before parent death. This covers one controlled fork slot, not arbitrary descendants. Unknown fills, changed identities, lost channels or missing exit events retain uncertainty.

The native path stops at C2 because an independent observer is unavailable. A generic fixture EOF cannot prove observer coverage loss. C3 contains a dormant owned-parent death operation. C4–C6 refuse missing guardian-loss evidence. Injected tests exercise all six cohorts; they do not certify those native paths. The proposed extra-child variant and its numerical budget remain unreleased.

Receipts count validated reports and received attempt records. Missing or invalid reports leave lower bounds. Unknown cleanup never becomes `allGone`. Direct-child reaping, registered exit events and general descendant completeness remain separate claims. Native behavior, installed-kernel correspondence and production recovery remain UNVERIFIED.

## Pinned correspondence

- Public-header self query: [task_info.h261–263](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/mach/task_info.h#L261-L263), [task.c5788–5802](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/kern/task.c#L5788-L5802). Child self-query/transport is not a kernel-authenticated sender trailer.
- Private structure/flavor: [proc_info_private.h](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_info_private.h#L45-L55). The 56-byte correspondence declaration in `bridge.h` is explicitly private and source-attributed; the installed SDK lacks this private header.
- PID-version/caller-permission signal path: [proc_info.c3531–3720](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c#L3531-L3720), [private-interface warning and declarations](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/libsyscall/wrappers/libproc/libproc.h).
- Unique lifetime ID versus exec version: [fork](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_fork.c#L977-L983), [exec](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_exec.c#L7102-L7105).
- Recursive tracking unavailable: [event.h362–369](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/event.h#L362-L369). Historical snapshots cannot establish crash completeness.

Initial zero-subject development preflight compiled both objects but failed linking because the link command omitted the explicit SDK (`ld: library 'proc' not found`). Its private build root was removed. The corrected command carries `-isysroot` through compile and link. This correction is covered by a portable preflight regression; successful linking does not replace the retained failure or establish private runtime behavior.

The permitted offline frozen dependency setup completed without downloads or tracked dependency-file changes. It warned that this Node22.22.2 is below two packages' declared22.22.3 minimum and that the Prisma build script was ignored. No approval/build installation was performed for that warning.

The c9 review retained two original failing cleanup probes: a late acquisition escaped finalized cleanup, and a concurrent cleanup caller returned before the first cleanup finished. The corrected portable transport retires and aborts pending acquisition, drains it within the remaining cleanup budget, and requests cooperative close even for a fixture reported after that budget expires. A late fixture never receives an ownership certificate; the original uncertainty remains in the finalized receipt. Every cleanup caller shares one in-progress promise. Unavailable close remains UNVERIFIED. These fake-transport results establish neither native cleanup nor descendant completeness.

Mutation children explicitly request TAP under Node22 and Node24. Setting `DORKOS_DARWIN_PORTABLE_EVIDENCE_DIR` during portable tests retains their raw stdout, stderr and exit-status records in the chosen private evidence directory. Historical c9 Node22 results and the original Node24 reporter failures remain separate from corrected-source verification.
