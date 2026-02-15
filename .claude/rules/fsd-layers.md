---
paths: apps/client/src/layers/**/*.ts, apps/client/src/layers/**/*.tsx
---

# FSD Layer Rules

These rules apply to all code within the FSD layer hierarchy in `apps/client/src/layers/`.

## Layer Dependency Rules

The FSD hierarchy enforces strict unidirectional imports:

```
app → widgets → features → entities → shared
```

### What This File Can Import

Determine the current file's layer from its path, then enforce:

| If editing in... | Can import from... | CANNOT import from... |
|------------------|--------------------|-----------------------|
| `layers/shared/` | Nothing in layers/ (base layer) | entities, features, widgets |
| `layers/entities/` | `layers/shared/` only | features, widgets |
| `layers/features/` | `layers/entities/`, `layers/shared/` | widgets, other features |
| `layers/widgets/` | `layers/features/`, `layers/entities/`, `layers/shared/` | other widgets |

### Cross-Module Rule

Modules at the **same layer level** have restricted cross-imports:

**UI composition across features: ALLOWED.** A feature's UI component may render a sibling feature's component for composition purposes (e.g., ChatPanel renders CommandPalette, StatusLine).

**Model/hook cross-imports: FORBIDDEN.** A feature's model/hooks must never import from another feature's model/hooks. This prevents circular business logic dependencies.

```typescript
// ALLOWED: UI composition (feature renders sibling component)
// In features/chat/ui/ChatPanel.tsx
import { CommandPalette } from '@/layers/features/commands'
import { StatusLine } from '@/layers/features/status'

// FORBIDDEN: Model/hook cross-import (business logic coupling)
// In features/chat/model/use-chat-session.ts
import { useFiles } from '@/layers/features/files'  // WRONG — lift to entities or shared

// FORBIDDEN: Entity importing sibling entity
// In entities/session/model/hooks.ts
import { useCommands } from '@/layers/entities/command'  // WRONG
```

## Import Conventions

### Always Use Path Alias

```typescript
// CORRECT
import { Button } from '@/layers/shared/ui'
import { useSession } from '@/layers/entities/session'

// WRONG — relative imports across layers
import { Button } from '../../../shared/ui/button'
```

### Always Import from index.ts

```typescript
// CORRECT — from module's public API
import { SessionBadge, useSession } from '@/layers/entities/session'

// WRONG — from internal path
import { SessionBadge } from '@/layers/entities/session/ui/SessionBadge'
```

### Cross-Package Imports Are Fine

```typescript
// These are NOT layer violations — they come from monorepo packages
import type { Session } from '@dorkos/shared/types'
import { createMockTransport } from '@dorkos/test-utils'
```

## Segment Structure

Each module should organize code by purpose:

```
[module-name]/
├── ui/          # React components (.tsx)
├── model/       # Hooks, stores, types, business logic (.ts)
├── api/         # Transport calls, data fetching (.ts)
├── lib/         # Pure utilities, helpers (.ts)
├── config/      # Constants (.ts)
├── __tests__/   # Tests (co-located)
└── index.ts     # Public API exports
```

Not all segments are required — only create what the module needs.

## Server Size Monitoring

See `.claude/rules/server-structure.md` for service count thresholds and domain grouping guidance.
