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

Modules at the **same layer level** must NOT import from each other:

```typescript
// FORBIDDEN: Feature importing another feature
// In features/chat/ui/ChatPanel.tsx
import { CommandPalette } from '@/layers/features/commands'  // WRONG

// CORRECT: Compose at widget layer
// In widgets/app-layout/ui/Layout.tsx
import { ChatPanel } from '@/layers/features/chat'
import { CommandPalette } from '@/layers/features/commands'
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

When creating or editing files in `apps/server/src/services/`:

**Count the service files.** If there are 15 or more `.ts` files in `services/`, proactively suggest domain grouping:

> "The server now has [N] service files. Consider grouping related services into domain directories (e.g., `domains/session/`, `domains/agent/`) for clearer ownership."

This is a suggestion, not a blocking rule.
