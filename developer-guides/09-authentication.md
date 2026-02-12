# Authentication

## Overview

This project uses BetterAuth with Email OTP (passwordless) authentication. Users sign in by entering their email, receiving a 6-digit code, and entering it to create a session. All authentication utilities follow the DAL pattern with built-in CSRF protection and 7-day session duration.

## Key Files

| Concept | Location |
|---------|----------|
| Server config | `src/lib/auth.ts` |
| Client utilities | `src/lib/auth-client.ts` |
| DAL auth functions | `src/layers/shared/api/auth.ts` |
| UI components | `src/layers/features/auth/` |
| Protected routes | `src/app/(authenticated)/` |
| Database models | `prisma/schema.prisma` (User, Session, Verification) |

## When to Use What

| Scenario | Function | Why |
|----------|----------|-----|
| Page requires auth (redirect if not) | `requireAuthOrRedirect()` | Redirects to `/sign-in`, guarantees user exists |
| DAL function needs user | `requireAuth()` | Throws error for caller to handle, never returns null |
| Optional personalization | `getCurrentUser()` | Returns `null` if not authenticated, no redirect/throw |
| Client component needs auth state | `useSession()` hook | Reactive, updates on auth changes, includes loading state |
| Get full session with metadata | `getSession()` | Returns session object with expiry, userAgent, etc. |
| Sign out from client component | `signOut()` | Clears session cookie and redirects to home |
| Protect entire route section | `(authenticated)/` group | Layout-level auth check, all children protected |

## Core Patterns

### Server Component with Optional Auth

Use `getCurrentUser()` when authentication is optional (e.g., personalization on public pages):

```typescript
import { getCurrentUser } from "@/layers/shared/api/auth"

export default async function HomePage() {
  const user = await getCurrentUser()

  return (
    <div>
      <h1>Welcome{user ? `, ${user.name}` : ""}</h1>
      {user ? (
        <Link href="/dashboard">Go to Dashboard</Link>
      ) : (
        <Link href="/sign-in">Sign In</Link>
      )}
    </div>
  )
}
```

### Protected Server Component (with redirect)

Use `requireAuthOrRedirect()` when the entire page requires authentication:

```typescript
import { requireAuthOrRedirect } from "@/layers/shared/api/auth"

export default async function SettingsPage() {
  const { user } = await requireAuthOrRedirect()
  // User is guaranteed to exist here - TypeScript knows this
  return <h1>Settings for {user.name}</h1>
}
```

### DAL Function with Auth Check

Use `requireAuth()` in DAL functions - throws `UnauthorizedError` for the caller to handle:

```typescript
// entities/post/api/queries.ts
import { requireAuth } from "@/layers/shared/api/auth"
import { prisma } from "@/lib/prisma"
import type { Post } from '../model/types'

export async function getUserPosts(): Promise<Post[]> {
  const user = await requireAuth() // Throws if not authenticated

  // Only return posts owned by the current user
  return prisma.post.findMany({
    where: { authorId: user.id },
    orderBy: { createdAt: 'desc' }
  })
}
```

### Client Component with Session

Use `useSession()` hook in client components for reactive auth state:

```typescript
"use client"

import { useSession, signOut } from "@/lib/auth-client"

export function UserMenu() {
  const { data: session, isPending, error } = useSession()

  if (isPending) {
    return <Skeleton className="h-8 w-32" />
  }

  if (!session) {
    return <Link href="/sign-in">Sign In</Link>
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Avatar>
          <AvatarImage src={session.user.image} />
          <AvatarFallback>{session.user.name?.[0]}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={() => signOut()}>
          Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

### Protected Route Group

Use the `(authenticated)/` folder to protect entire sections without per-page auth checks:

```typescript
// src/app/(authenticated)/layout.tsx
import { auth } from "@/lib/auth"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

export default async function AuthenticatedLayout({ children }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session) {
    redirect("/sign-in")
  }

  // All pages under (authenticated)/ are now protected
  return <>{children}</>
}
```

### Sign Out Button

Use the pre-built component or call `signOut()` directly:

```typescript
// Option 1: Pre-built component
import { SignOutButton } from "@/layers/features/auth"

<SignOutButton />

// Option 2: Custom implementation
import { signOut } from "@/lib/auth-client"

<button onClick={() => signOut()}>
  Sign Out
</button>
```

## Anti-Patterns

```typescript
// ❌ NEVER check auth in components - do it in DAL or server components
export function PostList() {
  const { data: session } = useSession()
  const posts = await fetch('/api/posts')  // No auth enforcement

  return posts.map(post => <Post key={post.id} post={post} />)
}

// ✅ Check auth in DAL, return only user's data
// entities/post/api/queries.ts
export async function getUserPosts(): Promise<Post[]> {
  const user = await requireAuth()
  return prisma.post.findMany({ where: { authorId: user.id } })
}
```

```typescript
// ❌ Using getCurrentUser() when you need guaranteed auth
export async function updateUserSettings(data: Settings) {
  const user = await getCurrentUser()
  // user could be null! TypeScript won't catch this.
  return prisma.user.update({ where: { id: user.id }, data })
}

// ✅ Use requireAuth() in DAL functions
export async function updateUserSettings(data: Settings) {
  const user = await requireAuth() // Throws if not authenticated
  return prisma.user.update({ where: { id: user.id }, data })
}
```

```typescript
// ❌ Storing sensitive data in session
await auth.api.setSession({
  session: {
    userId: user.id,
    creditCardNumber: user.creditCard, // NEVER store sensitive data
    apiKeys: user.apiKeys,              // NEVER store secrets
  }
})

// ✅ Store only user ID, fetch sensitive data from database when needed
await auth.api.setSession({
  session: {
    userId: user.id,
    // That's it - everything else comes from DB
  }
})
```

```typescript
// ❌ Not using the (authenticated)/ route group for protected pages
// src/app/dashboard/page.tsx
export default async function DashboardPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/sign-in')  // Repeated in every page!
  return <Dashboard user={user} />
}

// ✅ Put page in (authenticated)/ group - layout handles auth
// src/app/(authenticated)/dashboard/page.tsx
export default async function DashboardPage() {
  const { user } = await requireAuthOrRedirect()
  return <Dashboard user={user} />
}
```

```typescript
// ❌ Calling BetterAuth methods directly in components
import { auth } from "@/lib/auth"

export async function MyServerComponent() {
  const session = await auth.api.getSession({ headers: await headers() })
  // Bypasses our auth utilities, inconsistent pattern
}

// ✅ Use shared auth utilities
import { getCurrentUser } from "@/layers/shared/api/auth"

export async function MyServerComponent() {
  const user = await getCurrentUser()
  // Consistent with rest of codebase, follows DAL pattern
}
```

```typescript
// ❌ Checking auth on every data fetch in client components
function UserPosts() {
  const { data: session } = useSession()
  const { data: posts } = useQuery({
    queryKey: ['posts'],
    queryFn: () => fetch('/api/posts').then(r => r.json()),
    enabled: !!session  // Client-side check doesn't secure the API!
  })
}

// ✅ Secure the DAL/API endpoint, let it handle auth
// Client component just fetches - DAL enforces auth
function UserPosts() {
  const { data: posts } = useQuery({
    queryKey: ['posts'],
    queryFn: () => fetch('/api/posts').then(r => r.json())
  })
  // API route calls getUserPosts() which checks auth
}
```

## Adding a New Protected Page

1. **Create the page** under `src/app/(authenticated)/`:
   ```typescript
   // src/app/(authenticated)/my-feature/page.tsx
   import { requireAuthOrRedirect } from "@/layers/shared/api/auth"

   export default async function MyFeaturePage() {
     const { user } = await requireAuthOrRedirect()
     return <h1>My Feature for {user.name}</h1>
   }
   ```

2. **No additional configuration needed**. The layout at `(authenticated)/layout.tsx` automatically protects all child routes.

3. **Test**: Visit `/my-feature` while signed out - you should be redirected to `/sign-in`.

**Why this works:**

The `(authenticated)/` folder is a **route group**. Parentheses in folder names organize routes without affecting URLs:
- `/dashboard` → `src/app/(authenticated)/dashboard/page.tsx`
- `/sign-in` → `src/app/(auth)/sign-in/page.tsx`

The layout runs before any child page, checking auth once for all protected routes.

## Troubleshooting

### Sign-in redirects to /sign-in in a loop

**Cause**: Session cookie not being set or read correctly.

**Fix**:
1. Check `BETTER_AUTH_SECRET` is set in `.env` (run `openssl rand -base64 32` to generate)
2. Verify `BETTER_AUTH_URL` matches your app URL
3. Check browser console for cookie errors (SameSite, Secure attributes)
4. Clear cookies and try again

### OTP code not appearing in development

**Cause**: Email delivery is console-logged in development mode.

**Fix**: Check the server console (terminal running `pnpm dev`) for:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  OTP Code for user@example.com
  Type: sign-in
  Code: 123456
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### "Invalid OTP code" on valid code

**Cause**: One of:
1. Code expired (5-minute window)
2. Code already used
3. Email mismatch (code sent to different email)

**Fix**: Request a new code and enter it within 5 minutes.

### Protected page not redirecting unauthenticated users

**Cause**: Page is not in the `(authenticated)/` route group.

**Fix**:
1. Move page to `src/app/(authenticated)/[your-page]/page.tsx`
2. Or add `requireAuthOrRedirect()` at the top of the page component

### `getCurrentUser()` returns null in protected route

**Cause**: Session cache stale or middleware interfering.

**Fix**:
1. Use `requireAuthOrRedirect()` in protected pages (guarantees user exists)
2. Check for middleware that might clear headers
3. Verify session in Prisma Studio (`pnpm prisma:studio` → `sessions` table)

### Database shows no sessions but user appears logged in

**Cause**: Client-side cache out of sync with database.

**Fix**:
1. Hard refresh browser (Cmd+Shift+R / Ctrl+Shift+R)
2. Clear application cookies in DevTools
3. Check `sessions` table in Prisma Studio to verify actual state

## References

- [BetterAuth Documentation](https://www.better-auth.com/docs) - Official BetterAuth docs
- [Email OTP Plugin](https://www.better-auth.com/docs/plugins/email-otp) - OTP configuration details
- [DAL Pattern Guide](./03-database-prisma.md) - Data Access Layer conventions
- [Environment Variables Guide](./02-environment-variables.md) - Managing auth secrets
- [Prisma Guide](./03-database-prisma.md) - Database models and queries

### Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BETTER_AUTH_SECRET` | Yes | None | 32+ character secret for token signing |
| `BETTER_AUTH_URL` | No | `NEXT_PUBLIC_APP_URL` | Base URL for callbacks and redirects |

**Generate secret:**
```bash
openssl rand -base64 32
```

### Database Models

BetterAuth uses these Prisma models (auto-generated):

| Model | Fields | Purpose |
|-------|--------|---------|
| `User` | `id`, `email`, `name`, `image`, `emailVerified` | User accounts |
| `Session` | `id`, `userId`, `expiresAt`, `ipAddress`, `userAgent` | Active sessions (7-day expiry) |
| `Verification` | `id`, `identifier`, `value`, `expiresAt` | OTP codes (5-minute expiry) |
| `Account` | `id`, `userId`, `provider`, `providerAccountId` | OAuth providers (future) |

### Authentication Flow Reference

**Sign-in:**
1. User enters email at `/sign-in` → OTP sent (console-logged in dev)
2. User redirected to `/verify?email=user@example.com`
3. User enters 6-digit code → Auto-submits on 6th digit
4. Valid code → Session created, redirect to `/dashboard`
5. Invalid code → Error shown, can retry

**Sign-out:**
1. User clicks "Sign Out" → `signOut()` called
2. Session cookie cleared → Redirect to `/`
3. Protected routes now redirect to `/sign-in`

### Future Extensibility

**Adding OAuth (Google, GitHub):**
1. Install OAuth plugin: `pnpm add @better-auth/oauth`
2. Add provider credentials to `.env`
3. Update `auth.ts` with provider config
4. Add social sign-in buttons to auth UI

**Switching to real email (Resend):**
1. Install: `pnpm add resend`
2. Add `RESEND_API_KEY` to `env.ts`
3. Update `sendVerificationOTP` in `auth.ts`:
   ```typescript
   async sendVerificationOTP({ email, otp, type }) {
     const resend = new Resend(env.RESEND_API_KEY)
     await resend.emails.send({
       from: "noreply@yourapp.com",
       to: email,
       subject: "Your verification code",
       text: `Your code is: ${otp}`,
     })
   }
   ```
