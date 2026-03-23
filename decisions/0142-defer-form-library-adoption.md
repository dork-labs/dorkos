---
number: 142
title: Defer Form Library Adoption
status: superseded
created: 2026-03-18
spec: form-field-standardization
superseded-by: 180
---

# 0142. Defer Form Library Adoption

## Status

Superseded by [ADR-0180: Adopt TanStack Form for Submit-Lifecycle Forms](0180-adopt-tanstack-form.md).

## Context

During form field standardization, we evaluated adopting a form state management library. React Hook Form v7 has known incompatibility with React Compiler. TanStack Form v1 is React Compiler compatible and provides validation, submission, dirty tracking, and error handling. However, DorkOS settings use live-binding with `useState` (no submit lifecycle — changes take effect immediately), and there is currently only one multi-step wizard (adapter setup). The project uses `useState` per field throughout, which is simple and appropriate for the current scale.

## Decision

Do not adopt react-hook-form or TanStack Form at this time. Continue using `useState` per field for settings (live-binding) and the adapter wizard. Revisit TanStack Form adoption when a second multi-step wizard is introduced, at which point the cost of the library is justified by the complexity it absorbs.

## Consequences

### Positive

- No new dependency or learning curve for the team
- Settings remain simple: `useState` + `onChange` handler + immediate effect
- Avoids adopting a library that's overkill for current needs (YAGNI)
- TanStack Form can be adopted incrementally later without rework

### Negative

- Manual validation logic in ConfigFieldInput (pattern validation on blur, required field indicators)
- No built-in dirty tracking, touched states, or field-level error management
- If a second wizard is added without revisiting this decision, form logic may be duplicated
