# Project Structure Guide

## Overview

This project uses Feature-Sliced Design (FSD) to organize code by business domains with clear layer boundaries. FSD enforces unidirectional dependencies (higher layers import from lower layers only) and separates code by technical purpose (ui, model, api).

## Key Files

| Concept | Location |
|---------|----------|
| App Router pages | `src/app/**/page.tsx` |
| API routes | `src/app/api/**/route.ts` |
| Feature modules | `src/layers/features/[feature]/` |
| Business entities | `src/layers/entities/[entity]/` |
| Shared UI components | `src/layers/shared/ui/` |
| DAL utilities | `src/layers/shared/api/` |
| Prisma singleton | `src/lib/prisma.ts` (DAL only) |
| Environment config | `src/env.ts` |

## When to Use What

| Scenario | Location | Why |
|----------|----------|-----|
| New page or route | `src/app/[route]/page.tsx` | App Router convention, routing layer |
| External API endpoint | `src/app/api/[endpoint]/route.ts` | Webhooks, third-party integrations need HTTP access |
| Complete user feature | `src/layers/features/[feature]/` | Bundles UI, logic, and actions for one capability |
| Business entity type | `src/layers/entities/[entity]/` | Domain object with data access and types |
| Database query | `src/layers/entities/[entity]/api/queries.ts` | Centralized data access with auth checks |
| Database mutation | `src/layers/entities/[entity]/api/mutations.ts` | Centralized writes with validation |
| Reusable UI primitive | `src/layers/shared/ui/` | Domain-agnostic components (buttons, cards) |
| Utility function | `src/layers/shared/lib/` | Pure functions with no business logic |
| Large UI composition | `src/layers/widgets/[widget]/` | Combines multiple features (dashboards, sidebars) |

## Core Patterns

### FSD Layer Hierarchy

FSD enforces unidirectional dependencies from top to bottom:

```
app → widgets → features → entities → shared
```

| Layer | Purpose | Can Import From |
|-------|---------|-----------------|
| `app/` | Routes, layouts, providers | All lower layers |
| `widgets/` | Large UI compositions | features, entities, shared |
| `features/` | Complete user-facing functionality | entities, shared |
| `entities/` | Business domain objects | shared only |
| `shared/` | Reusable utilities, UI primitives | Nothing (base layer) |

**Key rules:**
- Higher layers can import from lower layers
- Never import upward (e.g., entities → features)
- Never import across same-level modules (e.g., feature A → feature B)
- All Prisma imports confined to `entities/*/api/` and `shared/api/`

### Entity Structure

Business domain objects with data access, types, and UI:

```
src/layers/entities/user/
├── api/
│   ├── queries.ts      # Read operations (getUserById, listUsers)
│   ├── mutations.ts    # Write operations (createUser, updateUser)
│   └── index.ts        # Public exports
├── model/
│   └── types.ts        # Zod schemas, TypeScript types
├── ui/
│   └── UserAvatar.tsx  # Domain-specific UI components
└── index.ts            # Public API (re-exports from api/, model/, ui/)
```

Example entity DAL function:

```typescript
// entities/user/api/queries.ts
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/layers/shared/api/auth'
import type { User } from '../model/types'

export async function getUserById(id: number): Promise<User | null> {
  const currentUser = await getCurrentUser()

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, image: true }
  })

  // Enforce visibility rules
  if (user && user.isPrivate && user.id !== currentUser?.id) {
    return null
  }

  return user
}
```

### Feature Structure

Complete user-facing functionality with UI, logic, and server actions:

```
src/layers/features/user-profile/
├── ui/
│   ├── UserCard.tsx         # Feature-specific components
│   └── EditProfileForm.tsx
├── model/
│   ├── types.ts             # Feature types, schemas
│   └── use-profile.ts       # Client-side hooks
├── api/
│   └── actions.ts           # Server actions for this feature
└── index.ts                 # Public exports
```

Example feature component:

```typescript
// features/user-profile/ui/UserCard.tsx
import { UserAvatar } from '@/layers/entities/user'  // ✅ Import entity UI
import { Button } from '@/layers/shared/ui'          // ✅ Import shared primitives
import type { User } from '@/layers/entities/user'

export function UserCard({ user }: { user: User }) {
  return (
    <div className="card-interactive">
      <UserAvatar user={user} />
      <h3>{user.name}</h3>
      <Button>View Profile</Button>
    </div>
  )
}
```

### Import Patterns

Use `@/` alias for all imports from `src/`:

```typescript
// FSD layer imports
import { UserCard } from '@/layers/features/user-profile'
import { getUserById } from '@/layers/entities/user'
import { Button } from '@/layers/shared/ui'

// Core utilities
import { prisma } from '@/lib/prisma'  // Only in DAL functions!
import { cn } from '@/lib/utils'
import { env } from '@/env'
```

### File Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| React components | PascalCase | `UserCard.tsx`, `SignInForm.tsx` |
| Pages | `page.tsx` in route folder | `app/profile/page.tsx` |
| API routes | `route.ts` in route folder | `app/api/users/route.ts` |
| Hooks | `use-` prefix, kebab-case | `use-mobile.ts`, `use-session.ts` |
| Stores | `-store` suffix, kebab-case | `user-store.ts` |
| Types/Schemas | `types.ts` in `model/` | `entities/user/model/types.ts` |
| DAL queries | `queries.ts` in `api/` | `entities/user/api/queries.ts` |
| DAL mutations | `mutations.ts` in `api/` | `entities/user/api/mutations.ts` |
| Server actions | `actions.ts` in `api/` | `features/auth/api/actions.ts` |

### Next.js App Router Conventions

| File | Purpose |
|------|---------|
| `page.tsx` | Page component (defines route) |
| `layout.tsx` | Layout wrapper (wraps children) |
| `loading.tsx` | Loading UI (Suspense fallback) |
| `error.tsx` | Error boundary (catches errors in route) |
| `route.ts` | API route handler (HTTP endpoints) |
| `(group)/` | Route group (logical grouping, no URL segment) |

## Anti-Patterns

```typescript
// ❌ NEVER import upward in layer hierarchy
// In entities/user/api/queries.ts
import { UserProfileForm } from '@/layers/features/user-profile'  // features is higher layer!

// ✅ Import downward only
// In features/user-profile/ui/UserCard.tsx
import { getUserById } from '@/layers/entities/user'  // entities is lower layer
```

```typescript
// ❌ NEVER import Prisma outside DAL
// In app/users/page.tsx
import { prisma } from '@/lib/prisma'
const users = await prisma.user.findMany()  // Bypasses auth, violates DAL pattern

// ✅ Always use DAL functions
// In app/users/page.tsx
import { listUsers } from '@/layers/entities/user'
const users = await listUsers()  // Auth checked, consistent patterns
```

```typescript
// ❌ NEVER import across same-level modules
// In features/user-profile/ui/UserCard.tsx
import { PostList } from '@/layers/features/post-feed'  // Cross-feature dependency!

// ✅ Create a widget that composes both features
// In widgets/user-dashboard/ui/Dashboard.tsx
import { UserCard } from '@/layers/features/user-profile'
import { PostList } from '@/layers/features/post-feed'
// Now both features are composed at a higher layer
```

```typescript
// ❌ NEVER put business logic in shared/
// In shared/lib/user-utils.ts
export function isUserAdmin(user: User) { /* ... */ }  // Business logic belongs in entity!

// ✅ Put business logic in entity model/
// In entities/user/model/helpers.ts
export function isUserAdmin(user: User) { /* ... */ }
```

```typescript
// ❌ NEVER use relative imports for FSD layers
import { Button } from '../../../shared/ui/button'  // Hard to refactor, unclear layer

// ✅ Always use @/ alias
import { Button } from '@/layers/shared/ui/button'  // Clear layer, easy to refactor
```

## Adding a New Feature

1. **Create feature directory** in `src/layers/features/`:
   ```bash
   mkdir -p src/layers/features/my-feature/{ui,model,api}
   touch src/layers/features/my-feature/index.ts
   ```

2. **Create entity if needed** (for new business domain):
   ```bash
   mkdir -p src/layers/entities/my-entity/{ui,model,api}
   touch src/layers/entities/my-entity/index.ts
   ```

3. **Add types and schemas** in `model/types.ts`:
   ```typescript
   // entities/my-entity/model/types.ts
   import { z } from 'zod'

   export const myEntitySchema = z.object({
     id: z.number(),
     name: z.string(),
   })

   export type MyEntity = z.infer<typeof myEntitySchema>
   ```

4. **Create DAL functions** in entity `api/`:
   ```typescript
   // entities/my-entity/api/queries.ts
   import { prisma } from '@/lib/prisma'
   import { requireAuth } from '@/layers/shared/api/auth'

   export async function getMyEntity(id: number) {
     await requireAuth()
     return prisma.myEntity.findUnique({ where: { id } })
   }
   ```

5. **Build feature UI** in `features/my-feature/ui/`:
   ```typescript
   // features/my-feature/ui/MyFeature.tsx
   import { getMyEntity } from '@/layers/entities/my-entity'

   export async function MyFeature({ id }: { id: number }) {
     const entity = await getMyEntity(id)
     return <div>{entity.name}</div>
   }
   ```

6. **Export public API** in `index.ts`:
   ```typescript
   // features/my-feature/index.ts
   export { MyFeature } from './ui/MyFeature'
   ```

7. **Use in page**:
   ```typescript
   // app/my-feature/page.tsx
   import { MyFeature } from '@/layers/features/my-feature'

   export default async function Page() {
     return <MyFeature id={1} />
   }
   ```

## Troubleshooting

### "Cannot import from higher layer"

**Cause**: Attempting to import from a higher FSD layer (e.g., importing a feature from an entity).

**Fix**: Reverse the dependency. Move shared logic to a lower layer (shared or entity) or create a widget to compose both.

```typescript
// Before (broken)
// In entities/user/api/queries.ts
import { formatUserProfile } from '@/layers/features/user-profile'  // ❌

// After (fixed)
// Move formatting to entity
// In entities/user/model/helpers.ts
export function formatUserProfile(user: User) { /* ... */ }

// Or use composition
// In features/user-profile/ui/UserCard.tsx
import { getUserById } from '@/layers/entities/user'  // ✅
```

### "Circular dependency detected"

**Cause**: Two modules importing each other, often from cross-layer imports or shared index files.

**Fix**:
1. Check for upward imports (violates FSD hierarchy)
2. Avoid re-exporting everything in `index.ts` — export only public API
3. Move shared code to a lower layer

```typescript
// Bad: index.ts exports everything
export * from './ui'
export * from './model'
export * from './api'

// Good: index.ts exports public API only
export { UserCard } from './ui/UserCard'
export { getUserById, listUsers } from './api/queries'
export type { User } from './model/types'
```

### "Cannot find module '@/layers/...'"

**Cause**: TypeScript path alias not configured or wrong import path.

**Fix**: Verify `tsconfig.json` has path alias:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

### DAL function not enforcing auth

**Cause**: Forgot to call `requireAuth()` or `getCurrentUser()` at start of function.

**Fix**: Every DAL function must check auth:

```typescript
// Before (broken)
export async function deleteUser(id: number) {
  return prisma.user.delete({ where: { id } })  // ❌ No auth check!
}

// After (fixed)
export async function deleteUser(id: number) {
  const user = await requireAuth()
  if (user.id !== id && !user.isAdmin) {
    throw new UnauthorizedError('Cannot delete other users')
  }
  return prisma.user.delete({ where: { id } })
}
```

### Prisma import outside DAL

**Cause**: Importing `prisma` directly in Server Component, Server Action, or API Route instead of using DAL.

**Fix**: Call DAL function from entity `api/`:

```typescript
// Before (broken)
// In app/users/page.tsx
import { prisma } from '@/lib/prisma'  // ❌
const users = await prisma.user.findMany()

// After (fixed)
// In app/users/page.tsx
import { listUsers } from '@/layers/entities/user'  // ✅
const users = await listUsers()
```

## Roadmap Feature

The roadmap visualization lives at `/roadmap` and is implemented as a feature in the FSD architecture:

```
src/layers/features/roadmap/
├── ui/                              # React components
│   ├── RoadmapVisualization.tsx     # Main client component
│   ├── TimelineView.tsx             # Now/Next/Later kanban
│   ├── StatusView.tsx               # Status-based kanban
│   ├── PriorityView.tsx             # MoSCoW grouped list
│   ├── RoadmapCard.tsx              # Item card
│   ├── RoadmapModal.tsx             # Item detail modal
│   ├── RoadmapFilterPanel.tsx       # Filter controls
│   ├── ViewToggle.tsx               # View mode selector
│   ├── HealthDashboard.tsx          # Metrics display
│   └── RoadmapHeader.tsx            # Project header
├── model/
│   ├── types.ts                     # Zod schemas, TypeScript types
│   └── constants.ts                 # Labels, colors, formatters
├── lib/
│   └── use-roadmap-filters.ts       # URL state persistence hook
└── index.ts                         # Public exports
```

**Data source**: `roadmap/roadmap.json` (managed by Python scripts, bundled at build time)

**Data flow**:
1. Python CLI scripts write to `roadmap/roadmap.json`
2. `roadmap/roadmap.ts` imports JSON with TypeScript types
3. Next.js Server Component imports the typed data at build time
4. React components render the visualization
5. Changes require: edit JSON → commit → deploy

**Key files**:
- `roadmap/roadmap.ts` - TypeScript wrapper that imports JSON with types
- `src/app/(public)/roadmap/page.tsx` - Route handler (static, prerendered)
- `src/layers/features/roadmap/ui/RoadmapVisualization.tsx` - Main client component

**Python scripts** (unchanged, work with the JSON file):
- `roadmap/scripts/update_status.py` - Change item status
- `roadmap/scripts/link_spec.py` - Link spec files to items
- `roadmap/scripts/find_by_title.py` - Search items by title

## References

- [Feature-Sliced Design Documentation](https://feature-sliced.design/) - Official FSD methodology
- [Data Access Layer (DAL)](./03-database-prisma.md) - Database query patterns and auth enforcement
- [Forms & Validation](./04-forms-validation.md) - Feature form patterns with Zod schemas
