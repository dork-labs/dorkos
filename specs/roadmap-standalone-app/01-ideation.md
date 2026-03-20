---
slug: roadmap-standalone-app
number: 45
created: 2026-02-18
status: ideation
---

# Roadmap Standalone App

**Slug:** roadmap-standalone-app
**Author:** Claude Code
**Date:** 2026-02-18
**Branch:** preflight/roadmap-standalone-app
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Turn the existing roadmap system at `roadmap/` into a standalone app within the monorepo with its own Express backend API and React frontend, using the same frameworks as the existing DorkOS apps (Express, React 19, Vite 6, Tailwind 4, shadcn/ui).
- **Assumptions:**
  - New app lives at `apps/roadmap/` in the monorepo as `@dorkos/roadmap`
  - Reuses `roadmap/roadmap.json` as the data source (JSON file stays canonical)
  - Follows existing DorkOS patterns: Zod validation, FSD architecture, Calm Tech design system
  - Single-user tool (no auth, no multi-tenancy)
  - Replaces the deprecated standalone HTML visualization
  - Claude Code slash commands (`/roadmap:*`) and Python scripts remain unchanged
- **Out of scope:**
  - Authentication / multi-user support
  - Obsidian plugin integration for roadmap
  - Changes to MoSCoW methodology or JSON schema structure
  - Mobile-native views
  - CLI integration (the `dorkos` npm package does not bundle this app)

## 2) Pre-reading Log

- `roadmap/roadmap.json`: 8 sample items with full MoSCoW/status/health/timeHorizon/effort/dependencies fields. `projectName`, `projectSummary`, `lastUpdated`, `timeHorizons` config, and `items[]` array.
- `roadmap/schema.json`: JSON Schema v7 — items require id (UUID), title, type, moscow, status, health, timeHorizon, createdAt, updatedAt. Optional: description, effort (Fibonacci), dependencies, labels, linkedArtifacts, ideationContext, workflowState.
- `roadmap/scripts.js`: 1139 lines vanilla JS (IIFE). Fetches JSON, renders 3 views (Timeline/Status/Priority), modals, theme toggle, auto-refresh every 2 min. "Start Ideation" button copies `/ideate --roadmap-id` command.
- `roadmap/styles.css`: Calm Tech CSS with custom properties for theming. Standalone, no Tailwind.
- `roadmap/roadmap.ts`: TypeScript helpers — `getRoadmapItems()`, `getItemById()`, `getItemsByStatus()`. Imports JSON at build time.
- `roadmap/CLAUDE.md`: Emphasizes standalone design (vanilla JS, no React/Tailwind).
- `apps/server/src/index.ts`: Server bootstrap — port, boundary, MCP tools, Express app, Pulse scheduler, SessionBroadcaster, tunnel. 26 service files.
- `apps/server/src/app.ts`: Express app factory — CORS, JSON, logger, 8 route groups at `/api/*`, OpenAPI spec, error handler, static serving.
- `apps/server/src/routes/sessions.ts`: Route pattern — Zod validate, boundary check, delegate to service, return JSON.
- `apps/client/src/App.tsx`: React 19 entry with FSD layers, sidebar state (Zustand), responsive logic.
- `apps/client/vite.config.ts`: Vite 6 + React + Tailwind 4, path alias `@/*`, dev proxy `/api` to Express.
- `turbo.json`: Tasks — build, dev, test, typecheck, lint. `apps/*` glob auto-includes new apps.
- `vitest.workspace.ts`: Test projects — client, server, cli, shared. Would need `apps/roadmap` entry.
- `contributing/design-system.md`: Calm Tech — neutral grays, blue accent, 8pt grid, system fonts, motion.dev, shadcn/ui.
- `packages/shared/src/schemas.ts`: Zod schemas with `.openapi()` metadata, inferred TypeScript types.

## 3) Codebase Map

**Primary Components/Modules:**

- `roadmap/roadmap.json` — Source of truth, 8 items with MoSCoW prioritization
- `roadmap/schema.json` — JSON Schema v7 for validation
- `roadmap/roadmap.ts` — TypeScript query helpers (getItemById, getItemsByStatus)
- `roadmap/scripts.js` — 1139-line vanilla JS visualization (3 Kanban views, modals, health dashboard)
- `roadmap/styles.css` — Standalone Calm Tech CSS
- `roadmap/scripts/` — 7 Python utilities (update_status, link_spec, find_by_title, etc.)

**Shared Dependencies (to reuse):**

- `packages/shared/` — Zod schemas, types, constants (would add roadmap schemas here)
- `packages/typescript-config/` — tsconfig presets (react.json for frontend, node.json for backend)
- `packages/test-utils/` — Mock factories, test helpers

**Data Flow (current):**
`roadmap.json` → Python scripts (CLI mutations) → `scripts.js` fetches JSON → renders HTML views

**Data Flow (proposed):**
`roadmap.json` ← `lowdb` adapter ← Express CRUD routes ← React UI (TanStack Query) → Kanban/Table/Grid views

**Feature Flags/Config:** None currently. The roadmap JSON path could be configurable via env var `ROADMAP_PATH`.

**Potential Blast Radius:**

- Direct: New `apps/roadmap/` directory (server + client in one app)
- Shared: Add roadmap Zod schemas to `packages/shared/`
- Config: Add to `vitest.workspace.ts`
- No changes needed: `turbo.json` (glob auto-includes), root `package.json` (glob auto-includes), ESLint (glob auto-includes)

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

Research agent performed 10 web searches. Full findings at `research/20260218_roadmap-app-best-practices.md`.

### Data Layer

| Approach                   | Pros                                                                                 | Cons                                                    | Complexity |
| -------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---------- |
| **lowdb (JSON adapter)**   | Zero native deps, git-diffable, atomic writes via write-file-atomic, lodash-like API | Full-file reads/writes, no query language               | Very Low   |
| **better-sqlite3**         | Real SQL queries, WAL concurrency, battle-tested                                     | Native addon compilation, binary files not git-diffable | Medium     |
| **node:sqlite (Node 22+)** | Zero deps, built into Node                                                           | Experimental API, requires Node >= 22.5                 | Low-Medium |

**Recommendation:** `lowdb` — keeps JSON as canonical artifact, adds atomic writes, zero compilation overhead. Migrate to SQLite only if relational queries become necessary.

### Visualization

| View                     | Value                       | Complexity  | Library                                 |
| ------------------------ | --------------------------- | ----------- | --------------------------------------- |
| **Table/List**           | High (bulk editing, search) | Low         | shadcn Table + TanStack Table           |
| **Kanban by status**     | High (visual workflow)      | Low         | Kibo UI `kanban` or `@hello-pangea/dnd` |
| **MoSCoW priority grid** | Medium (unique to domain)   | Low-Medium  | Custom CSS Grid + `@hello-pangea/dnd`   |
| **Timeline/Gantt**       | Lower (needs date fields)   | Medium-High | Kibo UI `gantt`                         |

**Recommendation:** Ship Table + Kanban first (fastest to build, highest value). Add MoSCoW grid next. Gantt only if items get `startDate`/`endDate` fields.

### Component Libraries

- **Kibo UI** — shadcn-compatible registry (MIT, 3.6K stars). Has Kanban, Gantt, Calendar, List, Table, Status components. Install via `npx kibo-ui add kanban`. Code is copied into project (like shadcn/ui), so fully customizable.
- **@hello-pangea/dnd** — Community fork of react-beautiful-dnd, React 19 certified. Best for Kanban drag-and-drop.
- **SVAR React Gantt** — MIT, React 19 compatible (v2.3). Fallback if Kibo UI's Gantt lacks features.

### Real-Time Updates

For single-user: **TanStack Query `refetchOnWindowFocus: true`** is sufficient. No WebSocket/SSE needed initially. Add file-watch SSE (like DorkOS's `session-broadcaster.ts`) only if external mutations (CLI/Python scripts) need instant UI sync.

### API Design

```
GET    /api/roadmap/items          # List all items
POST   /api/roadmap/items          # Create item
GET    /api/roadmap/items/:id      # Get single item
PATCH  /api/roadmap/items/:id      # Update item fields
DELETE /api/roadmap/items/:id      # Delete item
PATCH  /api/roadmap/items/reorder  # Persist drag-and-drop order
GET    /api/roadmap/meta           # Project name, summary, health stats
```

Client-side filtering via TanStack Query `select` option (simpler for small datasets). Server-side filtering only if dataset grows.

## 6) Clarification (Resolved)

All clarification questions have been answered:

1. **Architecture:** Fully standalone app — own Express server on separate port + own React SPA at `apps/roadmap/`. Maximum independence from DorkOS.

2. **Data location:** Repo root — read/write `./roadmap/roadmap.json`, configurable via `ROADMAP_PATH` env var. Git-tracked, human-readable.

3. **Write path:** API becomes sole writer — migrate the 7 Python scripts to use the Express API (via `curl`/fetch or a thin CLI wrapper). Single write path guarantees consistency.

4. **Views:** All 4 views in v1 — Table/List, Kanban by status, MoSCoW priority grid, Timeline/Gantt. Schema will need `startDate`/`endDate` fields for Gantt.

5. **Health dashboard:** Persistent header bar above all views showing key metrics (Must-Have %, item count, in-progress, at-risk/blocked). Always visible, lightweight.

6. **Editing UX:** Modal/dialog — click a card or table row to open a dialog with all editable fields. Board stays visible behind. Matches current HTML behavior and user expectations (Linear, Notion pattern).

7. **Spec links:** Render spec content in modal — click linked spec fetches and renders the markdown in a dialog. Self-contained experience. Requires a file-reading API endpoint.
