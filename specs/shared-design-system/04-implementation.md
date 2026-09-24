# Implementation Summary: Shared UI foundations

**Created:** 2026-09-23
**Last Updated:** 2026-09-23
**Spec:** specs/shared-design-system/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 12 / 14

Foundations are implemented and independently reviewed. Public consumer migrations and the catalog are implemented; combined regression verification passed and independent branch review has converged; private preparation has passed local checks against the final candidate. Publication tasks 4.1 and 4.2 remain gated.

## Tasks Completed

### Session 1 - 2026-09-23

**Workers:** /root/decompose (decomposition and spec review), /root/foundations (package), /root/private_review (code review), /root (orchestration and private preparation).

- Task 1.1: public package and theme contract — worker: /root/foundations. Client palette bridge remains explicitly in task 2.1.
- Task 1.2: primitives and Notice — worker: /root/foundations.
- Task 1.3: behavior and independent packed consumer proof — worker: /root/foundations.

## Files Modified/Created

Specification, proposed ADR, canonical tasks, `packages/ui/`, root Vitest project registration and dependency lockfile.

## Known Issues

- Publication is not authorized; private adoption can be prepared and locally verified only.

## Implementation Notes

### Session 1

Reused the dedicated planning worktree on `codex/shared-design-system-ideation`, rebased its sole planning commit onto pinned base `92931cdda6c8823aaa4253efb652908f45383cb3`. Shared main and other worktrees are untouched. Private work uses a separate worktree and tracker issue; implementation details remain private.

Configured Claude worker names are unavailable in this harness, so delegated work uses explicit `gpt-6-sol`. The Task API is unavailable; canonical JSON plus this progress record remain authoritative. Execution batches: foundations 1.1 → 1.2 → 1.3; public forms/catalog/private preparation; playground split; proof/docs; independent review; gated release.

### Foundations evidence

Package build, typecheck and lint passed; six behavior tests and the 56-test Vitest project census passed. The independent installed consumer used React 19.3.0, Tailwind 4.3.3 and Vite 6.4.3, with one React installation. Its build/typecheck and browser-computed light/system/explicit themes, opposing theme islands, opacity and responsive sizes passed.

Final candidate archive SHA-256: `326f4816c717100e14f67062028d7778bbfe6fab079694fb32ae01c995910a21`. No publication occurred. The archive contains only the selected built modules, declarations, CSS and package metadata. `/root/decompose` passed spec compliance after token/theme fixes; `/root/private_review` then passed independent code quality.

### Community migration evidence

Task 2.2 completed — worker: /root. Admission uses shared Field/Input/Button/Notice while authentication, invitation, membership and recovery code remains local. Explicit and system themes also preserve the existing Community shell palette. Legacy element rules exclude migrated controls.

A built-browser test first failed on the original input, then all six flows passed after migration: phone/desktop light/dark, explicit theme overrides, Enter and pending state, one error alert, owner setup focus, invitation mode changes, social action, retry and successful membership confirmation. The Community build/typecheck and 103 unit tests passed; lint reported zero errors and 50 existing warnings. `/root/private_review` passed spec compliance, followed by `/root/community_quality` passing code quality. Database-backed Community tests were not needed for this presentation-only change; the browser proof mocks the actual page's network boundary.

### Independent consumer preparation

Tasks 2.5 and 3.2 completed — worker: /root. The independently released consumer installed the exact final archive and passed typecheck, production build, 516 tests in 50 files and four real mocked browser combinations (390px/1280px × light/dark). Its source-only candidate patch and detailed evidence stay in the private repository. Separate spec and quality reviews passed. This proves local preparation, not released adoption; no local-path dependency will be committed as a release dependency.

### Integration review and evidence format

The catalog split exposed stale client search expectations; the focused search suite proved the failure before repair. Client review also found that namespaced icon sizes need explicit bridges for both the user's mobile scale and the embedded host's fixed size. These are compatibility fixes within the extraction, not changes to the size policy.

The configured live-session evidence selector requests an annotated GIF, but its capture tool is unavailable in this harness. A real Playwright WebM and screenshot were captured for the Community phone sign-in flow instead; the recorded run passed. This is disclosed as an evidence-format substitution, not an annotated GIF. Private browser media remains private.

Active public overlap was checked against PR #2042 (destructive contrast) and PR #2040 (Community accessibility). Shared tokens carry the former's corrected red values. The latter changes the legacy Community muted text, links and mobile controls; the extraction retains that styling boundary. Neither external branch is rewritten or merged by this task.

### Catalog and documentation

Tasks 2.3 and 2.4 completed — worker: /root/decompose. The standalone catalog imports the production package, runs on an explicitly chosen port, and does not join the default development command. Generic pilot galleries moved out of the client; app-specific controls, feature simulations, registry and render guards remain. Spec and quality reviews passed after restoring the client-only surface swatch and updating search expectations.

Catalog unit tests: 6 passing; built-browser tests: 4 passing; complete client playground directory: 147 tests in 14 files passing. Browser coverage includes explicit/system themes, native and slotted controls, form submission, 390px layout at 200% text size, desktop sizing and reduced motion. Build, typecheck and lint passed.

Task 3.3 completed — worker: /root. The shared UI guide, design/styling references, contributor index, repository map and proposed ADR describe the implemented ownership boundary, import order, catalog commands and gated release procedure. The docs coverage map passes its generated-map check.

### Client and overlap reconciliation

Task 2.1 completed — worker: /root/foundations. The client facade and its existing leaf imports now re-export the package. Login preserves application authentication and password visibility; a shared Notice owns the error presentation. Explicit theme selection is applied before paint. The client mobile icon dial and embedded host icon size have dedicated bridges. Spec and quality reviews passed after fixing both bridges.

The worker's full client run exposed stale class/token assertions and one missing lint fixture under contention. The fixes passed focused reruns (92 tests in 10 files); the combined branch runs the full affected gate again. Client and plugin builds, typechecks and lint passed. Browser proof covered 390px login, Enter, pending state, password visibility, one associated error, explicit light/dark against opposing OS themes, no overflow, and a custom icon dial changing the rendered glyph from 20px to 24px. Embedded evidence remains built CSS only.

The overlap review found that the brighter shared dark red cannot land safely without its companion dimmed fills. The candidate therefore carries the source corrections from PR #2042 at `8662209a3bce4c9984113671fcda99afc55bd5c2`, including its application text/fill adjustments and embedded vault-theme pins. Its contrast guard was adapted to resolve package aliases, verify the bridge, and inspect namespaced package fills as well as application fills. The external branch is untouched. The adapted contrast guard passes 17 tests; the embedded stylesheet suite passes 12. The composer parity checks pass with the original PR's one-token baseline amendment. A separate source review found no remaining contrast reconciliation issue.

The combined public build gate passed all 18 tasks. The required full forced typecheck passed all 42 tasks; affected lint passed all 23 tasks with existing repository warnings and no errors. Root lint and script checks passed, including 615 script tests. CI Steward's ledger coverage check reports no uncovered pipeline change. Desktop and phone catalog screenshots were visually inspected, including a 390px form at 200% text size with no horizontal overflow.

### Landed parallel work

PRs #2040 and #2042 landed during the first combined regression run. The branch integrated pinned main `020c791cc1a429b55b75a4a307a314938375b130` to resolve four actual extraction conflicts. The resolved files retain the package-aware contrast guard, palette bridge, vault theme rules and icon-size bridge; the incoming Community behavior and accessibility changes remain intact. The interrupted pre-integration test run is not counted as a pass. The final gate runs against this combined tree.

The combined Community audit initially caught transient contrast failures while the browser switched color schemes. Shared controls animate color, so the audit now waits for running CSS transitions to settle before axe samples them. No axe rule or assertion is excluded. In the isolated combined-tree check, Community membership plus shared-control browser suites passed all 8 tests; the app-side membership suite passed all 4; catalog browser checks passed all 4; and focused client contrast, alert-dialog and plugin CSS checks passed all 30. The disposable local database used by those checks was removed.

Post-integration verification: the full client suite passed 15,969 tests in 1,269 files. Forced full typecheck passed 42 tasks with no cache hits, affected lint passed 23 tasks with existing warnings and no errors, Community's 112 unit tests passed, and primary-worktree browser reruns passed 6 Community checks plus 4 catalog checks. Changelog validity/coverage and CI Steward ledger coverage passed against the pinned integration base.

The complete affected test gate passed all 22 tasks. In addition to the client result above, it passed 1,162 CLI tests (2 intentional skips), 814 desktop tests and 90 plugin tests. The first CLI run stopped because the local SQLite binary targeted Node 22; rebuilding that dependency under Node 24 repaired the environment, and the rerun passed without a product-code change. Task 3.1 is complete; independent pushed-branch review (3.4) is next.

### Independent branch review

A fresh reviewer checked pushed head `b61f85215dbf80606fff03152be59f8a45e0a70a` against `REVIEW.md` and the frozen specification. It found one stale browser locator after the playground label became “Client Tokens.” The locator and comment were corrected; both real feedback capture browser tests then passed. The affected typecheck/lint gate passed 47 tasks and the affected test gate passed 23 tasks after that change. Re-review of pushed head `ee3b75e9c1caf5ca7ba6bfb05075f89f84b5702c` converged with no remaining findings. The reviewer verified the two-test browser receipt, passing gates, exact correction and pinned merge base. Task 3.4 is complete.

### Clean-build correction after CI

PR #2046 exposed a missing prerequisite in the Community Postgres/browser job: its explicit build list did not build the new UI package. The production and sealed acceptance Dockerfiles used the same boundary. Those paths now include the package build, and the production context includes its manifest and source. A clean production-image build reproduced the missing-package failure before correction, then passed; the sealed acceptance image also built successfully. CI Steward census, ledger validity and coverage passed, and the release workflow tests passed all 8 cases. No test, retry, deadline or required check was removed or relaxed.

Automated review found no important issues and three nits. Stale package module/token comments were corrected. Explicit and system Community dark palettes remain separate plain-CSS blocks because their activation differs; changing the theme mechanism is outside this extraction. Plugin instructions now use the dependency-aware Turbo build from the repository root.

The corrected comments changed only emitted comments and source-map positions in the package archive; syntax without comments, CSS and other packed files are unchanged. The new archive identity above passed independent install, typecheck/build, single-React resolution and four browser viewport/system combinations plus explicit/opposing themes. The private consumer repeated its typecheck/build, 516 tests and four browser flows against that exact archive.

The corrected sealed acceptance image passed its packaged Community/local-agent attachment test on an isolated Docker network. Both Communities completed the flow; the test-owned containers, volume and network were removed. This exercises the built distribution without publishing or deploying a service.

After the clean-build correction, the complete affected typecheck/lint gate passed all 47 tasks and the affected build/test gate passed all 23 tasks, including 15,969 client tests, 1,162 CLI tests (2 intentional skips), 814 desktop tests and 90 plugin tests. Independent review of the correction found no blocking issue.

### Merge-queue browser correction

The full queue suite found another obsolete gallery locator: the mobile touch-reach test still looked for the generic Small button that moved out of the client. It now measures the existing, unmodified `size="sm"` Button in the client Card example, through the client facade and emitted styles. The 390×844 touch viewport, hit-reach measurement and 44px assertion remain unchanged. The focused real-browser test passed, E2E typecheck/lint passed (existing warnings only), and independent review confirmed the correction preserves the original regression coverage. The package archive and production source are unchanged.
