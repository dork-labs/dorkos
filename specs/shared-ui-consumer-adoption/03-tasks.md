# Tasks — Complete shared UI consumer adoption

Source: `02-specification.md`. The JSON file is canonical; this document is its readable projection.

## Phase 1: Inventory and foundations

### Task 1.1: [shared-ui-consumer-adoption] [P1] Inventory public controls and record failure baseline

**Size:** medium · **Priority:** high · **Depends on:** none · **Parallel with:** none

Inspect every browser component under apps/community/src/browser, the live interactive forms under apps/site/src, package primitives under packages/ui/src, and the catalog under apps/design-system. Record each generic Button, Input, Textarea, Label/Field, Notice, and Separator candidate; for each retained local control record its native, domain, framework, or presentation reason. Distinguish live site call sites from dormant wrappers and inspect client Card, Badge, and Skeleton for compatible second-consumer contracts without extracting them by name alone. Preserve the current Chromium failure evidence for a class-only opposing-theme portal host, including computed dark background and inherited dark foreground. Note import/takedown work touching Community files before editing so incoming controls survive integration.

Acceptance: a public, reviewable inventory or receipt exists without private consumer details; candidate/exception lists cover Community and site; baseline includes the failing foreground/background values and reproduction; Card/Badge/Skeleton ownership is explicit.

### Task 1.2: [shared-ui-consumer-adoption] [P1] Pair foreground with owning backgrounds in shared primitives

**Size:** medium · **Priority:** high · **Depends on:** 1.1 · **Parallel with:** 2.1, 2.5

In packages/ui/src/dialog.tsx, alert-dialog.tsx, sheet.tsx, and button.tsx, add text-dui-foreground to modal surfaces that own bg-dui-background and to the outline Button variant. Use the package border token for the outline border. Audit other package background utilities; leave already paired popover, menu, tooltip, tabs, decorative tracks, and transparent native fields alone unless a real mismatch is found. Preserve caller className overrides and the existing Radix/portal behavior. Add focused component assertions where the owning class contract can regress.

Acceptance: Dialog, AlertDialog, Sheet, and outline Button own both background and foreground; caller classes can still override; package component tests, typecheck, lint, and build pass; no public API or dependency change.

### Task 1.3: [shared-ui-consumer-adoption] [P1] Extend catalog and prove opposing-theme portal behavior

**Size:** large · **Priority:** high · **Depends on:** 1.2 · **Parallel with:** 2.1, 2.5

Add AlertDialog and Sheet examples to apps/design-system beside the existing Dialog examples. Extend its real-browser regression to remove only the island text utility, then exercise dark-class host in light document and light-class host in dark document. Assert computed foreground and background for Dialog, AlertDialog, Sheet and outline Button, actual portal location, Escape/cancel behavior, focus return, and no overflow at 390px and desktop. Keep the nested menu/dialog cases, existing registry ownership, reduced-motion coverage, and keyboard interactions working.

Acceptance: new examples are visible; class-only hosts reproduce the former failure before the primitive fix and pass after it; catalog component and browser suites pass in light, dark and system preference; no unrelated page styling masks the assertion.

## Phase 2: Consumer adoption

### Task 2.1: [shared-ui-consumer-adoption] [P2] Adopt shared account and recovery controls in Community

**Size:** large · **Priority:** high · **Depends on:** 1.1 · **Parallel with:** 2.2, 2.3, 2.5

Migrate equivalent generic controls in apps/community/src/browser/components/OwnerClaim.tsx, SignInMethods.tsx, SignOut.tsx, Pairing.tsx, AdmissionPanels.tsx and recovery/account components found in the inventory to @dork-labs/ui Button, Input, FieldLabel/Label, Notice, Textarea or Separator as appropriate. Preserve IDs, htmlFor, aria-describedby, error roles, required fields, disabled and pending states, validation, requests, navigation and focus. Give form submit buttons explicit type="submit" and all other buttons explicit type="button". Compose real navigation anchors through asChild only when they are styled actions. Reconcile current import/takedown changes before integration; do not remove new controls.

Acceptance: covered account/recovery/admission generic controls use package primitives; owner claim, sign-in, pairing and recovery tests preserve the same outcomes; no authorization, request or route behavior changes.

### Task 2.2: [shared-ui-consumer-adoption] [P2] Adopt shared host and administration controls in Community

**Size:** large · **Priority:** high · **Depends on:** 1.1 · **Parallel with:** 2.1, 2.3, 2.5

Migrate equivalent generic buttons, text/email/password/number inputs, labels, notices and decorative separators in apps/community/src/browser/components/Manage.tsx, HostAdministration.tsx, HostHoldControls.tsx, HostApiKeys.tsx, HostCommunityLimits.tsx, HostShortNames.tsx, ExportPanel.tsx, Erasure.tsx and related administration components found in the inventory. Keep FocusDialog, dangerous-action confirmation, authorization, form/name/value/ref/event semantics, focusable unavailable choices and native select/date/file/radio/checkbox behavior. Preserve app-owned layout and states; use shared controls inside compositions without replacing their domain behavior. Reconcile active import/takedown changes before integration.

Acceptance: migrated controls preserve host settings, membership, erasure/removal and confirmation behavior; unavailable options remain keyboard reachable as designed; existing administration tests pass; no incoming feature control is lost.

### Task 2.3: [shared-ui-consumer-adoption] [P2] Adopt shared channel and shell actions in Community

**Size:** large · **Priority:** high · **Depends on:** 1.1 · **Parallel with:** 2.1, 2.2, 2.5

Migrate generic action buttons, notices, inputs and decorative separators in apps/community/src/browser/CommunityApp.tsx and channel/shell components including Channel.tsx, EntryCard.tsx, CommunityChooser.tsx, CommunityAddress.tsx and HostLinks.tsx. Keep navigation items, message content, sidebar/thread geometry, upload label/file input and bespoke composer textareas with their keyboard/resize behavior local. Use asChild for styled anchors when appropriate, and preserve onClick, disabled, aria-disabled, focus and explicit button types. Reconcile active import/takedown changes before integration.

Acceptance: generic controls use package exports without changing channel navigation, posting, upload or thread behavior; app-owned controls remain documented; no nested interactive element is introduced.

### Task 2.4: [shared-ui-consumer-adoption] [P2] Remove obsolete Community generic CSS after adoption

**Size:** medium · **Priority:** high · **Depends on:** 2.1, 2.2, 2.3 · **Parallel with:** 2.6

After Community component migrations, audit apps/community/src/browser/styles.css and each remaining .button, .field, .notice and separator selector/use. Delete rules with no users; narrow retained rules to documented app-owned native or domain controls so unlayered legacy styles cannot override package primitives. Confirm the Community Tailwind entry and @dork-labs/ui token/utilities import generate the needed classes and do not create duplicate React or visual regressions. Retain responsive shell and composer geometry.

Acceptance: every remaining legacy selector has a concrete owner/use; no stale generic class overrides shared controls; generated Community CSS includes adopted utilities; 390px and desktop layout remains usable.

### Task 2.5: [shared-ui-consumer-adoption] [P2] Inventory live site forms and CSS ownership

**Size:** medium · **Priority:** high · **Depends on:** 1.1 · **Parallel with:** 2.1, 2.2, 2.3

Inspect actual live site form routes and components, including account sign-in/sign-up/reset/profile, newsletter, feedback and managed account fields. Map shared Button/Input/Textarea/Label opportunities against existing site facades and local shadcn wrappers; identify dormant wrappers separately. Check CSS token import, Tailwind source scanning, Next server/client boundaries and the site's FSD barrel rule before deciding which imports to change. Keep Fumadocs controls, marketplace whole-card/filter links, branded CTA composition and intentional marketing density/layout local.

Acceptance: inventory names live candidates, dormant wrappers and explicit exceptions; target import/CSS strategy is written down; no speculative whole-site migration is proposed.

### Task 2.6: [shared-ui-consumer-adoption] [P2] Adopt shared foundations in compatible live site forms

**Size:** large · **Priority:** medium · **Depends on:** 2.5 · **Parallel with:** 2.4

Migrate equivalent generic Button, Input, Textarea and Label usage in live site forms identified by task 2.5, using @dork-labs/ui subpath exports through valid site-layer boundaries. Add the workspace dependency and CSS/source imports needed for generated styles. Preserve client/server component boundaries, label and error associations, pending/disabled state, submit types, validation, routes and request behavior. Avoid replacing Fumadocs widgets, marketplace link cards, branded CTAs or layout-specific controls. Remove a local wrapper only after proving it has no remaining live use.

Acceptance: selected live forms render package primitives with generated styles; existing functional tests pass; purposeful site presentation is unchanged; no dead wrapper or unused dependency remains.

## Phase 3: Verification and documentation

### Task 3.1: [shared-ui-consumer-adoption] [P3] Prove Community workflows and accessibility after adoption

**Size:** large · **Priority:** high · **Depends on:** 2.4 · **Parallel with:** 3.2, 3.3, 3.4

Add focused browser assertions for migrated Community controls: labels/errors and pending/submit behavior, owner claim, pairing, account controls, switching, host administration, erasure/removal and membership accessibility. Exercise keyboard/focus, focusable unavailable choices, dangerous-action cancel/confirm, light/dark/system, reduced motion and 390px/desktop overflow. Use existing browser fixtures and keep request/permission assertions. Run the Community component, browser, typecheck, lint and build gates; investigate failures before changing expectations.

Acceptance: tests identify shared controls in real workflows and verify preserved behavior; relevant suites and gates pass with recorded commands/results; imported/takedown controls remain covered.

### Task 3.2: [shared-ui-consumer-adoption] [P3] Prove adopted site forms and generated CSS

**Size:** large · **Priority:** medium · **Depends on:** 2.6 · **Parallel with:** 3.1, 3.3, 3.4

Add or update focused tests around each adopted live site form for labels, errors, pending/disabled state, actual submission and navigational outcomes. Inspect generated CSS to confirm package styles survive Next/Tailwind production build. Check keyboard/focus, reduced motion, light/dark/system, 390px and desktop presentation on representative live routes. Run affected site tests, typecheck, lint and build; preserve existing test intent and investigate failures before changing assertions.

Acceptance: adopted routes visibly use shared styles; form and navigation behavior is unchanged; no site layout or framework-owned control is inadvertently restyled; all affected site gates pass.

### Task 3.3: [shared-ui-consumer-adoption] [P3] Document primitive ownership and consumer exceptions

**Size:** medium · **Priority:** medium · **Depends on:** 1.3, 2.4, 2.6 · **Parallel with:** 3.1, 3.2, 3.4

Update contributing/shared-ui.md, relevant architecture/design-system guidance, packages/ui/README.md and the public surface inventory. State which generic primitives the package owns, how the client facade, Community and site consume them, and why remaining local Card/Badge/Skeleton, native controls, Fumadocs controls, marketing compositions and domain layouts stay local. Document foreground ownership, portal scoping, caller override behavior and package CSS/subpath requirements. Keep historical extraction specs as shipped records; describe this continuation separately. Include only package identity and verification categories for independent adoption.

Acceptance: ownership table matches code and live inventory; every remaining local generic-looking control has a concrete rationale; documentation has no private paths, IDs or business details.

### Task 3.4: [shared-ui-consumer-adoption] [P3] Verify and pack the public package candidate

**Size:** large · **Priority:** high · **Depends on:** 1.3 · **Parallel with:** 3.1, 3.2, 3.3

After foreground and catalog changes, run package component tests, typecheck, lint and build plus catalog component/browser suites. Pack the candidate archive, record integrity and size, inspect allowed contents, install it into an independent scratch consumer with no source alias, and prove every used export and declaration resolves. Confirm tokens.css/tailwind.css create browser-computed styles and only one React/ReactDOM runtime is present. Preserve the baseline failure and passing opposing-theme proof. Keep the current public API and dependency versions; if no API changes occur, prepare patch version 0.2.1 for the reviewed release.

Acceptance: a recorded archive can be installed independently and reproduces the tested contract; package/catalog gates pass; no private consumer details appear in public proof.

### Task 3.5: [shared-ui-consumer-adoption] [P3] Complete independent consumer archive adoption and private proof

**Size:** large · **Priority:** high · **Depends on:** 3.4 · **Parallel with:** 3.1, 3.2, 3.3

In a separate private implementation record, replace equivalent generic primitives using the exact packed candidate from task 3.4 while preserving that consumer's local behavior and presentation. Verify real forms, links, dialogs, authorization and keyboard/focus flows; run its affected component and browser suites, check generated CSS/declarations/exports and one React runtime. Record implementation paths, detailed test results and task identifiers only in private records. Public receipts may state package identity and verification categories without consumer implementation details.

Acceptance: private adoption passes its affected suites against exact archive bytes; no public repository file, tracker item or PR exposes private paths, IDs or business behavior.

### Task 3.6: [shared-ui-consumer-adoption] [P3] Run cross-consumer verification and independent reviews

**Size:** large · **Priority:** high · **Depends on:** 3.1, 3.2, 3.3, 3.4, 3.5 · **Parallel with:** none

Reconcile final Community/site/package branches and repeat affected gates after integration, including package/catalog browser, Community browser, site forms and packed archive contract checks. Perform an independent compliance review of public/private boundary, ownership exceptions, accessibility, preserved authorization and exact artifact; then a separate quality review of implementation, tests and docs. Resolve every blocking finding and rerun the checks it affects. Produce public evidence limited to package identity, test categories and outcome; retain private details in private records.

Acceptance: both reviews have recorded findings/resolution; all affected gates pass on integrated source; no private detail leaks into public artifacts; the tested packed artifact matches the candidate for delivery.

## Phase 4: Delivery and closure

### Task 4.1: [shared-ui-consumer-adoption] [P4] Deliver reviewed public changes through normal PR gates

**Size:** large · **Priority:** high · **Depends on:** 3.6 · **Parallel with:** none

From the isolated public worktree branch based on pinned origin/main, review the integrated diff against the frozen spec, resolve conflicts without losing incoming Community controls, commit with normal hooks and push. Open or update the PR with concrete before/after behavior and verification evidence, then follow automated review, required CI and merge queue to completion. Do not bypass hooks or review. Keep private implementation details out of the branch, PR description, comments and evidence.

Acceptance: public PR contains package/catalog, Community, site, docs and tests only; required checks and reviews pass; merged commit is identified; review findings are resolved.

### Task 4.2: [shared-ui-consumer-adoption] [P4] Publish and verify exact shared package release when authorized

**Size:** medium · **Priority:** high · **Depends on:** 4.1 · **Parallel with:** none

After the public merge and reviewed source/archive proof, follow the authorized owner publication procedure for a compatible patch release if the API remains unchanged. Compare published registry archive integrity and contents with the reviewed candidate, install the exact registry version independently, and repeat exports/declarations/CSS/browser-computed styles and single-React checks. Record the version, integrity, size and verification outcome publicly; do not publish before authorization or claim success from a local workspace build alone.

Acceptance: the authorized release is available from the registry; exact published bytes and browser contract pass independent verification; any byte mismatch is investigated and resolved before consumers upgrade.

### Task 4.3: [shared-ui-consumer-adoption] [P4] Upgrade independent consumer and close implementation records

**Size:** large · **Priority:** high · **Depends on:** 4.2 · **Parallel with:** none

After registry verification, update the independent consumer to the exact published version in its private branch, rerun its affected component/browser flows and generated CSS/single-React checks, and deliver through its normal review path. Keep private paths, IDs and business details in private records. Collect final public proof for package, Community, site and catalog; reconcile spec task status and implementation receipts; close the linked public work item only when both public and independent adoption meet acceptance.

Acceptance: independent consumer passes against published bytes and is delivered through review; public and private evidence are correctly separated; public task/issue state reflects completed work and any follow-ups are captured.
