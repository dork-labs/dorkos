# Shared UI: broader primitive adoption and maintenance — tasks

Canonical source: `03-tasks.json` • Generated 2026-09-24T13:11:00Z • 19 / 23 tasks complete

## Phase 1: Portable contract and baseline

### Task 1.1: Inventory the maintained primitives and capture baseline behavior

- Status: completed; size: medium; priority: high
- Depends on: none
- Parallel with: none

Before ownership changes, inventory the actual maintained client implementations, exports, types, variant helpers, Radix versions, current dependencies and CSS utilities for the 18 selected modules: textarea, checkbox, radio-group, switch, slider, tabs, collapsible, progress, scroll-area, dialog, alert-dialog, sheet, popover, hover-card, tooltip, select, dropdown-menu and context-menu. Map each selected leaf and FSD barrel consumer, app-specific wrapper that remains local, portal wrapper, package export, and existing test. Run the relevant existing primitive and consumer tests as a baseline; record exact commands/results and known failures in 04-implementation.md when that file is created. Resolve versions from the lockfile rather than upgrading dependencies. Identify concurrent Community form changes without rewriting them. Acceptance: a concrete ownership/export/CSS checklist covers all 18 modules and all original exports; baseline results exist before source replacement; deliberate app-local modules including Card, Skeleton, Badge, form engines, routing and responsive wrappers are identified; no private implementation is copied into public files.

### Task 1.2: Establish package styles, dependencies and release metadata

- Status: completed; size: large; priority: high
- Depends on: 1.1
- Parallel with: 1.3

Own the shared package metadata, lockfile and styles contract for this extraction. Prepare additive @dork-labs/ui 0.2.0 metadata without removing or changing any 0.1.0 export; keep React/ReactDOM external peers. Declare only publishable public runtime dependencies at lockfile-resolved versions, including the existing Radix packages, lucide-react, tailwind-variants and tw-animate-css needed by selected primitives. In packages/ui/tailwind.css and tokens.css, provide namespaced dui-* semantic utilities and package dark variant, explicit border color, scoped required animations and reduced-motion behavior, plus standalone defaults for every icon-size variable and a client host-font-scale bridge. Preserve existing literal colors only where deliberately used. Keep explicit Tailwind 4 scanning of installed emitted JavaScript, CSS side-effect metadata, source maps without sourcesContent and a strict packed-file allowlist. Do not add global resets, fonts, editor layers, stores, universal selectors or app/private imports. Coordinate later additions to root/subpath exports through task 3.6; this task is sole early writer of package.json, lockfile and package CSS. Acceptance: package build/typecheck/lint passes, existing 0.1.0 exports still resolve, inspected emitted CSS supplies all inventoried utilities, and package metadata has no unresolved workspace/private dependency.

### Task 1.3: Implement the optional portal-container provider

- Status: completed; size: medium; priority: high
- Depends on: 1.1
- Parallel with: 1.2

Add UiProvider to packages/ui as context-only configuration with optional portalContainer: HTMLElement | null. Undefined or null retains each Radix primitive's existing document-body default; an explicit existing Portal container prop takes precedence. Scope configuration per React subtree, allow nested providers to override parents, and avoid markup, theme store, browser-global mutation or app imports. Provide a package-local hook/adapter for selected portal wrappers to consume; do not pass provider-only props to DOM. The caller owns a stable mounted host and its lifetime. Add focused tests for absent provider, explicit null, sibling providers with different containers, nested override and explicit prop precedence, checking actual portal DOM ownership without cross-talk. This task owns provider source/tests; task 3.6 owns public export-map registration. Acceptance: standalone provider tests pass, body defaults remain unchanged, and a light/dark mounted host can supply inherited theme values to descendant portal DOM.

## Phase 2: Controls slice A

### Task 2.1: Extract textarea, checkbox and radio-group

- Status: completed; size: large; priority: high
- Depends on: 1.2
- Parallel with: 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5

Move the maintained textarea, checkbox and radio-group source into packages/ui/src using package-local cn and public Radix dependencies. Preserve every component/type/variant export, props, refs, events, data-slot attributes, disabled state, label/form associations, dimensions and existing useful comments. Convert semantic colors and dark states to dui-*; make borders explicit and retain deliberate literals. Replace client leaf implementations with explicit package re-exports so existing FSD consumers and local application wrappers remain intact; delete duplicate selected source in the same slice. Own only these component files, client leaves and focused tests, not package.json, lockfile, package root index or export map. Acceptance: focused package tests prove checkbox/radio checked change, disabled and label/form behavior plus ref/event forwarding; focused source tests pass; integrated client consumer tests/typecheck are gated by export registration in task 3.6; no app/private import enters package source.

### Task 2.2: Extract switch and slider

- Status: completed; size: large; priority: high
- Depends on: 1.2
- Parallel with: 2.1, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5

Move the maintained Switch and Slider source into packages/ui/src and convert semantic styling to dui-* without changing their controlled/uncontrolled semantics. Preserve Switch's tailwind-variants implementation and coupled track/thumb size tables, Slider thumb count, keyboard values, refs, disabled state, event callbacks, data-slot attributes and responsive target sizes. Use package-local cn and public Radix; keep app wrappers local. Replace only their client leaves with explicit re-exports; retain type/variant helper exports and remove duplicate implementations. Own component files, leaves and focused tests only. Acceptance: behavior tests exercise controlled/uncontrolled Switch, each track/thumb size pair, multiple Slider thumbs and keyboard changes; refs/events and current client consumers are checked after task 3.6 registers exports; reduced-motion and built-in icon-size defaults are supplied by package styles without client globals.

### Task 2.3: Extract tabs and collapsible

- Status: completed; size: large; priority: high
- Depends on: 1.2
- Parallel with: 2.1, 2.2, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5

Move maintained Tabs and Collapsible source into packages/ui/src with package-local cn, public Radix and dui-* semantics. Preserve all exports, types, data slots, refs, disabled behavior, activation mode, keyboard traversal, controlled/uncontrolled state and custom dimensions. Keep animation class behavior and reduced-motion treatment supplied by package-owned styles, including measured collapsible height transitions. Replace their client leaves with explicit re-exports and remove duplicate implementations, leaving app-specific wrappers local. Own component files, leaves and focused tests only. Acceptance: tests prove tab keyboard/automatic-or-manual activation as currently implemented, collapse open/close, refs and events; source-focused checks pass, with integrated package/client checks following task 3.6; a later installed-browser check can measure the collapsible height animation without client CSS.

### Task 2.4: Extract progress and scroll-area

- Status: completed; size: large; priority: high
- Depends on: 1.2
- Parallel with: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5

Move maintained Progress and ScrollArea source into packages/ui/src using package-local cn, public Radix and dui-* colors. Preserve all component/type exports, progress value semantics, ScrollArea viewport and scrollbar refs, orientation, data slots, sizing, keyboard and scroll behavior. Replace only client leaves with explicit re-exports while keeping app-specific responsive wrappers and consumers unchanged; remove duplicate selected implementations. Own component files, leaves and focused tests only. Acceptance: tests prove progress state/accessible value and ScrollArea viewport ref plus actual scrolling; existing client feature tests/typecheck run after task 3.6 registers exports; no global client CSS is required for package border or semantic colors.

## Phase 3: Overlays and menus slices B/C

### Task 3.1: Extract dialog and alert-dialog

- Status: completed; size: large; priority: high
- Depends on: 1.2, 1.3
- Parallel with: 2.1, 2.2, 2.3, 2.4, 3.2, 3.3, 3.4, 3.5

Move maintained Dialog and AlertDialog modules into packages/ui/src with public Radix, package-local cn and namespaced styles. Preserve custom close buttons, refs, prop spread, data slots, responsive sizing, phone gutters/scrolling, accessibility and escape/focus restoration. Every exported portal wrapper consumes UiProvider: omitted/null container retains document body, nested providers scope per subtree and an explicit Portal container prop wins. Retain caller-owned dangerous-action semantics; do not add app behavior or store. Replace client leaf implementations with explicit re-exports and remove duplicates. Own component files, leaves and focused tests only. Acceptance: tests prove open/close, escape, focus trap/restoration, custom close, explicit container precedence, disabled/ref/event behavior; client dialog consumers and phone layout are verified after task 3.6 registers exports.

### Task 3.2: Extract sheet

- Status: completed; size: large; priority: high
- Depends on: 1.2, 1.3, 3.1
- Parallel with: 3.3, 3.4, 3.5

Move the maintained Sheet module into packages/ui/src, preserving its Dialog-based behavior, exports/types, close affordance, responsive widths, phone gutters/scrolling, refs, data slots and animations. Use package-local cn, public Radix/lucide icons and dui-* semantics; consume UiProvider for exported SheetPortal with body default and explicit container precedence. Replace the client leaf with explicit package re-exports, keep application responsive wrappers local and remove duplicate selected implementation. Own Sheet source/leaf/focused tests only. Acceptance: component tests cover open/escape/close/focus restoration, container precedence and reduced-motion behavior; existing client sheet consumers are verified at desktop and 390px without overflow after task 3.6.

### Task 3.3: Extract popover, hover-card and tooltip

- Status: completed; size: large; priority: high
- Depends on: 1.2, 1.3
- Parallel with: 2.1, 2.2, 2.3, 2.4, 3.1, 3.4, 3.5

Move maintained Popover, HoverCard and Tooltip into packages/ui/src using public Radix, package-local cn, public lucide icons where built in and dui-* styling. Preserve all component/type exports, existing hover delays, trigger/content event behavior, refs, accessibility, data slots and sizing. Route each exported portal wrapper through UiProvider while retaining body default and explicit Portal container precedence. Replace only their client leaves with explicit re-exports and remove selected duplicates; app feature wrappers stay local. Own these source/leaf files and focused tests only. Acceptance: tests prove hover delay, keyboard/focus/dismissal, nested popover behavior and provider/explicit container ownership; existing client consumers are verified after task 3.6 without a theme or portal regression.

### Task 3.4: Extract select

- Status: completed; size: large; priority: high
- Depends on: 1.2, 1.3
- Parallel with: 2.1, 2.2, 2.3, 2.4, 3.1, 3.3, 3.5

Move maintained Select into packages/ui/src using public Radix, package-local cn, public lucide icons and dui-* styles. Preserve controlled/uncontrolled values, item selection, keyboard flow, disabled behavior, all refs/events/data slots, size variants, built-in affordance icons and existing client sizing. Route every exported SelectPortal through UiProvider with body default and explicit container precedence; keep native selects intentionally used elsewhere. Replace client leaf with explicit re-exports and remove its duplicate implementation. Own Select source/leaf/focused tests only. Acceptance: package tests prove controlled value changes, keyboard selection, refs and container precedence; current client Select consumers are verified after task 3.6 to typecheck and behave identically; no native select is silently converted.

### Task 3.5: Extract dropdown-menu and context-menu

- Status: completed; size: large; priority: high
- Depends on: 1.2, 1.3
- Parallel with: 2.1, 2.2, 2.3, 2.4, 3.1, 3.3, 3.4

Move maintained DropdownMenu and ContextMenu into packages/ui/src with public Radix, package-local cn, public lucide icons and dui-* styles. Preserve item selection, checkbox/radio/submenu behavior, disabled states, refs/events/data slots, animation, responsive sizing and immediate close/reopen semantics. Route all exported root and nested submenu Portal wrappers through UiProvider; explicit Portal container props win and no provider keeps body behavior. Replace client leaves with explicit re-exports and remove duplicate selected implementations. Own these source/leaf files and focused tests only. Acceptance: tests prove submenu keyboard flow, selection and immediate dismissal/reopen, focus restoration, sibling/nested provider container routing, refs/disabled events; client menu consumers are checked after task 3.6.

### Task 3.6: Consolidate public exports and client facades

- Status: completed; size: large; priority: high
- Depends on: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5
- Parallel with: none

After all selected module files land, own the sole integration edit to packages/ui/src/index.ts, packages/ui/package.json exports/dependency metadata, lockfile and client FSD barrels. Register UiProvider and every selected module at root and matching subpaths with emitted ESM JavaScript and declarations; retain every 0.1.0 export and every former client type/variant helper through explicit leaf re-exports. Resolve any extraction conflicts without deleting maintained behavior. Audit actual package imports for app/private/internal-only dependencies, circular imports and unresolved icon/animation utilities. Keep React/ReactDOM external peers, CSS side effects, strict packed allowlist and 0.2.0 additive candidate. Acceptance: package build/typecheck/lint and targeted tests pass, client facades typecheck, all 18 modules have one source owner, all root/subpath declarations resolve and no selected duplicate implementation remains.

## Phase 4: Catalog and verification

### Task 4.1: Expand the standalone catalog and migrate generic showcases

- Status: completed; size: large; priority: high
- Depends on: 3.6
- Parallel with: 5.1

Add navigable, mounted production examples for all 18 selected exported module families in apps/design-system using @dork-labs/ui exports and package CSS only. Include interactive selection, validation, open/close, nested popover/menu/dialog, scroll, progress, long labels, light/dark/system and explicit theme override, document-body portals and two independent themed islands with stable provider containers. Move generic selected primitive showcases from client/src/dev to the catalog as ownership moves; retain unrelated feature simulations, app providers and nonselected generic galleries in the client playground. Update both destinations' registry/navigation/coverage/no-replica guards and configurable links; a broken mount must fail tests. Keep catalog independent of server, auth, router singleton, transport and app store, and runnable on a caller-chosen strict port without joining root dev. Acceptance: catalog build/typecheck/lint/tests pass, every family mounts, feature demos still work, no replica or swallowed render error exists, and browser navigation reaches each example.

### Task 4.2: Run combined public regression and browser accessibility proof

- Status: completed; size: large; priority: high
- Depends on: 4.1
- Parallel with: 4.3

Run package build/typecheck/lint/tests, catalog build/typecheck/lint/tests, the full client suite, affected Community tests/browser proof, and embedded build/typecheck after the integrated facades/catalog land. Do not overwrite concurrent Community form work or force Radix onto intentional native controls. Use built real-browser tests at 390px and desktop for light/dark/system/explicit override, keyboard traversal, Escape/focus restoration, immediate menu reopen, two portal theme islands, nested overlays, long labels and 200% text, reduced motion, computed CSS/animation and no page errors/overflow. Assert actual focus and computed styles rather than class strings; inspect failures and fix underlying behavior without weakening assertions. Record commands/results and any justified exclusions in 04-implementation.md. Acceptance: all scoped public gates pass, baseline consumer behavior is preserved and browser proof covers portal inheritance and motion from installed or built assets.

### Task 4.3: Prove the exact packed candidate in an independent consumer

- Status: completed; size: large; priority: high
- Depends on: 4.1
- Parallel with: 4.2

Build and pack the exact @dork-labs/ui 0.2.0 candidate, then install that archive in a throwaway React 19/Tailwind 4 consumer outside the monorepo with no workspace/source aliases. Verify every documented root/subpath ESM/declaration/CSS export, one external React instance, Tailwind class discovery from installed emitted JS, light/dark/system/explicit themes, provider portal islands, built animation utilities including collapsible height, immediate dropdown dismissal and reduced-motion behavior. Inspect archive file list, size and integrity, source maps, CSS side effects and dependency graph for public allowlist, zero private/app files or credentials and no unresolved workspace dependency. Repack and repeat after any archive-affecting change; retain archive identity/versions/results as release evidence. Acceptance: independent build/typecheck/browser checks pass from the exact recorded archive and every package export is installable without repo source.

### Task 4.4: Verify candidate compatibility in an isolated private consumer

- Status: completed; size: large; priority: high
- Depends on: 4.3
- Parallel with: 4.2

In a separate private worktree, install the exact recorded public 0.2.0 candidate archive and verify existing adopted shared controls remain compatible with the private consumer's ordinary build, typecheck, tests and browser proof. Confirm one React peer and the intended CSS import/theme boundary without introducing source aliases or copying private code into the public repo. This is candidate compatibility only; do not claim published-registry adoption yet. Preserve the private worktree and report public evidence only at contract level (archive identity and pass/fail category), with no private paths, code, business details or tracker identifiers in public artifacts. Acceptance: private candidate checks pass or actionable compatibility findings are fixed in the owning code and the exact archive is retested; public evidence contains no private implementation details.

## Phase 5: Maintenance and release

### Task 5.1: Document ownership, theming, upgrade and portal contracts

- Status: completed; size: medium; priority: high
- Depends on: 3.6
- Parallel with: 4.1

Update packages/ui/README.md, contributing/shared-ui.md, design-system.md and styling-theming.md where the ownership and contract actually changed. Document all 18 migrated modules versus deliberate app-local modules, root/subpath exports, CSS import order/Tailwind source and animation requirements, supported React/Tailwind versions, reduced-motion behavior, 0.1-to-0.2 upgrade guidance, standalone catalog commands and release checklist. Explain UiProvider portalContainer as optional, body default, per-subtree nested override, explicit Portal container precedence, caller-owned stable themed host and clipping implications. Add a draft ADR for caller-owned portal containers and explicit primitive ownership, consistent with the existing package/CSS ADR. Maintain 04-implementation.md with public proof and canonical 03-tasks.json statuses as work completes; do not rewrite frozen historical specifications or include private details. Acceptance: examples compile against public exports, docs match tested behavior and version state, and public text makes no unverified runtime claim.

### Task 5.2: Converge independent compliance and quality reviews

- Status: completed; size: large; priority: high
- Depends on: 4.2, 4.3, 4.4, 5.1
- Parallel with: none

After public regression, exact packed proof, private candidate compatibility and documentation are complete, obtain separate independent reviews: first check every 02-specification.md requirement and excluded scope against the actual public diff; then review correctness, accessibility, performance, dependency/security and regression quality. Provide reviewers the stable diff, exact archive identity and test receipts. Fix findings in owning files, rerun affected gates and re-pack/retest the independent consumer after any archive change; repeat review until converged. Keep private source/details out of public review artifacts. Acceptance: two independent reviews report PASS on the final stable diff, required gates remain green and 04-implementation.md records evidence without claiming a registry release before publication.

### Task 5.3: Deliver the public implementation through PR and CI

- Status: pending; size: large; priority: high
- Depends on: 5.2
- Parallel with: none

From the reviewed public worktree branch, open the normal pull request with a concrete 0.2.0 additive-package and catalog summary, exact verification evidence and appropriate labels. Attach the PR to the task, resolve review comments and merge-queue conflicts while retaining incoming work, run required checks and follow the PR through CI and merge. Do not mutate main directly or overwrite concurrent Community changes. If a queue/rebase changes archive contents, repeat packed proof and independent review for the changed artifact before release. Acceptance: public implementation and documentation PR is merged at a known commit with required checks green and no unresolved review findings; the release source is that reviewed merged state.

### Task 5.4: Publish and verify the exact 0.2.0 registry release

- Status: pending; size: large; priority: high
- Depends on: 5.3
- Parallel with: none

Follow the package owner's release procedure for @dork-labs/ui 0.2.0 from the reviewed, merged public source. Check the actual package metadata, file allowlist, license/repository fields, changelog/docs and npm access/version availability before the outward publication step; use the operator's standing continuation authorization subject to the owner procedure. Publish once with the exact version, record registry integrity and tarball SHA256, then install the registry artifact in the independent outside-workspace consumer and rerun exports/declarations/CSS/theme/portal/animation/one-React proof. Do not substitute a local tarball or fake registry version for published adoption. Acceptance: registry 0.2.0 exists, its bytes/integrity and selected contents match the release evidence, independent install/build/typecheck/browser checks pass and public docs accurately say released.

### Task 5.5: Upgrade and deliver the independent private consumer

- Status: pending; size: large; priority: high
- Depends on: 5.4
- Parallel with: none

In the isolated private worktree, pin the real published @dork-labs/ui 0.2.0 registry version and lockfile integrity, replacing the candidate archive reference. Preserve adopted shared controls, CSS/theme boundaries and one React peer. Run ordinary private build, typecheck, full relevant tests and browser checks; obtain independent compliance and quality review of the final private diff, fix findings and deliver through its normal PR/CI/merge process after the public contract is available. Do not expose private source, paths, business details or tracker IDs in public artifacts. Acceptance: private consumer installs exactly the published package, no local archive/source alias remains, verification and reviews pass, and the private upgrade PR is merged.

### Task 5.6: Close the evidence and task ledger against delivered results

- Status: pending; size: medium; priority: high
- Depends on: 5.5
- Parallel with: none

After both public release and private delivery, update canonical 03-tasks.json statuses and 03-tasks.md mirror, 04-implementation.md and public completion documentation to reflect only achieved work. Record public PR/merge and registry artifact identity, completed test/review receipts, supported boundaries and any honest residual limitation; include private adoption only as a contract-level fact with no private URLs, paths, code, business details or tracker IDs. Project completion into the work item through the Flow tracker adapter, following its closing procedure; tracker state remains a projection of filesystem evidence. If public documentation needs a follow-up PR, run its required checks and merge it. Acceptance: all tasks marked completed only after their gates, public record is current and privacy-safe, package release and both delivery paths are verifiable, and DOR-2315 is closed with durable evidence.
