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
import { readJsonBody, validationProblem } from '@dorkos/http-kit';

const createSchema = z.object({
  name: z.string().min(1).max(100),
});

router.post('/', async (c) => {
  const result = createSchema.safeParse(readJsonBody(c));
  if (!result.success) return validationProblem(c, result.error); // 400 malformed_request

  // Use result.data (typed and validated)
});
```

### Error Handling

Every failure is an RFC 9457 problem document (`application/problem+json`), sent with `problem()` from `@dorkos/http-kit` and a code from `PROBLEM_CODE_LIST` (`packages/shared/src/problem.ts`). The full contract is the Errors section of `contributing/api-reference.md`.

```typescript
import { problem } from '@dorkos/http-kit';

// Success
c.json(data);
c.json(created, 201);

// Failures: a code from the list, and a sentence for a person
problem(c, 'not_found', { detail: 'No agent is registered at that path.' });
problem(c, 'conflict', { detail: 'Someone else changed this. Reload and try again.' });

// Server errors: throw, and let the error handler answer 500 internal_error
```

Never write `c.json({ error: '…' }, 4xx)` or a hand-built `{ error, code }` body in new code. Older routes still do; they move to problem documents folder by folder (DOR-4979), and each one that moves changes its callers in the same PR.

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
- [ ] Answer failures with `problem()` / `validationProblem()`, never `{ error }`
- [ ] Don't expose internal error details to clients
