---
paths: apps/server/src/services/**/*.ts, packages/shared/src/**/*.ts
---

# Data Access Layer (DAL) Rules

These rules apply to all DAL functions in the entities and shared layers.

## Architecture

DAL functions are the ONLY place where Prisma should be imported:

```
apps/server/src/services/
├── [service-name].ts      # Service logic (queries + mutations)
└── index.ts               # Re-exports

packages/shared/src/
├── schemas.ts             # Zod schemas and types
└── types.ts               # Re-exported types
```

## Required Patterns

### Every DAL Function Must

1. **Check authorization** before data access
2. **Accept validated input** (caller validates with Zod)
3. **Return typed data** with explicit return types
4. **Throw errors** for auth failures (not null)

### Query Pattern

```typescript
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/layers/shared/api/auth'
import type { Entity } from '../model/types'

export async function getEntityById(id: string): Promise<Entity | null> {
  const user = await getCurrentUser()

  const entity = await prisma.entity.findUnique({
    where: { id },
    select: { id: true, name: true, ownerId: true }  // Explicit select
  })

  if (!entity) return null

  // Authorization check
  if (entity.ownerId !== user?.id && !user?.isAdmin) {
    throw new UnauthorizedError('Access denied')
  }

  return entity
}
```

### Mutation Pattern

```typescript
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/layers/shared/api/auth'
import type { CreateEntityInput } from '../model/types'

export async function createEntity(data: CreateEntityInput): Promise<Entity> {
  const user = await requireAuth()  // Throws if not authenticated

  return prisma.entity.create({
    data: {
      ...data,
      ownerId: user.id,
    }
  })
}
```

## Naming Conventions

### Function Names

| Operation | Prefix | Example |
|-----------|--------|---------|
| Get single | `get` | `getUserById`, `getPostBySlug` |
| Get multiple | `list` | `listUserPosts`, `listActiveUsers` |
| Create | `create` | `createUser`, `createPost` |
| Update | `update` | `updateUser`, `updatePostStatus` |
| Delete | `delete` | `deleteUser`, `softDeletePost` |
| Check existence | `exists` | `emailExists`, `slugExists` |

### Database Naming

All database identifiers use snake_case:

```prisma
model BlogPost {
  id        String   @id @default(cuid())
  authorId  String   @map("author_id")
  createdAt DateTime @default(now()) @map("created_at")

  @@map("blog_posts")
}
```

## Anti-Patterns (Never Do)

```typescript
// NEVER return null for auth failures
if (!authorized) return null  // Wrong!
if (!authorized) throw new UnauthorizedError()  // Correct

// NEVER skip auth checks
export async function getUser(id: string) {
  return prisma.user.findUnique({ where: { id } })  // Wrong!
}

// NEVER use include without limits
include: { comments: true }  // Wrong - could be thousands
include: { comments: { take: 10 } }  // Correct
```

## Query Optimization

- Use `select` to fetch only needed fields
- Index all foreign keys
- Use cursor pagination for large datasets
- Add `take` limits to relations
