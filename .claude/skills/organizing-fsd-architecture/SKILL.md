---
name: organizing-fsd-architecture
description: Guides organization of code using Feature-Sliced Design (FSD) architecture. Use when structuring projects, creating new features, determining file and layer placement, or reviewing architectural decisions. Also monitors codebase size and proactively suggests structural improvements.
---

# Organizing FSD Architecture

## Overview

This skill provides expertise for implementing Feature-Sliced Design (FSD) in the DorkOS monorepo. FSD organizes code by business domains with clear layer boundaries and unidirectional dependency rules.

## When to Use

- Creating new features, widgets, or entities in `apps/client`
- Deciding where code should live (which layer/segment)
- Reviewing imports for layer violations
- Refactoring components into FSD structure
- Adding new services to `apps/server` (size-aware guidance)

## Layer Hierarchy

FSD uses strict top-to-bottom dependency flow within `apps/client/src/layers/`:

```
app → widgets → features → entities → shared
```

| Layer | Purpose | Can Import From |
|-------|---------|-----------------|
| `app/` | App initialization (`App.tsx`, `main.tsx`, providers) | All lower layers |
| `widgets/` | Large UI compositions (app layout, sidebars) | features, entities, shared |
| `features/` | Complete user-facing functionality (chat, commands) | entities, shared |
| `entities/` | Business domain objects (Session, Command) | shared only |
| `shared/` | Reusable utilities, UI primitives, Transport | Nothing (base layer) |

### Dependency Rules (Critical)

```
ALLOWED: Higher layer imports from lower layer
  features/chat/ui/ChatPanel.tsx → entities/session/model/types.ts
  widgets/app-layout/ui/Layout.tsx → features/chat/ui/ChatPanel.tsx

FORBIDDEN: Lower layer imports from higher layer
  entities/session/model/hooks.ts → features/chat/model/use-chat.ts
  shared/ui/Button.tsx → entities/session/ui/SessionBadge.tsx

FORBIDDEN: Same-level cross-imports (usually)
  features/chat/ → features/commands/
  entities/session/ → entities/command/
```

### Standard Segments

Each layer's modules follow this internal structure:

```
[layer]/[module-name]/
├── ui/          # React components
├── model/       # Business logic, hooks, stores, types
├── api/         # Transport calls, data fetching
├── lib/         # Pure utilities, helpers
├── config/      # Constants, configuration
└── index.ts     # Public API exports (barrel)
```

## Step-by-Step: Determine the Correct Layer

```
Is it a reusable utility, UI primitive (Button, Card), or type?
└─ YES → shared/

Is it a core business entity (Session, Command, StreamEvent)?
└─ YES → entities/[entity-name]/

Is it a complete user-facing feature (chat, command palette, settings)?
└─ YES → features/[feature-name]/

Is it a large composition of multiple features (app layout, main workspace)?
└─ YES → widgets/[widget-name]/

Is it app initialization, providers, or entry point?
└─ YES → app/ (App.tsx, main.tsx level)
```

## DorkOS-Specific Layer Mapping

### Client (`apps/client/src/layers/`)

| Module | Layer | Contents |
|--------|-------|----------|
| `shared/ui/` | shared | Shadcn components (button, card, dialog, etc.) |
| `shared/model/` | shared | TransportContext, app-store, 8 hooks (useTheme, useIsMobile, etc.) |
| `shared/lib/` | shared | cn(), Transports, font-config, favicon-utils, celebrations |
| `entities/session/` | entities | Session types, useSessions hook, session transport calls |
| `entities/command/` | entities | Command types, useCommands hook |
| `features/chat/` | features | ChatPanel, MessageList, MessageItem, ToolCallCard, StreamingText, useChatSession |
| `features/commands/` | features | CommandPalette |
| `features/settings/` | features | SettingsDialog |
| `features/files/` | features | FilePalette, useFiles |
| `features/session-list/` | features | SessionSidebar, SessionItem, DirectoryPicker |
| `widgets/app-layout/` | widgets | PermissionBanner |

### Server (`apps/server/src/`)

The server uses flat `routes/` + `services/` structure (not strict FSD layers). See "Server Size Awareness" below for when to restructure.

## Public API via index.ts (Required)

Every module MUST export its public API through `index.ts`:

```typescript
// features/chat/index.ts
export { ChatPanel } from './ui/ChatPanel'
export { useChatSession } from './model/use-chat-session'
export type { ChatMessage } from './model/types'

// DON'T export internal implementations
// export { parseStreamEvent } from './lib/stream-parser'  // Keep internal
```

Import from index, never from internal paths:

```typescript
// CORRECT: Import from module's public API
import { ChatPanel, useChatSession } from '@/layers/features/chat'

// WRONG: Import from internal path
import { ChatPanel } from '@/layers/features/chat/ui/ChatPanel'
```

## Cross-Feature Communication

**UI composition across features is allowed.** A feature's UI component may render a sibling feature's component (e.g., ChatPanel renders CommandPalette). **Model/hook cross-imports are forbidden** — this prevents circular business logic dependencies.

When features need to share data or logic:

```typescript
// Option 1: UI composition (ALLOWED)
// features/chat/ui/ChatPanel.tsx renders features/commands CommandPalette
import { CommandPalette } from '@/layers/features/commands'

// Option 2: Lift shared logic to entities layer
// entities/session/model/use-current-session.ts (shared across features)

// Option 3: Use Zustand store in shared layer for truly global UI state
// shared/model/app-store.ts (e.g., sidebar open/closed)

// FORBIDDEN: Model/hook importing from sibling feature
// features/chat/model/use-chat-session.ts → features/files/model/use-files.ts
```

## Server Size Awareness

The server currently uses flat `routes/` + `services/`. This is appropriate at the current size. Monitor these thresholds:

### When to Suggest Domain Grouping

**Proactively suggest restructuring when ANY of these are true:**

- `apps/server/src/services/` has **15+ service files**
- A single domain (e.g., session-related) has **4+ service files**
- New service is being added and the developer asks "where does this go?"
- Two services have circular or unclear dependencies

**Suggested transition:**
```
services/           →  domains/
├── agent-manager   →  ├── agent/
├── transcript-     →  │   └── agent-manager.ts
│   reader          →  ├── session/
├── session-        →  │   ├── transcript-reader.ts
│   broadcaster     →  │   ├── session-broadcaster.ts
├── command-        →  │   └── stream-adapter.ts
│   registry        →  ├── commands/
├── stream-adapter  →  │   └── command-registry.ts
├── openapi-        →  └── shared/
│   registry        →      ├── openapi-registry.ts
├── file-lister     →      ├── file-lister.ts
├── git-status      →      ├── git-status.ts
├── tunnel-manager  →      └── tunnel-manager.ts
```

**When suggesting, say:**
> "The server now has [N] services. The FSD architecture guide recommends domain grouping at 15+ services. Would you like to restructure into domain directories?"

## Detecting Layer Violations

```bash
# Find features importing from other features
grep -r "from '@/layers/features/" apps/client/src/layers/features/ --include="*.ts" --include="*.tsx" | grep -v "__tests__"

# Find entities importing from features (should be 0)
grep -r "from '@/layers/features/" apps/client/src/layers/entities/ --include="*.ts"

# Find shared importing from anywhere except shared
grep -r "from '@/layers/" apps/client/src/layers/shared/ --include="*.ts" | grep -v "from '@/layers/shared"
```

## Common Pitfalls

- **Putting everything in shared/**: Only truly reusable, domain-agnostic code belongs in shared
- **Feature-to-feature imports**: Features must not import from each other; lift shared logic to entities
- **Giant features**: If a feature has 20+ files, split into multiple features or extract entities
- **Skipping index.ts**: Every module needs a public API barrel export
- **Transport in wrong layer**: Transport interface lives in `packages/shared`, Transport implementations in `shared/lib/`, TransportContext in `shared/model/`

## References

- `guides/01-project-structure.md` — Full FSD patterns, directory layout, adding features
- `guides/architecture.md` — Hexagonal architecture, Transport interface
