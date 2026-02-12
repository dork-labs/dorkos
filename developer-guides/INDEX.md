# Developer Guide Index & Coverage Map

This file maps code areas to their relevant developer guides. It serves three purposes:

1. **Automatic relevance detection** — Tools can check which guides may need updates based on changed files
2. **Developer reference** — Find the right guide for your task
3. **Maintenance tracking** — Each guide has a `last_reviewed` date to help identify stale documentation

## Guide Coverage Map

| Guide | Covers | File Patterns |
|-------|--------|---------------|
| [01-project-structure.md](./01-project-structure.md) | FSD architecture, directory layout, layer organization | `src/layers/**`, `src/app/**/page.tsx`, `src/app/**/layout.tsx` |
| [02-environment-variables.md](./02-environment-variables.md) | T3 Env configuration, adding variables | `src/env.ts`, `.env*`, `*.config.ts` |
| [03-database-prisma.md](./03-database-prisma.md) | Prisma 7, DAL patterns, schema design | `prisma/**`, `src/layers/entities/*/api/**`, `src/lib/prisma.ts`, `src/generated/prisma/**` |
| [04-forms-validation.md](./04-forms-validation.md) | React Hook Form, Zod schemas, Shadcn Form | `**/*form*.tsx`, `**/*schema*.ts`, `**/model/types.ts` |
| [05-data-fetching.md](./05-data-fetching.md) | TanStack Query, server actions, API routes | `src/app/api/**`, `**/api/queries.ts`, `**/api/mutations.ts`, `src/layers/shared/lib/query-client.ts` |
| [06-state-management.md](./06-state-management.md) | Zustand stores, client state patterns | `**/*store*.ts`, `**/model/store.ts`, `src/hooks/**` |
| [07-animations.md](./07-animations.md) | Motion library patterns, transitions | `**/*animation*.ts`, `**/*motion*.tsx`, components with `motion.` |
| [08-styling-theming.md](./08-styling-theming.md) | Tailwind v4, Shadcn UI, theming | `src/app/globals.css`, `src/layers/shared/ui/**`, `src/components/ui/**`, `tailwind.config.*` |
| [09-authentication.md](./09-authentication.md) | BetterAuth, sessions, OTP, auth utilities | `src/lib/auth.ts`, `src/lib/auth-client.ts`, `src/layers/shared/api/auth.ts`, `src/app/(auth)/**`, `src/app/api/auth/**` |
| [10-metadata-seo.md](./10-metadata-seo.md) | Metadata API, favicons, Open Graph, JSON-LD, SEO, AEO | `src/app/**/layout.tsx`, `src/app/**/page.tsx`, `src/app/sitemap.ts`, `src/app/robots.ts`, `src/app/**/opengraph-image.tsx`, `public/manifest.webmanifest` |
| [11-parallel-execution.md](./11-parallel-execution.md) | Parallel agent execution, background agents, batch scheduling | `.claude/commands/**`, `.claude/skills/**`, `Task(`, `TaskOutput(` |
| [12-site-configuration.md](./12-site-configuration.md) | Site configuration, feature toggles, env overrides | `site.config.ts`, `src/config/**` |
| [13-autonomous-roadmap-execution.md](./13-autonomous-roadmap-execution.md) | **⭐ Novel Feature** — Autonomous workflow execution, /roadmap:work, /roadmap:next, self-correction | `.claude/commands/roadmap/**`, `.claude/scripts/hooks/autonomous-check.mjs`, `roadmap/scripts/update_workflow_state.py`, `roadmap/schema.json` |
| [14-template-updates.md](./14-template-updates.md) | Template update system, /template:check, /template:update, version tracking | `.claude/commands/template/**`, `.claude/scripts/template-fetch.ts`, `.template.json`, `.claude/schemas/template-manifest.json` |

## Pattern Matching Reference

For tooling that needs to match files to guides, here are the glob patterns:

```yaml
# Guide: 01-project-structure.md
patterns:
  - "src/layers/**"
  - "src/app/**/page.tsx"
  - "src/app/**/layout.tsx"
keywords:
  - "FSD"
  - "Feature-Sliced"
  - "layer"
  - "entities"
  - "features"
  - "widgets"
  - "shared"

# Guide: 02-environment-variables.md
patterns:
  - "src/env.ts"
  - ".env*"
  - "*.config.ts"
keywords:
  - "env"
  - "environment"
  - "NEXT_PUBLIC"
  - "createEnv"
  - "T3 Env"

# Guide: 03-database-prisma.md
patterns:
  - "prisma/**"
  - "src/layers/entities/*/api/**"
  - "src/lib/prisma.ts"
  - "src/generated/prisma/**"
keywords:
  - "prisma"
  - "database"
  - "schema"
  - "migration"
  - "DAL"
  - "findMany"
  - "findUnique"
  - "create"
  - "update"
  - "delete"

# Guide: 04-forms-validation.md
patterns:
  - "**/*form*.tsx"
  - "**/*schema*.ts"
  - "**/model/types.ts"
keywords:
  - "useForm"
  - "zodResolver"
  - "z.object"
  - "FormField"
  - "FormItem"
  - "react-hook-form"

# Guide: 05-data-fetching.md
patterns:
  - "src/app/api/**"
  - "**/api/queries.ts"
  - "**/api/mutations.ts"
  - "src/layers/shared/lib/query-client.ts"
keywords:
  - "useQuery"
  - "useMutation"
  - "queryClient"
  - "TanStack"
  - "server action"
  - "API route"
  - "Route Handler"

# Guide: 06-state-management.md
patterns:
  - "**/*store*.ts"
  - "**/model/store.ts"
  - "src/hooks/**"
keywords:
  - "zustand"
  - "create("
  - "useStore"
  - "persist"
  - "devtools"

# Guide: 07-animations.md
patterns:
  - "**/*animation*.ts"
  - "**/*motion*.tsx"
keywords:
  - "motion."
  - "animate"
  - "variants"
  - "transition"
  - "useAnimation"
  - "AnimatePresence"

# Guide: 08-styling-theming.md
patterns:
  - "src/app/globals.css"
  - "src/layers/shared/ui/**"
  - "src/components/ui/**"
  - "tailwind.config.*"
keywords:
  - "@theme"
  - "dark:"
  - "cn("
  - "cva("
  - "Shadcn"
  - "className"

# Guide: 09-authentication.md
patterns:
  - "src/lib/auth.ts"
  - "src/lib/auth-client.ts"
  - "src/layers/shared/api/auth.ts"
  - "src/app/(auth)/**"
  - "src/app/api/auth/**"
  - "src/layers/features/auth/**"
keywords:
  - "BetterAuth"
  - "auth"
  - "session"
  - "signIn"
  - "signOut"
  - "getCurrentUser"
  - "requireAuth"
  - "OTP"

# Guide: 10-metadata-seo.md
patterns:
  - "src/app/**/layout.tsx"
  - "src/app/**/page.tsx"
  - "src/app/sitemap.ts"
  - "src/app/robots.ts"
  - "src/app/**/opengraph-image.tsx"
  - "public/manifest.webmanifest"
  - "public/favicon*"
  - "public/apple-touch-icon.png"
keywords:
  - "metadata"
  - "Metadata"
  - "generateMetadata"
  - "title"
  - "description"
  - "openGraph"
  - "twitter"
  - "favicon"
  - "sitemap"
  - "robots"
  - "SEO"
  - "JSON-LD"
  - "structured data"
  - "schema.org"

# Guide: 11-parallel-execution.md
patterns:
  - ".claude/commands/**"
  - ".claude/skills/**"
keywords:
  - "Task("
  - "TaskOutput("
  - "run_in_background"
  - "parallel"
  - "background agent"
  - "batch"
  - "concurrent"
  - "dependency"

# Guide: 12-site-configuration.md
patterns:
  - "site.config.ts"
  - "src/config/**"
keywords:
  - "siteConfig"
  - "getSiteConfig"
  - "SiteConfig"
  - "cookieBanner"
  - "legalPages"
  - "site configuration"
  - "feature toggle"

# Guide: 13-autonomous-roadmap-execution.md (⭐ Novel Feature)
patterns:
  - ".claude/commands/roadmap/**"
  - ".claude/scripts/hooks/autonomous-check.mjs"
  - "roadmap/scripts/update_workflow_state.py"
  - "roadmap/schema.json"
  - "roadmap/roadmap.json"
keywords:
  - "/roadmap:next"
  - "/roadmap:work"
  - "workflowState"
  - "PHASE_COMPLETE"
  - "ABORT"
  - "autonomous"
  - "Ralph Wiggum"
  - "stop hook"
  - "self-correction"
  - "human approval"
  - "checkpoint"

# Guide: 14-template-updates.md
patterns:
  - ".claude/commands/template/**"
  - ".claude/scripts/template-fetch.ts"
  - ".template.json"
  - ".claude/schemas/template-manifest.json"
keywords:
  - "/template:check"
  - "/template:update"
  - "template update"
  - "upstream"
  - "version tracking"
  - "manifest"
  - "user additions"
  - "gray zone"
  - "three-way diff"
  - "marker-based"
  - "template-section"
  - "backup branch"
```

## Maintenance Tracking

| Guide | Last Reviewed | Reviewed By | Notes |
|-------|--------------|-------------|-------|
| 01-project-structure.md | 2025-12-22 | Claude | Restructured: AI-optimized format (Decision Matrix, Anti-Patterns, Troubleshooting) |
| 02-environment-variables.md | 2025-12-22 | Claude | Restructured: AI-optimized format (Decision Matrix, Anti-Patterns, Troubleshooting) |
| 03-database-prisma.md | 2025-12-22 | Claude | Restructured: AI-optimized format (Decision Matrix, Anti-Patterns, Troubleshooting) |
| 04-forms-validation.md | 2025-12-22 | Claude | Restructured: AI-optimized format (Decision Matrix, Anti-Patterns, Troubleshooting) |
| 05-data-fetching.md | 2025-12-22 | Claude | Restructured: AI-optimized format (Decision Matrix, Anti-Patterns, Troubleshooting) |
| 06-state-management.md | 2025-12-22 | Claude | Restructured: AI-optimized format (Decision Matrix, Anti-Patterns, Troubleshooting) |
| 07-animations.md | 2025-12-22 | Claude | Restructured: AI-optimized format (Decision Matrix, Anti-Patterns, Troubleshooting) |
| 08-styling-theming.md | 2025-12-22 | Claude | Restructured: AI-optimized format (Decision Matrix, Anti-Patterns, Troubleshooting) |
| 09-authentication.md | 2025-12-22 | Claude | Created with AI-optimized format (already follows template) |
| 10-metadata-seo.md | 2025-12-23 | Claude | Created: Covers Metadata API, favicons, OG, JSON-LD, SEO, AEO with Next.js-specific patterns |
| 11-parallel-execution.md | 2026-02-01 | Claude | Created: Parallel agent patterns, background agents, batch scheduling, context savings |
| 12-site-configuration.md | 2026-02-01 | Claude | Created: Site configuration system, feature toggles, env overrides |
| 13-autonomous-roadmap-execution.md | 2026-02-01 | Claude | **⭐ Novel Feature** — Complete autonomous workflow execution system with self-correction |
| 14-template-updates.md | 2026-02-02 | Claude | Template update system — version tracking, selective updates, conflict resolution |

## How to Use This Index

### Finding the Right Guide

1. **By code area**: Look at the "Covers" column in the coverage map
2. **By file pattern**: Check if your file matches patterns in the Pattern Matching Reference
3. **By keyword**: Search for related terms in the keywords lists

### Updating Guides

When a guide is updated:
1. Update the "Last Reviewed" date in the Maintenance Tracking section
2. Add notes about what changed
3. Run `/docs:reconcile` to verify consistency with code

### Adding a New Guide

1. Create the guide file in `developer-guides/`
2. Add an entry to the Guide Coverage Map table
3. Add pattern matching rules to the YAML section
4. Add maintenance tracking entry

## Integration with Tooling

This file is read by:
- `/spec:execute` — Checks if implementation touched relevant guide areas
- `/docs:reconcile` — Uses patterns to detect documentation drift
- `check-docs-changed` hook — Session-end reminder for guide updates

The YAML section is designed to be machine-readable for automated tooling.
