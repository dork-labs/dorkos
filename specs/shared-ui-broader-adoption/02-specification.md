---
slug: shared-ui-broader-adoption
number: 260924-130508
created: 2026-09-24
status: specified
---

# Shared UI: broader primitive adoption and maintenance

**Status:** Approved for implementation by the operator's continuation request. Release follows the owner procedure.
**Author:** Codex
**Date:** 2026-09-24
**Work item:** DOR-2315 — Shared UI: broader primitive adoption and maintenance

## Overview

Complete the remaining shared design-system roadmap through three bounded extraction slices and maintenance delivery. Move 18 existing customized primitive modules into @dork-labs/ui, migrate their real client consumers via the FSD facade, expand the production catalog, prove the installed distribution, and deliver a compatible independent-consumer upgrade.

## Background / Problem Statement

The published 0.1.0 package owns form foundations, but dialogs, menus, selection controls and tabs still depend on client-local implementation and CSS. Copying them elsewhere would fork established fixes. Their generic behavior is reusable; their default portal target and implicit animation/icon CSS are the main portability gaps. Many other shared/ui modules are application components and should remain local.

## Goals

- One maintained implementation for each of the 18 selected modules, retaining existing exports, props, events, refs, data-slot attributes, responsive dimensions and custom behavior.
- Working explicit/system themes, portal scoping, keyboard interactions and reduced motion in an independent installed consumer.
- Catalog examples of every exported component family, with meaningful interactions and no app providers.
- Existing public consumers continue working; independent consumers upgrade explicitly through a real registry release.
- Ownership, contribution, versioning and consumer-upgrade guidance describe the final boundary.

## Non-Goals

No fresh upstream components, Base UI migration, application behavior rewrite, new backend, private source dependency, whole-site migration or automatic conversion of native selects. No claim of Obsidian runtime verification from CSS/build tests. Local wrappers for routing, responsive app state, domain identity, notifications, data tables, editors and form engines remain local. Card, Skeleton and Badge are not part of this release.

## Technical Dependencies

Retain the installed React 19 and Radix versions. Use the existing public lucide-react version for built-in affordance icons; no private icons package. Preserve Switch's tailwind-variants implementation and its coupled track/thumb size tables. Use the repository's current tw-animate-css version for existing animation utilities, with explicit package-owned reduced-motion behavior. Resolve exact versions from the current lockfile; no opportunistic dependency upgrades. React and ReactDOM remain external peers. Tailwind 4 source detection remains explicit.

## Detailed Design

### Extraction slices and ownership

A: textarea, checkbox, radio-group, switch, slider, tabs, collapsible, progress, scroll-area.
B: dialog, alert-dialog, sheet, popover, hover-card, tooltip.
C: select, dropdown-menu, context-menu.

Copy the current maintained source into packages/ui/src, preserving its documented behavior and useful comments. Replace app cn imports with package-local cn, import existing shared Button/touch-target locally, and use public Radix equivalents without changing semantics. Keep built-in lucide icons; retain caller-supplied icons and children APIs. Replace each client leaf implementation with explicit package re-exports, including every previously exported type and variant helper. Keep the current FSD barrel entry points, and keep app-specific responsive wrappers local. Remove duplicate selected implementations in the same slice.

Root and matching subpath package exports must resolve emitted JS and declarations. All runtime imports use publishable dependencies; build source maps must not include source content or private data. CSS remains a side effect; selected package files remain allowlisted. Version the additive release candidate as 0.2.0, keeping every 0.1.0 export compatible.

### Styling and independent distribution

Convert semantic color utilities to dui-* and dark variants to the package theme variant. Preserve fixed literal colors only where they are deliberate existing behavior. Provide package defaults for every icon-size variable used; retain client host-font-scale bridges for those defaults. Borders must use explicit package border color instead of relying on the client-wide border reset. Do not copy a global reset, font import, editor layer, app store or universal selector into the package.

Audit all custom utilities in selected source, including animations. Ensure the package Tailwind entry supplies the utilities required by exported modules through public dependencies or scoped package definitions. Gate animation and transition behavior for reduced-motion users on the component itself or package-owned selectors; never rely on the client global reset. Verify computed animation/transition behavior from a built installed consumer, including collapsible height animation and immediate dropdown dismissal.

### Portal container contract

Add UiProvider with optional portalContainer: HTMLElement | null. It supplies only React context, no markup, theme store, browser-global mutation or application dependency. Undefined/null retains each primitive's existing document-body portal behavior. Provider scope is per React subtree; nested providers override their parent. A provider receiving a mounted element inside a light/dark scope directs descendant exported portals into that element, so actual DOM inheritance supplies the correct CSS values. Caller owns container lifetime and must keep a stable host mounted while the overlay is open.

Every selected portalling component consumes the provider, including nested menu portals and exported portal wrappers. Explicit existing Portal container props take precedence over the provider. Preserve refs and all Radix props. Do not pass provider-only props onto DOM nodes. The catalog must demonstrate ordinary document portals plus two independent theme islands with separate containers, and test nested popover/menu/dialog behavior, dismissal and focus restoration. Do not silently relocate default portals into clipping ancestors.

### Consumer and catalog integration

Client features migrate through existing facades, including responsive app wrappers. Preserve custom dialog close buttons, phone width/gutters/scrolling, safe Button type defaults, select sizing, hover delays, tab activation, switch size tables, scroll viewport refs and immediate menu close/reopen behavior.

Extend apps/design-system with navigable production examples for all 18 module families. Move generic selected primitive showcases out of the client when their ownership moves; preserve feature simulations and all application providers. Update catalog/client registry guards together and remove superseded generic demos rather than maintain replicas. Catalog must run independently with configurable port and no server/auth/router initialization.

Community's existing shared controls continue using the workspace package and its established CSS boundary. Active feature PRs overlap its other form screens; do not overwrite them or force Radix controls onto intentional native controls. In a private isolated worktree, install the exact candidate archive, prove current adopted controls remain compatible, then pin the real published 0.2.0 version and repeat normal private verification. Public artifacts record only contract-level proof; private paths, code, business details and tracker IDs remain private.

### API and data changes

Only additive UI exports and UiProvider; existing consumer interfaces stay compatible. No API endpoints, storage, auth or data model changes.

## User Experience

Existing client dialogs, menus, selection controls and tabs look and behave as before, including keyboard activation, focus trapping/restoration, disabled states and responsive targets. The catalog exposes the same controls with working examples for selection, open/close, scroll and validation. Explicit light/dark selection wins over system preference, including portal content directed to a scoped container. Escape exits overlays according to Radix semantics and returns focus to the triggering control.

## Testing Strategy

Before changing ownership, run relevant existing primitive tests as baseline. Retain those consumer tests and add focused package behavior tests for meaningful contracts: checkbox/radio form and label behavior; Switch controlled/uncontrolled state and size tables; slider thumb count/keyboard values; tabs activation; collapsible state; ScrollArea viewport ref; dialog escape/focus and explicit container precedence; dropdown/submenu reopen and selection; Select controlled values and keyboard flow. Test UiProvider sibling/nested containers without global cross-talk. Preserve disabled/ref/event behavior. Each new test documents the behavior it protects.

Run package build/typecheck/lint/tests, catalog build/typecheck/lint/tests and built-browser proof. Run the full client suite because facade ownership reaches many parent components, plus affected Community tests/browser proof and embedded build/typecheck. No paid services or credentials are needed. Real browser coverage must include 390px/desktop, light/dark/system/explicit override, independent portal islands, keyboard focus/escape/reopen, long labels/200% text, reduced motion and no overflow/page errors. Assert computed styles and actual focused elements, not only class strings.

Pack the exact candidate and install outside the workspace with no source aliases. Verify every documented root/subpath/declaration/CSS export, one React instance, class generation from installed JS, animation dependency resolution, public file allowlist and zero app/private dependencies. Re-run installed proof after final archive changes. Inspect any test failures before repair; preserve the shared library's original behavior rather than weakening assertions.

## Performance Considerations

Keep subpath imports available, no bundle of app providers and no eager initialization. Portal context should contain only stable caller-provided configuration. Record archive size/file count and confirm consumers do not acquire a second React instance. No new polling or server requests.

## Security Considerations

No secrets, private implementation details or application callbacks with hidden network behavior in shared code. Public builds require no private checkout. Retain existing accessible semantics and caller ownership of dangerous actions. No real account mutation in browser proof. Independent package consumers use exact published versions and verified integrity.

## Documentation

Update packages/ui/README.md, contributing/shared-ui.md, design-system.md and styling-theming.md where needed. Publish an ownership matrix for migrated and deliberately app-local modules, portal-container examples, required CSS import order/animation support, supported React/Tailwind versions, 0.1→0.2 upgrade instructions, release checklist and catalog commands. Record evidence in 04-implementation.md and canonical task statuses in 03-tasks.json.

## Implementation Phases

1. Portable styles/portal contract and controls slice A, with package/client regression proof.
2. Overlays slice B and menus slice C, preserving customized behavior and removing duplicate implementations.
3. Expanded production catalog, moved generic showcases, combined public and independent-consumer verification.
4. Maintenance documentation, independent compliance/quality review, exact 0.2.0 release and independent upgrade, normal PR/CI/merge delivery, tracker completion.

These are implementation slices within roadmap phases 4 and 5; the original completed foundation project remains closed.

## Open Questions

- ~~Which foundation?~~ (RESOLVED) Existing customized Radix components; explicit operator direction.
- ~~Extract every shared/ui file?~~ (RESOLVED) No; extract the listed 18 modules, keeping documented domain/app wrappers local.
- ~~How do portal themes work?~~ (RESOLVED) Default body behavior plus an optional caller-owned themed container through UiProvider; no implicit app theme synchronization.
- ~~Should active Community forms be rewritten now?~~ (RESOLVED) Preserve concurrent work and intentional native form semantics. Client facades provide real adoption; Community and independent consumer receive verified package compatibility upgrades.

## Related ADRs

Existing ADR 260923-201140 defines the package/CSS boundary. This continuation retains it; a new draft ADR records caller-owned portal containers and the explicit primitive ownership boundary.

## References

- specs/shared-design-system/migration-plan.md and 04-implementation.md
- specs/shared-ui-broader-adoption/01-ideation.md
- DOR-2315 — Shared UI: broader primitive adoption and maintenance
- Public baseline 6ca1e5b8410f2a2b4f73beb3fcf4a15d70187e9a
