---
slug: form-field-standardization
number: 146
created: 2026-03-18
status: draft
---

# Form Field Standardization

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-18
**Ideation:** `specs/form-field-standardization/01-ideation.md`

---

## 1. Overview

Install Shadcn Field primitives and extract reusable `SettingRow` and `PasswordInput` components to `shared/ui`. Replace 26+ inline reimplementations of the horizontal settings row pattern across settings, relay, mesh, and shared layers. Rebuild `ConfigFieldInput` internals on Field primitives while preserving its public API.

## 2. Background / Problem Statement

DorkOS has a consistent visual pattern for settings rows — label + description on the left, control on the right — but **no shared component** for it. The pattern is reimplemented inline across 26+ locations using raw `flex items-center justify-between gap-4` divs. This creates:

- **Maintenance burden**: Styling changes require touching 15+ files
- **Inconsistency risk**: Minor variations creep in (some use `space-y-0.5`, others `min-w-0`, some omit gap)
- **Accessibility gaps**: No `aria-describedby` association between descriptions and controls, no `htmlFor` on labels in many inline patterns
- **Password input duplication**: The eye/eye-off toggle with sentinel mode is ~50 lines inline in `ConfigFieldInput` with no reuse path

Additionally, the `ContextBlockSection` in `agent-settings/ui/ContextTab.tsx` and `ToolBlockSection` in `settings/ui/ToolsTab.tsx` are near-identical duplicate components (~40 lines each) that should share a common base.

## 3. Goals

- Install Shadcn Field as the foundation for all form field layouts
- Extract `SettingRow` to `shared/ui` as a thin wrapper on `<Field orientation="horizontal">`
- Extract `PasswordInput` to `shared/ui` with eye toggle, sentinel mode, and trim behavior
- Replace all 26+ inline settings row patterns with `<SettingRow>`
- Rebuild `ConfigFieldInput` internals on Field primitives (public API unchanged)
- Add component tests and dev playground showcases for new components
- Improve accessibility: proper `aria-describedby`, `htmlFor`, and `role="alert"` for errors

## 4. Non-Goals

- Adopting react-hook-form or TanStack Form (revisit when a second multi-step wizard is needed)
- Redesigning the adapter wizard flow or `ConfigFieldInput`'s descriptor-driven architecture
- Creating compound components (`SettingRow.Label`, etc.) — flat props API is sufficient
- Adding form validation beyond what `ConfigFieldInput` already provides
- Migrating non-settings-row patterns (AgentCard rows, ConversationRow, PulsePanel header)
- Extracting the debounce pattern repeated in IdentityTab/CapabilitiesTab/PersonaTab (separate concern)
- Replacing raw `<input>` elements in agent-settings tabs with `<Input>` (separate cleanup)

## 5. Technical Dependencies

| Dependency               | Version                                         | Notes                                          |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------- |
| Shadcn Field             | Latest (via `pnpm dlx shadcn@latest add field`) | Copy-pasted, not npm dependency                |
| React                    | ^19.0.0                                         | Already installed                              |
| Tailwind CSS             | ^4.0.0                                          | Already installed; native `@container` support |
| class-variance-authority | ^0.7.1                                          | Already installed; used by Shadcn primitives   |
| lucide-react             | latest                                          | Already installed; provides Eye/EyeOff icons   |

**Shadcn configuration** (`apps/client/components.json`):

- Style: `new-york`
- Base color: `zinc`
- Aliases: `components` → `@/layers/shared/ui`, `utils` → `@/layers/shared/lib/utils`
- Icon library: `radix`

The `add field` command respects these aliases and writes to `apps/client/src/layers/shared/ui/field.tsx`.

## 6. Detailed Design

### 6.1 Install Shadcn Field

```bash
cd apps/client && pnpm dlx shadcn@latest add field
```

This creates `apps/client/src/layers/shared/ui/field.tsx` with 10 exports:

| Component          | Purpose                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `Field`            | Core wrapper with `orientation` prop (`vertical` / `horizontal` / `responsive`) |
| `FieldLabel`       | `<label>` with `htmlFor` association                                            |
| `FieldDescription` | Helper text with `aria-describedby`                                             |
| `FieldError`       | Error container with `role="alert"`; accepts `children` or `errors` array       |
| `FieldContent`     | Flex-column grouper for label + description                                     |
| `FieldTitle`       | Title variant of label inside `FieldContent`                                    |
| `FieldGroup`       | Stacks multiple `Field` elements; container query root                          |
| `FieldSet`         | Semantic `<fieldset>` wrapper                                                   |
| `FieldLegend`      | `<legend>` for `FieldSet`                                                       |
| `FieldSeparator`   | Visual divider between fields                                                   |

Add all exports to `apps/client/src/layers/shared/ui/index.ts`.

### 6.2 Create SettingRow

**File:** `apps/client/src/layers/shared/ui/setting-row.tsx`

```tsx
import * as React from 'react';
import { Field, FieldContent, FieldDescription, FieldLabel } from './field';
import { cn } from '@/layers/shared/lib';

interface SettingRowProps {
  /** Label text displayed on the left. */
  label: string;
  /** Description text below the label. */
  description: string;
  /** Control element (Switch, Button, Select, etc.) rendered on the right. */
  children: React.ReactNode;
  /** Optional className for the outer Field wrapper. */
  className?: string;
}

/**
 * Horizontal settings row — label and description on the left, control on the right.
 *
 * Built on Shadcn Field with `orientation="horizontal"` for accessible
 * label/description association.
 */
function SettingRow({ label, description, children, className }: SettingRowProps) {
  return (
    <Field orientation="horizontal" className={cn('items-center justify-between gap-4', className)}>
      <FieldContent className="min-w-0">
        <FieldLabel className="text-sm font-medium">{label}</FieldLabel>
        <FieldDescription className="text-xs">{description}</FieldDescription>
      </FieldContent>
      {children}
    </Field>
  );
}

export { SettingRow };
export type { SettingRowProps };
```

**Visual equivalence check:** The rendered DOM must produce the same visual output as:

```tsx
<div className="flex items-center justify-between gap-4">
  <div className="min-w-0">
    <Label className="text-sm font-medium">{label}</Label>
    <p className="text-muted-foreground text-xs">{description}</p>
  </div>
  {children}
</div>
```

If Shadcn Field's default `orientation="horizontal"` styling doesn't produce `flex items-center justify-between`, the `className` prop on `<Field>` must override to match. Verify after installation by comparing rendered output.

### 6.3 Create PasswordInput

**File:** `apps/client/src/layers/shared/ui/password-input.tsx`

```tsx
import * as React from 'react';
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input, type InputProps } from './input';
import { Button } from './button';
import { cn } from '@/layers/shared/lib';

interface PasswordInputProps extends Omit<InputProps, 'type'> {
  /** Controlled visibility state. When provided, component is controlled. */
  showPassword?: boolean;
  /** Callback when visibility toggle is clicked (controlled mode). */
  onShowPasswordChange?: (show: boolean) => void;
  /** Initial visibility state for uncontrolled mode. Defaults to false. */
  visibleByDefault?: boolean;
}

/**
 * Password input with eye/eye-off visibility toggle.
 *
 * Supports both controlled (`showPassword` + `onShowPasswordChange`) and
 * uncontrolled (`visibleByDefault`) modes.
 */
function PasswordInput({
  className,
  showPassword: controlledShow,
  onShowPasswordChange,
  visibleByDefault = false,
  ...props
}: PasswordInputProps) {
  const [internalShow, setInternalShow] = useState(visibleByDefault);
  const isControlled = controlledShow !== undefined;
  const isVisible = isControlled ? controlledShow : internalShow;

  const toggleVisibility = () => {
    if (isControlled) {
      onShowPasswordChange?.(!controlledShow);
    } else {
      setInternalShow((prev) => !prev);
    }
  };

  return (
    <div className="relative">
      <Input type={isVisible ? 'text' : 'password'} className={cn('pr-10', className)} {...props} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="absolute top-0 right-0 h-full px-3"
        onClick={toggleVisibility}
        aria-label={isVisible ? 'Hide password' : 'Show password'}
      >
        {isVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

export { PasswordInput };
export type { PasswordInputProps };
```

**Note on sentinel mode:** Sentinel behavior (clearing on focus, showing "Saved — enter a new one to replace") is a _consumer concern_, not a PasswordInput concern. The calling code passes `onFocus`, `placeholder`, and `value` props. PasswordInput just handles visibility toggling.

### 6.4 Update Shared UI Barrel

Add to `apps/client/src/layers/shared/ui/index.ts`:

```tsx
// After existing exports...
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from './field';
export { PasswordInput } from './password-input';
export type { PasswordInputProps } from './password-input';
export { SettingRow } from './setting-row';
export type { SettingRowProps } from './setting-row';
```

### 6.5 Migrate Inline SettingRow Patterns

Each migration follows the same mechanical pattern:

**Before:**

```tsx
<div className="flex items-center justify-between gap-4">
  <div className="min-w-0">
    <Label className="text-sm font-medium">Cross-client sync</Label>
    <p className="text-muted-foreground text-xs">
      Real-time updates from other clients and presence indicators
    </p>
  </div>
  <Switch checked={value} onCheckedChange={handler} />
</div>
```

**After:**

```tsx
<SettingRow
  label="Cross-client sync"
  description="Real-time updates from other clients and presence indicators"
>
  <Switch checked={value} onCheckedChange={handler} />
</SettingRow>
```

#### Migration targets (by priority)

**Priority 1 — Settings feature:**

| File                                        | Patterns                        | Notes                                            |
| ------------------------------------------- | ------------------------------- | ------------------------------------------------ |
| `features/settings/ui/SettingsDialog.tsx`   | 1 (delete private `SettingRow`) | Replace import, delete function at lines 338-356 |
| `features/settings/ui/tabs/AdvancedTab.tsx` | 4                               | Lines 31-42, 46-57, 66-80, 84-98                 |
| `features/settings/ui/tabs/ToolsTab.tsx`    | 1 (`ToolBlockSection`)          | Replace flex row inside the section component    |
| `features/settings/ui/tabs/PersonaTab.tsx`  | 1                               | Enable persona toggle row                        |
| `features/settings/ui/TunnelDialog.tsx`     | 1                               | Auth toggle at bottom                            |

**Priority 2 — Agent settings feature:**

| File                                             | Patterns                  | Notes                                     |
| ------------------------------------------------ | ------------------------- | ----------------------------------------- |
| `features/agent-settings/ui/ContextTab.tsx`      | 1 (`ContextBlockSection`) | Replace flex row inside section component |
| `features/agent-settings/ui/CapabilitiesTab.tsx` | 1+ (`ToolGroupRow`)       | Replace flex row in the sub-component     |

**Priority 3 — Relay feature:**

| File                                     | Patterns    | Notes                                     |
| ---------------------------------------- | ----------- | ----------------------------------------- |
| `features/relay/ui/ConfigFieldInput.tsx` | 0 (Phase 3) | Uses vertical layout — handled separately |

**Priority 4 — Mesh and shared:**

| File                             | Patterns | Notes             |
| -------------------------------- | -------- | ----------------- |
| `features/mesh/ui/ServerTab.tsx` | 1+       | Tunnel manage row |
| `shared/ui/tunnel-dialog.tsx`    | 1        | Auth toggle       |

**Important:** Some inline patterns have **additional elements** beyond label + description + control (e.g., conditional badges in `ToolBlockSection`, reset buttons in `IdentityTab`). For these, the `children` prop accommodates wrapping multiple elements:

```tsx
<SettingRow label="Tool group" description="Enable/disable tool access">
  <div className="flex items-center gap-2">
    {!available && <Badge variant="secondary">{unavailableReason}</Badge>}
    <Switch checked={enabled} onCheckedChange={onToggle} disabled={!available} />
  </div>
</SettingRow>
```

For patterns that **don't match** the SettingRow shape (e.g., AdvancedTab danger zone rows that use `<p>` instead of `<Label>`, or IdentityTab color/icon pickers), use `<Field orientation="horizontal">` directly rather than forcing them into `SettingRow`.

### 6.6 Rebuild ConfigFieldInput on Field Primitives

Replace the manual layout wrapper in `ConfigFieldInput` with Shadcn Field:

**Before (lines 221-252):**

```tsx
return (
  <div className="space-y-2">
    <Label htmlFor={fieldId} className={cn(...)}>
      {field.label}
    </Label>
    {renderControl()}
    {field.description && (
      <p className="text-xs text-muted-foreground">{field.description}</p>
    )}
    {/* helpMarkdown collapsible... */}
    {(error ?? patternError) && (
      <p className="text-xs text-red-500">{error ?? patternError}</p>
    )}
  </div>
);
```

**After:**

```tsx
return (
  <Field orientation="vertical">
    <FieldLabel
      htmlFor={fieldId}
      className={cn(
        field.required && !isSentinel && 'after:ml-0.5 after:text-red-500 after:content-["*"]'
      )}
    >
      {field.label}
    </FieldLabel>
    {renderControl()}
    {field.description && <FieldDescription>{field.description}</FieldDescription>}
    {field.helpMarkdown && (
      <Collapsible>{/* ... existing helpMarkdown collapsible unchanged ... */}</Collapsible>
    )}
    <FieldError errors={(error ?? patternError) ? [error ?? patternError] : []} />
  </Field>
);
```

**Password case migration:** Replace the inline password rendering (lines 92-140) to use `PasswordInput`:

```tsx
case 'password': {
  if (isSentinel) {
    return (
      <PasswordInput
        id={fieldId}
        value={stringValue}
        onChange={(e) => {
          onChange(field.key, e.target.value.trim());
          if (patternError) setPatternError('');
        }}
        onFocus={() => onChange(field.key, '')}
        onBlur={handleBlur}
        placeholder="Saved — enter a new one to replace"
        showPassword={false}
      />
    );
  }
  return (
    <PasswordInput
      id={fieldId}
      visibleByDefault={field.visibleByDefault ?? false}
      value={stringValue}
      onChange={(e) => {
        onChange(field.key, e.target.value.trim());
        if (patternError) setPatternError('');
      }}
      onBlur={handleBlur}
      onPaste={() => setTimeout(handleBlur, 0)}
      placeholder={field.placeholder}
    />
  );
}
```

**Note:** The `showPassword` state that currently lives in `ConfigFieldInput` (line 45) is no longer needed — `PasswordInput` manages its own visibility state internally via `visibleByDefault`.

### 6.7 Dev Playground Showcases

**Extend `apps/client/src/dev/showcases/ComposedFormShowcases.tsx`** with two new sections:

**SettingRow showcase:**

- SettingRow with Switch control
- SettingRow with Select control
- SettingRow with destructive Button control
- SettingRow with badge + Switch (compound children)

**PasswordInput showcase:**

- Default (hidden)
- With `visibleByDefault={true}`
- Sentinel mode demonstration (placeholder text, clears on focus)

**Update `apps/client/src/dev/sections/forms-sections.ts`** — add entries:

```tsx
{
  id: 'settingrow',
  title: 'SettingRow',
  page: 'forms',
  category: 'Composed',
  keywords: ['setting', 'row', 'horizontal', 'field', 'switch', 'toggle', 'label', 'description'],
},
{
  id: 'passwordinput',
  title: 'PasswordInput',
  page: 'forms',
  category: 'Composed',
  keywords: ['password', 'input', 'eye', 'toggle', 'visibility', 'sentinel', 'secret'],
},
```

## 7. User Experience

This is an **internal refactoring** — end users see no change. The visual appearance of all settings rows, adapter wizard fields, and tunnel dialogs must remain pixel-identical before and after migration.

Developers benefit from:

- A single `<SettingRow>` import instead of 10+ lines of inline layout
- Accessible form fields by default (no manual aria wiring)
- `PasswordInput` reusable across any feature that needs a secret field

## 8. Testing Strategy

### Unit Tests

**`apps/client/src/layers/shared/ui/__tests__/setting-row.test.tsx`:**

```tsx
/** Verifies SettingRow renders label, description, and child control. */
it('renders label and description text', () => {
  render(
    <SettingRow label="Theme" description="Choose light or dark mode">
      <Switch />
    </SettingRow>
  );
  expect(screen.getByText('Theme')).toBeInTheDocument();
  expect(screen.getByText('Choose light or dark mode')).toBeInTheDocument();
  expect(screen.getByRole('switch')).toBeInTheDocument();
});

/** Verifies accessible label-description association via Field primitives. */
it('associates description with the field via aria-describedby', () => {
  render(
    <SettingRow label="Notifications" description="Enable push alerts">
      <Switch />
    </SettingRow>
  );
  // Shadcn Field automatically sets aria-describedby on the field wrapper
  const description = screen.getByText('Enable push alerts');
  expect(description).toHaveAttribute('id');
});

/** Verifies custom className is applied to the outer wrapper. */
it('applies custom className', () => {
  const { container } = render(
    <SettingRow label="Test" description="Desc" className="border-red-500">
      <Switch />
    </SettingRow>
  );
  expect(container.firstChild).toHaveClass('border-red-500');
});
```

**`apps/client/src/layers/shared/ui/__tests__/password-input.test.tsx`:**

```tsx
/** Verifies password is hidden by default. */
it('renders as password type by default', () => {
  render(<PasswordInput placeholder="Enter password" />);
  expect(screen.getByPlaceholderText('Enter password')).toHaveAttribute('type', 'password');
});

/** Verifies toggle switches between password and text. */
it('toggles visibility on button click', async () => {
  const user = userEvent.setup();
  render(<PasswordInput placeholder="Secret" />);
  const input = screen.getByPlaceholderText('Secret');
  const toggle = screen.getByRole('button', { name: 'Show password' });

  expect(input).toHaveAttribute('type', 'password');
  await user.click(toggle);
  expect(input).toHaveAttribute('type', 'text');
  expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
});

/** Verifies controlled mode respects external state. */
it('respects controlled showPassword prop', () => {
  const onChange = vi.fn();
  render(<PasswordInput showPassword={true} onShowPasswordChange={onChange} />);
  expect(screen.getByRole('textbox')).toHaveAttribute('type', 'text');
});

/** Verifies visibleByDefault sets initial state. */
it('starts visible when visibleByDefault is true', () => {
  render(<PasswordInput visibleByDefault placeholder="Token" />);
  expect(screen.getByPlaceholderText('Token')).toHaveAttribute('type', 'text');
});
```

### Existing Test Updates

Review and update any settings tab tests that assert on specific DOM structure (e.g., querying `div.flex.items-center`). The switch from raw divs to `<Field>` may change the DOM tree. Tests should query by role/text, not class names.

### No E2E Tests Needed

This is a visual-parity refactoring. No new user flows are introduced. The existing Playwright browser tests for settings and adapter wizard cover the user journeys.

## 9. Performance Considerations

- **Bundle size**: Shadcn Field is ~3KB unminified (copy-pasted, tree-shakeable). SettingRow and PasswordInput add ~1KB combined. Net impact after removing 26+ inline patterns: **slight reduction** due to deduplication.
- **Runtime**: No new hooks, state, or effects. Field primitives are thin wrappers over native HTML elements. Zero re-render impact.
- **Container queries**: Only relevant if `orientation="responsive"` is used in the future. No performance cost for `horizontal`/`vertical` modes.

## 10. Security Considerations

- **PasswordInput**: Renders `type="password"` by default. The toggle switches to `type="text"` only when user explicitly clicks. No value logging or exposure in React DevTools beyond what native `<input>` provides.
- **Sentinel mode**: Preserved as a consumer pattern. ConfigFieldInput continues to use `"***"` sentinel value and clear-on-focus behavior. PasswordInput doesn't interpret the value.

## 11. Documentation

- **`contributing/design-system.md`**: Add a "Form Fields" section documenting:
  - `SettingRow` for horizontal settings layouts
  - `PasswordInput` for secret fields
  - `Field` orientation conventions (horizontal for settings, vertical for wizards)
- **Dev playground**: SettingRow and PasswordInput showcases on the Forms page serve as living documentation

## 12. Implementation Phases

### Phase 1: Foundation

1. Install Shadcn Field via CLI
2. Verify generated file matches expectations (10 sub-components, correct aliases)
3. Create `setting-row.tsx` with SettingRow component
4. Create `password-input.tsx` with PasswordInput component
5. Update `shared/ui/index.ts` barrel exports
6. Write component tests for both new components

### Phase 2: Settings Migration

1. Replace private `SettingRow` in `SettingsDialog.tsx` with shared import
2. Migrate `AdvancedTab.tsx` (4 inline patterns)
3. Migrate `ToolsTab.tsx` (`ToolBlockSection` inner row)
4. Migrate `PersonaTab.tsx` (toggle row)
5. Migrate `TunnelDialog.tsx` (auth toggle)
6. Migrate `agent-settings/ui/ContextTab.tsx` (`ContextBlockSection`)
7. Migrate `agent-settings/ui/CapabilitiesTab.tsx` (`ToolGroupRow`)
8. Verify existing tests still pass after each file

### Phase 3: ConfigFieldInput Rebuild

1. Replace outer `<div className="space-y-2">` + `<Label>` + `<p>` with `<Field>` + `<FieldLabel>` + `<FieldDescription>`
2. Replace error `<p>` with `<FieldError>`
3. Replace inline password rendering with `<PasswordInput>`
4. Remove the `showPassword` state from `ConfigFieldInput`
5. Verify ConfigFieldInput tests pass
6. Verify adapter wizard still works end-to-end in the dev playground

### Phase 4: Remaining Migrations + Polish

1. Migrate `mesh/ui/ServerTab.tsx`
2. Migrate `shared/ui/tunnel-dialog.tsx`
3. Add SettingRow and PasswordInput showcases to dev playground Forms page
4. Update `forms-sections.ts` with new entries
5. Update `contributing/design-system.md`
6. Run `pnpm typecheck && pnpm lint` — fix any issues
7. Visual regression check in browser

## 13. Open Questions

No open questions — all decisions were resolved during ideation (see Section 6 of `01-ideation.md`).

## 14. Related ADRs

| ADR      | Title                                             | Relevance                                                                                                                                                                                     |
| -------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0008 | Promote Shared Components for Cross-Feature Reuse | Defines the extraction pattern — components needed by >1 feature must be promoted to shared layer. SettingRow and PasswordInput follow this ADR directly.                                     |
| ADR-0063 | Use Shadcn CommandDialog for Global Agent Palette | Demonstrates successful Shadcn component integration pattern.                                                                                                                                 |
| ADR-0064 | Use Shadcn Sidebar for Standalone Layout          | Shows controlled-mode pattern for bridging Shadcn state to Zustand.                                                                                                                           |
| ADR-0097 | Adopt tailwind-variants for Multi-Slot Components | CVA remains for single-element Shadcn primitives (like Field sub-components); tailwind-variants for multi-slot feature components. SettingRow uses neither — it's a pure composition wrapper. |

## 15. References

- [Shadcn Field documentation](https://ui.shadcn.com/docs/components/radix/field)
- [FieldError horizontal positioning bug #8388](https://github.com/shadcn-ui/ui/issues/8388)
- Research: `research/20260318_shadcn_field_component_reference.md`
- Research: `research/20260318_shadcn_form_patterns_2026.md`
- Ideation: `specs/form-field-standardization/01-ideation.md`
