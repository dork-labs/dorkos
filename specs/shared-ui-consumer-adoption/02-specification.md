---
slug: shared-ui-consumer-adoption
number: 260925-100000
created: 2026-09-25
status: specified
---

# Complete shared UI consumer adoption

**Status:** Approved by the operator's continuation request.
**Author:** Codex
**Date:** 2026-09-25
**Work item:** DOR-2342 — Shared UI: finish consumer adoption and opposing-theme overlay correctness

## Overview

Extend maintained shared primitives beyond the completed extraction and sign-in pilots. Correct foreground ownership in themed surfaces, adopt equivalent generic controls in Community and appropriate site forms, verify independent consumers against the released contract, and publish an honest ownership inventory.

## Background / Problem Statement

0.2.0 is a working library and catalog, but generic controls still have separate implementations in consumers. A class-only opposing theme host also reveals a concrete missing foreground in modal surfaces. A dependency bump alone proves neither adoption nor visual consistency.

## Goals

- Dialog, AlertDialog, Sheet and outline Button pair their background with an explicit theme foreground; caller class overrides remain possible.
- Equivalent Community generic buttons, text fields, notices and separators use shared implementations across account/recovery, administration and channel/shell actions.
- Appropriate live site forms use shared foundations while deliberate marketing and documentation presentation stays intact.
- Independent consumer adoption verifies real forms, links, dialogs and authorization flows without exporting its implementation details.
- Every remaining local primitive or custom control has a concrete semantic, domain or presentation reason.

## Non-Goals

No auth/data/permission/protocol changes, page layout homogenization, upstream regeneration, Base UI rewrite programme, app feature extraction or marketing redesign. Native select/date/file/radio controls retain platform behavior. Fumadocs components remain framework-owned. No claim of embedded runtime support from builds alone.

## Technical Dependencies

React 19, Tailwind 4 and the currently installed customized Radix components. Keep current dependency versions. Public consumers use workspace exports; independent consumers install the exact archive and then published registry version. React/ReactDOM remain peers and a single runtime instance.

## Detailed Design

### Surface ownership

Add text-dui-foreground to modal surfaces owning bg-dui-background and the outline Button variant. Outline borders use the package border token. Audit all package background utilities; already paired popover/menu/tooltip/tabs and decorative tracks need no unrelated change. Transparent native fields inherit their surrounding form foreground rather than force an opaque panel contract.

Extend the portal catalog with AlertDialog and Sheet examples. Browser regression removes only the island's text utility to reproduce a documented class-only host, then asserts computed foreground/background in both directions, real portal location, focus return and cancellation. Preserve the existing nested menu/dialog tests and registry ownership.

### Community adoption

Inventory each browser component. Migrate generic .button controls to Button with explicit submit types; preserve disabled, aria-disabled, form/name/value/ref/event semantics. Compose real navigation/download anchors with asChild only where they are styled actions. Migrate generic text/password/email/number fields to Input and labels to FieldLabel/Label without moving validation or changing IDs and error associations. Textareas may use Textarea when their behavior is ordinary text entry; retain bespoke composer geometry and keyboard behavior. Use Notice with explicit role where needed and Separator for decorative separators. Remove legacy generic CSS only after every remaining use is migrated or deliberately narrowed to an app-owned native control. Never leave legacy unlayered styles overriding shared controls.

Preserve focusable unavailable community choices, native selects/date/file inputs/radio/checkbox semantics, navigation items, sidebar/thread geometry, message content, upload labels and app-owned FocusDialog behavior. Migrate the generic controls inside those compositions. Reconcile active import and takedown features before integration; do not delete incoming feature controls.

### Other public surfaces

Audit site forms and adopt equivalent Button/Input/Textarea/Label where live behavior and CSS scope are compatible. Inventory dormant wrappers separately before removing them; no speculative whole-site replacement. Keep Fumadocs controls, marketplace links, branded CTA composition and intentional marketing density/layout. Document client Card/Badge/Skeleton differences and keep them local unless a concrete second consumer establishes one compatible contract during inventory.

### Independent adoption

Maintain separate private implementation and task records. Replace equivalent generic primitives and keep business behavior local. Verify actual installed archive CSS/declarations/exports and single React; repeat against published release. Public evidence contains only package identity and verification categories, no private paths, tracker IDs or business details.

No public API, data model, routing or backend changes are required. Package patch version 0.2.1 is appropriate if the final public API remains unchanged. Publication must use the authorized owner procedure after reviewed source, archive proof and normal PR delivery.

## User Experience

Forms keep their existing labels, errors, submission behavior and routes. Shared buttons and inputs have consistent phone/desktop dimensions, focus and disabled behavior. Theme-scoped dialogs remain readable irrespective of the surrounding document; Escape/cancel restore focus. Native inputs retain browser behavior and deliberate local layouts remain recognizable.

## Testing Strategy

Retain baseline failure evidence before fixing. Run package and catalog component suites, typechecks/build/lint, and real browser tests at 390px/desktop for light/dark/system preference, opposing theme hosts, reduced motion, keyboard/focus and overflow. Community regression runs cover owner claim, pairing, account controls, switching, host administration, erasure/removal and membership accessibility. Add focused browser proof of migrated controls and pending/error/submit behavior. Site checks cover actual adopted forms and generated CSS. Preserve existing consumer test intent; investigate failures before updating assertions.

Pack the final candidate; install independently with no source alias and prove exports, declarations, CSS generation, allowed contents, one React and computed browser styles. Retest exact registry bytes after publication. Independent consumer runs include its own affected component and browser suites, recorded privately. Independent compliance review precedes quality review and normal PR/CI/merge gates.

## Performance Considerations

No added app providers, network traffic, polling or runtime dependency bundles. Keep subpath imports and external React peers. Record archive integrity and size.

## Security Considerations

Preserve authorization and dangerous-action confirmation behavior. No paid services, real account mutations or secret access required for tests. Keep private evidence out of public source, tracker and PRs. No bypasses of hooks, CI or review.

## Documentation

Update contributing/shared-ui.md, relevant architecture/design-system guides, package README and the surface inventory. Keep historical specs as shipped records; this spec explicitly corrects the gap between extraction and full consumer adoption. Maintain canonical tasks and implementation receipts.

## Implementation Phases

1. Inventory, baseline and owning-component foreground correction.
2. Community generic control adoption and appropriate site foundations; independent consumer adoption in private work.
3. Cross-consumer verification, ownership documentation and independent reviews.
4. Normal public delivery, exact package release if authorized, independent registry upgrade/delivery, final evidence and tracker closure.

## Open Questions

- ~~Rewrite primitive foundations?~~ Resolved: no; retain customized Radix implementations.
- ~~Force every surface to share layout or replace native controls?~~ Resolved: no; consistency applies to equivalent primitives, with documented native/domain/presentation exceptions.
- ~~Reopen completed extraction work?~~ Resolved: preserve historical completion and track remaining adoption separately.

## Related ADRs

260923-201140 (public package/CSS boundary) and the existing caller-owned portal-container decision remain authoritative. No new architectural seam is introduced.

## References

specs/shared-design-system/; specs/shared-ui-broader-adoption/; contributing/shared-ui.md; DOR-2342.
