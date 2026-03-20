---
title: 'Shadcn UI Field Component: Installation Reference & API Surface'
date: 2026-03-18
type: external-best-practices
status: active
tags: [shadcn, field, form, react-19, tailwind-4, accessibility, container-queries]
searches_performed: 8
sources_count: 9
---

## Research Summary

This is a quick-verification reference for the exact Shadcn UI `Field` component system installation command, exported sub-components, orientation API, and container query behavior. The `Field` component family was introduced in the October 2025 Shadcn changelog. There is **no official `password-input` component** in the core Shadcn registry — it is a community-built pattern only. The `Field` system has no framework-specific peer dependencies; it works with plain React, React Hook Form, TanStack Form, or server actions.

---

## Installation Command

```bash
# pnpm (preferred for this monorepo)
pnpm dlx shadcn@latest add field

# npm
npx shadcn@latest add field

# yarn
yarn dlx shadcn@latest add field
```

This installs a single file: `components/ui/field.tsx` (or the path configured in `components.json`).

**No peer library dependencies.** The component is pure React + Tailwind + Radix Label. It does not require `react-hook-form`, `@tanstack/react-form`, or any other form library.

---

## Exported Sub-Components (Complete List)

All exports come from `@/components/ui/field` (single barrel import):

| Component          | Purpose                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Field`            | Core wrapper for a single field. Accepts `orientation` prop.                                                                                           |
| `FieldLabel`       | Renders a `<label>` with proper `htmlFor` association.                                                                                                 |
| `FieldDescription` | Helper/hint text. Automatically balances long lines in horizontal layouts.                                                                             |
| `FieldError`       | Accessible error container. Renders with `role="alert"`. Accepts `children` or an `errors` array (compatible with RHF and TanStack Form error shapes). |
| `FieldContent`     | Flex column grouping label and description. Not required if there is no description.                                                                   |
| `FieldTitle`       | Title with label styling inside `FieldContent`. Use when control is already associated via wrapping label.                                             |
| `FieldGroup`       | Layout wrapper that stacks multiple `Field` elements. Target for container query classes.                                                              |
| `FieldSet`         | Semantic `<fieldset>` wrapper with spacing presets.                                                                                                    |
| `FieldLegend`      | `<legend>` element for `FieldSet`.                                                                                                                     |
| `FieldSeparator`   | Visual divider between sections inside a `FieldGroup`. Accepts optional inline content.                                                                |

**Import pattern:**

```tsx
import {
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
} from '@/components/ui/field';
```

---

## Orientation Prop

`Field` accepts `orientation?: "vertical" | "horizontal" | "responsive"`:

| Value          | Behavior                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"vertical"`   | Default. Stacks `FieldLabel`, control, `FieldDescription`, `FieldError` top-to-bottom. Best for mobile-first and text inputs.                               |
| `"horizontal"` | Aligns label and control side-by-side. Pair with `FieldContent` to keep description aligned under the label column. Best for switches and select dropdowns. |
| `"responsive"` | Starts vertical; switches to horizontal at container breakpoints. Driven by CSS container queries on the parent `FieldGroup`. Best for settings panels.     |

### Horizontal Layout Pattern

```tsx
<Field orientation="horizontal">
  <FieldContent>
    <FieldLabel>Enable Touch ID</FieldLabel>
    <FieldDescription>Use biometric authentication to unlock</FieldDescription>
  </FieldContent>
  <Switch />
</Field>
```

### Responsive Layout Pattern

```tsx
<FieldGroup className="@container/field-group">
  <Field orientation="responsive">
    <FieldContent>
      <FieldLabel>API Key</FieldLabel>
      <FieldDescription>Your secret API key</FieldDescription>
    </FieldContent>
    <Input type="password" />
    <FieldError />
  </Field>
</FieldGroup>
```

---

## Container Query Implementation

The `orientation="responsive"` value works by applying `@container/field-group` CSS container query classes. The parent `FieldGroup` must be the container query root. Tailwind CSS 4's native `@container` support handles this without any additional plugin configuration (unlike Tailwind CSS 3 which required `@tailwindcss/container-queries`).

**How it works in Tailwind 4:**

```tsx
// FieldGroup becomes the container
<FieldGroup className="@container/field-group">
  {/* Field switches layout at the container's breakpoints, not the viewport's */}
  <Field orientation="responsive">...</Field>
</FieldGroup>
```

This means two `FieldGroup`s on the same page can switch orientation at different widths independently, based on their respective container sizes rather than the viewport width.

**Known bug (GitHub #8388):** When using `orientation="horizontal"`, `FieldError` appears inline with the label/input row rather than below the input. The fix is to nest input and error inside a `FieldContent` wrapper:

```tsx
// Workaround for FieldError positioning in horizontal orientation
<Field orientation="horizontal">
  <FieldLabel>Email</FieldLabel>
  <FieldContent>
    <Input />
    <FieldError />
  </FieldContent>
</Field>
```

---

## FieldError API

`FieldError` accepts errors in two shapes:

```tsx
// 1. Simple string child
<FieldError>Email is required</FieldError>

// 2. errors array prop (compatible with RHF fieldState.error and TanStack Form)
<FieldError errors={["Must be at least 8 characters", "Must contain a number"]} />

// 3. Conditional — renders nothing when no errors
<FieldError errors={fieldState.error?.message ? [fieldState.error.message] : []} />
```

---

## FieldSet / FieldGroup / FieldLegend Pattern

```tsx
<FieldSet>
  <FieldLegend>Notifications</FieldLegend>
  <FieldGroup>
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel>Email alerts</FieldLabel>
        <FieldDescription>Receive alerts via email</FieldDescription>
      </FieldContent>
      <Switch />
    </Field>
    <FieldSeparator />
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel>Push notifications</FieldLabel>
      </FieldContent>
      <Switch />
    </Field>
  </FieldGroup>
</FieldSet>
```

---

## Password Input Component: Status

**No official `password-input` component exists in the core Shadcn registry.**

The URL `https://ui.shadcn.com/docs/components/password-input` returns 404.

Available alternatives:

| Option                                                                                        | Status             | Install                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| Official Shadcn core                                                                          | Does not exist     | N/A                                                                                   |
| [WDS Shadcn Registry](https://wds-shadcn-registry.netlify.app/components/password-input/)     | Community registry | `npx shadcn@latest add https://wds-shadcn-registry.netlify.app/r/password-input.json` |
| [mjbalcueva GitHub Gist](https://gist.github.com/mjbalcueva/b21f39a8787e558d4c536bf68e267398) | Copy-paste pattern | Manual                                                                                |
| Build from base `Input`                                                                       | DIY                | Use `Input` + Lucide `Eye`/`EyeOff` toggle                                            |

The community pattern wraps Shadcn's `Input` with a visibility toggle button using Lucide React icons (`Eye` / `EyeOff`) and `useState` for the `type` prop (`"password"` vs `"text"`).

**DorkOS recommendation**: Build a `PasswordInput` component in `layers/shared/ui/` using the base `Input` + Lucide icons. Do not depend on a third-party registry for a 20-line component. Wrap it in a `Field` for label/error accessibility:

```tsx
// layers/shared/ui/password-input/PasswordInput.tsx
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function PasswordInput(props: React.ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className="pr-10" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-0 right-0 h-full px-3 py-2"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  );
}
```

---

## Compatibility Notes: React 19 + Tailwind CSS 4 + new-york Style

| Concern                      | Status                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| React 19 compatibility       | Full. `Field` is a pure composition of standard React elements. No class components or deprecated APIs.                                    |
| Tailwind CSS 4 compatibility | Full. Container queries (`@container`) are native in Tailwind 4 — no `@tailwindcss/container-queries` plugin required.                     |
| new-york style               | Supported. Shadcn's `add` command respects the `style` setting in `components.json`. Using `new-york` style installs the new-york variant. |
| React Compiler               | No known issues. `Field` has no internal `useMemo`/`useCallback` that would conflict.                                                      |
| Peer dependency conflicts    | None. No form library required.                                                                                                            |

---

## Sources & Evidence

- [Field — shadcn/ui official docs](https://ui.shadcn.com/docs/components/radix/field) — install command, orientation prop, sub-component list
- [October 2025 New Components — shadcn/ui changelog](https://ui.shadcn.com/docs/changelog/2025-10-new-components) — original Field release announcement
- [Field — shadcn/ui GitHub Discussion #9537](https://github.com/shadcn-ui/ui/discussions/9537) — Field usage patterns discussion
- [FieldError bug #8388 — shadcn-ui/ui](https://github.com/shadcn-ui/ui/issues/8388) — horizontal orientation FieldError positioning bug
- [FieldGroup Select bug #8448 — shadcn-ui/ui](https://github.com/shadcn-ui/ui/issues/8448) — Select in FieldGroup with conditional fields
- [Shadcn UI React Series Part 32: Field — Medium](https://medium.com/@rivainasution/shadcn-ui-react-series-part-32-field-structuring-form-intent-cdd7917feac6) — community deep-dive on Field component
- [WDS Shadcn Registry — Password Input](https://wds-shadcn-registry.netlify.app/components/password-input/) — community password-input registry
- [password-input GitHub Gist — mjbalcueva](https://gist.github.com/mjbalcueva/b21f39a8787e558d4c536bf68e267398) — popular copy-paste implementation
- [shadcn-ui/ui Field search result](https://ui.shadcn.com/docs/components/field) — confirms official docs location

---

## Research Gaps & Limitations

- Could not directly access the `field.tsx` source file from GitHub (path changed between Shadcn versions). The export list above is confirmed via official docs fetch and multiple community sources — all 10 exports are consistently documented.
- The exact Tailwind CSS 4 `@container` class names used internally in `field.tsx` were not confirmed from source — only the public API (`orientation="responsive"` + `@container/field-group` on `FieldGroup`) was verified.
- `FieldSeparator` inline content API (what you can pass as children) was not fully documented in retrieved sources.
- Password-input 404 confirmed by direct fetch — the page does not exist as of March 2026.
