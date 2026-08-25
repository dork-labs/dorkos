---
paths: apps/server/src/**/*.ts, packages/*/src/**/*.ts
---

# DorkOS Data Directory (`dorkHome`) Convention

## Rules by Location

### Server code (`apps/server/`)

- **Never** construct `~/.dork` paths using `os.homedir()`.
- Receive `dorkHome` as a **required** `string` parameter. No fallback chains.
- The single source of truth is `lib/dork-home.ts` → `resolveDorkHome()`, called once in `index.ts`.

Two ESLint rules in `apps/server/eslint.config.js` enforce the ban together, because each alone has a hole (DOR-668): `no-restricted-imports` catches the IMPORT (`import { homedir } from 'os'`, `import * as os from 'os'`) and is blind to `import os from 'os'`; `no-restricted-properties` catches the CALL (`os.homedir()`, and any other spelling of `.homedir`). Neither is `no-restricted-syntax` — that one guards `process.env`, and a second entry for it would replace the first rather than extend it.

The import half is applied per-directory and must be restated in every block that sets `no-restricted-imports`, so it is the half that silently loses coverage when a block is added; `scripts/test-homedir-guard.sh` pins both halves against the real config, and the `scripts-test` workflow runs it.

**The carve-outs, in full.** Nothing else under `apps/server/src` may call `os.homedir()`:

| Where                                                | Why                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/dork-home.ts`                                   | Resolves the data directory itself — the one place production may fall back to `~`.                                                                                                                                                                                   |
| `lib/boundary.ts` — two call sites, inline-disabled  | With no boundary configured the reachable area _is_ the operator's home; and a `~` a person typed means _their_ home. Neither is a DorkOS path.                                                                                                                       |
| `services/runtimes/claude-code/claude-config-dir.ts` | Mirrors the Claude Agent SDK subprocess's own `~/.claude` resolution 1:1. Exempt from the CALL ban by name; it must keep spelling the import `import os from 'os'`, because the IMPORT ban still reaches it and `import { homedir }` there is an error.               |
| `services/runtimes/opencode/opencode-data-dir.ts`    | Mirrors the OpenCode CLI's own `$XDG_DATA_HOME \|\| ~/.local/share` + `opencode` resolution 1:1, so the search snapshot reads the store OpenCode actually writes. Same terms as the row above: exempt from the CALL ban by name, and the IMPORT ban still reaches it. |
| `**/__tests__/**` and `**/*.test.ts`                 | Tests assert the fallback and stage fixtures under a fake `HOME`.                                                                                                                                                                                                     |

Two more exemptions exist by accident of scope rather than by decision, and neither has anything in it today:

- `src/core-extensions/**` is excluded from the server lint pass entirely (`eslint.config.js` top-level `ignores`) because its source is compiled at runtime by esbuild. No rule reaches it, this one included.
- The ban covers `os.homedir()`, not the env vars beneath it. `process.env.HOME` and `process.env.USERPROFILE` name the same directory and are only a `no-restricted-syntax` **warning**.

### Packages (`packages/*/`)

- `os.homedir()` defaults are acceptable as standalone/test safety nets.
- The server **always** overrides with the resolved path via constructor options.

### CLI (`packages/cli/`)

- `~/.dork` is correct (CLI always runs in production mode).
- Use `process.env.DORK_HOME` after `cli.ts` resolves and sets it during startup.

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
