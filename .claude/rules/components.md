---
paths: apps/client/src/**/*.tsx
---

# UI Component Rules

These rules apply to all React components in `apps/client/src/`.

Picking a primitive? Start at [`shared/ui/README.md`](../../apps/client/src/layers/shared/ui/README.md) — which overlay, row, or form control to reach for, before writing a new one.

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

- **Shadcn primitives** (`layers/shared/ui/`): follow the existing files — `cva` variants, `data-slot="component-name"` attribute on the root element AND on every sub-part, `cn()` for class merging, export both the component and its `componentVariants`, plus its `*Props` type on the barrel (a test pins that last one). `data-slot` is a styling and testing seam, not decoration: `field.tsx` selects on `[data-slot=field-label]`, the sidebar's browser tests address `[data-slot="sidebar-row-title"]`, and `index.css` hides a scrollbar by `data-slot` because a utility class could not beat an unlayered global.
- **`cn()` from `@/layers/shared/lib/utils`** for all conditional/merged classes; caller `className` goes last so it can override. Inside `shared/` that leaf path is the ONLY spelling — see `.claude/rules/fsd-layers.md`; from `entities/`, `features/` and `widgets/` the `@/layers/shared/lib` barrel is fine.
- **Focus styles**: `focus-visible:` (keyboard only), never bare `focus:`.
- **Deterministic values**: never `Math.random()` in components — derive stable pseudo-random values from `React.useId()`.
- **React 19 refs**: `ref` is a regular prop — components take `ref` in props, never `forwardRef`. `shared/ui/` has none left, so the grandfather clause is gone (DOR-1761): a `forwardRef` in a diff is a mistake, not a leftover. A named `function` needs no `displayName` either; the ones still in `ui/` are leftovers, not a pattern to copy.
- **Compound components use flat sibling exports** (`CardHeader`, `DialogContent`, `FieldLabel`) — the shadcn convention every other multi-part primitive follows (`card.tsx`, `dialog.tsx`, `field.tsx`, `navigation-layout.tsx`, `sidebar.tsx`, `table.tsx`). Don't reach for an `Object.assign` namespace (`FilterBar.Search`); `filter-bar/` predates this rule and stays as it is.
- **Sizes are one ordinal scale** — `xs · sm · md · lg`, with `md` the default and `icon-*` its square twin. No token named `default`: it says nothing about how big the thing is, and `<Button size="default">` beside `<Switch size="md">` used to be two controls that did not line up (DOR-1761). When the axis genuinely is not "how big", name the pair for what it is (`compact | comfortable`) and say why in its TSDoc.

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

Still **site-only** (not ported; port the `@utility` into `apps/client/src/index.css` before using them in `apps/client`): `container-narrow`, `container-wide`, `container-default`, `glass`, and `glass-card`.

### Page width

Page-level width is not a utility class: wrap the route's content in `<PageContainer width="full | wide | reading">` from `layers/shared/ui` (DOR-1047). `wide` caps at `--page-width-wide` (80rem) — the default for top-level pages (dashboards, directories, feeds); `reading` at `--page-width-reading` (56rem) — true forms and prose only, never directories (DOR-1082); `full` fills the pane. It owns the page scroller by default (`scroll={false}` for pages whose list scrolls internally) and always includes `w-full`, so it cannot shrink-wrap inside a flex parent. Never hand-roll `mx-auto max-w-*` page wrappers. Chat/room surfaces are the exception — their width system is the `--msg-*` token family.

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

`layers/shared/ui/` is the exception: files are kebab-case regardless of
shadcn-vs-custom origin (`button.tsx`, `mention-pill.tsx`, `trust-dial.tsx`).
Only the component's own PascalCase name changes inside the file. The
`filter-bar/`, `form-fields/`, and `tour-spotlight/` subdirectories, plus five
standalone files (`ConnectionStatusBanner.tsx`, `DirectoryPicker.tsx`,
`FeatureDisabledState.tsx`, `PromptSuggestionChips.tsx`, `ScanLine.tsx`), keep
PascalCase filenames and stay that way — they predate this rule.
