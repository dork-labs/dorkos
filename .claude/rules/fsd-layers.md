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

| If editing in...   | Can import from...                                       | CANNOT import from...       |
| ------------------ | -------------------------------------------------------- | --------------------------- |
| `layers/shared/`   | Nothing in layers/ (base layer)                          | entities, features, widgets |
| `layers/entities/` | `layers/shared/`, other entities (acyclic — see below)   | features, widgets           |
| `layers/features/` | `layers/entities/`, `layers/shared/`                     | widgets, other features     |
| `layers/widgets/`  | `layers/features/`, `layers/entities/`, `layers/shared/` | other widgets               |

### Cross-Module Rule: Features

Sibling features are isolated — but the isolation is about business logic, not composition:

**UI composition across features: ALLOWED.** A feature's UI component may render a sibling feature's component for composition purposes (e.g., ChatPanel renders CommandPalette, StatusLine).

**Model/hook cross-imports: FORBIDDEN.** A feature's model/hooks must never import from another feature's model/hooks. This prevents circular business logic dependencies.

```typescript
// ALLOWED: UI composition (feature renders sibling component)
// In features/chat/ui/ChatPanel.tsx
import { CommandPalette } from '@/layers/features/commands';
import { StatusLine } from '@/layers/features/status';

// FORBIDDEN: Model/hook cross-import (business logic coupling)
// In features/chat/model/use-chat-session.ts
import { useFiles } from '@/layers/features/files'; // WRONG — lift to entities or shared
```

### Cross-Module Rule: Entities Form a DAG

Entity slices **may** import each other. What they may never do is form a circle.

Sibling features are isolated because a feature is a screen's worth of behaviour and two of them coupling is usually an accident. Entities are the opposite: they are the shared vocabulary, and some questions are genuinely about several of them at once. `attention` answers "what needs me right now?", which is a question about sessions, agents, tasks and mesh simultaneously. Forbidding the import would not remove the coupling — it would push that hook up into a feature, where only one screen could reach it.

So the rule is direction, not isolation:

1. **Import through the barrel.** `@/layers/entities/session`, never `@/layers/entities/session/model/...`. The barrel is the slice's contract; a deep import couples you to its file layout. ESLint enforces this one too.

   The exception is `vi.mock()`, which needs the concrete module path — mocking a barrel replaces every export in it, not the one you meant to stub. So `vi.mock('@/layers/entities/session/model/use-recent-sessions')` is correct and stays. The lint rule does not see it, because `vi.mock()` is a call and not an import declaration; that is the carve-out, and it is the only one.

2. **Composites consume foundations.** A foundational slice answers one question about one thing (`runtime`, `config`, `mesh`, `relay`, `tasks`, `room`, `interactions`). A composite slice aggregates several into one normalized answer. That direction needs no defence — it is the pattern.
3. **A foundational slice reaching for another entity is the smell.** It usually means the aggregation belongs one level up, in a composite. If it really doesn't, say why in the PR — this is the case a reviewer should stop on.
4. **Never close a circle.** Not through two slices, not through five, not through a lazy `import()`.

Rule 4 is the one a reviewer cannot check by eye, so it is machine-checked: `import-x/no-cycle` runs at `error` over `src/layers/entities/**` in `apps/client/eslint.config.js`. A cycle cannot land, in this layer or inside a single slice.

The graph as it stands (2026-09) — every slice not listed imports no other entity:

| Slice       | Depends on                                               |
| ----------- | -------------------------------------------------------- |
| `session`   | `runtime`                                                |
| `tunnel`    | `config`                                                 |
| `binding`   | `config`, `mesh`, `relay`, `runtime`                     |
| `recents`   | `interactions`, `room`, `session`                        |
| `agent`     | `config`, `mesh`, `relay`, `runtime`, `session`, `tasks` |
| `attention` | `agent`, `mesh`, `session`, `tasks`                      |

The table is in dependency order: every arrow points **upward**, to an earlier row or to an unlisted foundation, and never downward. That is what makes it a DAG. Adding an upward edge is ordinary work and needs no ceremony. A **downward** edge — `session` reaching for `attention`, say — is the move that closes a circle, and the linter will say so.

```typescript
// ALLOWED: composite consumes foundation, through the barrel
// In entities/attention/model/use-attention-signals.ts
import { useResolvedAgents } from '@/layers/entities/agent';

// FORBIDDEN: deep import past the barrel
import { useResolvedAgents } from '@/layers/entities/agent/model/use-resolved-agents'; // WRONG

// FORBIDDEN: closes a cycle (agent already depends on config)
// In entities/config/model/use-config.ts
import { useAttentionSignals } from '@/layers/entities/attention'; // WRONG — lint error
```

## Import Conventions

### Always Use Path Alias

```typescript
// CORRECT
import { Button } from '@/layers/shared/ui';
import { useSession } from '@/layers/entities/session';

// WRONG — relative imports across layers
import { Button } from '../../../shared/ui/button';
```

### Always Import from index.ts

```typescript
// CORRECT — from module's public API
import { SessionBadge, useSession } from '@/layers/entities/session';

// WRONG — from internal path
import { SessionBadge } from '@/layers/entities/session/ui/SessionBadge';
```

### Cross-Package Imports Are Fine

```typescript
// These are NOT layer violations — they come from monorepo packages
import type { Session } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
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

**Note on `shared/` layer:** The `shared/` layer uses both `model/` and `lib/` segments at the top level. `shared/model/` contains hooks, stores, and React context (TransportContext, app-store, useTheme, useIsMobile, etc.). `shared/lib/` contains pure utilities, Transport implementations, and helpers (cn, font-config, favicon-utils, celebrations, etc.). Import hooks and stores from `@/layers/shared/model`, utilities from `@/layers/shared/lib`.

## Server Size Monitoring

See `.claude/rules/server-structure.md` for service count thresholds and domain grouping guidance.
