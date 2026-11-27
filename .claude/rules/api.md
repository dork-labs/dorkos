---
paths: apps/server/src/routes/**/*.ts
---

# API Route Handler Rules

These rules apply to all API route handlers in the Hono server.

## Required Patterns

### Input Validation

Always validate the request body with Zod before processing, reading it through `readJsonBody` (`@dorkos/http-kit`), never a raw body property. Lint refuses `c.req.json()` in `routes/` (`dorkos/restricted-syntax` in `apps/server/eslint.config.js`):

```typescript
import { z } from 'zod';
import { readJsonBody, validationProblem } from '@dorkos/http-kit';

const createSchema = z.object({
  name: z.string().min(1).max(100),
});

router.post('/', async (c) => {
  const result = createSchema.safeParse(readJsonBody(c));
  if (!result.success) return validationProblem(c, result.error); // 400 invalid_request

  // Use result.data (typed and validated)
});
```

### Error Handling

Every failure is an RFC 9457 problem document (`application/problem+json`), sent with `problem()` from `@dorkos/http-kit` and a code from `PROBLEM_CODE_LIST` (`packages/shared/src/problem.ts`; the codes live in `packages/shared/src/problem-codes/`). The full contract is the Errors section of `contributing/api-reference.md`.

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

Never write `c.json({ error: '…' }, 4xx)` or a hand-built `{ error, code }` body in new code. Older routes still do; they move to problem documents folder by folder (DOR-4979), and each one that moves changes its callers in the same PR. No alias, no deprecation notice, no `Sunset` header: the old shape goes away in the same PR (ADR `261123-170832`).

### Use Service Functions

Never access data directly in route handlers; use service modules:

```typescript
// WRONG - direct data access in route handler
const data = readFileSync(transcriptPath);

// CORRECT - use the domain's service layer
import { getWorkspaceManager } from '../services/workspace/index.js';
const workspaces = await getWorkspaceManager().list({ projectKey });
```

Lint holds this (DOR-4923, `apps/server/eslint-rules/routes-imports.js`): a non-test file under `src/routes/` may not import `@dorkos/db` or `drizzle-orm` (types included), `fs`/`node:fs`, or a concrete runtime adapter under `services/runtimes/{claude-code,codex,opencode,doe}/`. A query goes in the service that owns the data, behind a named function; a route that needs the database takes that service bound to it (as `sessionLocationStore(db)` or `searchAnswerer(db)` are), never a `Db`. The files that still import `fs` or a concrete runtime are listed there, and those lists only shrink.

## Security Checklist

- [ ] Validate all input with Zod
- [ ] Use service layer functions (not direct file/data access)
- [ ] Answer failures with `problem()` / `validationProblem()`, never `{ error }`
- [ ] Don't expose internal error details to clients
