---
paths: apps/server/src/routes/**/*.ts
---

# API Route Handler Rules

These rules apply to all API route handlers in the Hono server.

## Required Patterns

### Input Validation

Always validate the request body with Zod before processing, reading it through `readJsonBody` (`http/request-body.ts`), never a raw body property:

```typescript
import { z } from 'zod';
import { readJsonBody } from '../http/request-body.js';

const createSchema = z.object({
  name: z.string().min(1).max(100),
});

router.post('/', async (c) => {
  const result = createSchema.safeParse(readJsonBody(c));

  if (!result.success) {
    return c.json({ error: 'Validation failed', details: z.flattenError(result.error) }, 400);
  }

  // Use result.data (typed and validated)
});
```

### Error Handling

Return consistent error responses:

```typescript
// Success
c.json(data);
c.json(created, 201);

// Client errors
c.json({ error: 'Validation failed' }, 400);
c.json({ error: 'Unauthorized' }, 401);
c.json({ error: 'Not found' }, 404);

// Server errors
c.json({ error: 'Internal server error' }, 500);
```

### Use Service Functions

Never access data directly in route handlers; use service modules:

```typescript
// WRONG - direct data access in route handler
const data = readFileSync(transcriptPath);

// CORRECT - use the domain's service layer
import { getWorkspaceManager } from '../services/workspace/index.js';
const workspaces = await getWorkspaceManager().list({ projectKey });
```

## Security Checklist

- [ ] Validate all input with Zod
- [ ] Use service layer functions (not direct file/data access)
- [ ] Return appropriate status codes
- [ ] Don't expose internal error details to clients
