# Database & Prisma Guide

## Overview

This project uses Prisma 7 with a Data Access Layer (DAL) pattern to manage database operations. All database queries must go through entity-specific DAL functions to enforce authorization and maintain consistent patterns.

## Key Files

| Concept | Location |
|---------|----------|
| Prisma config | `prisma.config.ts` (project root) |
| Schema definition | `prisma/schema.prisma` |
| Prisma singleton | `src/lib/prisma.ts` |
| Auth utilities | `src/layers/shared/api/auth.ts` |
| DAL functions | `src/layers/entities/*/api/` |
| SQLite database | `.data/dev.db` (gitignored) |
| Generated client | `src/generated/prisma/` |

## When to Use What

| Scenario | Approach | Why |
|----------|----------|-----|
| Read single record | `findUnique()` with `where: { id }` or unique field | Fastest, uses unique index |
| Read with non-unique field | `findFirst()` with `where` clause | Returns first match |
| Read all matching | `findMany()` with `where`, `orderBy`, `take` | Supports filtering, pagination |
| Fetch only needed fields | Use `select: { field: true }` | Reduces data transfer, hides sensitive fields |
| Fetch with relations | Use `include: { relation: true }` | Loads related data in one query |
| Multi-step write operation | Use `$transaction()` | Ensures atomicity (all or nothing) |
| Large result sets | Cursor-based pagination with `cursor`, `take` | More efficient than offset pagination |
| Check if exists | `count()` with `where` or `findUnique()` | `count()` for multiple, `findUnique()` for single |

## Core Patterns

### Prisma 7 Configuration

Prisma 7 requires a config file in your project root:

```typescript
// prisma.config.ts (in project root)
import 'dotenv/config'  // Required to load .env
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
})
```

### Schema Setup

```prisma
// prisma/schema.prisma
generator client {
  provider   = "prisma-client"           // Prisma 7 - NOT "prisma-client-js"
  output     = "../src/generated/prisma" // Required in Prisma 7
  engineType = "client"                  // Rust-free for smaller bundles
}

datasource db {
  provider = "sqlite"  // Use "postgresql" for production
  url      = env("DATABASE_URL")
}
```

### Database Connection

```bash
# .env
# SQLite (default for local development)
DATABASE_URL="file:./.data/dev.db"

# PostgreSQL (for production)
DATABASE_URL="postgresql://user:password@host/database?sslmode=require"
```

### Prisma Singleton

```typescript
// src/lib/prisma.ts
import { PrismaClient } from '@/generated/prisma'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
})

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
```

**Important**: Only import `prisma` in DAL functions (`entities/*/api/`), never in Server Components, Actions, or API Routes.

### Naming Conventions (Snake Case Mapping)

Both SQLite and PostgreSQL work best with lowercase snake_case identifiers. Use `@map` and `@@map` to maintain idiomatic naming:

```prisma
model BlogPost {
  id          String   @id @default(cuid())
  authorId    String   @map("author_id")      // Multi-word fields get @map
  title       String                          // Single-word fields skip @map
  publishedAt DateTime? @map("published_at")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  author User @relation(fields: [authorId], references: [id])

  @@map("blog_posts")  // Every model gets @@map for table name
}

enum PostStatus {
  DRAFT     @map("draft")      // Enum values get @map to lowercase
  PUBLISHED @map("published")
  ARCHIVED  @map("archived")
}
```

**Mapping rules:**
1. Every model: `@@map("snake_case_plural")`
2. Multi-word fields: `@map("snake_case")`
3. Single-word fields: skip `@map`
4. Enum values: `@map("lowercase")`

### DAL Query Pattern

```typescript
// entities/user/api/queries.ts
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/layers/shared/api/auth'
import type { User } from '../model/types'

export async function getUserById(id: string): Promise<User | null> {
  const currentUser = await getCurrentUser()

  const user = await prisma.user.findUnique({
    where: { id },
    // Only fetch needed fields to avoid exposing sensitive data
    select: { id: true, email: true, name: true, image: true }
  })

  if (!user) return null

  // Enforce authorization - throw for forbidden, return null for not found
  if (user.id !== currentUser?.id && !currentUser?.isAdmin) {
    throw new Error('Unauthorized to view this user')
  }

  return user
}
```

### DAL Mutation Pattern

```typescript
// entities/post/api/mutations.ts
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/layers/shared/api/auth'
import type { CreatePostInput, UpdatePostInput } from '../model/types'

export async function createPost(data: CreatePostInput) {
  const user = await requireAuth()  // Throws if not authenticated

  return prisma.post.create({
    data: {
      ...data,
      authorId: user.id  // Always set from authenticated user
    }
  })
}

export async function updatePost(id: string, data: UpdatePostInput) {
  const user = await requireAuth()

  const post = await prisma.post.findUnique({ where: { id } })
  if (!post) throw new Error('Post not found')

  // Check ownership before allowing update
  if (post.authorId !== user.id) {
    throw new Error('Cannot update post you do not own')
  }

  return prisma.post.update({ where: { id }, data })
}
```

### Query with Relations

```typescript
// entities/post/api/queries.ts
export async function getPostWithAuthor(id: string) {
  const user = await getCurrentUser()

  return prisma.post.findUnique({
    where: { id },
    include: {
      // Only select needed fields from relations
      author: { select: { id: true, name: true, image: true } },
      comments: {
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { author: { select: { name: true, image: true } } }
      }
    }
  })
}
```

### Transaction Pattern

```typescript
// entities/order/api/mutations.ts
export async function createOrderWithItems(data: CreateOrderInput) {
  const user = await requireAuth()

  // Use transaction to ensure atomicity
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: { userId: user.id, status: 'pending' }
    })

    await tx.orderItem.createMany({
      data: data.items.map(item => ({
        orderId: order.id,
        productId: item.productId,
        quantity: item.quantity
      }))
    })

    return order
  })
}
```

### Pagination Pattern

```typescript
// Cursor-based (preferred for large datasets)
export async function listPosts(cursor?: string) {
  return prisma.post.findMany({
    take: 20,
    skip: cursor ? 1 : 0,  // Skip the cursor itself
    cursor: cursor ? { id: cursor } : undefined,
    orderBy: { createdAt: 'desc' }
  })
}

// Offset-based (simpler, for smaller datasets)
export async function listPostsByPage(page: number = 1) {
  const pageSize = 20
  return prisma.post.findMany({
    take: pageSize,
    skip: (page - 1) * pageSize,
    orderBy: { createdAt: 'desc' }
  })
}
```

## Anti-Patterns

```typescript
// ❌ NEVER import prisma directly in Server Components
import { prisma } from '@/lib/prisma'

export default async function Page() {
  const users = await prisma.user.findMany()  // Bypasses auth, breaks DAL
  return <UserList users={users} />
}

// ✅ Always use DAL functions
import { listUsers } from '@/layers/entities/user'

export default async function Page() {
  const users = await listUsers()  // Auth checked, consistent patterns
  return <UserList users={users} />
}
```

```typescript
// ❌ Don't forget @map for multi-word fields
model BlogPost {
  publishedAt DateTime
  @@map("blog_posts")
}
// Creates column "publishedAt" (camelCase) - breaks PostgreSQL conventions

// ✅ Use @map for snake_case database columns
model BlogPost {
  publishedAt DateTime @map("published_at")
  @@map("blog_posts")
}
// Creates column "published_at" (snake_case) - follows conventions
```

```typescript
// ❌ Don't fetch all fields when only some needed
const user = await prisma.user.findUnique({
  where: { id }
})
// Fetches ALL fields including passwordHash, internal metadata

// ✅ Use select to fetch only needed fields
const user = await prisma.user.findUnique({
  where: { id },
  select: { id: true, email: true, name: true, image: true }
})
// Only fetches public fields, improves performance
```

```typescript
// ❌ N+1 query pattern - fetches posts then loops to get authors
const posts = await prisma.post.findMany()
for (const post of posts) {
  post.author = await prisma.user.findUnique({ where: { id: post.authorId } })
}
// Makes 1 + N database queries

// ✅ Use include to fetch relations in one query
const posts = await prisma.post.findMany({
  include: { author: { select: { id: true, name: true } } }
})
// Makes 1 database query with JOIN
```

```typescript
// ❌ Don't skip auth checks in DAL functions
export async function deletePost(id: string) {
  return prisma.post.delete({ where: { id } })  // Anyone can delete any post!
}

// ✅ Always check authorization before mutations
export async function deletePost(id: string) {
  const user = await requireAuth()
  const post = await prisma.post.findUnique({ where: { id } })

  if (!post) throw new Error('Post not found')
  if (post.authorId !== user.id && !user.isAdmin) {
    throw new Error('Cannot delete post you do not own')
  }

  return prisma.post.delete({ where: { id } })
}
```

## Adding Models

1. **Add model to schema** with proper mappings:

   ```prisma
   // prisma/schema.prisma
   model Post {
     id        String   @id @default(cuid())
     title     String
     content   String?
     published Boolean  @default(false)
     authorId  String   @map("author_id")
     createdAt DateTime @default(now()) @map("created_at")
     updatedAt DateTime @updatedAt @map("updated_at")

     author User @relation(fields: [authorId], references: [id], onDelete: Cascade)

     @@index([authorId])
     @@map("posts")
   }
   ```

2. **Create migration**:
   ```bash
   pnpm prisma migrate dev --name add_post_model
   ```

3. **Generate client**:
   ```bash
   pnpm prisma:generate
   ```

4. **Create DAL structure**:
   ```
   src/layers/entities/post/
   ├── api/
   │   ├── queries.ts      # Read operations
   │   ├── mutations.ts    # Write operations
   │   └── index.ts        # Re-exports
   ├── model/
   │   └── types.ts        # Zod schemas, TypeScript types
   └── index.ts            # Public API
   ```

5. **Implement DAL functions** following patterns above

6. **Verify**: Run `pnpm typecheck` to ensure types are correct

## Troubleshooting

### "Cannot find module '@/generated/prisma'"

**Cause**: Prisma client hasn't been generated after schema changes.

**Fix**: Run `pnpm prisma:generate`

### "The datasource property is required"

**Cause**: One of:
1. `prisma.config.ts` is in wrong location (must be project root)
2. `dotenv/config` isn't imported at top of config file
3. `.env` file doesn't exist or `DATABASE_URL` isn't set

**Fix**: Check each cause in order. Most common is missing `.env` file.

### Connection refused to localhost:5432 (PostgreSQL only)

**Cause**: PostgreSQL Docker container isn't running.

**Fix**: Start the container:
```bash
docker ps | grep postgres
# If not running:
docker start postgres
```

### SQLite database locked

**Cause**: SQLite only supports one writer at a time.

**Fix**:
- Close Prisma Studio if open
- Ensure no other process is writing to the database
- Restart your dev server

### Schema drift detected

**Cause**: Database state doesn't match schema.

**Fix**:
```bash
pnpm prisma db pull   # Pull current DB state
pnpm prisma migrate dev  # Create migration for differences
```

### Type mismatches after schema changes

**Cause**: Generated types are stale.

**Fix**:
```bash
pnpm prisma:generate
```

## Migrating to PostgreSQL

When deploying to production:

1. **Update schema** datasource:
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```

2. **Update .env** with PostgreSQL URL:
   ```bash
   DATABASE_URL="postgresql://user:password@host/database?sslmode=require"
   ```

3. **Regenerate and migrate**:
   ```bash
   pnpm prisma:generate
   pnpm prisma migrate deploy
   ```

**SQLite limitations to note:**
- Enums stored as TEXT (no database-level validation)
- No `@db.Text` or PostgreSQL-specific column types
- Single-writer concurrency (fine for local dev)

## Local Development

### SQLite (default)

```bash
# Database file is created automatically at .data/dev.db
pnpm prisma db push       # Create/update schema
pnpm prisma:studio        # View data in GUI

# Reset database (delete and recreate)
rm .data/dev.db && pnpm prisma db push
```

### Docker PostgreSQL (optional)

If you need PostgreSQL locally to match production:

```bash
# Create and start Postgres
docker run -d \
  --name postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=myapp \
  -p 5432:5432 \
  -v postgres_data:/var/lib/postgresql/data \
  postgres:17

# Update schema.prisma to use postgresql
# Update .env: DATABASE_URL="postgresql://postgres:postgres@localhost:5432/myapp"

# Stop/start Postgres
docker stop postgres
docker start postgres

# Connect via psql
docker exec -it postgres psql -U postgres -d myapp

# Delete everything and start fresh
docker rm -f postgres && docker volume rm postgres_data
```

## Common Commands

```bash
# Generate client after schema changes
pnpm prisma:generate

# Open Prisma Studio (database GUI)
pnpm prisma:studio

# Validate schema
pnpm prisma validate

# Create a migration (development)
pnpm prisma migrate dev --name descriptive_name

# Apply migrations (production)
pnpm prisma migrate deploy

# Reset database (development only - deletes all data!)
pnpm prisma migrate reset
```

## References

- [Prisma 7 Documentation](https://www.prisma.io/docs)
- [Data Access Layer Pattern](./01-project-structure.md#data-access-layer-dal)
- [Authentication Guide](./09-authentication.md) - Auth utilities used in DAL
- [Environment Variables](./02-environment-variables.md) - Setting up DATABASE_URL
