# Contributing Guides Index

This file is the single source of truth for documentation coverage mapping and maintenance tracking. It is consumed by:

- `.claude/hooks/check-docs-changed.sh` — Stop hook that reminds about affected guides
- `.claude/commands/docs/reconcile.md` — `/docs:reconcile` drift detection command
- `.claude/skills/writing-developer-guides/SKILL.md` — Guide authoring skill

## Guide Coverage Map

Maps source code patterns to the guides that document them. Patterns use `grep -qE` fragment syntax (pipe-delimited alternation).

| Guide | Description | Source Patterns |
|---|---|---|
| `project-structure.md` | FSD layer hierarchy, directory layout, adding features | `apps/client/src/layers/\|apps/server/src/\|packages/` |
| `architecture.md` | Hexagonal architecture, Transport interface, Electron compatibility | `transport.ts\|direct-transport\|http-transport\|apps/obsidian-plugin/build-plugins` |
| `design-system.md` | Color palette, typography, spacing, motion specs | `apps/client/src/index.css\|apps/client/src/layers/shared/ui/` |
| `api-reference.md` | OpenAPI spec, Scalar docs UI, Zod schema patterns | `openapi-registry\|apps/server/src/routes/\|packages/shared/src/schemas` |
| `configuration.md` | Config file system, settings reference, CLI commands, precedence | `config-manager\|config-schema\|packages/cli/` |
| `interactive-tools.md` | Tool approval, AskUserQuestion, TaskList interactive flows | `interactive-handlers\|apps/client/src/layers/features/chat/` |
| `keyboard-shortcuts.md` | Keyboard shortcuts and hotkeys | `use-interactive-shortcuts` |
| `obsidian-plugin-development.md` | Plugin lifecycle, Vite build, Electron quirks | `apps/obsidian-plugin/` |
| `data-fetching.md` | TanStack Query patterns, Transport abstraction, SSE streaming | `apps/server/src/routes/\|apps/client/src/layers/entities/\|apps/client/src/layers/features/chat/` |
| `state-management.md` | Zustand vs TanStack Query decision guide | `app-store\|apps/client/src/layers/entities/\|apps/client/src/layers/shared/model/` |
| `animations.md` | Motion library patterns | `animation\|motion\|apps/client/src/index.css` |
| `styling-theming.md` | Tailwind v4, dark mode, Shadcn | `index.css\|apps/client/src/layers/shared/ui/\|tailwind` |
| `parallel-execution.md` | Parallel agent execution patterns, batching | `.claude/agents/\|\.claude/commands/` |
| `autonomous-roadmap-execution.md` | Autonomous workflow, `/roadmap:work` | `.claude/commands/roadmap/` |

## Pattern Syntax

Patterns are `grep -qE` fragments. Each pattern is pipe-delimited (`|`) for alternation. A changed file matches a guide if any fragment matches the file path.

Example: If `apps/client/src/layers/shared/ui/button.tsx` changes, it matches:
- `design-system.md` via `apps/client/src/layers/shared/ui/`
- `styling-theming.md` via `apps/client/src/layers/shared/ui/`

## Maintenance Tracking

| Guide | Last Reviewed | Reviewer | Notes |
|---|---|---|---|
| `project-structure.md` | 2026-02-17 | Claude | Verified post-FSD paths |
| `architecture.md` | 2026-02-17 | Claude | Fixed pre-FSD path references |
| `design-system.md` | 2026-02-17 | Claude | Fixed pre-FSD component paths |
| `api-reference.md` | 2026-02-17 | Claude | Current |
| `configuration.md` | 2026-02-17 | Claude | Current |
| `interactive-tools.md` | 2026-02-17 | Claude | Fixed pre-FSD paths |
| `keyboard-shortcuts.md` | 2026-02-17 | Claude | Fixed pre-FSD paths |
| `obsidian-plugin-development.md` | 2026-02-17 | Claude | Fixed pre-FSD paths |
| `data-fetching.md` | 2026-02-17 | Claude | Full rewrite for DorkOS stack |
| `state-management.md` | 2026-02-17 | Claude | Full rewrite for DorkOS stack |
| `animations.md` | 2026-02-17 | Claude | Fixed path references |
| `styling-theming.md` | 2026-02-17 | Claude | Fixed path references |
| `parallel-execution.md` | 2026-02-17 | Claude | Current |
| `autonomous-roadmap-execution.md` | 2026-02-17 | Claude | Current |

## External Docs Coverage

Maps `docs/` MDX files (Fumadocs content for the marketing site) to the source code areas they document. Used by `check-docs-changed.sh` to remind about external docs drift.

| MDX File | Description | Source Patterns |
|---|---|---|
| `docs/getting-started/configuration.mdx` | User-facing config guide | `config-manager\|config-schema\|packages/cli/` |
| `docs/integrations/sse-protocol.mdx` | SSE wire format reference | `apps/server/src/routes/sessions\|stream-adapter\|session-broadcaster` |
| `docs/integrations/building-integrations.mdx` | Transport interface for custom clients | `transport.ts\|direct-transport\|http-transport` |
| `docs/self-hosting/deployment.mdx` | Production deployment guide | `packages/cli/\|config-manager` |
| `docs/self-hosting/reverse-proxy.mdx` | Reverse proxy configuration | `apps/server/src/routes/sessions\|stream-adapter` |
| `docs/contributing/architecture.mdx` | External architecture overview | `apps/server/src/services/\|transport.ts\|apps/obsidian-plugin/` |
| `docs/contributing/testing.mdx` | External testing guide | `packages/test-utils/\|vitest` |
| `docs/contributing/development-setup.mdx` | Dev environment setup | `package.json\|turbo.json\|apps/` |
| `docs/guides/cli-usage.mdx` | CLI usage guide | `packages/cli/` |
| `docs/guides/tunnel-setup.mdx` | Tunnel/ngrok setup | `tunnel-manager` |
| `docs/guides/slash-commands.mdx` | Slash command authoring | `command-registry\|.claude/commands/` |

### External Docs Maintenance

| MDX File | Last Reviewed | Reviewer | Notes |
|---|---|---|---|
| `docs/getting-started/configuration.mdx` | 2026-02-17 | Claude | Pre-existing content |
| `docs/integrations/sse-protocol.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/integrations/building-integrations.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/self-hosting/deployment.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/self-hosting/reverse-proxy.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/contributing/architecture.mdx` | 2026-02-17 | Claude | Fixed service count + links |
| `docs/contributing/testing.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/contributing/development-setup.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/guides/cli-usage.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/guides/tunnel-setup.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/guides/slash-commands.mdx` | 2026-02-17 | Claude | Written from scratch |
