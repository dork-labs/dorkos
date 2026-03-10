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
| `relay-adapters.md` | Adapter interface, lifecycle, testing | `packages/relay/src/adapters/\|adapter-registry\|adapter-manager` |
| `adapter-catalog.md` | AdapterManifest, ConfigField, plugin manifests, catalog API | `AdapterManifest\|ConfigField\|adapter-plugin-loader\|adapters/catalog` |
| `browser-testing.md` | Playwright test suite, AI-assisted test authoring, Page Object Models, manifest | `apps/e2e/\|playwright.config\|browsertest` |
| `environment-variables.md` | env.ts validation pattern, boolFlag helper, complete env var reference | `env.ts\|process\.env\|globalPassThroughEnv` |

## Pattern Syntax

Patterns are `grep -qE` fragments. Each pattern is pipe-delimited (`|`) for alternation. A changed file matches a guide if any fragment matches the file path.

Example: If `apps/client/src/layers/shared/ui/button.tsx` changes, it matches:
- `design-system.md` via `apps/client/src/layers/shared/ui/`
- `styling-theming.md` via `apps/client/src/layers/shared/ui/`

## Maintenance Tracking

| Guide | Last Reviewed | Reviewer | Notes |
|---|---|---|---|
| `project-structure.md` | 2026-03-06 | Claude | Added eslint-config and icons packages |
| `architecture.md` | 2026-03-09 | Claude | Added Transport.uploadFiles(), upload-handler, mcp-server, mcp middleware |
| `design-system.md` | 2026-03-06 | Claude | Reviewed — no content changes required |
| `api-reference.md` | 2026-03-09 | Claude | Added POST /api/uploads endpoint documentation |
| `configuration.md` | 2026-03-09 | Claude | Added uploads config section (maxFileSize, maxFiles, allowedTypes) |
| `interactive-tools.md` | 2026-03-06 | Claude | Fixed INTERACTION_TIMEOUT_MS constant ref, reject implementations, auto-approve logic, InteractiveSession type |
| `keyboard-shortcuts.md` | 2026-03-06 | Claude | Fixed useInteractiveShortcuts location (shared/model, not features/chat), corrected PaletteFooter shortcut table |
| `obsidian-plugin-development.md` | 2026-03-06 | Claude | Updated sdk-utils paths for runtime abstraction |
| `data-fetching.md` | 2026-03-06 | Claude | Reconciled — no content impact from ESLint migration |
| `state-management.md` | 2026-03-06 | Claude | Reviewed — no content changes required |
| `animations.md` | 2026-03-06 | Claude | Reviewed — no content changes required |
| `styling-theming.md` | 2026-03-06 | Claude | Reviewed — no content changes required |
| `parallel-execution.md` | 2026-03-06 | Claude | Reviewed — no stale patterns found |
| `relay-adapters.md` | 2026-03-06 | Claude | Reviewed — no content changes required |
| `adapter-catalog.md` | 2026-03-06 | Claude | Reviewed — no content changes required |
| `browser-testing.md` | 2026-03-06 | Claude | Reconciled — no content impact from ESLint migration |
| `environment-variables.md` | 2026-03-09 | Claude | Added MCP_API_KEY env var |

## External Docs Coverage

Maps `docs/` MDX files (Fumadocs content for the marketing site) to the source code areas they document. Used by `check-docs-changed.sh` to remind about external docs drift.

| MDX File | Description | Source Patterns |
|---|---|---|
| `docs/index.mdx` | Docs landing page | `apps/site/` |
| `docs/changelog.mdx` | Product changelog | `packages/cli/package.json` |
| `docs/getting-started/installation.mdx` | Install guide | `packages/cli/` |
| `docs/getting-started/quickstart.mdx` | Quickstart guide | `packages/cli/\|apps/client/` |
| `docs/getting-started/configuration.mdx` | User-facing config guide | `config-manager\|config-schema\|packages/cli/` |
| `docs/concepts/architecture.mdx` | Architecture concepts overview | `apps/server/src/services/\|transport.ts` |
| `docs/concepts/sessions.mdx` | Session model concepts | `transcript-reader\|apps/server/src/routes/sessions` |
| `docs/concepts/transport.mdx` | Transport interface concepts | `transport.ts\|direct-transport\|http-transport` |
| `docs/concepts/relay.mdx` | Relay messaging concepts | `packages/relay/\|apps/server/src/services/relay/` |
| `docs/concepts/mesh.mdx` | Mesh agent discovery concepts | `packages/mesh/\|apps/server/src/services/mesh/` |
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
| `docs/guides/keyboard-shortcuts.mdx` | Keyboard shortcuts reference | `use-interactive-shortcuts\|use-global-palette` |
| `docs/guides/tool-approval.mdx` | Tool approval user guide | `interactive-handlers\|apps/client/src/layers/features/chat/` |
| `docs/guides/agents.mdx` | Agent identity guide | `routes/agents\|manifest\|agent.json` |
| `docs/guides/agent-discovery.mdx` | Agent discovery guide | `packages/mesh/\|unified-scanner` |
| `docs/guides/agent-coordination.mdx` | Multi-agent coordination guide | `packages/relay/\|packages/mesh/` |
| `docs/guides/pulse-scheduler.mdx` | Pulse scheduler guide | `services/pulse/\|pulse-store` |
| `docs/guides/relay-messaging.mdx` | Relay messaging guide | `packages/relay/\|services/relay/` |
| `docs/guides/relay-observability.mdx` | Relay observability guide | `trace-store\|relay-metrics` |
| `docs/guides/building-relay-adapters.mdx` | Relay adapter authoring guide | `packages/relay/src/adapters/\|adapter-manager` |
| `docs/guides/obsidian-plugin.mdx` | Obsidian plugin user guide | `apps/obsidian-plugin/` |
| `docs/guides/persona.mdx` | Agent persona configuration | `manifest\|context-builder\|personaEnabled` |

### External Docs Maintenance

| MDX File | Last Reviewed | Reviewer | Notes |
|---|---|---|---|
| `docs/index.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/changelog.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/getting-started/installation.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/getting-started/quickstart.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/getting-started/configuration.mdx` | 2026-03-06 | Claude | Reconciled — no content impact from ESLint migration |
| `docs/concepts/architecture.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/concepts/sessions.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/concepts/transport.mdx` | 2026-03-09 | Claude | Added uploadFiles to Transport method tables |
| `docs/concepts/relay.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/concepts/mesh.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/integrations/sse-protocol.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/integrations/building-integrations.mdx` | 2026-03-09 | Claude | Added uploadFiles() to Transport interface listing |
| `docs/self-hosting/deployment.mdx` | 2026-03-06 | Claude | Reconciled — no content impact from ESLint migration |
| `docs/self-hosting/reverse-proxy.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/contributing/architecture.mdx` | 2026-03-09 | Claude | Added uploads.ts, mcp.ts routes; upload-handler, mcp-server services |
| `docs/contributing/testing.mdx` | 2026-03-06 | Claude | Reconciled — no content impact from ESLint migration |
| `docs/contributing/development-setup.mdx` | 2026-03-06 | Claude | Added eslint-config and icons packages |
| `docs/guides/cli-usage.mdx` | 2026-03-06 | Claude | Reconciled — no content impact from ESLint migration |
| `docs/guides/tunnel-setup.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/guides/slash-commands.mdx` | 2026-02-17 | Claude | Written from scratch |
| `docs/guides/keyboard-shortcuts.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/guides/tool-approval.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/guides/agents.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/guides/agent-discovery.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/guides/agent-coordination.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/guides/pulse-scheduler.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/guides/relay-messaging.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/guides/relay-observability.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/guides/building-relay-adapters.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/guides/obsidian-plugin.mdx` | 2026-03-06 | Claude | Added to coverage map |
| `docs/guides/persona.mdx` | 2026-03-06 | Claude | Added to coverage map |
