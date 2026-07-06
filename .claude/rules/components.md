---
paths: apps/client/src/**/*.tsx
---

# UI Component Rules

These rules apply to all React components in `apps/client/src/`.

## FSD Layer Awareness

| Location                | Layer    | Can Import From                        |
| ----------------------- | -------- | -------------------------------------- |
| `layers/shared/ui/`     | shared   | Nothing in layers/ (Shadcn primitives) |
| `layers/entities/*/ui/` | entities | `shared/` only                         |
| `layers/features/*/ui/` | features | `entities/`, `shared/`                 |
| `layers/widgets/*/ui/`  | widgets  | `features/`, `entities/`, `shared/`    |

See `.claude/rules/fsd-layers.md` for full import rules. Always import from barrel `index.ts` files, never internal paths.

## Composition: Radix + `asChild`

The client uses **Radix UI** primitives with `asChild` composition (the standard shadcn pattern, ~144 uses). Use Radix/`asChild` in new code — there is no Base UI in this app.

```tsx
<Button asChild>
  <a href="/contact">Contact</a>
</Button>
```

## Required Patterns

- **Shadcn primitives** (`layers/shared/ui/`): follow the existing files — `cva` variants, `data-slot="component-name"` attribute on the root element, `cn()` for class merging, export both the component and its `componentVariants`.
- **`cn()` from `@/layers/shared/lib`** for all conditional/merged classes; caller `className` goes last so it can override.
- **Focus styles**: `focus-visible:` (keyboard only), never bare `focus:`.
- **Deterministic values**: never `Math.random()` in components — derive stable pseudo-random values from `React.useId()`.
- **React 19 refs**: `ref` is a regular prop — new components take `ref` in props, no `forwardRef`. Existing `forwardRef` in `ui/` is fine; don't add more.

## Accessibility

- Icon-only buttons need `aria-label`; link text describes the destination (never "click here").
- Form inputs pair with `<Label htmlFor>`.
- Use semantic elements (`nav`, `main`, `article`, `aside`, `header`, `footer`) and a proper heading hierarchy (`h1` → `h2` → `h3`).

## Design System: Calm Tech

See `contributing/design-system.md`. Client ground truth (`apps/client/src/index.css`):

| Element             | Specification                                         |
| ------------------- | ----------------------------------------------------- |
| Base radius token   | `--radius: 0.5rem` (8px)                              |
| Cards/panels radius | 8px (`rounded-lg`)                                    |
| Button/Input radius | `rounded-md`                                          |
| Button height       | 36px default (`h-9`); `sm` 32px, `lg` 40px, `xs` 24px |
| Animation duration  | 100-300ms                                             |

### Custom Utilities

The client's `index.css` defines these `@utility` classes (ported from the site's design system in DOR-191), alongside `animate-drain`. They are dark-mode-aware: shadows read from the `--elevation-*` scale and colors from HSL tokens that swap under `.dark`.

| Utility                                                                | Effect                                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `shadow-soft` · `shadow-elevated` · `shadow-floating` · `shadow-modal` | Elevation scale (`--elevation-*` tokens)                                                      |
| `card-interactive`                                                     | Hover lift: elevated shadow + firmer border. Pair with `bg-card`, a border, and `shadow-soft` |
| `focus-ring`                                                           | Keyboard focus ring on `:focus-visible` (2px background gap + 2px accent ring)                |
| `container-default`                                                    | Centered 56rem column with responsive gutters                                                 |

Still **site-only** (not ported; port the `@utility` into `apps/client/src/index.css` before using them in `apps/client`): `container-narrow`, `container-wide`, `glass`, and `glass-card`.

## Data Tables

Use `<Table>` primitives for structured columnar data — never flex-based row layouts for tabular data.

| Data Shape                                  | Use                               |
| ------------------------------------------- | --------------------------------- |
| Columnar data (rows × columns)              | `Table` primitives or `DataTable` |
| Sortable/filterable data                    | `DataTable` + TanStack Table      |
| Card-based items (expandable, rich content) | Cards/custom layout               |
| Sidebar lists (sessions, navigation)        | `SidebarMenu`                     |

- `Table` primitives and `DataTable` (generic TanStack Table wrapper: pass `columns`, `data`, optional `tableOptions` for sorting/selection/pagination) live in `@/layers/shared/ui`.
- Column definitions and data-fetching hooks live in the feature module that uses them.
- Table showcase at `/dev/tables`.

## Anti-Patterns (Never Do)

```typescript
// NEVER use inline styles
<div style={{ marginTop: 20 }} />  // Wrong
<div className="mt-5" />           // Correct

// NEVER hardcode colors
<div className="bg-[#3b82f6]" />   // Wrong
<div className="bg-primary" />     // Correct

// NEVER skip className merging
<Button className={variant === 'large' ? 'text-lg' : ''} />  // Wrong
<Button className={cn(variant === 'large' && 'text-lg')} />  // Correct
```

## File Naming

| Type           | Convention | Example              |
| -------------- | ---------- | -------------------- |
| Component file | PascalCase | `UserCard.tsx`       |
| Utility file   | kebab-case | `use-sidebar.ts`     |
| Index exports  | `index.ts` | Re-export public API |
