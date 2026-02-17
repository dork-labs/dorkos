---
paths: apps/client/src/**/*.tsx, apps/client/src/layers/**/ui/**/*.tsx
---

# UI Component Rules

These rules apply to all React components in `apps/client/src/` and FSD UI segments.

## FSD Layer Awareness

Components live in different FSD layers with different rules:

| Location                | Layer    | Can Import From                        |
| ----------------------- | -------- | -------------------------------------- |
| `layers/shared/ui/`     | shared   | Nothing in layers/ (Shadcn primitives) |
| `layers/entities/*/ui/` | entities | `shared/` only                         |
| `layers/features/*/ui/` | features | `entities/`, `shared/`                 |
| `layers/widgets/*/ui/`  | widgets  | `features/`, `entities/`, `shared/`    |

See `.claude/rules/fsd-layers.md` for full import rules.

## Component Structure

### Shadcn UI Components (`layers/shared/ui/`)

Base primitives following Shadcn patterns:

```typescript
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/layers/shared/lib"

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

### FSD Layer Components (`layers/features/*/ui/`, `layers/entities/*/ui/`, etc.)

Feature/entity components with business logic:

```typescript
import { Button } from '@/layers/shared/ui'
import { useSession } from '@/layers/entities/session'
import type { Session } from '@dorkos/shared/types'

interface Props {
  session: Session
  onAction?: () => void
}

export function FeatureComponent({ session, onAction }: Props) {
  const { currentSession } = useSession()

  return (
    <div className="space-y-4">
      {/* Component content */}
    </div>
  )
}
```

## Base UI Composition (Planned Migration)

> **NOTE**: The project currently uses **Radix UI** with `asChild` composition. The patterns below document Base UI (via basecn) for a planned future migration. Until migration happens, use Radix/`asChild` patterns in new code.

Key differences from Radix:

### Composition Pattern: `render` prop (not `asChild`)

```tsx
// WRONG (Radix pattern - won't work)
<Button asChild>
  <a href="/contact">Contact</a>
</Button>

// CORRECT: render prop
<Button render={<a href="/contact" />}>
  Contact
</Button>

// With SidebarMenuButton
<SidebarMenuButton render={<a href={item.href} />}>
  <Icon className="size-4" />
  <span>{item.label}</span>
</SidebarMenuButton>
```

### Type Workarounds

**Dialog children type**: When wrapping Dialog, use `Omit` to override children type:

```tsx
function MyDialog({
  children,
  ...props
}: Omit<DialogProps, 'children'> & {
  children?: React.ReactNode;
}) {
  // children can now be passed to non-Dialog components
}
```

**Button type attribute**: Base UI Button doesn't include HTML button type by default:

```tsx
// Add type explicitly when needed
type Props = ButtonProps & {
  type?: 'button' | 'submit' | 'reset';
};
```

### Positioner Pattern (Critical)

Base UI requires `Popup`, `Arrow`, and `ScrollArrow` to be inside a `Positioner`. The `*Content` components must be self-contained:

```tsx
// WRONG (basecn default - exposes Positioner separately)
// This breaks if users don't manually wrap Content in Positioner
<Select>
  <SelectTrigger />
  <SelectContent /> {/* Error: PositionerContext missing */}
</Select>;

// CORRECT (self-contained Content)
function SelectContent({ children, ...props }) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner sideOffset={5} className="z-50">
        <SelectPrimitive.Popup {...props}>{children}</SelectPrimitive.Popup>
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
  <DropdownMenuLabel>My Account</DropdownMenuLabel> {/* Error: MenuGroupRootContext missing */}
  <DropdownMenuItem>Profile</DropdownMenuItem>
</DropdownMenuContent>;

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

| Radix                          | Base UI                    |
| ------------------------------ | -------------------------- |
| HoverCard                      | PreviewCard                |
| `side` prop on Content         | `sideOffset` on Positioner |
| `asChild`                      | `render` prop              |
| Multiple @radix-ui/\* packages | Single @base-ui/react      |

### Deterministic Values

Never use `Math.random()` in components — use `useId` for deterministic values:

```tsx
// WRONG
const width = Math.random() * 40 + 50;

// CORRECT - use useId for deterministic "random" values
const id = React.useId();
const width = React.useMemo(() => {
  const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return (hash % 40) + 50;
}, [id]);
```

## Required Patterns

### Styling with cn()

Always use `cn()` for conditional/merged classes:

```typescript
import { cn } from "@/layers/shared/lib"

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
'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

// Wrong - shows on every click
'focus:ring-2 focus:ring-ring';
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

Follow the Calm Tech design language (see `contributing/design-system.md`):

| Element             | Specification       |
| ------------------- | ------------------- |
| Card radius         | 16px (`rounded-xl`) |
| Button/Input radius | 10px (`rounded-md`) |
| Button height       | 40px default        |
| Card padding        | 24px (`p-6`)        |
| Animation duration  | 100-300ms           |

### Custom Utilities

```typescript
// Shadows
'shadow-soft'; // Subtle depth
'shadow-elevated'; // Cards
'shadow-floating'; // Dropdowns
'shadow-modal'; // Modals

// Containers
'container-narrow'; // 42rem max
'container-default'; // 56rem max
'container-wide'; // 72rem max

// Interactive
'card-interactive'; // Hover lift effect
'focus-ring'; // Consistent focus state
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

// NEVER forget ref forwarding for wrapped primitives
function Input(props) {  // Wrong - breaks refs
  return <input {...props} />
}
// React 19: ref is a regular prop, no forwardRef needed
function Input({ ref, ...props }: Props & { ref?: React.Ref<HTMLInputElement> }) {
  return <input ref={ref} {...props} />
}  // Correct
// Note: existing forwardRef usage in ui/ components is fine, but new components should use ref-as-prop
```

## File Naming

| Type           | Convention | Example              |
| -------------- | ---------- | -------------------- |
| Component file | PascalCase | `UserCard.tsx`       |
| Utility file   | kebab-case | `use-sidebar.ts`     |
| Index exports  | `index.ts` | Re-export public API |
