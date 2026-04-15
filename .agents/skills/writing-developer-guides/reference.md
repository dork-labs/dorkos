# Developer Guide Reference

This file contains the complete template and detailed guidance for writing developer guides.

## Complete Template

Copy this template when creating a new guide:

```markdown
# [Topic] Guide

## Overview

[1-2 sentences: What this guide covers]. [1 sentence: Why it matters for this project].

## Key Files

| Concept             | Location                    |
| ------------------- | --------------------------- |
| [Main config/entry] | `src/path/to/file.ts`       |
| [Types/schemas]     | `src/path/to/types.ts`      |
| [Related component] | `src/path/to/component.tsx` |

## When to Use What

| Scenario            | Approach               | Why      |
| ------------------- | ---------------------- | -------- |
| [Common scenario 1] | [Recommended approach] | [Reason] |
| [Common scenario 2] | [Recommended approach] | [Reason] |
| [Edge case]         | [Alternative approach] | [Reason] |

## Core Patterns

### [Pattern Name]

[1-2 sentence context for when to use this pattern]

\`\`\`typescript
// imports if non-obvious
import { something } from '@/path'

// Complete, runnable example
export function patternExample() {
// This approach ensures X because Y
return result
}
\`\`\`

### [Second Pattern Name]

[Context]

\`\`\`typescript
// Another complete example
\`\`\`

## Anti-Patterns

\`\`\`typescript
// ❌ NEVER do this
function badExample() {
dangerousThing() // Causes [specific problem]
}

// ✅ Do this instead
function goodExample() {
safeThing() // Ensures [specific benefit]
}
\`\`\`

\`\`\`typescript
// ❌ Another common mistake
const wrong = badApproach // [Why it's wrong]

// ✅ Correct approach
const right = goodApproach // [Why it's right]
\`\`\`

## [Procedural Section - e.g., "Adding a New X"]

1. **[First step]**: [What to do]
   \`\`\`typescript
   // Code for step 1
   \`\`\`

2. **[Second step]**: [What to do]
   \`\`\`typescript
   // Code for step 2
   \`\`\`

3. **Verify**: [How to confirm success]
   \`\`\`bash
   # Verification command
   \`\`\`

## Troubleshooting

### "[Exact error message]"

**Cause**: [Why this error occurs]
**Fix**: [Step-by-step resolution]

### [Symptom without exact error]

**Cause**: [Why this happens]
**Fix**: [How to resolve]

## References

- [Link to related guide](./other-guide.md) - [What it covers]
- [External documentation](https://example.com) - [What it provides]
```

---

## Section-by-Section Guidance

### Overview

**Purpose:** Enable quick relevance assessment.

**Good example:**

```markdown
## Overview

This project uses BetterAuth with Email OTP (passwordless) authentication. Users sign in by entering their email, receiving a 6-digit code, and entering it to create a session.
```

**Bad example:**

```markdown
## Overview

Authentication is an important part of any web application. There are many ways to implement authentication, including passwords, OAuth, magic links, and OTP codes. This guide covers how we do authentication in this project using a library called BetterAuth which provides many features...
```

**Why the first is better:** Gets to the point immediately. AI agents can determine relevance in one sentence.

---

### Key Files Table

**Purpose:** Map concepts to locations before explaining how things work.

**Good example:**

```markdown
## Key Files

| Concept          | Location                        |
| ---------------- | ------------------------------- |
| Server config    | `src/lib/auth.ts`               |
| Client utilities | `src/lib/auth-client.ts`        |
| DAL functions    | `src/layers/shared/api/auth.ts` |
| UI components    | `src/layers/features/auth/`     |
| Protected routes | `src/app/(authenticated)/`      |
```

**Why tables:** AI agents can scan vertically. Prose requires full reading.

---

### Decision Matrix

**Purpose:** Eliminate clarifying questions by covering common scenarios.

**Good example:**

```markdown
## When to Use What

| Scenario                       | Approach                  | Why                                          |
| ------------------------------ | ------------------------- | -------------------------------------------- |
| Page needs auth check          | `requireAuthOrRedirect()` | Redirects to sign-in, guarantees user exists |
| DAL function needs user        | `requireAuth()`           | Throws error, caller handles                 |
| Optional personalization       | `getCurrentUser()`        | Returns null if not authenticated            |
| Client component needs session | `useSession()` hook       | Reactive, updates on auth changes            |
```

**Good example (state management):**

```markdown
| State Type           | Tool           | Example                        |
| -------------------- | -------------- | ------------------------------ |
| Server state         | TanStack Query | User data from API             |
| Complex client state | Zustand        | Shopping cart, multi-step form |
| Simple UI state      | React useState | Modal open/close               |
| URL state            | Next.js router | Filters, pagination            |
```

**Bad example:**

```markdown
## When to Use What

You should use `requireAuth()` when you need to ensure the user is authenticated in a DAL function. If you're in a server component and want to redirect, use `requireAuthOrRedirect()` instead. For client components, the `useSession()` hook provides reactive access to the session...
```

**Why tables are better:** Pattern matching. Agents scan the "Scenario" column to find their situation.

---

### Core Patterns

**Purpose:** Provide copy-paste ready code that follows project conventions.

**Requirements:**

1. Complete imports (when non-obvious)
2. Runnable without modification
3. Comments explain WHY, not WHAT
4. Show the output/result type

**Good example:**

```typescript
// entities/user/api/queries.ts
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/layers/shared/api/auth';
import type { User } from '../model/types';

export async function getUserProfile(): Promise<User | null> {
  const currentUser = await requireAuth();

  // Only fetch fields needed for profile display
  // Avoids exposing internal fields like passwordHash
  return prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { id: true, email: true, name: true, image: true },
  });
}
```

**Bad example:**

```typescript
const user = await prisma.user.findUnique({ where: { id } });
```

**Why the first is better:**

- Shows file location in comment
- Includes imports
- Shows return type
- Explains the select clause reasoning
- Complete function, not fragment

---

### Anti-Patterns

**Purpose:** Prevent AI agents from generating common mistakes.

**Format:** Always show wrong → right with explanations.

**Good example:**

```typescript
// ❌ NEVER import prisma directly in server components
import { prisma } from '@/lib/prisma'

export default async function Page() {
  const users = await prisma.user.findMany()  // Bypasses auth, breaks DAL pattern
  return <UserList users={users} />
}

// ✅ Always use DAL functions
import { listUsers } from '@/layers/entities/user'

export default async function Page() {
  const users = await listUsers()  // Auth checked, consistent patterns
  return <UserList users={users} />
}
```

**Good example (styling):**

```typescript
// ❌ Don't use arbitrary values when tokens exist
<div className="bg-[#1a1a1a] rounded-[16px]">

// ✅ Use semantic tokens
<div className="bg-background rounded-xl">
```

**Why both parts matter:**

- ❌ shows what agents might generate (looks reasonable!)
- ✅ shows the correct pattern
- Comments explain the difference

---

### Procedural Steps

**Purpose:** Guide step-by-step tasks with verification.

**Good example:**

````markdown
## Adding a New Protected Page

1. **Create the page** under `src/app/(authenticated)/`:

   ```typescript
   // src/app/(authenticated)/my-feature/page.tsx
   import { requireAuthOrRedirect } from '@/layers/shared/api/auth'

   export default async function MyFeaturePage() {
     const { user } = await requireAuthOrRedirect()
     return <h1>Welcome, {user.name}</h1>
   }
   ```
````

2. **Verify**: The `(authenticated)/layout.tsx` automatically protects this route. No additional configuration needed.

3. **Test**: Visit `/my-feature` while signed out — you should be redirected to `/sign-in`.

````

**Why verification matters:** Agents need to confirm success before proceeding. "No additional configuration needed" is valuable information.

---

### Troubleshooting

**Purpose:** Enable error message → solution lookup.

**Format:** Use exact error messages when possible.

**Good example:**
```markdown
### "Cannot find module '@/generated/prisma'"

**Cause**: Prisma client hasn't been generated after schema changes.
**Fix**: Run `npm run build`

### "The datasource property is required"

**Cause**: One of:
1. `prisma.config.ts` is in wrong location (must be project root)
2. `dotenv/config` isn't imported at top of config file
3. `.env` file doesn't exist or `DATABASE_URL` isn't set

**Fix**: Check each cause in order. Most common is missing `.env` file.

### Database queries return stale data

**Cause**: TanStack Query cache not invalidated after mutation.
**Fix**: Add `queryClient.invalidateQueries()` in mutation's `onSuccess`:
```typescript
onSuccess: () => {
  queryClient.invalidateQueries({ queryKey: ['users'] })
}
````

```

**Why exact messages:** AI agents can grep for the error and find the solution directly.

---

## Consistency Patterns

### Section Headers

Use these exact headers for consistency across guides:

| Section | Header |
|---------|--------|
| Introduction | `## Overview` |
| File locations | `## Key Files` |
| Decision guide | `## When to Use What` |
| Code examples | `## Core Patterns` |
| What not to do | `## Anti-Patterns` |
| Step-by-step | `## [Verb]ing a [Thing]` (e.g., "Adding a New Entity") |
| Error fixes | `## Troubleshooting` |
| Links | `## References` |

### Code Block Languages

| Content | Language Tag |
|---------|--------------|
| TypeScript/React | `typescript` or `tsx` |
| Shell commands | `bash` |
| Prisma schema | `prisma` |
| JSON | `json` |
| CSS | `css` |
| SQL | `sql` |

### Table Conventions

- Use `|` alignment for readability
- Keep cells concise (< 50 chars)
- Use code backticks for file paths and code references
- Left-align text columns, center align short values

---

## Evaluating Existing Guides

When reviewing a guide, score each section:

| Section | Present? | Well-Structured? | AI-Optimized? |
|---------|----------|------------------|---------------|
| Overview | ✅/❌ | ✅/❌ | ✅/❌ |
| Key Files | ✅/❌ | ✅/❌ | ✅/❌ |
| Decision Matrix | ✅/❌ | ✅/❌ | ✅/❌ |
| Core Patterns | ✅/❌ | ✅/❌ | ✅/❌ |
| Anti-Patterns | ✅/❌ | ✅/❌ | ✅/❌ |
| Troubleshooting | ✅/❌ | ✅/❌ | ✅/❌ |

Prioritize fixing:
1. Missing Decision Matrix (highest impact)
2. Missing Anti-Patterns (prevents common mistakes)
3. Incomplete code examples (agents copy these)
4. Missing Key Files table (agents need locations)
```
