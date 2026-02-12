# Styling & Theming Guide

## Overview

This project uses Tailwind CSS v4 (CSS-first configuration) with Shadcn UI components following the "Calm Tech" design language. All theme tokens are defined in `src/app/globals.css` using OKLCH color space for better color manipulation and dark mode support.

## Key Files

| Concept | Location |
|---------|----------|
| Theme configuration | `src/app/globals.css` (via `@theme` directive) |
| Design system spec | `docs/DESIGN_SYSTEM.md` |
| Shadcn components | `src/layers/shared/ui/` (barrel export) |
| Base UI primitives | `src/components/ui/` (installed components) |
| Animation patterns | `developer-guides/07-animations.md` |
| cn() utility | `src/layers/shared/lib/utils.ts` |
| ThemeProvider | `src/app/providers.tsx` |

## When to Use What

| Scenario | Approach | Why |
|----------|----------|-----|
| Need semantic color (background, text) | Use tokens (`bg-background`, `text-foreground`) | Automatic dark mode, consistent design |
| Need arbitrary color (brand not in tokens) | Add to `@theme` in globals.css | Reusable, theme-aware |
| Need conditional classes | Use `cn()` utility | Type-safe, handles conflicts correctly |
| Need component variants | Use built-in variants (`variant="outline"`) | Consistent API, pre-styled |
| Need custom component styling | Pass `className` prop | Override defaults without editing source |
| Need dark mode variant | Use `dark:` prefix (`dark:bg-black`) | Class-based, automatic toggle |
| Need responsive design | Use breakpoint prefixes (`md:grid-cols-2`) | Mobile-first, standard breakpoints |
| Need animation | Use Motion library (see 07-animations.md) | Performance, accessibility, spring physics |
| Need complex state-dependent styles | Use `cn()` with conditionals | Readable, maintainable |
| Need one-off styles not in design system | Avoid if possible, or use arbitrary values sparingly | Prefer extending theme |

## Core Patterns

### Theme Token Definition (globals.css)

All design tokens live in `src/app/globals.css`:

```css
@import 'tailwindcss';

@theme {
  /* Colors - OKLCH for better manipulation */
  --color-background: oklch(100% 0 0);
  --color-foreground: oklch(10% 0 0);
  --color-primary: oklch(15% 0 0);
  --color-primary-foreground: oklch(98% 0 0);
  --color-muted: oklch(96% 0 0);
  --color-muted-foreground: oklch(45% 0 0);

  /* Radius tokens */
  --radius: 0.625rem;           /* 10px - buttons, inputs */
  --radius-lg: 1rem;            /* 16px - cards */

  /* Fonts */
  --font-sans: 'Geist Sans', system-ui, sans-serif;
  --font-mono: 'Geist Mono', monospace;

  /* Custom utilities (not part of Tailwind defaults) */
  --shadow-soft: 0 2px 8px oklch(0% 0 0 / 0.08);
  --shadow-elevated: 0 4px 16px oklch(0% 0 0 / 0.12);
}

/* Dark mode overrides */
.dark {
  --color-background: oklch(10% 0 0);
  --color-foreground: oklch(98% 0 0);
  --color-primary: oklch(98% 0 0);
  --color-primary-foreground: oklch(15% 0 0);
  --color-muted: oklch(15% 0 0);
  --color-muted-foreground: oklch(65% 0 0);
}
```

### Using Semantic Tokens

Always prefer semantic tokens over arbitrary values:

```tsx
// Component using semantic tokens
export function FeatureCard({ title, description }: FeatureCardProps) {
  return (
    <div className="bg-background text-foreground rounded-xl p-6 shadow-soft">
      <h3 className="text-primary font-semibold">{title}</h3>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  )
}
```

### Dark Mode with Class Strategy

Dark mode uses next-themes with class strategy:

```tsx
// Toggle theme
'use client'
import { useTheme } from 'next-themes'

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <button
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="p-2 rounded-md hover:bg-muted"
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  )
}
```

Apply dark mode variants with `dark:` prefix:

```tsx
<div className="bg-white dark:bg-black text-black dark:text-white">
  <p className="text-gray-600 dark:text-gray-400">Muted text</p>
</div>
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
import { Button } from '@/layers/shared/ui'
import { Card, CardContent, CardHeader, CardTitle } from '@/layers/shared/ui'
import { Form, FormControl, FormField, FormItem, FormLabel } from '@/layers/shared/ui'

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
  )
}
```

### Responsive Design

Use Tailwind breakpoints (mobile-first):

```tsx
export function ResponsiveGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {/* Stacks on mobile, 2 cols on tablet, 3 cols on desktop */}
      <Card>Item 1</Card>
      <Card>Item 2</Card>
      <Card>Item 3</Card>
    </div>
  )
}

export function ResponsiveText() {
  return (
    <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold">
      {/* 32px mobile, 48px tablet, 64px desktop */}
      Responsive Heading
    </h1>
  )
}
```

**Breakpoints:** `sm` (640px), `md` (768px), `lg` (1024px), `xl` (1280px), `2xl` (1536px)

### Custom Utilities (globals.css)

Define custom utilities for project-specific patterns:

```css
/* src/app/globals.css */
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
    @apply transition-all duration-200 hover:shadow-elevated hover:-translate-y-1;
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
  // Rich neutrals: oklch(100% 0 0) in light, oklch(10% 0 0) in dark
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
// File: src/components/ui/button.tsx
export function Button() {
  return <button className="px-4 py-2 bg-primary">...</button>
  // Changes lost on shadcn update
}

// ✅ Use className prop or create wrapper
import { Button as BaseButton } from '@/components/ui/button'

export function Button(props) {
  return <BaseButton className="custom-override" {...props} />
  // Safe, preserves updates
}
```

## Design System Quick Reference

The "Calm Tech" design language specifications:

| Element | Specification |
|---------|---------------|
| **Fonts** | Geist Sans (UI), Geist Mono (code) |
| **Colors** | OKLCH tokens — never pure black/white |
| **Card radius** | 16px (`rounded-xl` or `--radius-lg`) |
| **Button/Input radius** | 10px (`rounded-md` or `--radius`) |
| **Button height** | 40px default (`h-10`) |
| **Card padding** | 24px (`p-6`) |
| **Animation duration** | 100-300ms (fast to slower) |
| **Shadow hierarchy** | soft → elevated → floating → modal |
| **Container widths** | narrow (42rem), default (56rem), wide (72rem) |

### Core Principles

| Principle | Application |
|-----------|-------------|
| **Clarity over decoration** | Every element earns its place |
| **Soft depth over flat** | Subtle shadows create hierarchy |
| **Generous space** | Breathing room makes content shine |
| **Micro-delight** | Thoughtful, restrained animations |

## Adding a New Theme Token

1. **Add to `@theme` block** in `src/app/globals.css`:
   ```css
   @theme {
     --color-accent: oklch(60% 0.15 270);  /* Purple accent */
     --color-accent-foreground: oklch(98% 0 0);
   }
   ```

2. **Add dark mode variant** in `.dark` block:
   ```css
   .dark {
     --color-accent: oklch(70% 0.15 270);  /* Lighter in dark mode */
     --color-accent-foreground: oklch(10% 0 0);
   }
   ```

3. **Use in components**:
   ```tsx
   <button className="bg-accent text-accent-foreground">
     Accent Button
   </button>
   ```

4. **Add to TypeScript types** (optional, for autocomplete):
   ```typescript
   // src/types/tailwind.d.ts
   declare module 'tailwindcss/types/config' {
     export interface ThemeConfig {
       colors: {
         accent: string
         'accent-foreground': string
       }
     }
   }
   ```

5. **Verify**: Check both light and dark modes in browser.

## Troubleshooting

### "Styles not applying in production"

**Cause**: Tailwind couldn't find the classes during build (content paths issue).
**Fix**: Ensure `content` paths in `postcss.config.js` include all component locations:
```javascript
// postcss.config.js
module.exports = {
  plugins: {
    '@tailwindcss/postcss': {
      content: [
        './src/**/*.{ts,tsx}',  // Catches all TypeScript/React files
      ],
    },
  },
}
```

### "Dark mode not working"

**Cause**: One of:
1. ThemeProvider not wrapping app
2. `suppressHydrationWarning` missing from `<html>` tag
3. Using wrong strategy (should be `class`)

**Fix**:
```tsx
// src/app/layout.tsx
import { ThemeProvider } from 'next-themes'

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
```

### "cn() not combining classes correctly"

**Cause**: Class conflicts not resolved (e.g., `p-4` and `p-6` both present).
**Fix**: Ensure `cn()` uses `clsx` + `tailwind-merge`:
```typescript
// src/layers/shared/lib/utils.ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))  // twMerge handles conflicts
}
```

### "Custom utility classes not found"

**Cause**: Defined in wrong layer or not using `@layer`.
**Fix**: Always use `@layer utilities` in globals.css:
```css
/* src/app/globals.css */
@layer utilities {
  .shadow-soft {
    box-shadow: 0 2px 8px oklch(0% 0 0 / 0.08);
  }
}
```

### "Token colors look wrong in dark mode"

**Cause**: Forgot to override in `.dark` class.
**Fix**: Every color token needs a dark mode variant:
```css
@theme {
  --color-custom: oklch(60% 0.1 200);  /* Light mode */
}

.dark {
  --color-custom: oklch(80% 0.1 200);  /* Dark mode - lighter */
}
```

### "Shadcn component styling conflicts with custom classes"

**Cause**: CSS specificity — component styles override `className` prop.
**Fix**: Use `!important` sparingly, or modify component variant:
```tsx
// Option 1: Force override (use sparingly)
<Button className="!bg-accent !text-white">Custom</Button>

// Option 2: Create wrapper with default variant
export function AccentButton(props) {
  return <Button variant="ghost" className="bg-accent text-white" {...props} />
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

- **[docs/DESIGN_SYSTEM.md](../docs/DESIGN_SYSTEM.md)** - Complete Calm Tech design language specification
- **[developer-guides/07-animations.md](./07-animations.md)** - Motion library patterns and spring physics
- **[src/app/globals.css](../src/app/globals.css)** - Live theme token definitions
- **[Tailwind CSS v4 Docs](https://tailwindcss.com/docs)** - Official Tailwind CSS documentation
- **[OKLCH Color Picker](https://oklch.com)** - Interactive OKLCH color space tool
- **[Shadcn UI](https://ui.shadcn.com)** - Component documentation and examples
- **[next-themes](https://github.com/pacocoursey/next-themes)** - Theme provider documentation
