---
number: 180
title: Adopt TanStack Form for Submit-Lifecycle Forms
status: accepted
created: 2026-03-22
spec: tanstack-form-adoption
supersedes: 142
superseded-by: null
---

# 0180. Adopt TanStack Form for Submit-Lifecycle Forms

## Status

Accepted

Supersedes [ADR-0142: Defer Form Library Adoption](0142-defer-form-library-adoption.md).

## Context

DorkOS now has four dialogs with submit-lifecycle semantics: ComposeMessageDialog, BindingDialog, CreateScheduleDialog, and AdapterSetupWizard. Each had manual useState-per-field patterns with hand-rolled validation, dirty tracking, and error display. ADR-0142 deferred library adoption but noted it should be revisited when complexity warranted it. With four submit-lifecycle forms, the manual approach had become a maintenance burden with inconsistent patterns across dialogs.

TanStack Form v1 (`@tanstack/react-form` ^1.28.5) is React Compiler compatible, supports native Zod/Standard Schema validation, and provides field-level subscriptions via signals-based reactivity. The `createFormHook` API allows registering shared field components once and using them across all forms via `useAppForm`.

## Decision

Adopt TanStack Form v1 for all forms with submit-lifecycle semantics (dialogs with explicit Save/Create/Submit buttons). Continue using `useState` for live-binding settings (changes take effect immediately without a submit action).

The shared form infrastructure lives in `layers/shared/lib/form.ts` with field components in `layers/shared/ui/form-fields/`. A separate `form-context.ts` module breaks the circular dependency between the form hook and field components.

Components excluded from migration: AgentDialog (live-binding, no submit), QuickBindingPopover (selection UI, no form fields).

## Consequences

### Positive

- Consistent form patterns across all submit-lifecycle dialogs
- Built-in dirty tracking, touched states, and field-level error management
- Zod validation integrated directly into form lifecycle
- Shared field components reduce boilerplate in each dialog
- React Compiler compatible (unlike React Hook Form v7)

### Negative

- New dependency (~15KB gzipped) added to the client bundle
- Learning curve for `form.Subscribe`, `form.AppField`, and reactive patterns
- `form.state` is a non-reactive snapshot; reactive reads require `form.Subscribe`
- TanStack Form's `isDirty` is a one-way ratchet (never resets); manual value comparison needed for revert-to-pristine behavior
