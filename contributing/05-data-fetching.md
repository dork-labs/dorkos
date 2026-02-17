# Data Fetching Guide

## Overview

This guide covers data fetching patterns using TanStack Query for client-side data and Server Components for server-side data. The architecture follows a layered approach: Server Components call DAL functions directly, while Client Components use TanStack Query with API Routes or Server Actions for mutations.

## Key Files

| Concept            | Location                                                  |
| ------------------ | --------------------------------------------------------- |
| Query client setup | `src/app/providers.tsx`                                   |
| Query key factory  | `src/layers/shared/lib/query-client.ts`                   |
| DAL functions      | `src/layers/entities/*/api/queries.ts` and `mutations.ts` |
| Server Actions     | `src/app/actions/*.ts` or feature-specific locations      |
| API Routes         | `src/app/api/*/route.ts`                                  |
| Auth utilities     | `src/layers/shared/api/auth.ts`                           |

## When to Use What

### Data Fetching Approach

| Scenario                               | Approach                                      | Why                                                 |
| -------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Static page data                       | Server Component → DAL                        | No client JS, faster initial load, direct DB access |
| Dynamic client data (polling, filters) | Client Component → TanStack Query → API Route | Reactive, cacheable, refetch on demand              |
| User-triggered mutation                | Client Component → Server Action → DAL        | Built-in CSRF, progressive enhancement, type-safe   |
| Form submission                        | Server Action with `formData`                 | Works without JS, automatic revalidation            |
| Webhook from external service          | API Route                                     | External services cannot call Server Actions        |
| Large file upload (>1MB)               | API Route                                     | Server Actions have 1MB body limit                  |
| Streaming response                     | API Route                                     | Server Actions don't support streaming              |

### Server Actions vs API Routes

> **Decision Rule:** "Will anything outside my Next.js app need to call this?"
> **Yes → API Route** | **No → Server Action**

| Use Case                 | Choose        | Reason                                   |
| ------------------------ | ------------- | ---------------------------------------- |
| Form submission from UI  | Server Action | CSRF protection, progressive enhancement |
| Like/vote button         | Server Action | Simple mutation, optimistic UI support   |
| Webhook (Stripe, GitHub) | API Route     | External services need HTTP endpoint     |
| Mobile app backend       | API Route     | External client requires HTTP access     |
| GET request with caching | API Route     | Server Actions are POST-only             |
| Server-Sent Events (SSE) | API Route     | Server Actions don't support streaming   |

### Query Invalidation Strategy

| Scenario                           | Invalidation Pattern     | Example                                                            |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| Created new item                   | Invalidate list query    | `queryClient.invalidateQueries({ queryKey: queryKeys.users.all })` |
| Updated specific item              | Invalidate detail + list | `invalidateQueries({ queryKey: queryKeys.users.detail(id) })`      |
| Deleted item                       | Invalidate all related   | `invalidateQueries({ queryKey: queryKeys.users.all })`             |
| Mutation affects multiple entities | Invalidate multiple keys | Invalidate both `users.all` and `posts.all` if related             |

## Core Patterns

### Server Component Direct Data Fetching

Server Components fetch data directly from DAL functions without TanStack Query:

```typescript
// src/app/users/page.tsx
import { listUsers } from '@/layers/entities/user'

export default async function UsersPage() {
  const users = await listUsers()

  return (
    <div>
      <h1>Users</h1>
      <ul>
        {users.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  )
}
```

### Client Component with TanStack Query

Client Components use TanStack Query for reactive data fetching:

```typescript
// src/layers/features/users/ui/UserList.tsx
'use client'

import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/layers/shared/lib/query-client'

interface User {
  id: string
  name: string
  email: string
}

async function fetchUsers(): Promise<User[]> {
  const response = await fetch('/api/users')
  if (!response.ok) throw new Error('Failed to fetch users')
  return response.json()
}

export function UserList() {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.users.list(),
    queryFn: fetchUsers,
  })

  if (isLoading) return <div>Loading...</div>
  if (error) return <div>Error: {error.message}</div>

  return (
    <ul>
      {data?.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  )
}
```

### Query Key Factory Pattern

Use the factory pattern for type-safe, hierarchical query keys:

```typescript
// src/layers/shared/lib/query-client.ts
export const queryKeys = {
  users: {
    all: ['users'] as const,
    list: () => [...queryKeys.users.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.users.all, 'detail', id] as const,
  },
  posts: {
    all: ['posts'] as const,
    list: (filters?: { authorId?: string }) => [...queryKeys.posts.all, 'list', filters] as const,
    detail: (id: string) => [...queryKeys.posts.all, 'detail', id] as const,
  },
} as const;
```

### Mutation with Cache Invalidation

Mutations automatically invalidate related queries to keep UI in sync:

```typescript
'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/layers/shared/lib/query-client'

async function createUser(data: { name: string; email: string }) {
  const response = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error('Failed to create user')
  return response.json()
}

export function CreateUserForm() {
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      // Invalidate all user queries to refetch latest data
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all })
    },
  })

  const handleSubmit = (data: { name: string; email: string }) => {
    mutation.mutate(data)
  }

  return (
    <form onSubmit={(e) => {
      e.preventDefault()
      const formData = new FormData(e.currentTarget)
      handleSubmit({
        name: formData.get('name') as string,
        email: formData.get('email') as string,
      })
    }}>
      <input name="name" required />
      <input name="email" type="email" required />
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Creating...' : 'Create User'}
      </button>
    </form>
  )
}
```

### Server Action with Form Data

Server Actions work with FormData for progressive enhancement:

```typescript
// src/app/actions/user.ts
'use server';

import { userSchema } from '@/layers/entities/user/model/types';
import { createUser } from '@/layers/entities/user';
import { revalidatePath } from 'next/cache';

export async function createUserAction(formData: FormData) {
  // 1. Validate input with Zod
  const validated = userSchema.parse(Object.fromEntries(formData));

  // 2. Call DAL function (handles auth internally)
  const user = await createUser(validated);

  // 3. Revalidate cache for affected pages
  revalidatePath('/users');

  return user;
}
```

```typescript
// Component using the Server Action
'use client'

import { createUserAction } from '@/app/actions/user'
import { useActionState } from 'react'

export function CreateUserForm() {
  const [state, formAction, isPending] = useActionState(createUserAction, null)

  return (
    <form action={formAction}>
      <input name="name" required />
      <input name="email" type="email" required />
      <button type="submit" disabled={isPending}>
        {isPending ? 'Creating...' : 'Create User'}
      </button>
    </form>
  )
}
```

### Suspense Query

For better loading states with React Suspense:

```typescript
'use client'

import { useSuspenseQuery } from '@tanstack/react-query'
import { queryKeys } from '@/layers/shared/lib/query-client'
import { Suspense } from 'react'

export function UserList() {
  // useSuspenseQuery throws a promise during loading
  // No need for isLoading checks
  const { data } = useSuspenseQuery({
    queryKey: queryKeys.users.list(),
    queryFn: fetchUsers,
  })

  return (
    <ul>
      {data.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  )
}

// Wrap with Suspense boundary
export function UserListWithSuspense() {
  return (
    <Suspense fallback={<div>Loading users...</div>}>
      <UserList />
    </Suspense>
  )
}
```

### Optimistic Updates

Show immediate feedback while mutation is in flight:

```typescript
'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/layers/shared/lib/query-client';

async function updateUser(data: { id: string; name: string }) {
  const response = await fetch(`/api/users/${data.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: data.name }),
  });
  if (!response.ok) throw new Error('Failed to update user');
  return response.json();
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateUser,
    // Optimistically update cache before server responds
    onMutate: async (newData) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.users.detail(newData.id) });

      // Snapshot current value
      const previousUser = queryClient.getQueryData(queryKeys.users.detail(newData.id));

      // Optimistically update cache
      queryClient.setQueryData(queryKeys.users.detail(newData.id), (old: any) => ({
        ...old,
        ...newData,
      }));

      // Return snapshot for rollback
      return { previousUser };
    },
    // Rollback on error
    onError: (err, newData, context) => {
      queryClient.setQueryData(queryKeys.users.detail(newData.id), context?.previousUser);
    },
    // Refetch after success or error
    onSettled: (data, error, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users.detail(variables.id) });
    },
  });
}
```

### API Route with DAL

API Routes call DAL functions, never Prisma directly:

```typescript
// src/app/api/users/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { listUsers } from '@/layers/entities/user';
import { getCurrentUser } from '@/layers/shared/api/auth';

export async function GET(request: NextRequest) {
  try {
    // Auth check (if needed)
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Call DAL function
    const users = await listUsers();

    return NextResponse.json(users);
  } catch (error) {
    console.error('Failed to fetch users:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

## Anti-Patterns

```typescript
// ❌ NEVER import Prisma directly in Server Components
import { prisma } from '@/lib/prisma'

export default async function UsersPage() {
  const users = await prisma.user.findMany()  // Bypasses auth, breaks DAL pattern
  return <UserList users={users} />
}

// ✅ Always use DAL functions
import { listUsers } from '@/layers/entities/user'

export default async function UsersPage() {
  const users = await listUsers()  // Auth enforced, consistent patterns
  return <UserList users={users} />
}
```

```typescript
// ❌ Don't use TanStack Query in Server Components
'use server'
import { useQuery } from '@tanstack/react-query'  // Server components can't use hooks

export default async function UsersPage() {
  const { data } = useQuery(...)  // Error: hooks don't work in server components
  return <UserList users={data} />
}

// ✅ Server Components call DAL directly
import { listUsers } from '@/layers/entities/user'

export default async function UsersPage() {
  const users = await listUsers()  // Direct async/await
  return <UserList users={users} />
}
```

```typescript
// ❌ Don't forget to invalidate queries after mutations
const mutation = useMutation({
  mutationFn: createUser,
  // Missing onSuccess - UI shows stale data
});

// ✅ Always invalidate affected queries
const mutation = useMutation({
  mutationFn: createUser,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
  },
});
```

```typescript
// ❌ Don't use hardcoded query keys
const { data } = useQuery({
  queryKey: ['users'], // Not type-safe, hard to maintain
  queryFn: fetchUsers,
});

// ✅ Use query key factory
const { data } = useQuery({
  queryKey: queryKeys.users.list(), // Type-safe, consistent, hierarchical
  queryFn: fetchUsers,
});
```

```typescript
// ❌ Don't fetch on client when server would work
'use client'
import { useQuery } from '@tanstack/react-query'

export default function UsersPage() {
  const { data } = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsers,  // Extra network hop, slower initial load
  })
  return <UserList users={data} />
}

// ✅ Use Server Component for static data
import { listUsers } from '@/layers/entities/user'

export default async function UsersPage() {
  const users = await listUsers()  // Faster, no client JS needed
  return <UserList users={users} />
}
```

```typescript
// ❌ Don't skip validation in Server Actions
'use server';
export async function createUser(data: any) {
  // No validation
  return prisma.user.create({ data }); // Unsafe, bypasses schema checks
}

// ✅ Always validate with Zod before calling DAL
('use server');
import { userSchema } from '@/layers/entities/user/model/types';
import { createUser } from '@/layers/entities/user';

export async function createUserAction(formData: FormData) {
  const validated = userSchema.parse(Object.fromEntries(formData)); // Runtime validation
  return createUser(validated); // Type-safe, validated data
}
```

## Configuration

### Query Client Setup

The global QueryClient is configured in `src/app/providers.tsx`:

```typescript
'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { useState } from 'react'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute - data is fresh for 1 minute
            refetchOnWindowFocus: false, // Don't refetch when window regains focus
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
```

**Default options explained:**

- `staleTime: 60 * 1000` - Data is considered fresh for 1 minute, preventing unnecessary refetches
- `refetchOnWindowFocus: false` - Disabled to avoid aggressive refetching (enable per-query if needed)

### DevTools

React Query DevTools are automatically included in development mode via the `<ReactQueryDevtools />` component. Access them via the floating button in the bottom-right corner to:

- Inspect active queries and their states
- View query data and metadata
- Manually trigger refetches
- See query dependencies and invalidations

## Troubleshooting

### "Attempted to call useQuery() from the server"

**Cause**: Using TanStack Query hooks in Server Components.

**Fix**: Server Components should call DAL functions directly with async/await. Only use TanStack Query in Client Components (`'use client'`).

```typescript
// ❌ Server Component
export default async function Page() {
  const { data } = useQuery(...)  // Error
}

// ✅ Server Component
export default async function Page() {
  const data = await dalFunction()  // Correct
}

// ✅ Client Component
'use client'
export function Component() {
  const { data } = useQuery(...)  // Correct
}
```

### Stale data after mutation

**Cause**: Query cache not invalidated after mutation.

**Fix**: Add `onSuccess` callback to invalidate affected queries:

```typescript
const mutation = useMutation({
  mutationFn: updateUser,
  onSuccess: () => {
    // Invalidate all queries starting with ['users']
    queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
  },
});
```

### Hydration mismatch errors

**Cause**: Server and client render different content due to async data.

**Fix**: Use one of these patterns:

1. **Server Component**: Fetch data on server, no hydration mismatch
2. **Suspense Query**: Let Suspense handle loading state consistently
3. **Manual loading state**: Ensure server HTML matches initial client state

```typescript
// Option 1: Server Component (preferred)
export default async function Page() {
  const data = await dalFunction()
  return <Component data={data} />
}

// Option 2: Suspense Query
'use client'
export function Component() {
  const { data } = useSuspenseQuery(...)
  return <div>{data}</div>
}

// Option 3: Manual loading state
'use client'
export function Component() {
  const { data, isLoading } = useQuery(...)
  if (isLoading) return <div>Loading...</div>  // Matches server
  return <div>{data}</div>
}
```

### Query not refetching after invalidation

**Cause**: Query key mismatch between invalidation and query definition.

**Fix**: Use the query key factory pattern consistently:

```typescript
// Define query
const { data } = useQuery({
  queryKey: queryKeys.users.list(), // Must match exactly
  queryFn: fetchUsers,
});

// Invalidate
queryClient.invalidateQueries({
  queryKey: queryKeys.users.all, // Invalidates all users.* keys
});
```

### "Cannot read properties of undefined" in query function

**Cause**: Query function runs before data is ready or during error state.

**Fix**: Add proper error handling and type guards:

```typescript
const { data, isLoading, error } = useQuery({
  queryKey: queryKeys.users.list(),
  queryFn: async () => {
    const response = await fetch('/api/users')
    if (!response.ok) {
      throw new Error('Failed to fetch')  // Properly throw errors
    }
    return response.json()
  },
})

// Always check loading and error states
if (isLoading) return <div>Loading...</div>
if (error) return <div>Error: {error.message}</div>
if (!data) return null  // Type guard

return <div>{data.map(...)}</div>
```

### DevTools not showing up

**Cause**: Either not in development mode, or `<ReactQueryDevtools />` not included in providers.

**Fix**: Verify `src/app/providers.tsx` includes the devtools component:

```typescript
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'

export function Providers({ children }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />  {/* Must be included */}
    </QueryClientProvider>
  )
}
```

## References

- [TanStack Query Documentation](https://tanstack.com/query/latest) - Official docs
- [Database & Prisma Guide](./03-database-prisma.md) - DAL patterns and database access
- [State Management Guide](./06-state-management.md) - When to use TanStack Query vs Zustand
- [Forms & Validation Guide](./04-forms-validation.md) - Server Actions with forms
