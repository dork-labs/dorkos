---
name: organizing-fsd-architecture
description: Guides organization of code using Feature-Sliced Design (FSD) architecture. Use when structuring projects, creating new features, determining file and layer placement, or reviewing architectural decisions. Also monitors codebase size and proactively suggests structural improvements.
---

# Organizing FSD Architecture

## Overview

This skill provides expertise for implementing Feature-Sliced Design (FSD) in the DorkOS monorepo. FSD organizes code by business domains with clear layer boundaries and unidirectional dependency rules.

The full layer-import matrix, cross-module rules, segment structure, and barrel/alias conventions live in `.claude/rules/fsd-layers.md` — that rule is the authority; this skill is the placement and size-monitoring guidance on top of it.

## When to Use

- Creating new features, widgets, or entities in `apps/client`
- Deciding where code should live (which layer/segment)
- Reviewing imports for layer violations
- Refactoring components into FSD structure
- Adding new services to `apps/server` (size-aware guidance)

## The Layer Spine

Strict top-to-bottom dependency flow within `apps/client/src/layers/`:

```
app → widgets → features → entities → shared
```

Higher imports lower, never the reverse; same-level model/hook cross-imports are forbidden (UI composition across features is allowed). See `.claude/rules/fsd-layers.md` for the per-layer import matrix and code examples.

## Step-by-Step: Determine the Correct Layer

```
Is it a reusable utility, UI primitive (Button, Card), or type?
└─ YES → shared/

Is it a core business entity (Session, Agent, Workspace)?
└─ YES → entities/[entity-name]/

Is it a complete user-facing feature (chat, command palette, settings)?
└─ YES → features/[feature-name]/

Is it a large composition of multiple features (app layout, dashboard)?
└─ YES → widgets/[widget-name]/

Is it app initialization, providers, or entry point?
└─ YES → the src/ root shell (App.tsx, AppShell.tsx, main.tsx, router.tsx)
```

## DorkOS-Specific Layer Mapping

Current shape of `apps/client/src/layers/` (representative, not exhaustive — `ls` the layer for ground truth):

| Layer       | Scale       | Representative modules                                                                                                           |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`   | base layer  | `ui/` (shadcn components), `model/` (TransportContext, app-store, useTheme, useIsMobile), `lib/` (cn, Transport implementations) |
| `entities/` | ~14 modules | `session`, `agent`, `command`, `marketplace`, `mesh`, `relay`, `runtime`, `tasks`, `workspace`                                   |
| `features/` | ~30 modules | `chat`, `command-palette`, `session-list`, `settings`, `marketplace`, `agents-list`, `dashboard-*`, `onboarding`                 |
| `widgets/`  | ~9 modules  | `app-layout`, `session`, `dashboard`, `agents`, `marketplace`, `tasks`                                                           |

The app shell (`App.tsx`, `AppShell.tsx`, `main.tsx`, `router.tsx`) lives at the `src/` root and may import from any layer.

## Cross-Feature Communication

When features need to share data or logic:

1. **UI composition (allowed)** — a feature's UI may render a sibling feature's component (ChatPanel renders CommandPalette)
2. **Lift shared logic to entities** — hooks used by several features belong in an entity module
3. **Zustand store in shared** — for truly global UI state (`shared/model/app-store.ts`)

Never let one feature's model/hooks import another feature's model/hooks.

## Size Monitoring

Proactively suggest structural improvements when these thresholds are hit:

**Client:**

- A feature reaches **20+ files** → split into multiple features or extract entities
- A module accumulates logic used by several features → lift it to `entities/` or `shared/`

**Server** (`apps/server/src/`) — already domain-grouped (`services/<domain>/`, flat `routes/`; see `.claude/rules/server-structure.md`):

- A new service always joins an existing domain — no loose files at `services/` root
- Several related services emerge with a clear boundary and no home → propose a **new domain directory** (never for a single orphan file)
- A single domain grows unwieldy or two services develop circular/unclear dependencies → propose splitting the domain

When suggesting, name the threshold that fired and the concrete restructure, then ask before moving files.

## Detecting Layer Violations

```bash
# Find features importing from other features
grep -r "from '@/layers/features/" apps/client/src/layers/features/ --include="*.ts" --include="*.tsx" | grep -v "__tests__"

# Find entities importing from features (should be 0)
grep -r "from '@/layers/features/" apps/client/src/layers/entities/ --include="*.ts"

# Find shared importing from anywhere except shared
grep -r "from '@/layers/" apps/client/src/layers/shared/ --include="*.ts" | grep -v "from '@/layers/shared"
```

(ESLint `no-restricted-imports` enforces the hierarchy as errors; these greps are for quick audits.)

## Common Pitfalls

- **Putting everything in shared/**: only truly reusable, domain-agnostic code belongs in shared
- **Feature-to-feature model imports**: lift shared logic to entities
- **Giant features**: 20+ files means split
- **Skipping index.ts**: every module needs a public API barrel export
- **Transport in wrong layer**: the Transport interface lives in `packages/shared`, implementations in `shared/lib/`, TransportContext in `shared/model/`

## References

- `.claude/rules/fsd-layers.md` — Layer-import matrix, cross-module rules, segments, import conventions
- `.claude/rules/server-structure.md` — Server domain layout and service placement
- `contributing/project-structure.md` — Full FSD patterns, directory layout, adding features
- `contributing/architecture.md` — Hexagonal architecture, Transport interface
