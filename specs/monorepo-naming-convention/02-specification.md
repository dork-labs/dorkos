---
slug: monorepo-naming-convention
number: 78
created: 2026-03-01
status: draft
authors: [Claude Code]
spec: monorepo-naming-convention
---

# Rename `apps/web` → `apps/site` & Fix AGENTS.md Doc Drift

## Status

Draft

## Overview

Rename the marketing/docs app from `apps/web` to `apps/site` and update the AGENTS.md monorepo structure section to reflect the actual app/package inventory. This eliminates a genuine DX confusion where new contributors assume `apps/web` is the main web application (it's the marketing site — the actual web app is `apps/client`).

## Background / Problem Statement

The DorkOS monorepo contains two web-based apps:

- `apps/client` — the React 19 SPA (the product's web application)
- `apps/web` — the Next.js 16 marketing site + Fumadocs documentation

A new contributor's natural assumption is "the web app is in `apps/web`" — which is wrong. This naming collision creates real confusion because both are web-based.

Industry convention (Vercel, Linear, shadcn/ui) uses `apps/site` or `apps/www` for marketing sites when the monorepo also contains a product web app. DorkOS has this inverted.

Additionally, AGENTS.md says "four apps and four shared packages" but the monorepo actually has **5 apps** and **7 packages**:

- Missing apps: `apps/e2e`
- Missing packages: `packages/db`, `packages/relay`, `packages/mesh`

## Goals

- Rename `apps/web` → `apps/site` with package name `@dorkos/site`
- Update all live documentation and configuration references
- Fix AGENTS.md structure section to reflect actual 5 apps + 7 packages
- Verify builds, typechecks, and lint pass after rename

## Non-Goals

- Renaming any other apps or packages (all others assessed as well-named)
- Renaming environment variables (`DORKOS_*` prefix)
- Renaming internal FSD layers or component directories
- Updating historical artifacts (specs, research, plans, decisions)
- Renaming the product itself or subsystem features

## Technical Dependencies

- **pnpm workspaces** — auto-discovers via `apps/*` and `packages/*` patterns (no explicit listing)
- **Turborepo** — auto-discovers workspaces, no explicit `@dorkos/web` references in `turbo.json`
- **Vercel** — `apps/web/vercel.json` uses `npx turbo-ignore` which reads from `package.json` name (self-correcting after rename)
- **Git** — `git mv` preserves file history

## Detailed Design

### Phase 1: Directory & Package Rename

#### 1a. Rename directory

```bash
git mv apps/web apps/site
```

#### 1b. Update package.json name

In `apps/site/package.json`, change:

```json
"name": "@dorkos/web"
```

to:

```json
"name": "@dorkos/site"
```

#### 1c. Update internal script comments

In `apps/site/scripts/generate-api-docs.ts`, update lines 8-9:

```
- * Must be run from the apps/web/ directory
+ * Must be run from the apps/site/ directory
- * Run via: npm run generate:api-docs -w apps/web
+ * Run via: npm run generate:api-docs -w apps/site
```

#### 1d. Regenerate lockfile

```bash
pnpm install
```

### Phase 2: Update Live Documentation

These files contain references to `apps/web` or `@dorkos/web` and are actively consumed by contributors/agents. Update all occurrences.

#### 2a. `AGENTS.md`

Three changes:

1. **Line 17** — Update count: "four apps and four shared packages" → "five apps and seven shared packages"

2. **Lines 19-36** — Update ASCII tree to include all apps and packages:

```
dorkos/
├── apps/
│   ├── client/           # @dorkos/client - React 19 SPA (Vite 6, Tailwind 4, shadcn/ui)
│   ├── server/           # @dorkos/server - Express API (tsc, NodeNext)
│   ├── site/             # @dorkos/site - Marketing site & docs (Next.js 16, Fumadocs)
│   ├── obsidian-plugin/  # @dorkos/obsidian-plugin - Obsidian plugin (Vite lib, CJS)
│   └── e2e/              # @dorkos/e2e - Playwright browser tests
├── packages/
│   ├── cli/              # dorkos - Publishable npm CLI (esbuild bundle)
│   ├── shared/           # @dorkos/shared - Zod schemas, types (JIT .ts exports)
│   ├── db/               # @dorkos/db - Drizzle ORM schemas (SQLite)
│   ├── relay/            # @dorkos/relay - Inter-agent message bus
│   ├── mesh/             # @dorkos/mesh - Agent discovery & registry
│   ├── typescript-config/ # @dorkos/typescript-config - Shared tsconfig presets
│   └── test-utils/       # @dorkos/test-utils - Mock factories, test helpers
```

3. **Line 269** — Update documentation section reference:

```
- The `apps/web` workspace (`@dorkos/web`) is a Next.js 16 marketing site
+ The `apps/site` workspace (`@dorkos/site`) is a Next.js 16 marketing site
```

#### 2b. `CONTRIBUTING.md`

**Line 36** — Update table row:

```
- | `apps/web` | `@dorkos/web` | Marketing site & docs (Next.js 16, Fumadocs) |
+ | `apps/site` | `@dorkos/site` | Marketing site & docs (Next.js 16, Fumadocs) |
```

Also add missing entries for `apps/e2e`, `packages/db`, `packages/relay`, `packages/mesh` if not present.

#### 2c. `contributing/project-structure.md`

**Line 14** — Update ASCII tree entry:

```
- │   ├── web/              # @dorkos/web — Marketing site & docs (Next.js 16, Fumadocs)
+ │   ├── site/             # @dorkos/site — Marketing site & docs (Next.js 16, Fumadocs)
```

Also add missing app/package entries to match AGENTS.md structure.

#### 2d. `contributing/environment-variables.md`

**Line 17** — Update table row:

```
- | `apps/web`       | `apps/web/src/env.ts`                    |
+ | `apps/site`      | `apps/site/src/env.ts`                   |
```

#### 2e. `docs/contributing/development-setup.mdx`

**Line 107** — Update folder tree:

```
- <Folder name="web">
+ <Folder name="site">
```

**Line 137** — Update table row:

```
- | `apps/web` | `@dorkos/web` | Marketing site & docs (Next.js 16, Fumadocs) |
+ | `apps/site` | `@dorkos/site` | Marketing site & docs (Next.js 16, Fumadocs) |
```

#### 2f. `.claude/agents/typescript/typescript-expert.md`

**Line 247** — Update path reference:

```
- { "path": "./apps/web" }
+ { "path": "./apps/site" }
```

#### 2g. `apps/e2e/BROWSER_TEST_PLAN.md`

**Line 213** — Update section header:

```
- ## 10. Marketing Site (apps/web)
+ ## 10. Marketing Site (apps/site)
```

### Files NOT Updated (Historical Artifacts)

The following contain `apps/web` or `@dorkos/web` references but are point-in-time historical documents. Updating them would be revisionist:

- `specs/*/` — 15+ spec files
- `research/` — 6+ research files
- `plans/` — 2 plan files
- `decisions/` — 4 ADR files

## User Experience

No user-facing changes. This is an internal developer experience improvement. External users interact with the deployed marketing site at `dorkos.ai`, which is unaffected by the directory name.

## Testing Strategy

No new tests needed. Verification is build/lint/typecheck based:

1. `pnpm install` — lockfile regenerates without workspace errors
2. `turbo build --filter=@dorkos/site` — Next.js builds successfully
3. `pnpm typecheck` — all packages pass type checking
4. `pnpm lint` — no lint errors introduced
5. `pnpm test -- --run` — existing tests still pass (none reference `@dorkos/web` directly)

## Performance Considerations

None. This is a rename with no runtime impact.

## Security Considerations

None. No code logic changes.

## Documentation

This spec IS the documentation change. All doc updates are detailed in Phase 2 above.

## Implementation Phases

### Phase 1: Rename & Regenerate

1. `git mv apps/web apps/site`
2. Update `apps/site/package.json` name field
3. Update `apps/site/scripts/generate-api-docs.ts` comments
4. `pnpm install` to regenerate lockfile

### Phase 2: Update Live References

5. Update `AGENTS.md` (structure tree + counts + doc section reference)
6. Update `CONTRIBUTING.md`
7. Update `contributing/project-structure.md`
8. Update `contributing/environment-variables.md`
9. Update `docs/contributing/development-setup.mdx`
10. Update `.claude/agents/typescript/typescript-expert.md`
11. Update `apps/e2e/BROWSER_TEST_PLAN.md`

### Phase 3: Verify

12. `pnpm install` (verify clean lockfile)
13. `turbo build --filter=@dorkos/site` (verify Next.js build)
14. `pnpm typecheck` (verify no broken refs)
15. `pnpm lint` (verify no lint errors)

## Open Questions

None — all decisions resolved during ideation.

## Related ADRs

- `decisions/0004-monorepo-with-turborepo.md` — Established the monorepo structure convention (historical reference to `@dorkos/web` — not updated)

## References

- Ideation: `specs/monorepo-naming-convention/01-ideation.md`
- Industry conventions: Vercel uses `apps/site`, Linear uses `apps/site`, shadcn/ui uses `apps/www`
