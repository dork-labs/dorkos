---
paths: apps/server/src/**/*.ts, packages/*/src/**/*.ts
---

# DorkOS Data Directory (`dorkHome`) Convention

## Rules by Location

### Server code (`apps/server/`)

- **Never** construct `~/.dork` paths using `os.homedir()`. ESLint enforces this via `no-restricted-syntax`.
- Receive `dorkHome` as a **required** `string` parameter. No fallback chains.
- The single source of truth is `lib/dork-home.ts` → `resolveDorkHome()`, called once in `index.ts`.

### Packages (`packages/*/`)

- `os.homedir()` defaults are acceptable as standalone/test safety nets.
- The server **always** overrides with the resolved path via constructor options.

### CLI (`packages/cli/`)

- `~/.dork` is correct (CLI always runs in production mode).
- Use `process.env.DORK_HOME` after `cli.ts` sets it (line ~96).

## Anti-Pattern

```typescript
// BAD: fallback chain that can silently write to ~/.dork in dev
const dir = dorkHome ?? env.DORK_HOME ?? path.join(os.homedir(), '.dork');
```

## Correct Pattern

```typescript
// GOOD: required parameter, no fallback
constructor(dorkHome: string) {
  const configDir = dorkHome;
}
```
