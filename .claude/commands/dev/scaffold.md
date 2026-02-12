---
description: Scaffold a new feature with components, schemas, and API routes
argument-hint: <feature-name>
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Scaffold New Feature

Create a complete feature scaffold following FSD (Feature-Sliced Design) architecture.

## Arguments

- `$ARGUMENTS` - The feature name in kebab-case (e.g., `user-profile`, `order-history`)

## Task

### Step 1: Validate Feature Name

Ensure the feature name follows conventions:
- Must be kebab-case (lowercase with hyphens)
- Must not already exist

Check existing features:
```bash
ls -la src/layers/features/ 2>/dev/null || echo "No features directory yet"
ls -la src/app/
```

### Step 2: Create Directory Structure

Create the following FSD-aligned structure for feature `$ARGUMENTS`:

```
src/
├── app/$ARGUMENTS/
│   ├── page.tsx           # Route page (imports from feature layer)
│   └── loading.tsx        # Loading state
└── layers/features/$ARGUMENTS/
    ├── ui/                # React components
    │   └── index.tsx      # Main feature component
    ├── model/             # Business logic, hooks, types
    │   └── types.ts       # Zod schemas and TypeScript types
    ├── api/               # Server actions (if needed)
    │   └── actions.ts     # Server actions for this feature
    └── index.ts           # Public API exports
```

### Step 3: Generate Files

**Public API** (`src/layers/features/$ARGUMENTS/index.ts`):
```typescript
// Public API - only export what other layers need
export { $ARGUMENTS_COMPONENT } from './ui'
export type { $ARGUMENTS_TYPE } from './model/types'
```
(Replace `$ARGUMENTS_COMPONENT` and `$ARGUMENTS_TYPE` with PascalCase versions)

**Main Component** (`src/layers/features/$ARGUMENTS/ui/index.tsx`):
```tsx
'use client'

import { cn } from '@/layers/shared/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/layers/shared/ui/card'

export function $ARGUMENTS_COMPONENT({ className }: { className?: string }) {
  return (
    <Card className={cn('p-6 rounded-xl shadow-soft', className)}>
      <CardHeader className="pb-4">
        <CardTitle className="text-lg font-semibold">$ARGUMENTS</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Feature content */}
      </CardContent>
    </Card>
  )
}
```
(Replace `$ARGUMENTS_COMPONENT` with PascalCase version)

**Design System Note**: Components follow Calm Tech design language:
- Cards: 16px radius (`rounded-xl`), 24px padding (`p-6`), soft shadow
- Typography: Geist fonts, semantic sizes
- See `docs/DESIGN_SYSTEM.md` for full specifications

**Types & Schema** (`src/layers/features/$ARGUMENTS/model/types.ts`):
```typescript
import { z } from 'zod'

// Define validation schemas for $ARGUMENTS
export const $ARGUMENTS_SCHEMA = z.object({
  // Add fields as needed
})

export type $ARGUMENTS_TYPE = z.infer<typeof $ARGUMENTS_SCHEMA>
```
(Replace `$ARGUMENTS_SCHEMA` and `$ARGUMENTS_TYPE` with appropriate names)

**Server Actions** (`src/layers/features/$ARGUMENTS/api/actions.ts`):
```typescript
'use server'

import { $ARGUMENTS_SCHEMA } from '../model/types'

export async function create$ARGUMENTS(data: unknown) {
  const validated = $ARGUMENTS_SCHEMA.safeParse(data)

  if (!validated.success) {
    return { error: validated.error.errors[0].message }
  }

  // TODO: Implement using DAL functions from entities layer
  // import { createEntity } from '@/layers/entities/[entity-name]'

  return { success: true }
}
```

**Page Component** (`src/app/$ARGUMENTS/page.tsx`):
```tsx
import { Metadata } from 'next'
import { $ARGUMENTS_COMPONENT } from '@/layers/features/$ARGUMENTS'

export const metadata: Metadata = {
  title: '$ARGUMENTS',
}

export default async function Page() {
  return (
    <div className="container mx-auto py-8">
      <h1 className="text-2xl font-bold mb-6">$ARGUMENTS</h1>
      <$ARGUMENTS_COMPONENT />
    </div>
  )
}
```
(Replace `$ARGUMENTS_COMPONENT` with PascalCase version)

**Loading State** (`src/app/$ARGUMENTS/loading.tsx`):
```tsx
export default function Loading() {
  return (
    <div className="container mx-auto py-8">
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-48 bg-muted rounded" />
        <div className="h-32 bg-muted rounded" />
      </div>
    </div>
  )
}
```

### Step 4: Report Created Files

List all created files and suggest next steps:

## Output Format

```
✅ Created feature scaffold: $ARGUMENTS (FSD-aligned)

Files created:
  - src/layers/features/$ARGUMENTS/index.ts (public API)
  - src/layers/features/$ARGUMENTS/ui/index.tsx (main component)
  - src/layers/features/$ARGUMENTS/model/types.ts (schemas & types)
  - src/layers/features/$ARGUMENTS/api/actions.ts (server actions)
  - src/app/$ARGUMENTS/page.tsx (route page)
  - src/app/$ARGUMENTS/loading.tsx (loading state)

Next steps:
  1. Define schema fields in src/layers/features/$ARGUMENTS/model/types.ts
  2. Build UI components in src/layers/features/$ARGUMENTS/ui/
  3. Implement server actions using DAL functions
  4. Update public exports in src/layers/features/$ARGUMENTS/index.ts

FSD Layer Rules:
  - Import from: entities/, shared/ (lower layers only)
  - Never import from: other features, widgets, app (same or higher layers)
```

## Edge Cases

- If feature already exists, warn and ask for confirmation before overwriting
- Convert PascalCase or camelCase input to kebab-case automatically
- If `$ARGUMENTS` is empty, prompt for a feature name
- If `src/layers/` doesn't exist, create it first
