---
description: Debug and fix TypeScript type errors with systematic analysis and expert guidance
argument-hint: '[error-message or file-path]'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Agent, TodoWrite, AskUserQuestion, mcp__plugin_context7_context7__resolve-library-id, mcp__plugin_context7_context7__query-docs
---

# TypeScript Type Error Debugging

Debug and fix the TypeScript error(s) described by `$ARGUMENTS` (an error message, a file path, or empty for a full typecheck). Load the `debugging-typescript-errors` skill — it carries the methodology (trace the real mismatch, minimal verified fix, explain the underlying concept). This command adds the project-specific ground truth below.

## Running typecheck in this repo

```bash
pnpm typecheck                              # All packages via Turborepo (~28s)
pnpm --filter @dorkos/server typecheck      # One package (~4s) — prefer for the fix loop
pnpm --filter @dorkos/client typecheck
```

**Gotcha:** after pulling, a stale `@dorkos/shared` dist causes false-red errors in downstream packages (imports resolve to old types). Rebuild first: `pnpm --filter @dorkos/shared build`. If errors reference `@dorkos/shared` exports that clearly exist in `packages/shared/src/`, this is almost certainly the cause.

## Project-specific type landscape

- **Zod is the type source of truth** for runtime data: schemas in `packages/shared/src/schemas.ts`, `relay-schemas.ts`, `mesh-schemas.ts`, `config-schema.ts`; derive with `z.infer<typeof Schema>` rather than hand-writing parallel interfaces.
- **Database types come from Drizzle** — schemas in `packages/db` (SQLite). Use Drizzle's inferred types (`$inferSelect` / `$inferInsert`), not manual assertions.
- **Cross-package imports** use `@dorkos/shared/*` subpaths (`/types`, `/agent-runtime`, `/transport`, ...). "Cannot find module" on these usually means a stale dist (see gotcha) or a missing subpath in `packages/shared/package.json` exports.
- **Server is NodeNext** — relative imports in `apps/server` need explicit `.js` extensions; TS2307 there is often a missing extension, not a missing file.
- **Client hooks** are typed TanStack Query wrappers in `apps/client/src/layers/entities/*/model/`; Express routes validate bodies with `Schema.safeParse(req.body)` (Express 5: `req.body` can be undefined on empty POSTs).
- **`any` is banned** (project rule) — fix the type, don't silence it. Prefer type guards over assertions.

## Escalation

- Complex generics, recursive types, or "excessively deep" instantiation → dispatch the `typescript-expert` agent with the error, file, and what the code is trying to do.
- Third-party library type questions → context7 (`resolve-library-id` → `query-docs`, topic "types").

## Non-negotiables

- Read the file at the error location (and the involved type definitions) before proposing a fix — fix the root mismatch, not the symptom the compiler happens to report first.
- After the fix, verify with the package-scoped typecheck, then the full `pnpm typecheck` to catch cascading effects.

Wrap up with: the error, why it occurred, what changed, files modified — and the underlying concept if it's likely to recur.
