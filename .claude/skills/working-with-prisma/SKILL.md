---
name: working-with-prisma
description: Guides Prisma 7 database patterns and project conventions. Use when designing schemas, writing queries, or working with the Data Access Layer.
---

# Working with Prisma

This skill provides **Prisma 7 patterns** specific to this project — schema design, DAL conventions, and query patterns.

**For complex database operations**: Use the `prisma-expert` agent.

## Current Documentation (Context7)

Prisma 7 has breaking changes from v6. Before implementing queries, fetch current patterns:

```
# 1. Check installed version
grep '"prisma"' package.json

# 2. Resolve library
mcp__context7__resolve-library-id: { libraryName: "prisma" }

# 3. Fetch specific docs (use focused topics to minimize tokens)
mcp__context7__get-library-docs: {
  context7CompatibleLibraryID: "[resolved-id]",
  topic: "[specific query pattern, e.g., 'findMany with relations', 'transactions', 'raw queries']"
}
```

**When to fetch docs:**
- Uncertain about current API syntax
- Implementing complex queries (nested writes, transactions)
- Working with features that changed in v7

## Project Setup

### Prisma 7 Configuration

```prisma
generator client {
  provider = "prisma-client"           // NOT "prisma-client-js"
  output   = "../src/generated/prisma" // Required explicit output
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")      // Pooled (Neon)
  directUrl = env("DIRECT_URL")        // Direct (migrations)
}
```

### Import Path

```typescript
// Correct for Prisma 7
import { PrismaClient } from '@/generated/prisma'

// Wrong - old Prisma 6 pattern
import { PrismaClient } from '@prisma/client'
```

## Naming Conventions

**All database identifiers use snake_case. Prisma models use PascalCase/camelCase.**

### Required Mappings

```prisma
model BlogPost {
  id          String   @id @default(cuid())
  authorId    String   @map("author_id")
  title       String
  publishedAt DateTime? @map("published_at")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  author User @relation(fields: [authorId], references: [id])

  @@map("blog_posts")
}
```

### Mapping Rules

| What | Rule | Example |
|------|------|---------|
| Model | `@@map("snake_case_plural")` | `BlogPost` → `blog_posts` |
| Multi-word field | `@map("snake_case")` | `authorId` → `author_id` |
| Single-word field | Skip `@map` | `id`, `name`, `email` |
| Enum values | `@map("lowercase")` | `ACTIVE` → `active` |

## Data Access Layer (DAL)

### Architecture

**All Prisma imports are confined to `entities/*/api/` and `shared/api/`.**

```
src/layers/entities/user/
├── api/
│   ├── queries.ts      # Read operations
│   ├── mutations.ts    # Write operations
│   └── index.ts        # Re-exports
├── model/
│   └── types.ts        # Zod schemas, TypeScript types
└── index.ts            # Public API
```

### Query Pattern

```typescript
// entities/user/api/queries.ts
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/layers/shared/api/auth'

export async function getUserById(id: string) {
  const currentUser = await getCurrentUser()

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true }
  })

  if (!user) return null

  // Enforce authorization
  if (user.id !== currentUser?.id && !currentUser?.isAdmin) {
    throw new Error('Unauthorized')
  }

  return user
}
```

### Mutation Pattern

```typescript
// entities/user/api/mutations.ts
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/layers/shared/api/auth'
import type { CreateUserInput } from '../model/types'

export async function createUser(data: CreateUserInput) {
  const currentUser = await requireAuth()

  if (!currentUser.isAdmin) {
    throw new Error('Only admins can create users')
  }

  return prisma.user.create({ data })
}
```

### DAL Rules

| Rule | Reason |
|------|--------|
| Never import `prisma` outside DAL | Centralizes data access |
| Auth checks in every function | Defense in depth |
| Throw errors, don't return null for auth | Distinguishes "not found" from "forbidden" |
| Export via entity index.ts | Clean public API |

## Schema Design

### Relations

```prisma
// One-to-Many
model User {
  id    String  @id @default(cuid())
  posts Post[]

  @@map("users")
}

model Post {
  id       String @id @default(cuid())
  author   User   @relation(fields: [authorId], references: [id])
  authorId String @map("author_id")

  @@index([authorId])  // Always index foreign keys
  @@map("posts")
}
```

### Cascade Deletes

```prisma
model Post {
  // Delete comments when post is deleted
  comments Comment[] @relation("PostComments")
}

model Comment {
  post   Post   @relation("PostComments", fields: [postId], references: [id], onDelete: Cascade)
  postId String
}
```

### Indexes

```prisma
model Post {
  id        String   @id @default(cuid())
  slug      String   @unique
  authorId  String
  createdAt DateTime @default(now())

  @@index([authorId])                          // Single field
  @@index([createdAt(sort: Desc)])             // Sorted
  @@index([authorId, createdAt(sort: Desc)])   // Composite
}
```

## Query Patterns

### Selecting Specific Fields

```typescript
// Good - only fetch needed fields
const user = await prisma.user.findUnique({
  where: { id },
  select: { id: true, email: true, name: true }
})

// Avoid - fetches all fields
const user = await prisma.user.findUnique({ where: { id } })
```

### Including Relations

```typescript
// Include related data
const post = await prisma.post.findUnique({
  where: { id },
  include: {
    author: { select: { id: true, name: true } },
    comments: { take: 10, orderBy: { createdAt: 'desc' } }
  }
})
```

### Pagination

```typescript
// Cursor-based (preferred for large datasets)
const posts = await prisma.post.findMany({
  take: 20,
  skip: 1,
  cursor: { id: lastPostId },
  orderBy: { createdAt: 'desc' }
})

// Offset-based (simpler, for smaller datasets)
const posts = await prisma.post.findMany({
  take: 20,
  skip: page * 20,
  orderBy: { createdAt: 'desc' }
})
```

### Transactions

```typescript
export async function createOrderWithItems(data: CreateOrderInput) {
  const user = await requireAuth()

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: { userId: user.id, status: 'pending' }
    })

    await tx.orderItem.createMany({
      data: data.items.map(item => ({
        orderId: order.id,
        ...item
      }))
    })

    return order
  })
}
```

## Migration Workflow

### Development

```bash
# Create migration (requires interactive terminal)
pnpm prisma migrate dev --name descriptive_name

# Apply existing migrations
pnpm prisma migrate deploy
pnpm prisma generate
```

### Using `/db:migrate` Command

The project provides `/db:migrate` for safe migration application:
- Validates schema before migrating
- Applies pending migrations
- Regenerates Prisma client
- Verifies client generation

### Resetting (Development Only)

```bash
# Destructive - drops all data!
pnpm prisma migrate reset
```

## Live Database Inspection

For debugging and verification, use MCP database tools to inspect actual data:

### Check Schema and Data

```
mcp__mcp-dev-db__get_schema_overview: {}
mcp__mcp-dev-db__get_table_details: { table: "users" }
```

### Verify Mutations

```
mcp__mcp-dev-db__execute_sql_select: {
  sql: "SELECT * FROM [table] WHERE id = '[id]'"
}
```

### Analyze Query Performance

```
mcp__mcp-dev-db__explain_query: {
  sql: "SELECT * FROM posts WHERE author_id = '...' ORDER BY created_at DESC"
}
```

**Requires**: `MCP_DEV_ONLY_DB_ACCESS=true` in `.env.local`

See `/debug:data` command for interactive database inspection.

## Common Issues

### "Cannot find module '@/generated/prisma'"

```bash
pnpm prisma generate
```

### Schema Drift

```bash
pnpm prisma db pull   # Pull current DB state
pnpm prisma migrate dev  # Create migration for differences
```

### Connection Issues (Neon)

- Use `DATABASE_URL` with pooled connection string
- Use `DIRECT_URL` only for migrations
- Check Neon dashboard for connection limits

### Type Mismatches

Regenerate types after schema changes:
```bash
pnpm prisma generate
```

## Best Practices

### Do

- Index all foreign keys
- Use `select` to fetch only needed fields
- Use transactions for multi-step operations
- Add `onDelete` behavior explicitly
- Use `cuid()` or `uuid()` for IDs

### Don't

- Import Prisma outside DAL
- Use raw SQL unless necessary
- Skip auth checks in DAL functions
- Use N+1 queries (use `include`)
- Forget to run `prisma generate` after schema changes

## Quick Reference

### Common Commands

```bash
pnpm prisma:generate   # Generate client
pnpm prisma:studio     # Open Prisma Studio
pnpm prisma validate   # Validate schema
```

### File Locations

| What | Where |
|------|-------|
| Schema | `prisma/schema.prisma` |
| Migrations | `prisma/migrations/` |
| Generated client | `src/generated/prisma/` |
| Prisma singleton | `src/lib/prisma.ts` |
| DAL functions | `src/layers/entities/*/api/` |
| Auth utilities | `src/layers/shared/api/auth.ts` |

## References

- `prisma-expert` agent — Complex schema design, optimization
- `developer-guides/03-database-prisma.md` — Full database guide
- `/db:migrate` command — Safe migration application
- `/debug:data` command — Live database inspection with MCP tools
