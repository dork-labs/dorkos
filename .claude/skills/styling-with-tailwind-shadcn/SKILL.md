---
name: styling-with-tailwind-shadcn
description: Implements the Calm Tech design system using Tailwind CSS v4 and Shadcn UI. Use when writing styles, building components, or theming. For design decisions, see designing-frontend.
---

# Styling with Tailwind CSS v4 & Shadcn UI

This skill provides **implementation patterns** for the Calm Tech design system using Tailwind CSS v4 (CSS-first configuration) and Shadcn UI.

**For design thinking (what/why)**: Use the `designing-frontend` skill.

## Current Documentation (Context7)

Tailwind v4 uses CSS-first configuration (no `tailwind.config.js`). For current patterns:

```
# Check installed version
grep '"tailwindcss"' package.json

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

# Fetch Base UI docs (for primitive behavior)
mcp__context7__resolve-library-id: { libraryName: "base-ui react" }
mcp__context7__query-docs: {
  context7CompatibleLibraryID: "/mui/base-ui",
  topic: "[component, e.g., 'button render prop', 'dialog composition']"
}
```

**When to fetch docs:**

- Uncertain about Tailwind v4 CSS-first syntax
- Adding new Shadcn/basecn components
- Implementing theming or dark mode
- Understanding Base UI primitive behavior (render prop, useRender hook)

## When to Use

- Writing Tailwind classes for components
- Implementing dark mode theming
- Using the `cn()` utility for conditional classes
- Customizing Shadcn UI components
- Adding animations with Motion library

## Installing Components

This project uses **basecn** (Base UI powered Shadcn components):

```bash
# Install a component from basecn registry
npx shadcn@latest add @basecn/<component>

# Examples
npx shadcn@latest add @basecn/button
npx shadcn@latest add @basecn/dialog
npx shadcn@latest add @basecn/select
```

The basecn registry is configured in `components.json`:

```json
{
  "registries": {
    "@basecn": "https://basecn.dev/r/{name}.json"
  }
}
```

**Note**: Use `render` prop for composition (not `asChild`). See `.claude/rules/components.md` for patterns.

## Typography

| Role          | Font       | Fallback                             |
| ------------- | ---------- | ------------------------------------ |
| **Primary**   | Geist Sans | system-ui, -apple-system, sans-serif |
| **Monospace** | Geist Mono | ui-monospace, monospace              |

```css
/* Already configured in globals.css */
--font-sans: var(--font-geist-sans), system-ui, -apple-system, sans-serif;
--font-mono: var(--font-geist-mono), ui-monospace, monospace;
```

**Type Scale (Major Third 1.25):**

| Class       | Size | Usage                        |
| ----------- | ---- | ---------------------------- |
| `text-xs`   | 11px | Labels, badges, metadata     |
| `text-sm`   | 13px | Secondary text, captions     |
| `text-base` | 15px | Body text, inputs            |
| `text-lg`   | 17px | Emphasized body, card titles |
| `text-xl`   | 20px | Section headings             |
| `text-2xl`  | 24px | Page section titles          |
| `text-3xl`  | 30px | Page titles                  |
| `text-4xl`  | 36px | Hero headings                |

## Color System (OKLCH)

**Never use pure black or white.** Use rich, tinted neutrals.

### Semantic Colors

```tsx
// Primary actions
<Button className="bg-primary text-primary-foreground" />

// Secondary actions
<Button variant="secondary" className="bg-secondary text-secondary-foreground" />

// Destructive actions
<Button variant="destructive" className="bg-destructive text-destructive-foreground" />

// Muted/secondary text
<p className="text-muted-foreground">Secondary information</p>

// Status colors
<Badge className="bg-success text-success-foreground">Active</Badge>
<Badge className="bg-warning text-warning-foreground">Pending</Badge>
<Badge className="bg-info text-info-foreground">Info</Badge>
```

### Dark Mode

Dark mode is automatic via `next-themes`. Apply dark variants:

```tsx
<div className="bg-background text-foreground">{/* Automatically adapts to theme */}</div>;

// Toggle theme
const { theme, setTheme } = useTheme();
setTheme(theme === 'dark' ? 'light' : 'dark');
```

## Border Radius

Generous, soft corners for a modern feel:

| Token          | Value  | Usage                  |
| -------------- | ------ | ---------------------- |
| `rounded-sm`   | 8px    | Small elements, badges |
| `rounded-md`   | 10px   | **Buttons, inputs**    |
| `rounded-lg`   | 12px   | Default radius         |
| `rounded-xl`   | 16px   | **Cards, modals**      |
| `rounded-2xl`  | 20px   | Large cards, panels    |
| `rounded-full` | 9999px | Pills, avatars         |

**Rules:**

- Cards: Always `rounded-xl` (16px)
- Buttons: `rounded-md` (10px)
- Inputs: Match button radius (`rounded-md`)
- Modals/dialogs: `rounded-xl` (16px)

## Shadows

Soft, diffused shadows create depth without noise:

```tsx
// Custom utility classes (defined in globals.css)
<div className="shadow-xs" />      // Inputs at rest
<div className="shadow-soft" />    // Cards, buttons on hover
<div className="shadow-elevated" /> // Dropdowns
<div className="shadow-floating" /> // Modals, dialogs
<div className="shadow-modal" />   // Popovers, sheets
```

## Component Specifications

### Buttons

| Size      | Height | Padding   | Usage             |
| --------- | ------ | --------- | ----------------- |
| `sm`      | 32px   | 12px 16px | Compact actions   |
| `default` | 40px   | 12px 20px | Standard actions  |
| `lg`      | 48px   | 14px 28px | Primary CTAs      |
| `icon`    | 40px   | -         | Icon-only buttons |

```tsx
<Button size="default">Default (40px)</Button>
<Button size="sm">Small (32px)</Button>
<Button size="lg">Large (48px)</Button>
<Button size="icon"><Icon /></Button>
```

### Cards

- Padding: `24px` (p-6)
- Border radius: `16px` (rounded-xl)
- Shadow: `shadow-soft` (light mode)
- Gap between elements: `16px` (gap-4)

```tsx
<Card className="shadow-soft rounded-xl p-6">
  <CardHeader className="pb-4">
    <CardTitle>Title</CardTitle>
  </CardHeader>
  <CardContent className="space-y-4">{/* Content */}</CardContent>
</Card>
```

### Inputs

- Height: `40px` (h-10)
- Padding: `10px 14px` (px-3.5 py-2.5)
- Border radius: `10px` (rounded-md)

```tsx
<Input className="h-10 rounded-md px-3.5" />
```

## Custom Utilities

These are defined in `globals.css`:

```tsx
// Glass morphism
<div className="glass">Frosted glass effect</div>
<Card className="glass-card">Glass card with shadow</Card>

// Focus states
<button className="focus-ring">Accessible focus</button>

// Interactive cards
<Card className="card-interactive">Hover effect</Card>

// Container widths
<div className="container-narrow">Max 42rem</div>
<div className="container-default">Max 56rem</div>
<div className="container-wide">Max 72rem</div>

// Tabular numbers (for data)
<td className="tabular-nums">1,234.56</td>
```

## Animations with Motion

Use the Motion library (`motion/react`) for animations:

```tsx
'use client'
import { motion } from 'motion/react'

// Duration scale
const duration = {
  fast: 0.1,    // 100ms - micro-interactions
  normal: 0.15, // 150ms - standard transitions
  slow: 0.2,    // 200ms - layout shifts
  slower: 0.3,  // 300ms - modal enter/exit
}

// Easing
const ease = {
  out: [0, 0, 0.2, 1],           // Enter animations
  in: [0.4, 0, 1, 1],            // Exit animations
  inOut: [0.4, 0, 0.2, 1],       // Symmetric
  spring: [0.34, 1.56, 0.64, 1], // Bouncy
}

// Fade in up (common pattern)
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.15, ease: ease.out }}
>
  Content
</motion.div>

// Button interaction
<motion.button
  whileHover={{ scale: 1.02 }}
  whileTap={{ scale: 0.98 }}
  transition={{ duration: 0.1 }}
>
  Click Me
</motion.button>

// Exit animations (require AnimatePresence)
import { AnimatePresence } from 'motion/react'

<AnimatePresence>
  {isOpen && (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
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

Mobile-first with standard breakpoints:

```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
  {/* Responsive grid */}
</div>

<p className="text-sm md:text-base lg:text-lg">
  Responsive text
</p>
```

Breakpoints: `sm` (640px), `md` (768px), `lg` (1024px), `xl` (1280px), `2xl` (1536px)

## Best Practices

- **Use semantic color names**: `bg-primary` not `bg-blue-500`
- **Follow component specs**: 40px buttons, 24px card padding, 16px card radius
- **Respect the type scale**: Use Geist fonts, follow size guidelines
- **Apply animations thoughtfully**: One well-orchestrated animation beats many scattered ones
- **Test dark mode**: Ensure proper contrast and desaturated colors

## Common Pitfalls

- Using `tailwind.config.js` (use `@theme` in CSS instead)
- Hardcoding colors instead of semantic variables
- Using pure black (`#000`) or white (`#fff`) - use theme colors
- Inconsistent border radius (buttons: 10px, cards: 16px)
- Missing dark mode variants
- Over-animating - focus on high-impact moments

## References

- `designing-frontend` skill — Design thinking, hierarchy, component decisions
- `contributing/design-system.md` — Full design language documentation
- `contributing/styling-theming.md` — Practical styling patterns
- `contributing/animations.md` — Animation patterns
- `src/app/globals.css` — Implemented tokens and utilities
