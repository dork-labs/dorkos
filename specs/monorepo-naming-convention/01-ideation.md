---
slug: monorepo-naming-convention
number: 78
created: 2026-03-01
status: ideation
---

# Monorepo Naming Convention Review

**Slug:** monorepo-naming-convention
**Author:** Claude Code
**Date:** 2026-03-01

---

## 1) Intent & Assumptions

- **Task brief:** Review the DorkOS monorepo structure and product homepage to assess whether any apps, packages, or directories should be renamed to improve developer experience and intuitiveness.
- **Assumptions:**
  - Renames should prioritize new-contributor DX (first-time clarity)
  - Industry conventions matter (what do similar monorepos do?)
  - Product branding (subsystem names: Pulse, Relay, Mesh, Console, etc.) should inform but not dictate internal naming
  - Renames have a cost: import updates, turbo filter changes, CI config, docs, and contributor muscle memory
- **Out of scope:**
  - Renaming the product itself (DorkOS)
  - Renaming subsystem features (Pulse, Relay, Mesh)
  - Renaming internal FSD layers or component directories
  - Environment variable naming (`DORKOS_*` prefix)

## 2) Pre-reading Log

- `apps/web/src/app/page.tsx`: Homepage entry point — confirms product positions six subsystems (Pulse, Relay, Mesh, Console, Loop, Wing)
- `apps/web/src/app/layout.tsx`: Root layout with metadata, IBM Plex fonts, PostHog analytics
- `apps/web/src/components/sections/hero-section.tsx`: Hero copy — "The operating system for autonomous AI agents"
- `apps/web/src/components/sections/subsystems-section.tsx`: Subsystem names and descriptions — "Console" is the web dashboard name
- `apps/web/package.json`: Package name `@dorkos/web`, described as Next.js 16 marketing + docs site
- `apps/client/package.json`: Package name `@dorkos/client` — the React 19 SPA (Vite 6)
- `apps/server/package.json`: Package name `@dorkos/server` — Express API + SDK orchestration
- `apps/obsidian-plugin/package.json`: Package name `@dorkos/obsidian-plugin`
- `apps/e2e/package.json`: Package name `@dorkos/e2e` — Playwright tests
- `packages/cli/package.json`: Package name `dorkos` (published, unscoped)
- `packages/shared/package.json`: Package name `@dorkos/shared`
- `packages/db/package.json`: Package name `@dorkos/db` — Drizzle ORM schema layer
- `packages/relay/package.json`: Package name `@dorkos/relay`
- `packages/mesh/package.json`: Package name `@dorkos/mesh`
- `packages/test-utils/package.json`: Package name `@dorkos/test-utils`
- `packages/typescript-config/package.json`: Package name `@dorkos/typescript-config`
- `turbo.json`: Pipeline tasks (build, dev, test, typecheck, lint, e2e, db:generate, db:check)
- `contributing/architecture.md`: Hexagonal architecture, Transport interface, build plugins
- `CLAUDE.md`: Structure section says "four apps and four shared packages" — stale (actual: 5 apps, 7 packages)

## 3) Codebase Map

**Current Naming Inventory:**

| Directory                    | Package Name                | Role                                                           |
| ---------------------------- | --------------------------- | -------------------------------------------------------------- |
| `apps/client`                | `@dorkos/client`            | React 19 SPA — the main product UI (chat, dashboard, settings) |
| `apps/server`                | `@dorkos/server`            | Express API + Agent SDK orchestration + MCP + schedulers       |
| `apps/web`                   | `@dorkos/web`               | Next.js 16 marketing site + Fumadocs documentation             |
| `apps/obsidian-plugin`       | `@dorkos/obsidian-plugin`   | Obsidian sidebar plugin                                        |
| `apps/e2e`                   | `@dorkos/e2e`               | Playwright browser tests                                       |
| `packages/cli`               | `dorkos`                    | Published npm CLI (bundles server + client)                    |
| `packages/shared`            | `@dorkos/shared`            | Zod schemas, TS types, config, transport                       |
| `packages/db`                | `@dorkos/db`                | Drizzle ORM schema layer (SQLite)                              |
| `packages/relay`             | `@dorkos/relay`             | Inter-agent message bus library                                |
| `packages/mesh`              | `@dorkos/mesh`              | Agent discovery & registry library                             |
| `packages/test-utils`        | `@dorkos/test-utils`        | Mock factories, test helpers                                   |
| `packages/typescript-config` | `@dorkos/typescript-config` | Shared tsconfig presets                                        |

**Naming Consistency:**

- All internal packages use `@dorkos/*` scope (good)
- Published CLI is unscoped `dorkos` (correct for npm distribution)
- Directory names match package name suffixes in all cases (good)
- Subsystem packages (`relay`, `mesh`) match product branding (good)

**The DX Problem:**

- `apps/web` is the marketing site, but `apps/client` is the actual web application
- A new contributor's natural assumption: "the web app is in `apps/web`" — wrong
- This naming collision creates real confusion because both are web-based

**References to `@dorkos/web` in the codebase:**

- `turbo.json` filter references
- `package.json` workspace declarations (implicit via `apps/*`)
- Cross-package dependency declarations
- CI/CD configs (Vercel turbo-ignore)
- Documentation (CLAUDE.md, contributing guides)

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

**Industry Conventions for Marketing Sites in Monorepos:**

| Project               | Marketing Site Directory  | Main App Directory          |
| --------------------- | ------------------------- | --------------------------- |
| Vercel (Next.js repo) | `apps/site`               | `apps/web`                  |
| Linear                | `apps/site`               | `apps/app`                  |
| Cal.com               | `apps/web` (main app)     | separate repo for marketing |
| Turborepo examples    | `apps/web` or `apps/docs` | `apps/web`                  |
| Shadcn/ui             | `apps/www`                | N/A                         |

**Key finding:** When a monorepo has both a product app and a marketing site, the dominant conventions are:

- Marketing/docs: `apps/site` or `apps/www`
- Product app: `apps/web` or `apps/app`

DorkOS currently has this inverted — `apps/web` is marketing, not the product. `apps/site` is the most common fix.

**On `apps/server` vs `apps/api`:**

- `server` is accurate because it's more than a REST API — it runs Agent SDK sessions, MCP tool servers, Pulse scheduler jobs, SSE streams, and session sync
- `api` would undersell its scope
- No rename needed

**Rename Cost Assessment:**

- `apps/web` → `apps/site` touches: directory name, `package.json` name, turbo filter references, Vercel config (turbo-ignore), CLAUDE.md, contributing docs
- No runtime imports cross this boundary (Next.js app is self-contained)
- Risk: Low — the marketing site has no cross-package consumers

## 6) Decisions

| #   | Decision                 | Choice                     | Rationale                                                                                                                                                          |
| --- | ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Rename `apps/web`?       | Yes, rename to `apps/site` | Eliminates genuine confusion — `web` suggests it's the main web app but it's the marketing site. `site` follows Vercel/Linear convention and is immediately clear. |
| 2   | Rename `apps/server`?    | No, keep as-is             | The server is more than an API — it runs SDK sessions, MCP servers, schedulers, and SSE streams. `server` accurately reflects its broader role.                    |
| 3   | Fix CLAUDE.md doc drift? | Yes, include in scope      | CLAUDE.md says "four apps and four shared packages" but the actual count is 5 apps and 7 packages. Small fix, keeps docs honest.                                   |
| 4   | Rename any packages?     | No changes needed          | All packages follow consistent `@dorkos/*` scoping, directory names match, subsystem names match product branding. No DX issues found.                             |
