---
name: styling-with-tailwind-shadcn
description: Implements the Calm Tech design system using Tailwind CSS v4 and Shadcn UI. Use when writing styles, building components, or theming. For design decisions, see designing-frontend.
---

# Styling with Tailwind CSS v4 & Shadcn UI

This skill provides **implementation patterns** for the Calm Tech design system using Tailwind CSS v4 (CSS-first configuration) and shadcn/ui (new-york style) on Radix primitives.

**For design thinking (what/why)**: Use the `designing-frontend` skill.

All tokens and utilities live in `apps/client/src/index.css` (there is no `tailwind.config.js` and no `globals.css` — this is a Vite SPA, not Next.js).

## Current Documentation (Context7)

Tailwind v4 uses CSS-first configuration. For current patterns:

```
# Check installed version
grep '"tailwindcss"' apps/client/package.json

# Fetch Tailwind v4 docs
mcp__context7__resolve-library-id: { libraryName: "tailwindcss" }
mcp__context7__query-docs: {
  context7CompatibleLibraryID: "[resolved-id]",
  topic: "[specific topic, e.g., '@theme directive', 'dark mode', 'custom utilities']"
}

# Fetch Shadcn docs
mcp__context7__resolve-library-id: { libraryName: "shadcn" }
mcp__context7__query-docs: {
  context7CompatibleLibraryID: "[resolved-id]",
  topic: "[component name, e.g., 'Button', 'Form', 'Dialog']"
}
```

**When to fetch docs:**

- Uncertain about Tailwind v4 CSS-first syntax
- Adding new shadcn components
- Implementing theming or dark mode
- Understanding Radix primitive behavior

## When to Use

- Writing Tailwind classes for components
- Implementing dark mode theming
- Using the `cn()` utility for conditional classes
- Customizing Shadcn UI components
- Adding animations with Motion library

## Installing Components

This project uses **shadcn/ui** (new-york style, Radix primitives). Config lives in `apps/client/components.json`; installed components land in `apps/client/src/layers/shared/ui/`:

```bash
# From apps/client/ — install from the default shadcn registry
npx shadcn@latest add <component>

# Examples
npx shadcn@latest add button
npx shadcn@latest add dialog
npx shadcn@latest add select
```

One extra registry is configured (`@aceternity` for effect components):

```json
{
  "registries": {
    "@aceternity": "https://ui.aceternity.com/registry/{name}.json"
  }
}
```

After installing, adapt the component to project conventions: imports resolve to `@/layers/shared/ui` and `@/layers/shared/lib/utils` via the aliases in `components.json`, and new components should use ref-as-prop (React 19), not `forwardRef`.

## Composition: `asChild`

Radix composition uses the **`asChild` prop** (backed by `Slot` from `radix-ui`). This is the established pattern (~144 uses in `apps/client/src`) — use it for all new code:

```tsx
// Render a Button as a link
<Button asChild>
  <a href="/contact">Contact</a>
</Button>

// SidebarMenuButton wrapping a router link
<SidebarMenuButton asChild>
  <Link to={item.href}>
    <Icon className="size-4" />
    <span>{item.label}</span>
  </Link>
</SidebarMenuButton>
```

Do **not** use a `render` prop — that is a Base UI pattern and its primitives are not in this project (`package.json` has `@radix-ui/*` deps only). See `.claude/rules/components.md` for full component rules.

## Typography

System font stacks — no webfonts are shipped:

```css
/* apps/client/src/index.css */
--font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
--font-mono: ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, Consolas, monospace;
```

**Type scale**: standard Tailwind rem sizes, redefined in `@theme inline` so every size is multiplied by the mobile scale (`--_st`, 1.25x below 768px) and the user's font-scale preference (`--user-font-scale`). Two extra sub-`xs` sizes exist for dense UI chrome:

| Class       | Base size        | Usage                        |
| ----------- | ---------------- | ---------------------------- |
| `text-3xs`  | 0.625rem (10px)  | Tiny metadata, dense chrome  |
| `text-2xs`  | 0.6875rem (11px) | Badges, timestamps           |
| `text-xs`   | 0.75rem (12px)   | Labels, captions             |
| `text-sm`   | 0.875rem (14px)  | Secondary text, most UI text |
| `text-base` | 1rem (16px)      | Body text                    |
| `text-lg`   | 1.125rem (18px)  | Emphasized body, card titles |
| `text-xl`   | 1.25rem (20px)   | Section headings             |

Sizes above `xl` (`text-2xl`+) fall through to Tailwind defaults and are **not** mobile-scaled. Because the scale multiplies at the token level, do not hand-roll responsive font sizes for standard UI text — the dial in `index.css` handles it.

## Color System

Colors are **HSL CSS variables** defined per theme (`:root` / `.dark`) and bridged to Tailwind utilities via `@theme inline` (`--color-primary: hsl(var(--primary))` etc.).

**Never use pure black or white.** Use the semantic tokens.

### Semantic Colors

```tsx
// Primary actions
<Button className="bg-primary text-primary-foreground" />

// Secondary actions
<Button variant="secondary" className="bg-secondary text-secondary-foreground" />

// Destructive actions
<Button variant="destructive" />

// Muted/secondary text
<p className="text-muted-foreground">Secondary information</p>
```

### Status Colors

Status tokens use the `status-*` namespace with `-bg` / `-border` / `-fg` companions (`success`, `error`, `warning`, `info`, `pending`):

```tsx
// Icon or text in the status color
<Check className="text-status-success" />

// Tinted chip: background + matching foreground
<span className="bg-status-success-bg text-status-success-fg">Approved</span>
<span className="bg-status-error-bg text-status-error-fg border-status-error-border border">Failed</span>
```

### Dark Mode

Dark mode is class-based: `@custom-variant dark (&:is(.dark *))` in `index.css`, with the `.dark` class toggled on `<html>` by the local `useTheme` hook (`@/layers/shared/model`) — light / dark / system, persisted to `localStorage`. There is no `next-themes`.

```tsx
import { useTheme } from '@/layers/shared/model';

const { theme, setTheme } = useTheme();
setTheme(theme === 'dark' ? 'light' : 'dark'); // or 'system'

// Components adapt automatically via semantic tokens
<div className="bg-background text-foreground" />;
```

## Sizing Tokens (Mobile-Scaled)

Icon and interactive-element sizes are tokens in `@theme inline`, multiplied by the mobile dial like text:

```tsx
// Icons: --size-icon-xs / -sm / -md
<Check className="size-(--size-icon-sm)" />

// Interactive heights: --size-btn-sm / -md / -lg
<div className="h-(--size-btn-md)" />
```

## Component Specifications

### Buttons (`shared/ui/button.tsx`)

Desktop heights; the `responsive` behavior bumps sizes on mobile (e.g. `h-11 md:h-9`):

| Size      | Height        | Usage             |
| --------- | ------------- | ----------------- |
| `xs`      | 24px (h-6)    | Dense UI chrome   |
| `sm`      | 32px (h-8)    | Compact actions   |
| `default` | 36px (h-9)    | Standard actions  |
| `lg`      | 40px (h-10)   | Primary CTAs      |
| `icon`    | 36px (size-9) | Icon-only buttons |

Icon-only variants: `icon-xs`, `icon-sm`, `icon-lg`.

### Inputs (`shared/ui/input.tsx`)

- Height: 36px (`h-9`), or `h-11 md:h-9` when `responsive`
- Border radius: `rounded-md`
- Shadow: `shadow-xs`

### Radius

Buttons and inputs use `rounded-md`; cards and modals use `rounded-xl`. The project uses Tailwind's default radius scale (no custom `--radius-*` overrides beyond message-specific tokens like `--radius-msg`).

## Control Surfaces

Sidebars, toolbars, list panes, menus and table rows are **control surfaces** — operated many times an hour, so they run dense. Pages, cards and empty states keep the generous spacing. `designing-frontend` → Two Spatial Modes decides which one you are building.

### The dense row

```tsx
<div className="group/row hover:bg-muted/50 flex h-7 items-center gap-2 rounded-md px-2 text-[13px]">
  <Icon className="text-muted-foreground size-(--size-icon-xs) shrink-0" />
  <span className="truncate">{label}</span>
  <span className="text-2xs text-muted-foreground ml-auto">{meta}</span>
</div>
```

- **Height** — `h-7` (28px), or `h-8` (32px) when the row carries an avatar. 4px-grid multiples only.
- **Text** — 13px label, `text-2xs` (11px) metadata.
- **Inset — 16px total, paid once.** Panel edge to first glyph. If the scroll container pays `px-2`, the row pays `px-2` and nothing in between pays anything. Stacking container + section + row padding is how a sidebar ends up with a 30px gutter.
- **Nav panel width** — 240–280px.

`text-[13px]` is an arbitrary value, so it does **not** ride the `--_st` mobile dial — there is no token between `text-xs` (12px) and `text-sm` (14px). On a surface that also renders on mobile, write `text-sm md:text-[13px]`: mobile keeps the scaled token, desktop gets the dense size.

### Hover-reveal

Row and section actions render nothing at rest:

```tsx
<Button
  size="icon-xs"
  variant="ghost"
  aria-label="Row actions"
  className={cn(
    'transition-opacity focus-visible:opacity-100',
    // hidden only where a pointer can hover; always there on touch
    '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100'
  )}
>
  <MoreVertical className="size-(--size-icon-xs)" />
</Button>
```

Three non-negotiables:

- **Name the group.** Bare `group-hover:` compiles to `:where(.group):hover &` and matches _any_ `.group` ancestor — the sidebar's outer group left every nested affordance permanently visible. Use `group/row` + `group-hover/row:`.
- **`focus-visible:` parity.** A keyboard user must never learn less than a mouse user.
- **A touch path.** Gate the hiding on `[@media(hover:hover)]` (the query asks about the pointer, not the viewport) so touch gets the action outright, or route it to long-press / context menu. Anything draggable needs a non-drag alternative — WCAG 2.2 §2.5.7.

Overflow glyph: **vertical kebab** (`MoreVertical`, ⋮) for row and section overflow; `MoreHorizontal` (⋯) is toolbar and table vocabulary. Vertical also needs less reserved gutter — keep that gutter as narrow as the icon.

### Separation: tint, not lines

```tsx
// A zone, separated by tint rather than a rule
<section className="bg-muted/40 rounded-lg" />

// Hover is the same mechanism, one step
<div className="hover:bg-muted/50" />
```

Order of preference: gap → 5–10% background tint → elevation (`shadow-soft`, `shadow-elevated`, scarce). No `border-b` under a panel header, no `border-t` above a footer.

### Scroll-edge shadow

The header detaches only once content is under it:

```tsx
const [scrolled, setScrolled] = useState(false);

<header className={cn('transition-shadow', scrolled && 'shadow-soft')}>{title}</header>
<div className="overflow-y-auto" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
  {rows}
</div>
```

For a virtualized or very long list, put a 1px sentinel at the top of the scroll content and drive the same boolean from an `IntersectionObserver` — cheaper than a scroll handler firing every frame.

### Status colors on control surfaces

Agent and job state comes from the `status-*` tokens (`success`, `error`, `warning`, `info`, `pending` — see [Status Colors](#status-colors)). Never `text-green-500` for healthy, never `bg-primary` for a state: `primary` is a button color, and a status painted with it stops meaning anything the moment a button sits next to it.

Only a genuinely-happening-now state animates. `bg-status-success` with a pulse means _working right now_; idle, done and error are static fills.

## Animations with Motion

Use the Motion library (`motion/react`) for animations (see `contributing/animations.md`):

```tsx
import { motion, AnimatePresence } from 'motion/react';

// Duration scale
const duration = {
  fast: 0.1,    // 100ms - micro-interactions
  normal: 0.15, // 150ms - standard transitions
  slow: 0.2,    // 200ms - layout shifts
  slower: 0.3,  // 300ms - modal enter/exit
};

// Fade in up (common pattern)
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
>
  Content
</motion.div>

// Exit animations (require AnimatePresence)
<AnimatePresence>
  {isOpen && (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      Modal content
    </motion.div>
  )}
</AnimatePresence>
```

## cn() Utility

Always use `cn()` for conditional classes:

```typescript
import { cn } from '@/layers/shared/lib/utils'

<button
  className={cn(
    'px-4 py-2 rounded-md',
    isActive && 'bg-primary text-primary-foreground',
    isDisabled && 'opacity-50 cursor-not-allowed'
  )}
>
  Button
</button>
```

## Responsive Design

Mobile-first with standard breakpoints: `sm` (640px), `md` (768px), `lg` (1024px), `xl` (1280px), `2xl` (1536px).

```tsx
<div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">{/* Responsive grid */}</div>
```

Text and icon sizes below 768px scale automatically via the token dial — prefer the tokens over per-component `md:` font overrides.

## Scrollbars

Use Tailwind's first-party `scrollbar-*` utilities (v4.3+); never hand-roll `scrollbar-width` or `::-webkit-scrollbar` CSS:

- `scrollbar-none` — hide the native scrollbar, keep scroll (status strip, containers with custom scroll overlays)
- `scrollbar-thin` — thin visible scrollbar (the `index.css` base style already thins everything; rarely needed per-component)
- `scrollbar-gutter-stable` — reserve gutter space so conditionally-scrolling dialog/panel bodies don't shift layout on classic-scrollbar platforms

For a styled, fading thumb, use the Radix `ScrollArea` primitive from `shared/ui` instead.

## Best Practices

- **Use semantic color names**: `bg-primary` not `bg-blue-500`; `text-status-error` not `text-red-500`
- **Follow the shipped components**: check `shared/ui/` source for the real variant/size API before styling around it
- **Respect the type scale**: use the token sizes; let the mobile dial do responsive scaling
- **Pick the spatial mode first**: dense recipes for control surfaces, generous spacing for content
- **Separate with tint before a border**: `bg-muted/40` over `border-b`
- **Apply animations thoughtfully**: one well-orchestrated animation beats many scattered ones
- **Test dark mode**: ensure proper contrast in both themes

## Common Pitfalls

- Using `tailwind.config.js` (use `@theme` in `apps/client/src/index.css` instead)
- Hardcoding colors instead of semantic variables
- Using pure black (`#000`) or white (`#fff`) - use theme colors
- Inventing utilities that don't exist (verify custom classes against `index.css` before using them)
- Stacking padding on a control surface (container + section + row) instead of budgeting the inset once
- Bare `group-hover:` on a nested control — it matches any `.group` ancestor; name the group
- Hiding an action on hover with no `focus-visible:` twin and no touch path
- Missing dark mode variants
- Over-animating - focus on high-impact moments

## References

- `designing-frontend` skill — Design thinking, hierarchy, component decisions
- `.claude/rules/components.md` — Component rules (composition, accessibility, tables)
- `contributing/design-system.md` — Full design language documentation
- `contributing/styling-theming.md` — Practical styling patterns
- `contributing/animations.md` — Animation patterns
- `apps/client/src/index.css` — Implemented tokens and utilities
