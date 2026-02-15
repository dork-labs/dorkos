# Project Structure Guide

## Overview

DorkOS uses Feature-Sliced Design (FSD) to organize frontend code by business domains with clear layer boundaries. The server uses a layered architecture (routes + services) with size-aware guidance for when to adopt domain grouping. The monorepo structure (Turborepo + npm workspaces) is orthogonal to FSD — FSD applies *within* each app.

## Monorepo Layout

```
dorkos/
├── apps/
│   ├── client/           # @dorkos/client — React 19 SPA with FSD layers
│   ├── server/           # @dorkos/server — Express API (flat services)
│   └── obsidian-plugin/  # @dorkos/obsidian-plugin — Obsidian plugin
├── packages/
│   ├── cli/              # dorkos — Publishable npm CLI
│   ├── shared/           # @dorkos/shared — Zod schemas, types, Transport interface
│   ├── typescript-config/ # Shared tsconfig presets
│   └── test-utils/       # Mock factories, test helpers
├── turbo.json
├── vitest.workspace.ts
└── package.json
```

**Key distinction:** `packages/shared` is monorepo-level infrastructure (Transport interface, Zod schemas). `apps/client/src/layers/shared/` is client-level FSD shared layer (UI primitives, utilities).

## Client FSD Structure (`apps/client/src/`)

```
src/
├── App.tsx              # App entry — composes widgets, provides context
├── main.tsx             # Vite entry point
├── index.css            # Global styles
├── layers/              # FSD architecture layers
│   ├── shared/          # Reusable utilities, UI primitives, hooks & stores
│   │   ├── ui/          # Shadcn components (button, card, dialog, etc.)
│   │   ├── model/       # TransportContext, app-store, hooks (useTheme, useIsMobile, etc.)
│   │   └── lib/         # cn(), Transports, font-config, favicon-utils, celebrations
│   ├── entities/        # Business domain objects
│   │   ├── session/     # Session types, hooks, transport calls
│   │   │   ├── ui/
│   │   │   ├── model/
│   │   │   ├── api/
│   │   │   └── index.ts
│   │   └── command/     # Command types, hooks
│   │       ├── model/
│   │       ├── api/
│   │       └── index.ts
│   ├── features/        # Complete user-facing functionality
│   │   ├── chat/        # ChatPanel, MessageList, streaming, useChatSession
│   │   │   ├── ui/
│   │   │   ├── model/
│   │   │   ├── api/
│   │   │   └── index.ts
│   │   ├── commands/    # CommandPalette
│   │   ├── session-list/ # SessionSidebar
│   │   ├── settings/    # SettingsPanel
│   │   └── files/       # FileBrowser
│   └── widgets/         # Large UI compositions
│       └── app-layout/  # Header, Layout, main workspace
│           ├── ui/
│           └── index.ts
└── contexts/            # React Context (TransportProvider)
```

## FSD Layer Hierarchy

Unidirectional dependencies from top to bottom:

```
app → widgets → features → entities → shared
```

| Layer | Purpose | Can Import From |
|-------|---------|-----------------|
| `app/` | App.tsx, main.tsx, providers | All lower layers |
| `widgets/` | Large compositions (layout, workspace) | features, entities, shared |
| `features/` | Complete user functionality (chat, commands) | entities, shared |
| `entities/` | Business domain objects (Session, Command) | shared only |
| `shared/` | UI primitives, utilities, Transport | Nothing (base layer) |

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
export { SessionBadge } from './ui/SessionBadge'
export { useSession, useSessions } from './model/hooks'
export type { Session, SessionMetadata } from './model/types'

// DON'T export internals
// export { parseTranscript } from './lib/transcript-parser'  // Keep internal
```

```typescript
// Consumer imports from index
import { SessionBadge, useSession } from '@/layers/entities/session'

// NEVER import internal paths
import { SessionBadge } from '@/layers/entities/session/ui/SessionBadge'  // WRONG
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
     isActive: boolean
     data: SomeEntity[]
   }
   ```

3. **Add hooks** in `model/`:
   ```typescript
   // model/use-my-feature.ts
   import { useTransport } from '@/layers/shared/model'
   import type { Session } from '@/layers/entities/session'
   ```

4. **Build UI** in `ui/`:
   ```typescript
   // ui/MyFeature.tsx
   import { Button } from '@/layers/shared/ui'
   import { useSession } from '@/layers/entities/session'
   import { useMyFeature } from '../model/use-my-feature'
   ```

5. **Export public API** in `index.ts`:
   ```typescript
   export { MyFeature } from './ui/MyFeature'
   export { useMyFeature } from './model/use-my-feature'
   ```

6. **Use in widget or app:**
   ```typescript
   // widgets/app-layout/ui/Layout.tsx
   import { MyFeature } from '@/layers/features/my-feature'
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
   import type { Session } from '@dorkos/shared/types'
   export type { Session }  // Re-export for layer consumers
   ```

3. **Add data access** via Transport:
   ```typescript
   // api/queries.ts
   import { useTransport } from '@/layers/shared/model'

   export function useSessionQuery(id: string) {
     const transport = useTransport()
     // TanStack Query integration
   }
   ```

4. **Export public API.**

## Server Structure (`apps/server/src/`)

The server uses flat routes + services (not FSD layers):

```
apps/server/src/
├── app.ts           # Express app configuration
├── index.ts         # Server entry point
├── routes/          # HTTP endpoint handlers (thin, delegate to services)
│   ├── sessions.ts
│   ├── commands.ts
│   ├── health.ts
│   ├── directory.ts
│   ├── config.ts
│   ├── files.ts
│   └── git.ts
├── services/        # Business logic
│   ├── agent-manager.ts
│   ├── transcript-reader.ts
│   ├── session-broadcaster.ts
│   ├── stream-adapter.ts
│   ├── command-registry.ts
│   ├── openapi-registry.ts
│   ├── file-lister.ts
│   ├── git-status.ts
│   └── tunnel-manager.ts
└── middleware/
```

### Server Size Thresholds

When `services/` grows beyond **15 files**, transition to domain grouping:

```
domains/
├── session/           # transcript-reader, session-broadcaster, stream-adapter
├── agent/             # agent-manager
├── commands/          # command-registry
└── shared/            # openapi-registry, file-lister, git-status, tunnel-manager
```

Routes stay flat regardless — they're thin HTTP handlers.

## Import Patterns

```typescript
// FSD layer imports (within apps/client)
import { ChatPanel } from '@/layers/features/chat'
import { useSession } from '@/layers/entities/session'
import { Button } from '@/layers/shared/ui'
import { cn } from '@/layers/shared/lib/utils'

// Cross-package imports (monorepo level — always allowed)
import type { Session, StreamEvent } from '@dorkos/shared/types'
import { SessionSchema } from '@dorkos/shared/schemas'
```

## File Naming

| Type | Convention | Example |
|------|------------|---------|
| React components | PascalCase | `ChatPanel.tsx`, `SessionBadge.tsx` |
| Hooks | `use-` prefix, kebab-case | `use-chat-session.ts` |
| Stores | `-store` suffix, kebab-case | `app-store.ts` |
| Types | `types.ts` in `model/` | `entities/session/model/types.ts` |
| Utilities | kebab-case | `stream-parser.ts` |
| Index | `index.ts` | Public API barrel export |

## Anti-Patterns

```typescript
// NEVER import upward in layer hierarchy
// In entities/session/model/hooks.ts
import { ChatPanel } from '@/layers/features/chat'  // features is higher!

// NEVER import across same-level modules
// In features/chat/ui/ChatPanel.tsx
import { CommandPalette } from '@/layers/features/commands'  // Cross-feature!
// FIX: Compose both in widgets/app-layout/

// NEVER import from internal paths
import { Button } from '@/layers/shared/ui/button'  // WRONG
import { Button } from '@/layers/shared/ui'          // CORRECT (from index)

// NEVER put business logic in shared/
// shared/lib/session-utils.ts → WRONG
// entities/session/model/helpers.ts → CORRECT
```

## Transport & FSD Integration

The hexagonal Transport interface bridges FSD and the monorepo:

```
packages/shared/transport.ts    → Transport interface (port)
layers/shared/lib/              → HttpTransport, DirectTransport (adapters)
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
- `guides/architecture.md` — Hexagonal architecture, Transport interface
- `.claude/skills/organizing-fsd-architecture/` — Layer placement skill
