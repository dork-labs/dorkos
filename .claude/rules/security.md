---
paths: "**/auth/**", "**/login/**", "**/session/**", "**/password/**", "**/token/**", "**/api/auth/**"
---

# Security-Critical Code Rules

These rules apply to all authentication, authorization, and security-related code.

## Critical Security Requirements

### Never Log Sensitive Data

```typescript
// NEVER log these
console.log(password)           // Passwords
console.log(token)              // Tokens
console.log(sessionId)          // Session IDs
console.log(req.headers.cookie) // Cookies
console.log(apiKey)             // API keys

// Log safely
console.log(`User ${userId} authenticated`)
console.log(`Session created for user ${userId}`)
```

### Always Hash Passwords

```typescript
import { hash, verify } from '@node-rs/argon2'

// Hashing
const passwordHash = await hash(password, {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
})

// Verification
const isValid = await verify(passwordHash, password)
```

### Session Validation

Always validate sessions on every request:

```typescript
export async function getCurrentUser(): Promise<User | null> {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get('session')?.value

  if (!sessionId) return null

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true }
  })

  // Check session validity
  if (!session) return null
  if (session.expiresAt < new Date()) return null

  return session.user
}
```

### Protect Against Common Attacks

**CSRF Protection:**
- Server Actions have built-in CSRF protection
- For API routes, verify Origin/Referer headers

**SQL Injection:**
- Always use Prisma (parameterized queries)
- Never use raw SQL with string interpolation

**XSS Prevention:**
- React escapes by default
- Never use `dangerouslySetInnerHTML` with user input

## Required Patterns

### Rate Limiting

Sensitive endpoints must be rate limited:

```typescript
// Use middleware or edge function
const rateLimiter = new RateLimiter({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 5,                      // 5 attempts
})
```

### Secure Cookie Settings

```typescript
cookies().set('session', sessionId, {
  httpOnly: true,      // Prevent XSS access
  secure: true,        // HTTPS only
  sameSite: 'lax',     // CSRF protection
  maxAge: 60 * 60 * 24 * 30,  // 30 days
  path: '/',
})
```

### Token Generation

```typescript
import { generateRandomString } from 'oslo/crypto'

// Session tokens (32 bytes = 256 bits)
const sessionId = generateRandomString(32)

// Password reset tokens (with expiry)
const resetToken = generateRandomString(32)
const expiresAt = new Date(Date.now() + 1000 * 60 * 60) // 1 hour
```

## Security Checklist

Before committing auth-related code:

- [ ] No sensitive data in logs
- [ ] Passwords hashed with Argon2
- [ ] Sessions validated on every request
- [ ] Cookies have secure flags
- [ ] Rate limiting on auth endpoints
- [ ] Tokens generated with crypto-safe randomness
- [ ] Error messages don't leak information
