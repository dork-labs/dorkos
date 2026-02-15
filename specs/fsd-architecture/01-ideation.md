# Feature-Sliced Design Architecture for DorkOS

**Slug:** fsd-architecture
**Author:** Claude Code
**Date:** 2026-02-15

---

## 1) Intent & Assumptions

**Task brief:** Adopt Feature-Sliced Design (FSD) methodology across the DorkOS monorepo. Before reorganizing any code, configure the Claude Code harness (skills, rules, guides, commands) to fully support FSD workflows.

**Assumptions:**
- FSD applies primarily to `apps/client` and `apps/server`, not to infrastructure packages (`packages/shared`, `packages/cli`, etc.)
- The monorepo's Turborepo/workspace structure stays as-is — FSD applies *within* each app
- We'll adapt FSD to fit DorkOS's existing hexagonal Transport architecture rather than replacing it
- The reference project (`next_starter`) provides the FSD patterns to follow, adapted for Vite+React (client) and Express (server)
- Harness updates come first; code migration comes later in a separate effort

**Out of scope:**
- Actual code migration (moving files into FSD layers)
- ESLint boundary enforcement (future follow-up)
- Changes to `packages/shared`, `packages/cli`, `packages/test-utils`, or `packages/typescript-config`
- Changes to `apps/obsidian-plugin` (uses DirectTransport, minimal own structure)

---

## 2) Pre-reading Log

### Reference Project (`next_starter`)
- `.claude/skills/organizing-fsd-architecture/SKILL.md`: Complete FSD skill — layer hierarchy, dependency rules, standard segments (ui/model/api/lib/config), step-by-step approach, placement guide, violation detection
- `.claude/rules/components.md`: UI component rules scoped to `src/components/**/*.tsx` and `src/layers/**/ui/**/*.tsx` — Shadcn patterns, FSD layer components, Base UI composition
- `.claude/rules/dal.md`: DAL rules scoped to `src/layers/entities/*/api/**/*.ts` and `src/layers/shared/api/**/*.ts` — query/mutation patterns, auth enforcement
- `developer-guides/01-project-structure.md`: Comprehensive FSD guide — layer hierarchy, entity/feature structure, import patterns, naming conventions, anti-patterns, troubleshooting
- `CLAUDE.md` (lines 30-58): Directory structure with FSD annotations; (lines 470-530): DAL architecture FSD-aligned

### Current DorkOS Project
- `CLAUDE.md`: Documents current client structure (components/{domain}/, hooks/, stores/, contexts/, lib/) and server structure (routes/, services/, middleware/)
- `guides/architecture.md`: Hexagonal architecture with Transport interface — key constraint for FSD adaptation
- `.claude/skills/`: 8 skills, none FSD-related
- `.claude/rules/`: 3 rules (api.md, components.md, testing.md), none FSD-aware
- `guides/`: 12 guides, none covering project structure or FSD

---

## 3) Codebase Map

### Current Client Structure (`apps/client/src/`)
```
components/
├── chat/        # ChatPanel, MessageList, MessageItem, ToolCallCard, StreamingText
├── commands/    # CommandPalette
├── files/       # FileBrowser
├── layout/      # Header, Layout
├── sessions/    # SessionSidebar
├── settings/    # SettingsPanel
├── status/      # StatusBar
└── ui/          # Shadcn primitives (button, card, dialog, etc.)
contexts/        # TransportContext (DI for Transport interface)
hooks/           # useChatSession, useCommands, useSessions, useAppStore
stores/          # app-store.ts (Zustand)
lib/             # http-transport.ts, direct-transport.ts, utils, celebrations
```

### Current Server Structure (`apps/server/src/`)
```
routes/          # sessions, commands, health, directory, config, files, git
services/        # agent-manager, transcript-reader, session-broadcaster,
                 # stream-adapter, command-registry, openapi-registry,
                 # file-lister, git-status, tunnel-manager
middleware/      # (minimal)
```

### Shared Package (`packages/shared/src/`)
```
schemas.ts       # Zod schemas for all types (Session, StreamEvent, etc.)
types.ts         # Re-exports from schemas
transport.ts     # Transport interface (hexagonal port)
```

### Potential FSD Mapping

**Client (`apps/client/src/layers/`):**

| Current | FSD Layer | Rationale |
|---------|-----------|-----------|
| `components/ui/` | `shared/ui/` | Domain-agnostic Shadcn primitives |
| `lib/utils.ts` | `shared/lib/` | Pure utilities |
| `contexts/TransportContext` | `shared/lib/` or `app/providers/` | DI infrastructure |
| `hooks/useSessions`, session types | `entities/session/` | Business domain object |
| `components/chat/*` | `features/chat/ui/` | Complete user-facing feature |
| `components/commands/*` | `features/commands/ui/` | Complete user-facing feature |
| `components/sessions/*` | `features/session-list/ui/` | Session browsing feature |
| `components/settings/*` | `features/settings/ui/` | Settings feature |
| `components/layout/*` | `widgets/app-layout/ui/` | Composes multiple features |
| `stores/app-store.ts` | Split across features/entities | State co-located with domain |

**Server (`apps/server/src/`):**

FSD is frontend-focused, but its *principles* apply to server:

| Current | Adapted Structure | Rationale |
|---------|-------------------|-----------|
| `routes/` | Keep as-is (HTTP layer = app layer) | Routes are thin handlers |
| `services/agent-manager.ts` | `domains/agent/` | Core domain |
| `services/transcript-reader.ts` | `domains/session/` | Session domain |
| `services/session-broadcaster.ts` | `domains/session/` | Session domain |
| `services/command-registry.ts` | `domains/commands/` | Commands domain |
| `services/stream-adapter.ts` | `shared/` | Infrastructure |
| `services/tunnel-manager.ts` | `shared/` | Infrastructure |

---

## 4) Research

### Approach: Adapt FSD for Monorepo

**Reference project pattern (single-app Next.js):**
```
src/layers/{shared,entities,features,widgets}/[module]/{ui,model,api,lib,config}/
```

**DorkOS adaptation (monorepo with Vite client + Express server):**

For `apps/client`:
- Use `src/layers/` directory with standard FSD layers
- `shared/ui/` = Shadcn components (already isolated in `components/ui/`)
- `shared/lib/` = utilities, Transport infrastructure
- `entities/session/` = session types, hooks, transport calls
- `features/chat/` = chat UI, streaming logic
- `features/commands/` = command palette
- `widgets/app-layout/` = main layout composing features

For `apps/server`:
- Use domain-based organization inspired by FSD principles
- Not strict FSD layers (server doesn't have ui/model/api segments the same way)
- Group by business domain: `domains/session/`, `domains/agent/`, `domains/commands/`
- Keep `shared/` for cross-cutting infrastructure

### Key Adaptation Decisions

1. **No `app/` layer in client** — Vite SPA doesn't have file-based routing. `App.tsx` + `main.tsx` serve as the app layer directly.
2. **Transport as shared infrastructure** — The hexagonal Transport interface lives in `packages/shared/`, consumed via `shared/lib/` in client.
3. **Server uses "domains" not "layers"** — Server-side FSD adaptation uses domain grouping rather than strict FSD hierarchy since the server has different concerns (no UI rendering).
4. **`packages/shared` stays as-is** — The monorepo shared package is cross-app infrastructure, not an FSD "shared" layer.

---

## 5) Harness Updates Needed

### New Skill: `organizing-fsd-architecture`
- Adapt from reference project's skill
- Customize for monorepo context (client layers vs server domains)
- Include DorkOS-specific layer mapping and Transport considerations

### New Guide: `guides/01-project-structure.md`
- FSD layer hierarchy and rules
- Client FSD structure
- Server domain structure
- Import patterns and path aliases
- Anti-patterns and troubleshooting
- How to add new features/entities

### Updated Rule: `.claude/rules/components.md`
- Add FSD path patterns: `apps/client/src/layers/**/ui/**/*.tsx`
- Include FSD-specific component conventions

### New Rule: `.claude/rules/fsd-layers.md`
- Path: `apps/client/src/layers/**/*.ts`, `apps/client/src/layers/**/*.tsx`
- Enforce layer dependency rules
- Import conventions

### Updated: `CLAUDE.md`
- Update client and server directory structure sections
- Add FSD layer hierarchy reference
- Update architecture section

### Updated: `guides/architecture.md`
- Add FSD layer mapping
- Explain how FSD interacts with hexagonal Transport architecture

### Updated Commands (remove stale FSD references):
- `spec/execute.md` — Update FSD references to match actual structure
- `app/cleanup.md` — Update FSD scaffold references
- `system/ask.md` — Update scaffolding reference

---

## 6) Clarification

1. **Server-side FSD depth**: Should the server adopt domain grouping (`domains/session/`, `domains/agent/`) or keep the current flat `routes/` + `services/` structure? The server is relatively small (7 routes, 9 services).

2. **Widget layer necessity**: The client is small enough that `widgets/` may be premature. Start with `shared` + `entities` + `features` only, add `widgets` later?

3. **Barrel exports (index.ts)**: The reference project uses `index.ts` public API files for each module. Should we adopt this pattern? It adds ceremony but clarifies public APIs.

4. **Path alias**: Currently `@/*` maps to `./src/*` within each app. Keep this (layers accessed as `@/layers/features/chat`) or add a `@layers/*` shortcut?

5. **Migration scope for harness**: Should the harness updates assume the *future* FSD structure (so they're ready when we migrate code), or should they support *both* current and FSD structures during transition?
