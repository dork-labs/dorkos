---
slug: shared-design-system
number: 260923-144507
created: 2026-09-23
status: specified
---

# Shared UI foundations and the first three consumers

**Status:** Approved for implementation under the operator's instruction; publication remains separately gated; merging follows the repository’s autonomous review and merge-queue policy.
**Author:** Codex
**Date:** 2026-09-23
**Tracker:** [DOR-2280](https://linear.app/dorkspace/issue/DOR-2280)
**Project:** [DorkOS Shared Design System](https://linear.app/dorkspace/project/dorkos-shared-design-system-0db76fa6b316)

## Overview

Deliver one maintained implementation of tokens, Button, Input, Field and Notice, used by real sign-in forms in the client, Community and the independently released account surface. A standalone catalog consumes exactly those exports. This specification freezes the first complete slice; later dialog/menu extraction and broader adoption remain subsequent work, not hidden completion criteria for this slice.

## Background / Problem Statement

The three surfaces independently implement control sizes, focus states, labels and error presentation. Guidelines cannot propagate interaction fixes. The existing client playground also mixes portable foundations with feature simulations that initialize application contexts. The committed [discovery](discovery.md) and [migration plan](migration-plan.md) remain the source inventory and regression checklist.

The initial source base was `2f901e390b70b567370544e7bcad2e20a0dc00ae`; this specification was reconciled against pinned public base `92931cdda6c8823aaa4253efb652908f45383cb3`. Open PR #2042 owns destructive contrast corrections. Carry those corrections forward when integrating; do not overwrite its work. DOR-1808, DOR-1812, DOR-1861, DOR-1867 and DOR-1837 were read in full and remain separate: extraction does not decide selected-state colors, expand icon-sm targets or repair the whole CSS cascade.

## Goals

- One implementation of each pilot primitive, with existing native-button defaults, Slot composition, responsive sizing and reduced-motion behavior preserved.
- Portable semantic tokens with no dependency on client state, private source or credentials.
- One working sign-in form per primary surface, including errors, pending states and keyboard operation.
- A catalog whose examples import production package exports and whose failures cannot be swallowed into a green result.
- Packed JavaScript, declarations and CSS work in an independent consumer using a single React installation.

## Non-Goals

Backend, authentication, room protocols, pricing, deployment, publishing a package, changing primitive libraries across the product, broad visual redesign, marketing-site migration, or blanket replacement of all UI primitives. Existing 40px icon-sm and xs exceptions remain explicit. No claims about untested desktop/embedded platforms follow from a browser check.

## Technical Dependencies

Use the repository's installed React 19, TypeScript 5.9, Tailwind CSS 4, Vite 6, class-variance-authority, clsx, tailwind-merge and Radix libraries. React and React DOM are peers; package output never bundles React. Retain Radix Slot/Label/Separator semantics; complex dialogs and portal components stay local until a later contract review. The first package does not import the private icon workspace package: callers supply icons as children.

## Detailed Design

### Package and ownership

Create `packages/ui`, named `@dork-labs/ui`, version `0.1.0`, initially protected from accidental publication. One release owns both styles and components; separate token versioning adds no benefit yet. Export ESM JavaScript and declarations from the root and deliberately selected public subpaths, plus `tokens.css` and `tailwind.css`. The packed file allowlist excludes fixtures, source secrets and app files. CSS remains marked as a side effect. React is external and peers target the tested React 19 range.

Move Button, Input and Field and their pure Label/Separator/touch-target dependencies, retaining their prop APIs, refs, events, data-slot attributes and accessibility semantics. Package-local `cn` depends only on clsx and tailwind-merge. Keep the client FSD barrel as a supported facade to the package, not a second implementation; internal leaf re-exports may remain where existing shared primitives import them. These are ownership boundaries, not temporary copies. PasswordInput stays local and composes the shared Input.

Add `Notice` with `tone: 'info' | 'error' | 'success'`, ordinary div props and children. Error tone defaults to role alert; other tones have no unsolicited live announcement. Callers may deliberately pass role status for asynchronous success. It owns presentation only, with no title parsing, errors API, dismissal state or request logic. Empty application errors render nothing at the application boundary.

### Styles and themes

Export namespaced `--dui-*` HSL token values and matching `dui-*` Tailwind semantic color names. Shared components use these namespaced colors so Cloud's existing full-color token format and Community's canvas/panel vocabulary do not collide. Non-color utility classes retain the current sizing, spacing and behavior. Namespaced icon sizes have standalone defaults. Support `.dark` and `.light` ancestors plus the system preference when neither explicit theme is present. Explicit selection wins over system. The package does not persist theme state or manipulate document classes.

The client bridges its existing color variables to the extracted values; move only the selected portable palette declarations, leaving sidebar/editor resets, feature colors, font settings, scrollbars and layer ordering local. Preserve existing user font scaling. Consume the common stylesheet once in each application. Package CSS must not ship a global reset, font import or universal element rules.

Use the Tailwind 4 source distribution contract: `tailwind.css` registers the package's emitted JavaScript as an explicit source and declares the namespaced semantic mappings. Consumers import it after Tailwind. This avoids an additional preflight and avoids unprefixed competing compiled utility sheets. Shipping built JS plus raw CSS is intentional: supported consumers already compile Tailwind 4. The independent packed consumer test must prove source discovery through installed dependency paths, theme selection, dark variants, opacity modifiers and responsive behavior. No undocumented workspace source alias is permitted.

### First screens

Client: `features/auth/ui/LoginScreen.tsx`, using shared Field/Input/Button/Notice through the FSD facade. Preserve password visibility, error detail, autofill, submission and focus.

Community: `browser/components/Admission.tsx`, changing presentation only. Preserve preflight, invitation recovery, account-mode toggles, focus, social sign-in and membership flow. Every action that submits must explicitly use type submit because the extracted Button defaults to type button. Use shared Field, FieldLabel, Input and Notice; remove obsolete class ownership for those selected controls, while unconverted screens keep their existing classes.

The private account sign-in adoption is tracked and implemented in the private repository. Public artifacts contain only the shared contract and acceptance result. Its auth, redirects, validation, notifications and business components stay private. Active PRs were inspected before choosing these forms; no broad freeze on feature development is needed. Refresh file-level overlap before landing and reconcile additive changes against pinned revisions.

### Catalog

Create `apps/design-system` as a standalone Vite React app using the workspace package. No Transport, router singleton, app store, backend, credentials or private imports. Provide token swatches, Button variants/sizes, disabled state, native/Slot form behavior, Field labels/errors, Input and Notice. Include light/dark/system controls and narrow-screen examples. Fixtures use real exported components.

Move generic pilot showcase ownership from the client into the catalog. Preserve client feature simulations and their providers. Link both destinations with configurable URLs, retain registry/coverage guards, and make catalog rendering errors fail tests. The migration is limited to pilot primitives; unrelated generic galleries may migrate in later slices. Run the catalog explicitly with a caller-selected port (`pnpm --filter @dorkos/design-system dev --port <port> --strictPort`); do not add it to root turbo dev or modify pipeline/port infrastructure in this slice.

### Distribution and release

Build and pack locally, then install the archive into a throwaway consumer with no workspace access. Verify package exports, declaration resolution, React peers and generated CSS. Use that same archive for local private adoption validation. Do not commit an absolute filesystem dependency, sibling-checkout link or fake published version. Keep release-dependent manifest changes as a reviewed private patch if a real package version is unavailable. The candidate is ready for publication only after public verification and human authorization; then publish the exact verified archive, pin its version in the private consumer and regenerate its lockfile. This release gate may leave Cloud delivery prepared and locally verified but not landed. Report that boundary honestly.

Before enabling publication, confirm name availability/organization authority, remove the publication guard intentionally, select a version and run the packed checks. No new CI workflow or release-train change is part of this first slice. Existing clean-build entry points must build the new dependency before its consumers. Document the manual package owner procedure and required consumer upgrade checks.

No API, database or runtime network changes.

## User Experience

Sign-in still follows each application's existing flow. Controls share focus treatment, responsive dimensions and label/error presentation. Pending buttons remain disabled with their existing text. Keyboard tab order, password manager hints, form Enter behavior, recovery actions and app-specific error copy remain intact. A failed request is announced once; field messages point to real IDs. Longer labels and 200% zoom must not conceal an action.

## Testing Strategy

- Package behavior: native default type, explicit submit, Slot child event/ref behavior, disabled controls, field associations and error deduplication, Notice role semantics, preserved size variants.
- Distribution: pack/install/build/typecheck outside the workspace; assert no React copy, unresolved workspace dependency, missing declaration or omitted CSS. Browser checks must inspect rendered styles rather than source strings alone.
- Regression: inventory every test importing changed primitives directly or through parents. Since the client facade changes ownership globally, run the client project suite as well as focused auth/form tests. Run Community browser/component suites covering Admission, including owner and member forms. Private consumer runs its own relevant suites in its worktree.
- Browser: light/dark/system and explicit override, 390px and desktop, keyboard focus, disabled/loading/error, reduced motion, text scaling and overflow. Check actual catalog and real forms using mocked application requests where appropriate, never paid services.
- Embedded: build/typecheck the plugin and inspect the CSS boundary; retain host-specific styles. Do not claim platform validation without running it.
- Tests carry purpose comments and must fail when the primitive does not render. No boundary that swallows failures qualifies as a successful fixture.

## Performance Considerations

Keep React external and no eager application providers in the package/catalog. Export tree-shakeable ESM; inspect the packed consumer output and CSS size. Tailwind emits only discovered classes. No network font request is introduced.

## Security Considerations

No credentials, authentication decisions, private files or telemetry enter the shared package. No paid tests or deployment. Public package builds must succeed without the private checkout. Scan packed files and new dependency edges before review.

## Documentation

Update design-system and styling-theming guides, the contributor index, package README and catalog navigation instructions. Record tested versions, CSS imports, ownership, intentional size exceptions, release gates and private adoption status without private implementation details.

## Implementation Phases

1. Public package/tokens and packed-consumer contract.
2. Public consumer migration and catalog split; private consumer preparation from the same package contract.
3. Regression/browser proof, documentation and independent review. Publication and private release adoption follow their explicit gate.

Dependency graph: foundations → public forms + catalog + private preparation → integrated proof → reviewed public delivery → authorized publication → private version pin and delivery. Broader primitive migration is deferred and must be scoped separately.

## Open Questions

- ~~Separate token package?~~ **(RESOLVED)** One UI package with CSS subpaths. One tested artifact prevents version skew.
- ~~Replace Radix with Base UI?~~ **(RESOLVED)** Preserve the client baseline for this slice. Avoid coupling extraction to an interaction-library rewrite.
- ~~Compiled CSS or source contract?~~ **(RESOLVED)** Tailwind 4 source contract with namespaced colors, proven from the installed archive. Consumers already use Tailwind 4.
- ~~Catalog tooling?~~ **(RESOLVED)** Vite, matching existing tooling; no additional framework or hosted service.
- ~~Can packages publish automatically?~~ **(RESOLVED)** No. Prepare reviewable archives, then request authorization for the concrete release. Existing cloud-api permission does not apply.

## Related ADRs

A proposed shared UI ownership/distribution ADR is seeded alongside this specification. Existing FSD boundaries and host-specific styling remain in force. No backend seam is superseded.

## References

- [Ideation](01-ideation.md), [discovery](discovery.md), [migration plan](migration-plan.md).
- [Design system](../../contributing/design-system.md), [styling](../../contributing/styling-theming.md).
- [Tailwind source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files).
