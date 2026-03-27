---
number: 141
title: Use Shadcn Field for Form Layout Foundation
status: proposed
created: 2026-03-18
spec: form-field-standardization
superseded-by: null
---

# 0141. Use Shadcn Field for Form Layout Foundation

## Status

Proposed

## Context

DorkOS has 26+ inline reimplementations of a horizontal settings row pattern (`flex items-center justify-between gap-4` with label/description on the left and control on the right). These lack accessibility attributes (`aria-describedby`, proper `htmlFor` association). The project already uses Shadcn UI (new-york style, zinc base color) for all shared UI primitives (Button, Input, Select, Switch, etc.) and has established precedents for adopting Shadcn components (ADR-0063 CommandDialog, ADR-0064 Sidebar).

## Decision

Adopt Shadcn Field as the foundation for all form field layouts. Install via `pnpm dlx shadcn@latest add field` which provides 10 sub-components with an `orientation` prop (`vertical` / `horizontal` / `responsive`). Build `SettingRow` as a thin wrapper on `<Field orientation="horizontal">` and use `<Field orientation="vertical">` for wizard/form contexts (ConfigFieldInput). This replaces all inline layout patterns with accessible, composable primitives.

## Consequences

### Positive

- Consistent form field accessibility across the entire application (aria-describedby, label association, role="alert" for errors)
- Single `SettingRow` component replaces 26+ inline implementations — one place to update styling
- Aligns with the existing Shadcn adoption strategy (copy-pasted files, not npm dependencies)
- `orientation` prop formalizes the horizontal-for-settings / vertical-for-wizards convention

### Negative

- Adds ~10 new files to shared/ui (Shadcn Field sub-components)
- Known FieldError horizontal positioning bug (#8388) requires workaround when using error display in horizontal layouts
- Migration touches 15+ files across multiple features (mechanical but broad blast radius)
