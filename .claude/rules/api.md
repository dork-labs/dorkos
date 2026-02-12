---
paths: apps/server/src/routes/**/*.ts
---

# API Route Handler Rules

These rules apply to all API route handlers in the Express server.

## When to Use API Routes

Only create API routes for:
- Webhooks (Stripe, GitHub, external services)
- Mobile app backends (external clients)
- Third-party integrations requiring HTTP
- GET requests that benefit from HTTP caching
- Streaming responses (SSE)

## Required Patterns

### Input Validation

Always validate request body with Zod before processing:

```typescript
import { z } from 'zod'

const createSchema = z.object({
  name: z.string().min(1).max(100),
})

router.post('/', async (req, res) => {
  const result = createSchema.safeParse(req.body)

  if (!result.success) {
    return res.status(400).json(
      { error: 'Validation failed', details: result.error.flatten() }
    )
  }

  // Use result.data (typed and validated)
})
```

### Error Handling

Return consistent error responses:

```typescript
// Success
res.json(data)
res.status(201).json(created)

// Client errors
res.status(400).json({ error: 'Validation failed' })
res.status(401).json({ error: 'Unauthorized' })
res.status(404).json({ error: 'Not found' })

// Server errors
res.status(500).json({ error: 'Internal server error' })
```

### Use Service Functions

Never access data directly in route handlers; use service modules:

```typescript
// WRONG - direct data access in route handler
const data = readFileSync(transcriptPath)

// CORRECT - use service layer
import { transcriptReader } from '../services/transcript-reader'
const session = await transcriptReader.getSession(id)
```

## Security Checklist

- [ ] Validate all input with Zod
- [ ] Use DAL functions (auth checks built-in)
- [ ] Return appropriate status codes
- [ ] Don't expose internal error details to clients
- [ ] Rate limit sensitive endpoints (auth, payments)
