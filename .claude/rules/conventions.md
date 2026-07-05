---
paths: '**/*.ts, **/*.tsx'
---

# Code Conventions

## TSDoc (enforced by `eslint-plugin-jsdoc`)

Required on exported functions and classes, public APIs re-exported from barrel `index.ts` files, and anywhere behavior is non-obvious (surprising side effects, tricky generics, complex algorithms). Skip for test files (rule disabled in `__tests__/`) and private one-off helpers.

Use TSDoc syntax — `@param name - Description`, never `{type}` annotations (TypeScript owns types):

```typescript
/**
 * Send a message and stream the response via SSE.
 *
 * @param sessionId - Target session UUID
 * @param signal - Optional AbortSignal to cancel the request
 */
export function sendMessage(sessionId: string, signal?: AbortSignal): Promise<void> {
```

FSD barrel files get a module-level TSDoc comment (`@module entities/session`) describing purpose and layer role.

Mark exports that exist only for tests with `@internal`:

```typescript
/** @internal Exported for testing only. */
export function parsePorcelainOutput(stdout: string): GitStatusResponse {
```

Inline comments: only where code can't speak for itself — magic numbers, ordering dependencies, workarounds (link the issue/PR), why-not-what. Never restate the next line.

## File Size

| Lines   | Action                                                |
| ------- | ----------------------------------------------------- |
| < 300   | Ideal, no action                                      |
| 300-500 | Consider splitting if multiple responsibilities exist |
| 500+    | Must split — find extraction opportunities            |

Extraction patterns: sub-components, custom hooks for stateful logic, pure functions to a `lib/` file, large type blocks to a types file. Exceptions: generated files, barrel `index.ts`, tightly coupled state machines, test files.

## DRY

3-strike rule: same logic 3+ times → extract. Don't extract coincidental duplication (similar now, different concerns), test setup, or cases where extraction reduces clarity.

## Complexity Limits

| Metric                | Limit                                  |
| --------------------- | -------------------------------------- |
| Cyclomatic complexity | 15 per function                        |
| Function length       | 50 lines (excluding types)             |
| Nesting depth         | 4 levels max                           |
| Function parameters   | 4 max (use options object beyond that) |

Over a limit → extract helpers, use early returns, or split responsibilities.

## Hard Nos

- No `any` — prefer `unknown` with narrowing (lint warns).
- No magic numbers — name the constant.
- No stringly-typed code — use union types or Zod schemas.
- No boolean positional parameters — use an options object.
- No nested ternaries — use `if`/`else` or extract.
