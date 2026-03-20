# Styling & Theming Guide

## Overview

This project uses Tailwind CSS v4 (CSS-first configuration) with Shadcn UI components following the "Calm Tech" design language. All theme tokens are defined in `apps/client/src/index.css` using HSL CSS custom properties surfaced through the `@theme inline` block.

## Key Files

| Concept             | Location                                                            |
| ------------------- | ------------------------------------------------------------------- |
| Theme configuration | `apps/client/src/index.css` (via `@theme inline` + `:root`/`.dark`) |
| Design system spec  | `contributing/design-system.md`                                     |
| Shadcn components   | `apps/client/src/layers/shared/ui/` (barrel export)                 |
| Animation patterns  | `contributing/animations.md`                                        |
| cn() utility        | `apps/client/src/layers/shared/lib/utils.ts`                        |
| Theme hook          | `apps/client/src/layers/shared/model/use-theme.ts`                  |

## When to Use What

| Scenario                                   | Approach                                             | Why                                        |
| ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------ |
| Need semantic color (background, text)     | Use tokens (`bg-background`, `text-foreground`)      | Automatic dark mode, consistent design     |
| Need arbitrary color (brand not in tokens) | Add to `@theme` in index.css                         | Reusable, theme-aware                      |
| Need conditional classes                   | Use `cn()` utility                                   | Type-safe, handles conflicts correctly     |
| Need component variants                    | Use built-in variants (`variant="outline"`)          | Consistent API, pre-styled                 |
| Need custom component styling              | Pass `className` prop                                | Override defaults without editing source   |
| Need dark mode variant                     | Use `dark:` prefix (`dark:bg-black`)                 | Class-based, automatic toggle              |
| Need responsive design                     | Use breakpoint prefixes (`md:grid-cols-2`)           | Mobile-first, standard breakpoints         |
| Need animation                             | Use Motion library (see animations.md)               | Performance, accessibility, spring physics |
| Need complex state-dependent styles        | Use `cn()` with conditionals                         | Readable, maintainable                     |
| Need one-off styles not in design system   | Avoid if possible, or use arbitrary values sparingly | Prefer extending theme                     |

## Core Patterns

### Theme Token Definition (index.css)

All design tokens live in `apps/client/src/index.css`. The pattern uses HSL custom properties defined in `:root`/`.dark` blocks, surfaced to Tailwind via `@theme inline`:

```css
@import 'tailwindcss';
@custom-variant dark (&:is(.dark *));
@source '../node_modules/streamdown/dist/*.js';

@theme inline {
  /* Colors reference HSL variables */
  --color-background: hsl(var(--background));
  --color-foreground: hsl(var(--foreground));
  --color-primary: hsl(var(--primary));
  --color-muted: hsl(var(--muted));
  --color-muted-foreground: hsl(var(--muted-foreground));
  /* ...all other tokens follow the same pattern */
  --radius: var(--radius);
}

/* Light mode HSL values */
:root {
  --background: 0 0% 98%;
  --foreground: 0 0% 9%;
  --primary: 0 0% 9%;
  --primary-foreground: 0 0% 98%;
  --muted: 0 0% 96%;
  --muted-foreground: 0 0% 32%;
  --radius: 0.5rem;
}

/* Dark mode overrides */
.dark {
  --background: 0 0% 4%;
  --foreground: 0 0% 93%;
  --primary: 0 0% 93%;
  --muted: 0 0% 9%;
  --muted-foreground: 0 0% 64%;
}
```

Three things to note:

- `@custom-variant dark (&:is(.dark *))` enables the `dark:` prefix using class-based dark mode (`.dark` on `<html>`).
- `@source '../node_modules/streamdown/dist/*.js'` is required so Tailwind scans the `streamdown` markdown renderer for classes it injects at runtime. Without this, streamdown's utility classes are purged in production.
- Fonts default to system stacks: `system-ui, -apple-system, ...` (set in `:root` as `--font-sans` and `--font-mono`). Users can override via Settings → Appearance, which loads Google Fonts dynamically and writes to `--font-sans`/`--font-mono` via JavaScript.

### Using Semantic Tokens

Always prefer semantic tokens over arbitrary values:

```tsx
// Component using semantic tokens
export function FeatureCard({ title, description }: FeatureCardProps) {
  return (
    <div className="bg-background text-foreground shadow-soft rounded-xl p-6">
      <h3 className="text-primary font-semibold">{title}</h3>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}
```

### Dark Mode with Class Strategy

Dark mode uses the `useTheme` hook. The `dark` class is toggled on `<html>` by `ThemeProvider` in `App.tsx`. This is a Vite SPA — no `suppressHydrationWarning` or Next.js layout file needed.

```tsx
import { useTheme } from '@/layers/shared/model';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <button
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="hover:bg-muted rounded-md p-2"
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
```

Apply dark mode variants with `dark:` prefix, but prefer semantic tokens which handle both modes automatically:

```tsx
{
  /* Prefer tokens — no dark: variant needed */
}
<div className="bg-background text-foreground">
  <p className="text-muted-foreground">Muted text</p>
</div>;

{
  /* Only use dark: when tokens don't cover the case */
}
<div className="bg-gray-100 dark:bg-gray-900">...</div>;
```

### Conditional Classes with cn()

Use `cn()` for combining base classes with conditional variants:

```typescript
import { cn } from '@/layers/shared/lib/utils'

interface ButtonProps {
  variant?: 'default' | 'outline'
  size?: 'default' | 'sm' | 'lg'
  isActive?: boolean
  className?: string
}

export function Button({ variant = 'default', size = 'default', isActive, className }: ButtonProps) {
  return (
    <button
      className={cn(
        // Base styles
        'rounded-md font-medium transition-colors',
        // Variant styles
        variant === 'default' && 'bg-primary text-primary-foreground hover:bg-primary/90',
        variant === 'outline' && 'border border-input bg-background hover:bg-muted',
        // Size styles
        size === 'default' && 'h-10 px-4 py-2',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'lg' && 'h-12 px-6 text-lg',
        // State styles
        isActive && 'ring-2 ring-primary ring-offset-2',
        // Consumer overrides
        className
      )}
    >
      Button
    </button>
  )
}
```

### Shadcn Component Usage

Import from barrel export in `shared/ui/`:

```tsx
// Import components
import { Button } from '@/layers/shared/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@/layers/shared/ui';
import { Form, FormControl, FormField, FormItem, FormLabel } from '@/layers/shared/ui';

// Use with variants
export function Example() {
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Card Title</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button variant="default">Default</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </CardContent>
    </Card>
  );
}
```

### Responsive Design

Use Tailwind breakpoints (mobile-first):

```tsx
export function ResponsiveGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {/* Stacks on mobile, 2 cols on tablet, 3 cols on desktop */}
      <Card>Item 1</Card>
      <Card>Item 2</Card>
      <Card>Item 3</Card>
    </div>
  );
}

export function ResponsiveText() {
  return (
    <h1 className="text-2xl font-bold md:text-3xl lg:text-4xl">
      {/* 32px mobile, 48px tablet, 64px desktop */}
      Responsive Heading
    </h1>
  );
}
```

**Breakpoints:** `sm` (640px), `md` (768px), `lg` (1024px), `xl` (1280px), `2xl` (1536px)

### Custom Utilities (index.css)

Define custom utilities for project-specific patterns:

```css
/* apps/client/src/index.css */
@layer utilities {
  /* Shadow utilities */
  .shadow-soft {
    box-shadow: 0 2px 8px oklch(0% 0 0 / 0.08);
  }

  .shadow-elevated {
    box-shadow: 0 4px 16px oklch(0% 0 0 / 0.12);
  }

  .shadow-floating {
    box-shadow: 0 8px 24px oklch(0% 0 0 / 0.16);
  }

  /* Glass effect */
  .glass {
    background: oklch(100% 0 0 / 0.8);
    backdrop-filter: blur(8px);
  }

  .dark .glass {
    background: oklch(10% 0 0 / 0.8);
  }

  /* Container widths */
  .container-narrow {
    max-width: 42rem;
    margin-inline: auto;
    padding-inline: 1rem;
  }

  .container-default {
    max-width: 56rem;
    margin-inline: auto;
    padding-inline: 1rem;
  }

  .container-wide {
    max-width: 72rem;
    margin-inline: auto;
    padding-inline: 1rem;
  }

  /* Interactive card */
  .card-interactive {
    @apply hover:shadow-elevated transition-all duration-200 hover:-translate-y-1;
  }
}
```

Usage:

```tsx
<div className="shadow-soft rounded-xl p-6">Soft shadow</div>
<div className="glass rounded-xl p-4">Glass morphism</div>
<div className="container-narrow">Narrow content</div>
<div className="card-interactive">Hover lifts card</div>
```

## Anti-Patterns

```tsx
// ❌ NEVER use arbitrary values when semantic tokens exist
<div className="bg-[#ffffff] text-[#000000]">
  // Bypasses theme, breaks dark mode
</div>

// ✅ Use semantic tokens
<div className="bg-background text-foreground">
  // Theme-aware, automatic dark mode
</div>
```

```tsx
// ❌ NEVER use inline styles for themeable properties
<div style={{ backgroundColor: '#ffffff', color: '#000000' }}>
  // Bypasses dark mode, not responsive
</div>

// ✅ Use Tailwind classes
<div className="bg-background text-foreground">
  // Theme-aware, can use responsive variants
</div>
```

```tsx
// ❌ Don't use string concatenation for conditional classes
<button className={`px-4 py-2 ${isActive ? 'bg-primary' : 'bg-muted'}`}>
  // Doesn't handle class conflicts, hard to read
</button>

// ✅ Use cn() utility
<button className={cn('px-4 py-2', isActive ? 'bg-primary' : 'bg-muted')}>
  // Handles conflicts, more readable
</button>
```

```tsx
// ❌ Don't forget dark mode variants for custom colors
<div className="bg-gray-100">
  // Looks wrong in dark mode
</div>

// ✅ Add dark: variants or use tokens
<div className="bg-gray-100 dark:bg-gray-900">
  // Works in both modes
</div>
// OR better:
<div className="bg-muted">
  // Token handles both modes automatically
</div>
```

```tsx
// ❌ Don't use pure black/white
<div className="bg-white text-black dark:bg-black dark:text-white">
  // Harsh, not Calm Tech philosophy
</div>

// ✅ Use tinted neutrals from tokens
<div className="bg-background text-foreground">
  // Rich neutrals: hsl(0 0% 98%) in light, hsl(0 0% 4%) in dark
</div>
```

```tsx
// ❌ Don't hardcode border radius when design system defines it
<div className="rounded-[16px]">
  // Not maintainable, inconsistent
</div>

// ✅ Use semantic radius tokens
<div className="rounded-xl">
  // Uses --radius-lg (16px) from theme
</div>
```

```tsx
// ❌ Don't modify Shadcn component source files
// File: apps/client/src/layers/shared/ui/button.tsx
export function Button() {
  return <button className="bg-primary px-4 py-2">...</button>;
  // Changes lost on shadcn update
}

// ✅ Use className prop or create wrapper
import { Button as BaseButton } from '@/components/ui/button';

export function Button(props) {
  return <BaseButton className="custom-override" {...props} />;
  // Safe, preserves updates
}
```

## Design System Quick Reference

The "Calm Tech" design language specifications:

| Element                | Specification                                           |
| ---------------------- | ------------------------------------------------------- |
| **Fonts**              | System UI stack (user-configurable via Settings)        |
| **Colors**             | HSL tokens via `:root`/`.dark` — never pure black/white |
| **Base radius**        | 8px (`--radius: 0.5rem`)                                |
| **Button height**      | 36px default (`--size-btn-md: 2.25rem`)                 |
| **Card padding**       | 24px (`p-6`)                                            |
| **Animation duration** | 100-300ms (fast to slower)                              |
| **Shadow hierarchy**   | soft → elevated → floating → modal                      |
| **Container widths**   | narrow (42rem), default (56rem), wide (72rem)           |

### Core Principles

| Principle                   | Application                        |
| --------------------------- | ---------------------------------- |
| **Clarity over decoration** | Every element earns its place      |
| **Soft depth over flat**    | Subtle shadows create hierarchy    |
| **Generous space**          | Breathing room makes content shine |
| **Micro-delight**           | Thoughtful, restrained animations  |

## Adding a New Theme Token

1. **Add to `@theme inline`** in `apps/client/src/index.css`:

   ```css
   @theme inline {
     --color-warning: hsl(var(--warning));
     --color-warning-foreground: hsl(var(--warning-foreground));
   }
   ```

2. **Define HSL values** in `:root` and `.dark`:

   ```css
   :root {
     --warning: 38 92% 50%; /* amber-500 equivalent */
     --warning-foreground: 0 0% 9%;
   }

   .dark {
     --warning: 38 92% 60%; /* slightly lighter in dark mode */
     --warning-foreground: 0 0% 9%;
   }
   ```

3. **Use in components**:

   ```tsx
   <div className="bg-warning text-warning-foreground">Warning</div>
   ```

4. **Verify**: Check both light and dark modes in browser.

## Troubleshooting

### "Styles not applying in production"

**Cause**: Tailwind v4 scans source files via `@import 'tailwindcss'` — it automatically includes all files reachable from `index.css`. Classes are missing when they come from files outside that scan (e.g., third-party packages).

**Fix**: Add an explicit `@source` directive for any npm package that injects Tailwind classes at runtime:

```css
/* apps/client/src/index.css */
@source '../node_modules/streamdown/dist/*.js';
```

This is already present for `streamdown`. Add additional entries if you integrate another library that generates Tailwind class names dynamically.

### "Dark mode not working"

**Cause**: `ThemeProvider` not wrapping the app, or `dark` class not being toggled on `<html>`.

**Fix**: `ThemeProvider` is mounted in `App.tsx` wrapping all content. The `.dark` class is set on `<html>` by the provider. Verify with browser devtools that `<html class="dark">` toggles correctly.

No `suppressHydrationWarning` needed — this is a Vite SPA, not Next.js.

### "cn() not combining classes correctly"

**Cause**: Class conflicts not resolved (e.g., `p-4` and `p-6` both present).
**Fix**: Ensure `cn()` uses `clsx` + `tailwind-merge`:

```typescript
// src/layers/shared/lib/utils.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs)); // twMerge handles conflicts
}
```

### "Custom utility classes not found"

**Cause**: Defined in wrong layer or not using `@layer`.
**Fix**: Always use `@layer utilities` in index.css:

```css
/* apps/client/src/index.css */
@layer utilities {
  .shadow-soft {
    box-shadow: 0 2px 8px oklch(0% 0 0 / 0.08);
  }
}
```

### "Token colors look wrong in dark mode"

**Cause**: Forgot to override the HSL variable in `.dark`.
**Fix**: Every token needs both `:root` and `.dark` definitions:

```css
:root {
  --custom: 200 50% 40%; /* Light mode */
}

.dark {
  --custom: 200 50% 60%; /* Dark mode — lighter */
}

@theme inline {
  --color-custom: hsl(var(--custom));
}
```

### "Shadcn component styling conflicts with custom classes"

**Cause**: CSS specificity — component styles override `className` prop.
**Fix**: Use `!important` sparingly, or modify component variant:

```tsx
// Option 1: Force override (use sparingly)
<Button className="!bg-accent !text-white">Custom</Button>;

// Option 2: Create wrapper with default variant
export function AccentButton(props) {
  return <Button variant="ghost" className="bg-accent text-white" {...props} />;
}
```

### "Responsive classes not working"

**Cause**: Using max-width breakpoints instead of min-width (Tailwind is mobile-first).
**Fix**: Apply base styles first, then override with breakpoints:

```tsx
// ❌ WRONG (desktop-first)
<div className="grid-cols-3 md:grid-cols-1">

// ✅ CORRECT (mobile-first)
<div className="grid-cols-1 md:grid-cols-3">
  {/* 1 column on mobile, 3 on tablet+ */}
</div>
```

## References

- **[contributing/design-system.md](./design-system.md)** - Complete Calm Tech design language specification
- **[contributing/animations.md](./animations.md)** - Motion library patterns and spring physics
- **[apps/client/src/index.css](../apps/client/src/index.css)** - Live theme token definitions
- **[Tailwind CSS v4 Docs](https://tailwindcss.com/docs)** - Official Tailwind CSS documentation
- **[Shadcn UI](https://ui.shadcn.com)** - Component documentation and examples
- **[apps/client/src/layers/shared/model/](../apps/client/src/layers/shared/model/)** - useTheme hook for dark mode toggling
