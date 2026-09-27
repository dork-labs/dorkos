# Project Structure Guide

## Overview

DorkOS uses Feature-Sliced Design (FSD) to organize frontend code by business domains with clear layer boundaries. The server uses a layered architecture (routes + services) with size-aware guidance for when to adopt domain grouping. The monorepo structure (Turborepo + npm workspaces) is orthogonal to FSD — FSD applies _within_ each app.

## Monorepo Layout

```
dorkos/
├── apps/
│   ├── client/           # @dorkos/client — React 19 SPA with FSD layers
│   ├── community/        # @dorkos/community — independent Hono/Postgres community service
│   ├── design-system/    # @dorkos/design-system — standalone shared UI catalog
│   ├── desktop/          # @dorkos/desktop — Electron shell
│   ├── server/           # @dorkos/server — Express API (routes + domain-grouped services)
│   ├── site/             # @dorkos/site — Marketing site & docs (Next.js 16, Fumadocs)
│   └── e2e/              # @dorkos/e2e — Playwright browser tests
├── packages/
│   ├── cli/              # dorkos — Publishable npm CLI
│   ├── shared/           # @dorkos/shared — Zod schemas, types, AgentRuntime + Transport interfaces
│   ├── db/               # @dorkos/db — Drizzle ORM schemas (SQLite)
│   ├── relay/            # @dorkos/relay — Inter-agent message bus
│   ├── mesh/             # @dorkos/mesh — Agent discovery & registry
│   ├── harness/          # @dorkos/harness — Projects .agents/ + plugins to every agent harness
│   ├── memory/           # @dorkos/memory — MEMORY.md store behind the MemoryProvider port
│   ├── a2a-gateway/      # @dorkos/a2a-gateway — A2A protocol gateway
│   ├── connector-providers/ # @dorkos/connector-providers — Confined external connector SDK adapters
│   ├── extension-api/    # @dorkos/extension-api — Extension author API
│   ├── skills/           # @dorkos/skills — SKILL.md schemas, parser, writer, scanner
│   ├── operating-skills/ # @dorkos/operating-skills — First-party skill pack + version-stamped seeder
│   ├── marketplace/      # @dorkos/marketplace — Package manifest schema, validators, scaffolder
│   ├── cloud-api/        # @dork-labs/cloud-api — Public wire contract for DorkOS Cloud
│   ├── icons/            # @dorkos/icons — SVG icon & logo registry
│   ├── ui/               # @dork-labs/ui — Portable UI primitives + namespaced theme CSS
│   ├── evals/            # @dorkos/evals — Headless outcome-oracle eval harness
│   ├── ci-steward/       # @dorkos/ci-steward — CI Steward engine (census, ledger, verdicts)
│   ├── typescript-config/ # Shared tsconfig presets
│   ├── eslint-config/    # @dorkos/eslint-config — Shared ESLint presets
│   └── test-utils/       # Mock factories, test helpers
├── turbo.json
├── vitest.config.ts
└── package.json
```

**Key distinction:** `packages/shared` is monorepo-level infrastructure (Transport interface, Zod schemas). `apps/client/src/layers/shared/` is client-level FSD shared layer (UI primitives, utilities).

## Client FSD Structure (`apps/client/src/`)

```
src/
├── AppShell.tsx         # Standalone shell (sidebar, header, Outlet) — layout route component
├── router.tsx           # TanStack Router route tree: /, /activity, /team, /session, /tasks,
│                        #   /channels, /workspaces, /connections, /marketplace(/sources), /feedback-requests
├── main.tsx             # Vite entry point — RouterProvider; also mounts dev/ on /dev/* (DEV only, unrouted)
├── index.css            # Global styles
├── app/                 # App-level bootstrap: boot/error/unreachable screens, init-extensions,
│                        #   Electron glue (use-electron-*), room document-title + revocation watchers
├── dev/                 # Dev Playground — component showcases, mock factories (import.meta.env.DEV only)
├── layers/              # FSD architecture layers
│   ├── shared/          # Reusable utilities, UI primitives, hooks & stores
│   │   ├── ui/          # Shadcn components (button, card, dialog, etc.)
│   │   ├── model/       # TransportContext, extension-registry, hooks (useTheme, useIsMobile, etc.)
│   │   │   └── app-store/   # Zustand app store — panels, canvas, preferences, types
│   │   ├── lib/         # cn(), Transports, font-config, favicon-utils, celebrations, ui-action-dispatcher
│   │   └── config/      # home-surface tab table, home-tabs, tour-anchors
│   ├── entities/        # Business domain objects (~29 slices; highlights below)
│   │   ├── session/     # Session types, hooks, transport calls
│   │   │   ├── ui/
│   │   │   ├── model/
│   │   │   ├── api/
│   │   │   └── index.ts
│   │   ├── command/     # Command types, hooks
│   │   │   ├── model/
│   │   │   ├── api/
│   │   │   └── index.ts
│   │   ├── agent/       # Agent identity hooks (useCurrentAgent, useAgentToolStatus, etc.)
│   │   ├── room/        # Rooms/channels/DMs domain: use-room(s), reactions, threads, response mode
│   │   ├── team/        # Team roster domain hooks
│   │   ├── tasks/       # Task scheduler hooks (useSchedules, useRuns, etc.)
│   │   ├── relay/       # Relay messaging hooks (useRelayMessages, useRelayAdapters, etc.)
│   │   ├── connectors/  # Connections domain: connector management/credential/resource hooks
│   │   ├── mesh/        # Mesh discovery hooks (useRegisteredAgents, useDiscoverAgents, etc.)
│   │   ├── discovery/   # Shared discovery scan state (Zustand store + useDiscoveryScan hook)
│   │   ├── runtime/     # Runtime capabilities (useRuntimeCapabilities, useDefaultCapabilities)
│   │   ├── permissions/ # Permission mode / approval domain hooks
│   │   ├── tunnel/      # Tunnel state hooks
│   │   ├── binding/     # Adapter-agent binding hooks (useBindings, useCreateBinding, etc.)
│   │   └── marketplace/ # Marketplace hooks (useMarketplacePackages, useInstallPackage, etc.)
│   ├── features/        # Complete user-facing functionality (~60 slices; highlights below)
│   │   ├── chat/        # A session's model: useChatSession, streaming, message parts
│   │   │   ├── ui/
│   │   │   │   ├── input/    # QueuePanel, StopConfirmDialog, AnimatedPlaceholder
│   │   │   │   ├── message/  # AssistantMessageContent, StreamingText, ThinkingBlock, SubagentBlock
│   │   │   │   ├── status/   # ChatStatusSection, AgentIdentityChip, terminal-reason chip
│   │   │   │   ├── tasks/    # TaskListPanel, TaskDetail, AgentRunner, BackgroundTaskBar
│   │   │   │   └── tools/    # ToolCallCard (the prompts live in features/ask)
│   │   │   ├── model/
│   │   │   │   └── stream/   # StreamManager, stream-event-handler, classify-transport-error
│   │   │   ├── api/
│   │   │   └── index.ts
│   │   ├── composer/    # The one message box — Composer.Root/.Input/.OverlayLane/.Attachments/.ClearArmedHint, composed by chat, rooms, and the dashboard
│   │   │   └── ui/field/ # The two fields behind one ComposerFieldProps (DOR-948) — see below
│   │   ├── command-palette/ # Global Cmd+K palette (Fuse.js search, agent preview, sub-menus)
│   │   ├── slash-commands/ # Inline slash command palette (chat input)
│   │   ├── room-management/ # Room panel: roster, limits, create/rename/leave, agent picker
│   │   ├── connections/ # Connections page — connect flows, access review, agent requests, notifications
│   │   ├── permissions/ # Permission-mode UI (consent doors, decision surfaces)
│   │   ├── session-list/ # SessionsView and session lists
│   │   ├── dashboard-sidebar/ # DashboardSidebar — navigation + recent agents list at /
│   │   ├── dashboard-attention/ # Attention rows + detail sheets — what the triage header composes
│   │   ├── dashboard-activity/ # useDashboardActivity — time-grouped recent activity, read by Pulse
│   │   ├── settings/    # SettingsDialog (Appearance, Preferences, Server, Tools, Advanced)
│   │   ├── agent-settings/ # Agent config tabs (IntegrationsTab, ToolsTab), ConventionFileEditor, MCP server cards
│   │   ├── files/       # FileBrowser
│   │   ├── tasks/        # TasksPanel, ScheduleRow, CronVisualBuilder, AgentCombobox
│   │   ├── relay/       # RelayPanel, ActivityFeed, AdapterCard, AdapterSetupWizard
│   │   │   └── ui/adapter/  # AdapterCard, AdapterCardHeader, AdapterCardBindings, AdapterIcon
│   │   ├── mesh/        # MeshPanel, TopologyGraph, AgentNode, BindingDialog
│   │   ├── onboarding/  # OnboardingFlow, AgentDiscoveryStep, TaskPresetsStep
│   │   ├── canvas/      # CanvasViews — the Canvas and Browser right-panel tabs over one document store
│   │   ├── terminal/    # In-app terminal panel
│   │   ├── notifications/ # Notification center UI
│   │   ├── marketplace/ # Marketplace UI — Marketplace, PackageCard, PackageDetailSheet, InstallConfirmationDialog, etc.
│   │   └── status/      # StatusLine, GitStatusItem, ModelItem
│   └── widgets/         # Large UI compositions (~19 slices; highlights below)
│       ├── app-layout/  # Header, Layout, main workspace
│       │   ├── ui/
│       │   └── index.ts
│       ├── activity/    # ActivityPage (/activity) — feed, week summary, "From your extensions"
│       │   ├── lib/
│       │   ├── model/
│       │   ├── ui/
│       │   └── index.ts
│       ├── home/        # HomeSurfaceLayout + PinnedTriageHeader — the chrome over /, /activity, /tasks, /workspaces (their shared tab strip rides in widgets/one-bar)
│       │   ├── lib/     #   forward-look.ts, starter-chips.ts (the tab table lives in shared/config now)
│       │   ├── ui/
│       │   └── index.ts
│       ├── room-view/   # The #team room and every channel/DM surface — entries, composer dock, thread pane
│       │   ├── ui/
│       │   ├── model/
│       │   ├── lib/
│       │   └── index.ts
│       ├── control-center/ # Control Center — the consent/autonomy dashboard
│       │   ├── ui/
│       │   ├── model/
│       │   └── index.ts
│       ├── connections/ # ConnectionsPage (/connections)
│       │   ├── ui/
│       │   └── index.ts
│       ├── team/        # TeamPage (/team) — agent roster
│       │   ├── ui/
│       │   └── index.ts
│       ├── tasks/       # TasksPage (/tasks)
│       │   ├── ui/
│       │   └── index.ts
│       ├── marketplace/ # MarketplacePage (/marketplace), MarketplaceSourcesPage (/marketplace/sources)
│       │   ├── ui/
│       │   └── index.ts
│       └── session/     # SessionPage — agent chat wrapper at /session
│           ├── ui/
│           └── index.ts
```

`TransportContext` lives at `layers/shared/model/TransportContext.tsx` — there is no separate `contexts/` directory.

### `features/composer/ui/field/` — the two fields

The composer renders one of two fields behind a single `ComposerFieldProps`, chosen by the
`richText` prop (`ui.composer.richText`, DOR-948). Everything here is INTERNAL to the slice —
none of it is in `features/composer/index.ts`, which exports components and types only.

| Module                    | Owns                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ComposerFieldProps.ts`   | The one interface both fields satisfy — value, handlers, the palette a11y quartet, and `onSurfaceChange`                                   |
| `TextareaField.tsx`       | The plain `<textarea>`, exactly as it shipped, plus `useTextareaResize`                                                                    |
| `LexicalField.tsx`        | The rich field and the lazy chunk root — editor config, plugins, and the a11y attributes the e2e page objects and the feed navigation read |
| `lexical-nodes.ts`        | `MentionNode` (a token `TextNode` drawing the real identity pill) and `COMPOSER_NODES`, the closed registered set                          |
| `lexical-transformers.ts` | `COMPOSER_TRANSFORMERS` — the closed markdown set, built by naming transformers rather than spreading, plus ⌘B / ⌘I                        |
| `markdown-offsets.ts`     | Serialization and the offset map in ONE walk; the fixed-point invariant the controlled loop depends on                                     |
| `use-lexical-value.ts`    | The controlled-value boundary: the emitted-value latch, the selection-only fast path, and the text-then-cursor emission order              |
| `lexical-surface.ts`      | The `EditingSurface` adapter for Lexical — the second implementation of the port the ladder talks to                                       |
| `use-ladder-commands.ts`  | The keyboard ladder registered at `COMMAND_PRIORITY_CRITICAL`, including the list rows                                                     |
| `use-mention-nodes.ts`    | Promoting typed `@handle` text to `MentionNode`s when the handle is in the roster                                                          |
| `use-paste-precedence.ts` | Who owns a paste or a drop, so file attach and file-tree path drops still reach the host                                                   |

The port itself (`editing-surface.ts`) and the textarea adapter (`textarea-surface.ts`) sit one
level up in `features/composer/ui/`, because the ladder uses them whichever field is mounted.

## FSD Layer Hierarchy

Unidirectional dependencies from top to bottom:

```
app → widgets → features → entities → shared
```

| Layer       | Purpose                                                | Can Import From            |
| ----------- | ------------------------------------------------------ | -------------------------- |
| `app/`      | AppShell.tsx, router.tsx, main.tsx, init-extensions.ts | All lower layers           |
| `widgets/`  | Large compositions (layout, workspace)                 | features, entities, shared |
| `features/` | Complete user functionality (chat, commands)           | entities, shared           |
| `entities/` | Business domain objects (Session, Command)             | shared only                |
| `shared/`   | UI primitives, utilities, Transport                    | Nothing (base layer)       |

**Critical rules:**

- Higher layers import from lower layers only
- Never import upward (entities cannot import features)
- Never import across same-level modules (feature A cannot import feature B)
- Compose cross-feature interactions at the widget or app level

## Standard Segments

Each FSD module uses these directories by purpose:

```
[layer]/[module-name]/
├── ui/          # React components (.tsx)
├── model/       # Business logic, hooks, stores, types (.ts)
├── api/         # Transport calls, data fetching (.ts)
├── lib/         # Pure utilities, helpers (.ts)
├── config/      # Constants, configuration (.ts)
├── __tests__/   # Tests (co-located)
└── index.ts     # Public API exports (REQUIRED)
```

Not all segments are needed — create only what the module requires.

## Public API via index.ts

Every module MUST have an `index.ts` that exports its public API. Other layers import from this file only.

```typescript
// entities/session/index.ts
export { SessionBadge } from './ui/SessionBadge';
export { useSession, useSessions } from './model/hooks';
export type { Session, SessionMetadata } from './model/types';

// DON'T export internals
// export { parseTranscript } from './lib/transcript-parser'  // Keep internal
```

```typescript
// Consumer imports from index
import { SessionBadge, useSession } from '@/layers/entities/session';

// NEVER import internal paths
import { SessionBadge } from '@/layers/entities/session/ui/SessionBadge'; // WRONG
```

## Adding a New Feature

1. **Create directory structure:**

   ```bash
   mkdir -p apps/client/src/layers/features/my-feature/{ui,model,api}
   touch apps/client/src/layers/features/my-feature/index.ts
   ```

2. **Add types** in `model/types.ts`:

   ```typescript
   export interface MyFeatureState {
     isActive: boolean;
     data: SomeEntity[];
   }
   ```

3. **Add hooks** in `model/`:

   ```typescript
   // model/use-my-feature.ts
   import { useTransport } from '@/layers/shared/model';
   import type { Session } from '@/layers/entities/session';
   ```

4. **Build UI** in `ui/`:

   ```typescript
   // ui/MyFeature.tsx
   import { Button } from '@/layers/shared/ui';
   import { useSession } from '@/layers/entities/session';
   import { useMyFeature } from '../model/use-my-feature';
   ```

5. **Export public API** in `index.ts`:

   ```typescript
   export { MyFeature } from './ui/MyFeature';
   export { useMyFeature } from './model/use-my-feature';
   ```

6. **Use in widget or app:**
   ```typescript
   // widgets/app-layout/ui/Layout.tsx
   import { MyFeature } from '@/layers/features/my-feature';
   ```

## Adding a New Entity

1. **Create directory:**

   ```bash
   mkdir -p apps/client/src/layers/entities/my-entity/{ui,model,api}
   touch apps/client/src/layers/entities/my-entity/index.ts
   ```

2. **Define types** (typically mirrors `@dorkos/shared` schemas):

   ```typescript
   // model/types.ts
   import type { Session } from '@dorkos/shared/types';
   export type { Session }; // Re-export for layer consumers
   ```

3. **Add data access** via Transport:

   ```typescript
   // api/queries.ts
   import { useTransport } from '@/layers/shared/model';

   export function useSessionQuery(id: string) {
     const transport = useTransport();
     // TanStack Query integration
   }
   ```

4. **Export public API.**

## Server Structure (`apps/server/src/`)

The server uses flat routes + domain-grouped services (not FSD layers):

```
apps/server/src/
├── app.ts           # Express app configuration
├── index.ts         # Server entry point
├── env.ts           # Zod-validated environment config
├── harness-boot.ts  # Projects skills/hooks/commands into every agent harness at startup
├── routes/          # HTTP endpoint handlers (thin, delegate to services) — 70+ files, one
│   │                #   per resource or sub-resource; representative ones:
│   ├── sessions.ts
│   ├── rooms.ts
│   ├── commands.ts
│   ├── health.ts
│   ├── directory.ts
│   ├── config.ts
│   ├── files.ts
│   ├── git.ts
│   ├── tunnel.ts
│   ├── relay.ts
│   ├── mesh.ts
│   ├── agents.ts
│   ├── models.ts
│   ├── capabilities.ts
│   ├── connector-management.ts
│   ├── marketplace.ts
│   ├── tasks.ts
│   ├── search.ts
│   ├── permissions.ts
│   └── admin.ts
├── services/        # One directory per domain — a complete census (alphabetical): activity,
│   │                #   canvas, communities, connectors, core, core-extensions, diff, extensions,
│   │                #   harness, identity, marketplace, marketplace-mcp, mcp-apps, memory, mesh,
│   │                #   notifications, observability, relay, rooms, runtimes, search, session,
│   │                #   shapes, tasks, terminal, workbench-serve, workspace (AGENTS.md keeps the
│   │                #   census current; this tree expands the domains with the deepest nesting)
│   ├── core/                    # Shared infrastructure services
│   │   ├── runtime-registry.ts  # Registry of AgentRuntime instances (keyed by type, per-session binding)
│   │   ├── config-manager.ts    # Persistent user config (~/.dork/config.json)
│   │   ├── openapi-registry.ts  # Auto-generated OpenAPI spec from Zod schemas
│   │   ├── streams/             # SSE plumbing (stream-adapter, stream-socket, durable-stream-sink)
│   │   ├── approvals/           # Approval service, expiry sweep, decision authority
│   │   ├── capabilities/        # Capability defs, MCP/OpenAPI projection, permission enforcement
│   │   ├── cloud/               # DorkOS Cloud client (credits-inference, hosted-communities, plan)
│   │   ├── agent-identity/, auth/, external-mcp/, operator/, permissions/, safe-defaults/,
│   │   │   unattended-autonomy/, usage/   # Narrower core sub-domains, one folder each
│   │   ├── file-lister.ts       # Directory file listing
│   │   ├── git-status.ts        # Git status/branch info
│   │   ├── tunnel-manager.ts    # ngrok tunnel lifecycle
│   │   └── update-checker.ts    # npm registry version check (1-hour cache)
│   ├── runtimes/                # Agent backend implementations — every runtime passes the
│   │   │                        #   shared runtimeConformance suite (contributing/adding-a-runtime.md)
│   │   ├── claude-code/         # ClaudeCodeRuntime — the default backend
│   │   │   ├── claude-code-runtime.ts  # Implements AgentRuntime interface (composition root)
│   │   │   ├── agent-types.ts          # AgentSession, ToolState interfaces (shared across subdirs)
│   │   │   ├── messaging/              # Send-message pipeline: message-sender, context-builder,
│   │   │   │                           #   interactive-handlers, plugin-activation, runtime-cache
│   │   │   ├── sdk/                    # SDK message ↔ StreamEvent mapping: sdk-event-mapper,
│   │   │   │                           #   event-mappers/, sdk-error-mapping, turn-usage
│   │   │   ├── sessions/               # Transcript/session reading + sync: transcript-reader,
│   │   │   │                           #   session-pump, session-store, warm-process-ledger
│   │   │   ├── tooling/                # check-dependency, command-registry, claude-cli-auth
│   │   │   ├── accounts/               # Multi-account switching
│   │   │   └── mcp-tools/              # In-process MCP tool server for Claude Agent SDK
│   │   ├── codex/                # CodexRuntime — SDK threads (ADR-0309)
│   │   ├── opencode/             # OpencodeRuntime — managed sidecar (ADR-0308)
│   │   ├── connect/              # Runtime credentials / delegated login
│   │   ├── connectors/, connector-mcp/ # Connector-backed MCP bridging shared across runtimes
│   │   ├── shared/                # Cross-runtime helpers used by the conformance suite
│   │   └── test-mode/             # FakeAgentRuntime backend for e2e
│   ├── rooms/                    # Channels, DMs and threads (spec `rooms`)
│   │   ├── room-service.ts      # The domain's front door — delegates to the folders below (DOR-1697)
│   │   ├── manage/               # A room, its people and its turns: open, patch, bridge, roster, halt
│   │   ├── messages/             # Posting, reads, search, reactions
│   │   ├── attachments/          # Files posted with a message — rows, bytes, projected paths
│   │   ├── canvas/, moments/, follow/, response-gate/ # Room canvas, highlights rail, follow state,
│   │   │                                              #   the reply-limit ladder (room-turn overhaul)
│   │   └── session-bindings/     # Session ↔ room binding
│   ├── communities/               # CommunityAdapter backends: local/ (this machine's SQLite rooms,
│   │   │                          #   registered LOCAL_COMMUNITY) + remote-community aggregation
│   ├── connectors/                # Connections: connector accounts, agent-access requests/cleanup
│   ├── marketplace/               # Package install/uninstall/update pipeline
│   │   ├── marketplace-installer.ts  # Orchestrator, dispatches per-kind flows
│   │   ├── marketplace-cache.ts      # Content-addressable cache (TTL, prune, listPackages)
│   │   ├── package-fetcher.ts        # marketplace.json fetch + package clone
│   │   ├── transaction.ts            # Atomic transaction engine (backup/rollback)
│   │   └── flows/                    # Per-kind install flows (plugin, agent, skill-pack, adapter)
│   ├── marketplace-mcp/           # The 9 marketplace MCP tools + personal-marketplace recommend engine
│   ├── tasks/                    # Task scheduler services
│   │   ├── task-scheduler-service.ts # Cron engine (croner) with overrun protection
│   │   ├── task-store.ts             # SQLite + JSON schedule/run state
│   │   └── execution/, lifecycle/, session/, sync/, timing/, approvals/ # Per-concern subfolders
│   ├── relay/                    # Relay messaging services (adapter-manager, binding-router, trace-store)
│   ├── mesh/                     # Agent discovery + MCP sign-in/OAuth (delegates to @dorkos/mesh's
│   │   │                         #   unified-scanner for filesystem scanning; Mesh is always-on)
│   ├── memory/                   # MemoryProvider capabilities and provider registry
│   ├── search/                   # FTS5 message search index (indexer, jsonl-frontier, per-runtime discovery)
│   ├── session/                  # Session aggregation, activity, asks, attachments, browser-seat
│   ├── identity/                 # Avatars, display names, operator profile, team aggregation
│   ├── notifications/            # Notification center (channels/, emitters/, escalation-service)
│   ├── activity/, canvas/, diff/, extensions/, harness/, mcp-apps/, observability/, shapes/,
│   │   terminal/, workbench-serve/, workspace/  # One folder each; browse for per-domain detail
│   └── core-extensions/          # Toggleable first-party extensions staged at server startup
│       └── ensure-core-extensions.ts # Stages every core extension on startup
├── lib/             # Shared utilities
│   ├── resolve-root.ts  # DEFAULT_CWD (prefers DORKOS_DEFAULT_CWD, falls back to repo root)
│   ├── boundary.ts      # Directory boundary validation (403 for out-of-boundary paths)
│   ├── dork-home.ts     # resolveDorkHome() — single source of truth for data directory
│   ├── agents-home.ts   # Mirrors another harness's home-dir resolution (Hard Rule 3 carve-out)
│   └── feature-flag.ts  # Generic feature flag helpers
└── middleware/       # mcp-auth (fail-closed), host-guard, rate limiting, agent-execution-gate, error-handler
```

Routes are thin HTTP handlers — they delegate to services. Routes resolve a session's runtime via `runtimeRegistry` (per-session binding, first-write-wins, ADR-0255), never referencing `ClaudeCodeRuntime` directly.

## Import Patterns

```typescript
// FSD layer imports (within apps/client)
import { ChatPanel } from '@/layers/features/chat';
import { useSession } from '@/layers/entities/session';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib/utils';

// Cross-package imports (monorepo level — always allowed)
import type { Session, StreamEvent } from '@dorkos/shared/types';
import { SessionSchema } from '@dorkos/shared/schemas';
```

## File Naming

| Type             | Convention                  | Example                             |
| ---------------- | --------------------------- | ----------------------------------- |
| React components | PascalCase                  | `ChatPanel.tsx`, `SessionBadge.tsx` |
| Hooks            | `use-` prefix, kebab-case   | `use-chat-session.ts`               |
| Stores           | `-store` suffix, kebab-case | `app-store.ts`                      |
| Types            | `types.ts` in `model/`      | `entities/session/model/types.ts`   |
| Utilities        | kebab-case                  | `stream-parser.ts`                  |
| Index            | `index.ts`                  | Public API barrel export            |

`layers/shared/ui/` is the exception: files are kebab-case regardless of
shadcn-vs-custom origin (`button.tsx`, `mention-pill.tsx`, `trust-dial.tsx`).
See `.claude/rules/components.md` for the full rule, including its own named
exceptions.

## Anti-Patterns

```typescript
// NEVER import upward in layer hierarchy
// In entities/session/model/hooks.ts
import { ChatPanel } from '@/layers/features/chat'; // features is higher!

// NEVER import across same-level modules
// In features/chat/ui/ChatPanel.tsx
import { SlashCommandList } from '@/layers/features/slash-commands'; // Cross-feature!
// FIX: Compose both in widgets/app-layout/

// NEVER import from internal paths
import { Button } from '@/layers/shared/ui/button'; // WRONG
import { Button } from '@/layers/shared/ui'; // CORRECT (from index)

// NEVER put business logic in shared/
// shared/lib/session-utils.ts → WRONG
// entities/session/model/helpers.ts → CORRECT
```

## Transport & FSD Integration

The hexagonal Transport interface bridges FSD and the monorepo:

```
packages/shared/src/transport.ts → Transport interface (port)
layers/shared/lib/transport/    → HttpTransport (HTTP implementation)
layers/shared/model/            → TransportContext (React DI), app-store, hooks
layers/entities/*/api/          → Transport consumption (queries/mutations)
layers/features/*/model/        → Hooks composing entity data
```

## Troubleshooting

### "Cannot find module '@/layers/...'"

Verify `tsconfig.json` has `"@/*": ["./src/*"]` path alias and `vite.config.ts` has matching resolve alias.

### Circular dependency detected

Usually indicates wrong layer placement. Check for upward imports or cross-module imports at the same level.

### "Where does this code go?"

Use the layer decision tree in the `organizing-fsd-architecture` skill.

## References

- [Feature-Sliced Design Documentation](https://feature-sliced.design/)
- `contributing/architecture.md` — Hexagonal architecture, Transport interface
- `.claude/skills/organizing-fsd-architecture/` — Layer placement skill
