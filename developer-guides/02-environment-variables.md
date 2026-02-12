# Environment Variables Guide

## Overview

This project uses [T3 Env](https://env.t3.gg/) for type-safe environment variables with build-time validation. All environment variables are validated at build time using Zod schemas, preventing runtime errors from missing or invalid configuration.

## Key Files

| Concept | Location |
|---------|----------|
| Environment configuration | `src/env.ts` |
| Build-time validation | `next.config.ts` (imports `src/env.ts`) |
| Local values (gitignored) | `.env`, `.env.local` |
| Template for setup | `.env.example` |

## When to Use What

| Scenario | Approach | Why |
|----------|----------|-----|
| Server-only secret (API keys, DB credentials) | `server: { VAR: z.string() }` | Never exposed to browser |
| Client-accessible config (public API URL) | `client: { NEXT_PUBLIC_VAR: z.string() }` | Bundled into client code |
| Required variable | `z.string().min(1)` or `z.string().url()` | Build fails if missing |
| Optional with default | `z.string().optional().default('value')` | Provides fallback |
| Boolean flag from string | `z.string().optional().transform(val => val === 'true')` | Env vars are strings, this converts |
| Numeric value from string | `z.string().transform(val => parseInt(val, 10))` | Validates and converts to number |

## Core Patterns

### Basic Environment Configuration

```typescript
// src/env.ts
import { createEnv } from '@t3-oss/env-nextjs'
import { z } from 'zod'

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url().optional(),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url(),
  },
  runtimeEnv: {
    // Must manually map each variable
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
})
```

### Using Environment Variables

```typescript
// Server-side: any file (Server Components, Server Actions, API Routes)
import { env } from '@/env'

const dbUrl = env.DATABASE_URL  // Type-safe, validated
const secret = env.BETTER_AUTH_SECRET

// Client-side: only NEXT_PUBLIC_ variables available
import { env } from '@/env'

const appUrl = env.NEXT_PUBLIC_APP_URL
// env.DATABASE_URL would cause TypeScript error - not in client bundle
```

### Transform Patterns

```typescript
// Boolean from string
server: {
  MCP_DEV_ONLY_DB_ACCESS: z.string()
    .optional()
    .transform((val) => val === 'true'),
}

// Number with default
server: {
  MCP_DEFAULT_LIMIT: z.string()
    .optional()
    .default('200')
    .transform((val) => parseInt(val, 10)),
}

// URL with fallback to another variable
server: {
  BETTER_AUTH_URL: z.string()
    .url()
    .optional()
    .default(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
}
```

## Anti-Patterns

```typescript
// ❌ NEVER access process.env directly
const dbUrl = process.env.DATABASE_URL  // No type safety, no validation

// ✅ Always use the validated env object
import { env } from '@/env'
const dbUrl = env.DATABASE_URL  // Type-safe, validated at build time
```

```typescript
// ❌ NEVER add server variables to client object
client: {
  NEXT_PUBLIC_SECRET_KEY: z.string(),  // Exposed to browser!
}

// ✅ Server secrets go in server object
server: {
  SECRET_KEY: z.string(),  // Safe, never bundled
}
```

```typescript
// ❌ NEVER forget to add to runtimeEnv
server: {
  NEW_SECRET: z.string(),
}
// Missing from runtimeEnv → always undefined!

// ✅ Always map in runtimeEnv
server: {
  NEW_SECRET: z.string(),
}
runtimeEnv: {
  NEW_SECRET: process.env.NEW_SECRET,  // Required for T3 Env to read it
}
```

```typescript
// ❌ NEVER use optional() for truly required variables
server: {
  DATABASE_URL: z.string().optional(),  // App will crash at runtime
}

// ✅ Make required variables required
server: {
  DATABASE_URL: z.string().min(1),  // Build fails if missing
}
```

## Adding a New Environment Variable

### Adding a Server Variable

1. **Add to `server` object** in `src/env.ts`:
   ```typescript
   server: {
     MY_API_KEY: z.string().min(1),
   }
   ```

2. **Add to `runtimeEnv`** in same file:
   ```typescript
   runtimeEnv: {
     MY_API_KEY: process.env.MY_API_KEY,
   }
   ```

3. **Add to `.env.example`** with description:
   ```bash
   # My API service key
   MY_API_KEY=""
   ```

4. **Add to your local `.env`**:
   ```bash
   MY_API_KEY="your-actual-key-here"
   ```

5. **Verify**: Run `pnpm build` - it should succeed. Remove from `.env` and run again - build should fail with clear error.

### Adding a Client Variable

1. **Add to `client` object** with `NEXT_PUBLIC_` prefix:
   ```typescript
   client: {
     NEXT_PUBLIC_API_URL: z.string().url(),
   }
   ```

2. **Add to `runtimeEnv`**:
   ```typescript
   runtimeEnv: {
     NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
   }
   ```

3. **Add to `.env.example` and `.env`** (same as server variables)

4. **Verify**: Import in a client component and check browser console - value should be visible.

### Adding an Optional Variable with Default

1. **Use `.optional().default()`**:
   ```typescript
   server: {
     MAX_UPLOAD_SIZE: z.string()
       .optional()
       .default('10485760')  // 10MB
       .transform((val) => parseInt(val, 10)),
   }
   ```

2. **Add to `runtimeEnv`** (still required):
   ```typescript
   runtimeEnv: {
     MAX_UPLOAD_SIZE: process.env.MAX_UPLOAD_SIZE,
   }
   ```

3. **Add to `.env.example`** showing the default:
   ```bash
   # Max upload size in bytes (default: 10485760 = 10MB)
   MAX_UPLOAD_SIZE=10485760
   ```

4. **Verify**: Build without the variable in `.env` - should succeed with default value.

## Troubleshooting

### "Missing environment variable: DATABASE_URL"

**Cause**: Required variable not set in `.env` file.
**Fix**:
1. Check if `.env` exists in project root
2. Add the missing variable: `DATABASE_URL="file:./.data/dev.db"`
3. Ensure `.env` is not in `.gitignore` subdirectories

### "Invalid environment variable: BETTER_AUTH_SECRET (String must contain at least 32 character(s))"

**Cause**: Secret is too short or empty.
**Fix**: Generate a proper secret:
```bash
openssl rand -base64 32
```
Copy the output to `.env`:
```bash
BETTER_AUTH_SECRET="<generated-value>"
```

### "Property 'MY_VAR' does not exist on type 'Env'"

**Cause**: Variable defined in schema but missing from `runtimeEnv`.
**Fix**: Add to `runtimeEnv` object:
```typescript
runtimeEnv: {
  MY_VAR: process.env.MY_VAR,
}
```

### Build succeeds but variable is always undefined at runtime

**Cause**: Either not in `runtimeEnv`, or using `process.env.VAR` instead of `env.VAR`.
**Fix**:
1. Confirm variable is in `runtimeEnv`
2. Use `import { env } from '@/env'` and access via `env.VAR`
3. Never use `process.env.VAR` directly

### "Cannot use import statement outside a module" in next.config.ts

**Cause**: Build-time validation requires proper module handling.
**Fix**: The config uses `jiti` to load `src/env.ts`:
```typescript
import createJiti from 'jiti'
import { fileURLToPath } from 'node:url'

const jiti = createJiti(fileURLToPath(import.meta.url))
jiti('./src/env')  // Validates at build time
```

### Client component cannot access server variable

**Cause**: Server variables are never bundled into client code.
**Fix**: If the value must be client-accessible, move to `client` object with `NEXT_PUBLIC_` prefix. If it's a secret, use an API route or Server Action to expose only what's needed.

## Variable Reference

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Database connection string | `file:./.data/dev.db` (SQLite) or PostgreSQL URL |
| `BETTER_AUTH_SECRET` | Auth session secret (min 32 chars) | Generate with `openssl rand -base64 32` |
| `NEXT_PUBLIC_APP_URL` | Application base URL | `http://localhost:3000` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BETTER_AUTH_URL` | Auth server URL (if different from app) | Uses `NEXT_PUBLIC_APP_URL` |
| `MCP_DEV_ONLY_DB_ACCESS` | Enable MCP database tools (dev only) | `false` |
| `MCP_DEFAULT_LIMIT` | Default rows returned by MCP queries | `200` |
| `MCP_MAX_ROWS` | Maximum rows returned by MCP queries | `2000` |
| `MCP_STMT_TIMEOUT_MS` | MCP query timeout in milliseconds | `10000` |
| `SKIP_ENV_VALIDATION` | Skip validation (CI/CD with runtime injection) | `false` |

### Example .env File

```bash
# Database (SQLite for local development)
DATABASE_URL="file:./.data/dev.db"

# Authentication (BetterAuth)
BETTER_AUTH_SECRET=""  # Generate: openssl rand -base64 32
BETTER_AUTH_URL="http://localhost:3000"

# MCP Database Access (development only)
MCP_DEV_ONLY_DB_ACCESS=true

# Application
NEXT_PUBLIC_APP_URL="http://localhost:3000"

# Optional: Skip validation (useful for CI/CD)
# SKIP_ENV_VALIDATION=true
```

## References

- [T3 Env Documentation](https://env.t3.gg/) - Library used for environment validation
- [Next.js Environment Variables](https://nextjs.org/docs/app/building-your-application/configuring/environment-variables) - Framework integration
- [Zod Documentation](https://zod.dev/) - Schema validation used by T3 Env
