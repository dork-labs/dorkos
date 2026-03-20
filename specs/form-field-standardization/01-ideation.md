---
slug: form-field-standardization
number: 146
created: 2026-03-18
status: ideation
---

# Form Field Standardization

**Slug:** form-field-standardization
**Author:** Claude Code
**Date:** 2026-03-18
**Branch:** preflight/form-field-standardization

---

## 1) Intent & Assumptions

- **Task brief:** Standardize all form field components across DorkOS — settings dialogs, adapter wizards, and future forms — using Shadcn Field primitives as the foundation. Extract reusable `SettingRow` and `PasswordInput` components to `shared/ui`, eliminate 26+ inline reimplementations of the horizontal settings row pattern, and establish clear layout conventions (horizontal for settings, vertical for wizards).

- **Assumptions:**
  - Shadcn Field (`pnpm dlx shadcn@latest add field`) is production-ready for React 19 + Tailwind CSS 4 + new-york style
  - The existing `SettingRow` pattern (horizontal flex: label+description left, control right) is the correct layout for settings — it just needs to be extracted, not redesigned
  - ConfigFieldInput's vertical layout (label above control) is correct for wizard/form contexts
  - No form library (react-hook-form, TanStack Form) is needed now — `useState` per field is appropriate for settings (live-binding, no submit lifecycle) and the single adapter wizard
  - The adapter wizard's `ConfigFieldInput` should eventually be rebuilt on Shadcn Field, but can be migrated incrementally

- **Out of scope:**
  - Adopting react-hook-form or TanStack Form (revisit when a second multi-step wizard is needed)
  - Redesigning the adapter wizard flow or ConfigFieldInput's descriptor-driven architecture
  - Creating compound components (flat props API is sufficient for current needs)
  - Adding form validation beyond what ConfigFieldInput already provides (pattern validation on blur)

## 2) Pre-reading Log

- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` (lines 338-356): Private `SettingRow` component — horizontal flex layout with `Label` + description text left, control `children` right. Used throughout all settings tabs.
- `apps/client/src/layers/features/settings/ui/tabs/AdvancedTab.tsx`: 5 inline SettingRow-like patterns using the same `flex items-center justify-between gap-4` layout
- `apps/client/src/layers/features/settings/ui/tabs/ContextTab.tsx`: 3 inline reimplementations
- `apps/client/src/layers/features/settings/ui/tabs/ToolsTab.tsx`: 3 inline reimplementations
- `apps/client/src/layers/features/settings/ui/tabs/PersonaTab.tsx`: 2 inline reimplementations
- `apps/client/src/layers/features/relay/ui/ConfigFieldInput.tsx`: Descriptor-driven form field renderer. Supports text, password (with eye toggle, sentinel mode, trim, pattern validation on blur), url, number, boolean (Switch), select (dropdown or radio-cards), textarea. Vertical layout (label above control).
- `apps/client/src/layers/features/relay/ui/wizard/ConfigureStep.tsx`: Consumes ConfigFieldInput for adapter configuration forms
- `apps/client/src/layers/features/mesh/ui/ScanRootInput.tsx`: Chip/tag input for filesystem paths — composed form component
- `apps/client/src/layers/features/pulse/ui/TimezoneCombobox.tsx`: Searchable IANA timezone selector — composed form component
- `apps/client/src/layers/shared/ui/`: No existing SettingRow, FormField, or PasswordInput component. The shared layer has Button, Input, Textarea, Switch, Select, Label, Checkbox, RadioGroup, Tabs, and other Shadcn primitives.
- `apps/client/src/layers/features/relay/ui/IdentityTab.tsx`: Inline settings row patterns for relay identity configuration
- `apps/client/src/layers/features/relay/ui/CapabilitiesTab.tsx`: Inline settings row patterns for relay capabilities
- `apps/client/src/layers/features/mesh/ui/ServerTab.tsx`: Inline settings row patterns for mesh server settings
- `apps/client/src/layers/shared/ui/tunnel-dialog.tsx`: Inline settings row patterns for tunnel configuration
- `contributing/design-system.md`: Design system documentation — 8pt grid spacing, color palette, typography scale
- `contributing/styling-theming.md`: Tailwind v4 conventions, dark mode patterns

## 3) Codebase Map

- **Primary components/modules:**
  - `layers/features/settings/ui/SettingsDialog.tsx` — Main settings dialog with private `SettingRow` helper (the canonical pattern to extract)
  - `layers/features/settings/ui/tabs/*.tsx` — 6 settings tabs, each with multiple inline SettingRow patterns
  - `layers/features/relay/ui/ConfigFieldInput.tsx` — Descriptor-driven form field for adapter wizard (vertical layout)
  - `layers/features/relay/ui/wizard/ConfigureStep.tsx` — Wizard step consuming ConfigFieldInput
  - `layers/features/relay/ui/IdentityTab.tsx`, `CapabilitiesTab.tsx` — Relay settings with inline row patterns
  - `layers/features/mesh/ui/ServerTab.tsx` — Mesh settings with inline row patterns
  - `layers/shared/ui/tunnel-dialog.tsx` — Tunnel settings with inline row patterns

- **Shared dependencies:**
  - `layers/shared/ui/` — Shadcn primitives (Input, Textarea, Switch, Select, Label, Checkbox, RadioGroup)
  - `layers/shared/lib/cn.ts` — Tailwind class merge utility
  - `lucide-react` — Icons (Eye, EyeOff for password toggle)

- **Data flow:**
  - Settings: `useState` per field → onChange handler → live state update (no submit)
  - Wizard: `ConfigDescriptor[]` from adapter manifest → `ConfigFieldInput` renders per descriptor → form state via `useState` in ConfigureStep → submitted on wizard completion
  - Both patterns are controlled components with direct state binding

- **Feature flags/config:** None identified

- **Potential blast radius:**
  - Direct: ~15 files across settings, relay, mesh, and shared layers
  - Indirect: Any component importing from `@/layers/shared/ui` barrel (barrel re-export addition only)
  - Tests: Settings tab tests, ConfigFieldInput tests, new component tests
  - Dev playground: New Forms page showcases (already created)

## 4) Root Cause Analysis

N/A — this is a feature/standardization task, not a bug fix.

## 5) Research

### Potential Solutions

**1. Install Shadcn Field + Extract SettingRow + Extract PasswordInput (Recommended)**

- Description: Install the Shadcn Field primitive system (10 sub-components with orientation prop), build `SettingRow` on top of `<Field orientation="horizontal">`, extract `PasswordInput` as a standalone shared component, then incrementally migrate all 26+ inline patterns.
- Pros:
  - Shadcn Field provides accessible, composable primitives out of the box (aria-describedby, error states, label association)
  - `orientation` prop (vertical | horizontal | responsive) maps perfectly to our two layout needs
  - SettingRow becomes a thin wrapper: `<Field orientation="horizontal">` + our specific styling
  - PasswordInput becomes reusable across settings and wizard contexts
  - Incremental migration — can replace inline patterns one file at a time
  - Container query support via `orientation="responsive"` for future responsive layouts
- Cons:
  - Adds ~10 new files to shared/ui (Shadcn Field sub-components)
  - Need to verify FieldError horizontal positioning bug (#8388) doesn't affect our use
  - Migration touches many files (but each change is mechanical and low-risk)
- Complexity: Medium
- Maintenance: Low (Shadcn components are copy-pasted, not npm dependencies)

**2. Extract SettingRow Without Shadcn Field**

- Description: Extract the existing `SettingRow` pattern directly to `shared/ui` as a standalone component without adopting Shadcn Field.
- Pros:
  - Faster initial implementation
  - No new Shadcn components to install
  - Exact same API as the current private component
- Cons:
  - Misses accessibility benefits (aria-describedby, label-for association)
  - No foundation for error states, descriptions, or orientation variants
  - Would need to be rebuilt later when Shadcn Field is adopted for other reasons
  - Doesn't solve the vertical form field layout standardization
- Complexity: Low
- Maintenance: Medium (custom component to maintain, may need rebuilding)

**3. Adopt TanStack Form + Shadcn Field**

- Description: Install TanStack Form v1 as the form state management library alongside Shadcn Field for the presentation layer.
- Pros:
  - React Compiler compatible (unlike react-hook-form v7)
  - Provides validation, submission, dirty tracking, error handling
  - Would be the right choice when a second multi-step wizard is needed
- Cons:
  - Overkill for settings (live-binding with no submit lifecycle)
  - Only one wizard exists currently (adapter setup)
  - Adds complexity and learning curve
  - Can be adopted later when actually needed
- Complexity: High
- Maintenance: Medium

### Security Considerations

- PasswordInput must never log or expose values in React DevTools beyond what's necessary
- Sentinel mode (ConfigFieldInput's current behavior of only sending changed password values) must be preserved in extracted PasswordInput

### Performance Considerations

- Shadcn Field components are lightweight wrappers — no performance impact
- SettingRow extraction reduces bundle duplication (26 inline copies → 1 shared component)
- No re-render concerns — all patterns already use controlled components with `useState`

### Recommendation

**Recommended Approach:** Install Shadcn Field + Extract SettingRow + Extract PasswordInput

**Rationale:**
Shadcn Field provides the exact primitives we need (orientation-aware layout, accessible label/description/error association) and aligns with our existing Shadcn-based design system. Building SettingRow as a thin wrapper on `<Field orientation="horizontal">` gives us accessibility for free while maintaining the exact same visual pattern. The migration is mechanical and low-risk — each inline pattern replacement is a 1:1 swap.

**Caveats:**

- TanStack Form should be revisited when a second multi-step wizard is introduced
- The FieldError horizontal positioning bug (#8388) should be verified before relying on error display in horizontal layouts

## 6) Decisions

| #   | Decision                   | Choice                                             | Rationale                                                                                                                                                                                                      |
| --- | -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Form library adoption      | None (defer TanStack Form)                         | Settings use live-binding with no submit lifecycle; only one wizard exists. Revisit when a second wizard is needed.                                                                                            |
| 2   | Foundation primitives      | Shadcn Field (10 sub-components)                   | Provides accessible, orientation-aware field layout matching both our horizontal (settings) and vertical (wizard) patterns. Already compatible with React 19 + Tailwind 4 + new-york style.                    |
| 3   | SettingRow implementation  | Thin wrapper on `<Field orientation="horizontal">` | Preserves the exact same visual pattern while adding accessibility (aria-describedby, label-for). Mechanical 1:1 migration from 26+ inline copies.                                                             |
| 4   | PasswordInput extraction   | Standalone shared/ui component                     | Currently ~50 lines inline in ConfigFieldInput. Needed by both settings and wizard contexts. Eye/eye-off toggle, sentinel mode, trim behavior, pattern validation on blur.                                     |
| 5   | Compound components        | Not needed                                         | Flat props API is sufficient. SettingRow takes `label`, `description`, `children` — no need for `<SettingRow.Label>` slots. Compound components add API surface without proportional benefit at current scale. |
| 6   | ConfigFieldInput migration | Incremental, keep descriptor-driven architecture   | Rebuild internal rendering on Shadcn Field primitives; keep the public API (`descriptor` + `value` + `onChange`) unchanged.                                                                                    |
| 7   | Layout convention          | Horizontal for settings, vertical for wizards      | This matches current patterns. Shadcn Field's `orientation` prop formalizes what was previously implicit.                                                                                                      |
