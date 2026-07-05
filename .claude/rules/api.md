---
paths: apps/server/src/routes/**/*.ts
---

# API Route Handler Rules

These rules apply to all API route handlers in the Express server.

## Required Patterns

### Input Validation

Always validate request body with Zod before processing:

```typescript
import { z } from 'zod';

const createSchema = z.object({
  name: z.string().min(1).max(100),
});

router.post('/', async (req, res) => {
  const result = createSchema.safeParse(req.body);

  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }

  // Use result.data (typed and validated)
});
```

### Error Handling

Return consistent error responses:

```typescript
// Success
res.json(data);
res.status(201).json(created);

// Client errors
res.status(400).json({ error: 'Validation failed' });
res.status(401).json({ error: 'Unauthorized' });
res.status(404).json({ error: 'Not found' });

// Server errors
res.status(500).json({ error: 'Internal server error' });
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
