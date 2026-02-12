---
paths: apps/client/src/components/**/*.tsx, apps/client/src/**/*.tsx
---

# UI Component Rules

These rules apply to all React components in `apps/client/src/components/` and client UI segments.

## Component Structure

### Shadcn UI Components (`apps/client/src/components/ui/`)

Base primitives following Shadcn patterns:

```typescript
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const componentVariants = cva(
  "base-classes-here",
  {
    variants: {
      variant: {
        default: "default-styles",
        secondary: "secondary-styles",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-sm",
        lg: "h-12 px-6 text-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Component({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof componentVariants>) {
  return (
    <div
      data-slot="component"
      className={cn(componentVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Component, componentVariants }
```

### Client Components (`apps/client/src/`)

Feature/widget components with business logic:

```typescript
'use client'  // Only if using hooks/interactivity

import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { someUtil } from '../lib/utils'
import type { EntityType } from '../model/types'

interface Props {
  data: EntityType
  onAction?: () => void
}

export function FeatureComponent({ data, onAction }: Props) {
  const pathname = usePathname()

  return (
    <div className="space-y-4">
      {/* Component content */}
    </div>
  )
}
```

## Base UI Composition (Not Radix)

This project uses **Base UI** (via basecn) instead of Radix UI. Key differences:

### Composition Pattern: `render` prop (not `asChild`)

```tsx
// WRONG (Radix pattern - won't work)
<Button asChild>
  <Link href="/contact">Contact</Link>
</Button>

// CLIENT COMPONENTS: render prop works
'use client'
<Button render={<Link href="/contact" />}>
  Contact
</Button>

// SERVER COMPONENTS: Use plain Link with button styles (avoid render prop)
// The render prop can cause "Element type is invalid" errors in Server Components
<Link
  href="/contact"
  className="inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium h-9 px-4 py-2 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90"
>
  Contact
</Link>

// With SidebarMenuButton (Client Component - uses useRender)
<SidebarMenuButton render={<Link href={item.href} />}>
  <Icon className="size-4" />
  <span>{item.label}</span>
</SidebarMenuButton>
```

**Server Component Limitation:** The `Button render={<Link .../>}` pattern can cause intermittent "Element type is invalid: expected a string...but got: undefined" errors in React Server Components. When building Server Components, use plain `<Link>` elements with Tailwind button classes instead.

### Type Workarounds

**Dialog children type**: When wrapping Dialog, use `Omit` to override children type:

```tsx
function MyDialog({ children, ...props }: Omit<DialogProps, "children"> & {
  children?: React.ReactNode
}) {
  // children can now be passed to non-Dialog components
}
```

**Button type attribute**: Base UI Button doesn't include HTML button type by default:

```tsx
// Add type explicitly when needed
type Props = ButtonProps & {
  type?: "button" | "submit" | "reset"
}
```

### Positioner Pattern (Critical)

Base UI requires `Popup`, `Arrow`, and `ScrollArrow` to be inside a `Positioner`. The `*Content` components must be self-contained:

```tsx
// WRONG (basecn default - exposes Positioner separately)
// This breaks if users don't manually wrap Content in Positioner
<Select>
  <SelectTrigger />
  <SelectContent />  {/* Error: PositionerContext missing */}
</Select>

// CORRECT (self-contained Content)
function SelectContent({ children, ...props }) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner sideOffset={5} className="z-50">
        <SelectPrimitive.Popup {...props}>
          {children}
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}
```

**When installing new basecn components**, check if `*Content` wraps `Portal > Positioner > Popup`. If not, update it to be self-contained. Components affected:
- Select, Popover, Tooltip, HoverCard, DropdownMenu, ContextMenu, Dialog, Sheet, AlertDialog

### GroupLabel Pattern (Critical)

Base UI requires `GroupLabel` to be inside a `Group`. The `*Label` components must self-contain their Group wrapper:

```tsx
// WRONG (basecn default - exposes GroupLabel without Group)
// This breaks if users don't manually wrap Label in Group
<DropdownMenuContent>
  <DropdownMenuLabel>My Account</DropdownMenuLabel>  {/* Error: MenuGroupRootContext missing */}
  <DropdownMenuItem>Profile</DropdownMenuItem>
</DropdownMenuContent>

// CORRECT (self-contained Label with Group wrapper)
function DropdownMenuLabel({ className, inset, ...props }) {
  return (
    <MenuPrimitive.Group>
      <MenuPrimitive.GroupLabel {...props} />
    </MenuPrimitive.Group>
  );
}
```

**When installing new basecn components**, check if `*Label` or `*GroupLabel` wraps in a `Group`. Components affected:
- DropdownMenuLabel, ContextMenuGroupLabel

### Component Mapping

| Radix | Base UI |
|-------|---------|
| HoverCard | PreviewCard |
| `side` prop on Content | `sideOffset` on Positioner |
| `asChild` | `render` prop |
| Multiple @radix-ui/* packages | Single @base-ui/react |

### SSR Purity

Never use `Math.random()` in components - causes lint errors and SSR mismatches:

```tsx
// WRONG
const width = Math.random() * 40 + 50

// CORRECT - use useId for deterministic "random" values
const id = React.useId()
const width = React.useMemo(() => {
  const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return (hash % 40) + 50
}, [id])
```

## Required Patterns

### Use Client Directive

Only add `'use client'` when the component uses:
- React hooks (`useState`, `useEffect`, etc.)
- Browser APIs (`window`, `document`)
- Event handlers (`onClick`, `onChange`)
- Third-party client libraries

```typescript
// Server Component (default) - no directive needed
export function StaticCard({ title }: { title: string }) {
  return <div>{title}</div>
}

// Client Component - needs directive
'use client'
export function InteractiveCard() {
  const [open, setOpen] = useState(false)
  return <button onClick={() => setOpen(!open)}>Toggle</button>
}
```

### Styling with cn()

Always use `cn()` for conditional/merged classes:

```typescript
import { cn } from "@/lib/utils"

<div className={cn(
  "base-classes",
  isActive && "active-classes",
  className  // Always last to allow overrides
)} />
```

### Data Slot Attribute

Add `data-slot` for styling hooks (Shadcn pattern):

```typescript
<button data-slot="button" className={...} />
<div data-slot="card-header" className={...} />
```

### Focus Styles

Use focus-visible, not focus:

```typescript
// Correct - only shows on keyboard navigation
"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

// Wrong - shows on every click
"focus:ring-2 focus:ring-ring"
```

## Accessibility Requirements

### Interactive Elements

```typescript
// Buttons must have accessible names
<Button aria-label="Close dialog">
  <X className="size-4" />
</Button>

// Links must describe destination
<Link href="/settings">Settings</Link>  // Good
<Link href="/settings">Click here</Link>  // Bad

// Form inputs need labels
<Label htmlFor="email">Email</Label>
<Input id="email" type="email" />
```

### Semantic HTML

```typescript
// Use semantic elements
<nav>...</nav>           // Navigation
<main>...</main>         // Main content
<article>...</article>   // Self-contained content
<aside>...</aside>       // Sidebar content
<header>...</header>     // Header section
<footer>...</footer>     // Footer section

// Use heading hierarchy
<h1>Page Title</h1>
<h2>Section</h2>
<h3>Subsection</h3>
```

## Design System: Calm Tech

Follow the Calm Tech design language (see `docs/DESIGN_SYSTEM.md`):

| Element | Specification |
|---------|---------------|
| Card radius | 16px (`rounded-xl`) |
| Button/Input radius | 10px (`rounded-md`) |
| Button height | 40px default |
| Card padding | 24px (`p-6`) |
| Animation duration | 100-300ms |

### Custom Utilities

```typescript
// Shadows
"shadow-soft"      // Subtle depth
"shadow-elevated"  // Cards
"shadow-floating"  // Dropdowns
"shadow-modal"     // Modals

// Containers
"container-narrow"   // 42rem max
"container-default"  // 56rem max
"container-wide"     // 72rem max

// Interactive
"card-interactive"  // Hover lift effect
"focus-ring"        // Consistent focus state
```

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

// NEVER forget forwardRef for wrapped primitives
function Input(props) {  // Wrong - breaks refs
  return <input {...props} />
}
const Input = React.forwardRef<HTMLInputElement, Props>((props, ref) => {
  return <input ref={ref} {...props} />
})  // Correct
```

## File Naming

| Type | Convention | Example |
|------|------------|---------|
| Component file | PascalCase | `UserCard.tsx` |
| Utility file | kebab-case | `use-sidebar.ts` |
| Index exports | `index.ts` | Re-export public API |
