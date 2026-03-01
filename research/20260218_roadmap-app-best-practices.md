---
title: "Roadmap App Best Practices Research"
date: 2026-02-18
type: external-best-practices
status: active
tags: [roadmap, product, ux, public-roadmap, linear]
feature_slug: roadmap-standalone-app
searches_performed: 10
---

# Roadmap App Best Practices Research

**Date**: 2026-02-18
**Mode**: Deep Research
**Searches performed**: 10
**Topic**: Building a standalone roadmap/project management app — Express API + React 19 + Tailwind 4 + shadcn/ui in a Turborepo monorepo

---

## Research Summary

For a single-user developer roadmap tool built on the existing DorkOS stack (Express + React 19 + Vite 6 + Tailwind 4 + shadcn/ui), the simplest viable stack is: **`lowdb` or `write-file-atomic` for JSON persistence**, **`@hello-pangea/dnd` for drag-and-drop Kanban**, and **Kibo UI's Kanban/Gantt components** for zero-setup rich views, with **TanStack Query `refetchOnWindowFocus`** providing sufficient real-time freshness for a single-user tool.

---

## Key Findings

### 1. Data Layer Architecture

**JSON File Storage (Current Approach)**

- Description: Read the entire `roadmap.json` into memory on each GET, write the full JSON on each mutation with `write-file-atomic` (rename-based swap).
- Pros: Zero dependencies, git-diffable, human-readable, trivially portable.
- Cons: O(n) full reads/writes on every mutation; no query capabilities; race conditions if multiple processes write concurrently.
- Complexity: Very Low. Maintenance: Very Low.
- Best fit: roadmap files under ~1MB (~5,000 items).

**lowdb (JSON with Adapter Pattern)**

- Description: `lowdb` is a thin lodash-like wrapper around a JSON file, exposing a `db.data.items` API with `db.write()` for atomic persistence. Version 7 is pure ESM.
- Pros: Lodash-style `.chain()` for in-memory filtering/sorting; adapter pattern cleanly separates storage; still git-diffable; no native compilation.
- Cons: Still full-file reads/writes; not suitable for relational data.
- Complexity: Low. Maintenance: Low.
- Recommendation: **Best choice for JSON-file approach**. Weekly downloads: 913,579.

**better-sqlite3 (SQLite)**

- Description: Synchronous SQLite3 bindings for Node.js. Fast, battle-tested, native addon.
- Pros: Real queries (ORDER BY, WHERE), transactions for safe concurrent writes, much smaller on-disk footprint for large datasets, WAL mode for concurrent reads.
- Cons: Native addon requires compilation (problematic in Turborepo/CI); synchronous API blocks event loop (fine for single-user, but diverges from async Express patterns); SQLite files are binary (not git-diffable).
- Complexity: Medium. Maintenance: Low.
- Weekly downloads: 1,872,495.

**node:sqlite (Node.js 22+ built-in)**

- Description: Native SQLite in Node.js, no third-party packages needed.
- Pros: Zero external dependencies; same synchronous interface as better-sqlite3; no native compilation step.
- Cons: Requires Node.js >= 22.5.0 (check your target environment); API is still experimental/stabilizing as of 2025; no ecosystem of helper utilities yet.
- Complexity: Low-Medium. Maintenance: Very Low.

**Verdict**: For a roadmap with hundreds to low-thousands of items, **`lowdb` is the pragmatic choice** — it keeps the JSON file as the canonical artifact, adds safe atomic writes, and has zero compilation overhead. Migrate to `better-sqlite3` or `node:sqlite` only if you need relational queries, FTS, or encounter I/O performance bottlenecks.

---

### 2. Atomic Writes & Concurrent Access

The `write-file-atomic` npm package (maintained by npm, Inc.) uses a rename-based swap: it writes to a temp file then atomically renames it over the target, preventing partial-write corruption. This is the same mechanism used by `lowdb`'s default adapter.

For an Express server (single Node.js process), the event loop serializes async file operations naturally, so race conditions within the same process are not a concern. If you ever run multiple Express workers (e.g., `cluster`), you need a lockfile. The `proper-lockfile` npm package pairs well with `write-file-atomic` for that scenario.

Pattern recommendation:

```ts
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const adapter = new JSONFile<RoadmapData>('roadmap.json');
const db = new Low(adapter, { items: [] });

await db.read();
// mutate db.data
await db.write(); // atomic rename swap internally
```

---

### 3. Roadmap Visualization Patterns

**What views matter most for a developer roadmap tool:**

| View | Use Case | Complexity to Build |
|---|---|---|
| Kanban (by status) | Day-to-day workflow, "what's in progress?" | Low — many ready-made components |
| MoSCoW Priority Grid | Sprint/release planning sessions | Low — CSS grid with 4 columns |
| Table/List | Bulk editing, search, sorting | Low — shadcn Table + TanStack Table |
| Timeline/Gantt | Date-based planning, milestone tracking | Medium-High — requires date handling |

**MoSCoW Priority Grid**: This is a 2x2 (or 4-column) grid with drag-and-drop between quadrants. No specialized library is required — a simple CSS Grid with `@hello-pangea/dnd` drop targets per quadrant covers the full pattern. This is the highest-value custom view to build since no off-the-shelf solution precisely matches MoSCoW + status combinations.

**Recommendation for view priority order**:
1. Table view (fastest to build, most functional)
2. Kanban by status (most visual, highest perceived value)
3. MoSCoW priority grid (unique to your domain)
4. Timeline/Gantt (only if items have `startDate`/`endDate` fields)

---

### 4. Component Libraries

#### Kibo UI (Recommended — Best Fit for This Stack)

Kibo UI is a custom shadcn/ui registry with 41+ production-ready components. Acquired by Shadcnblocks in October 2025. MIT licensed. Ships components as source code (like shadcn/ui itself), so fully customizable.

Relevant components:
- **Kanban** — drag-and-drop board with columns and cards
- **Gantt** — project timeline with hierarchical task tracking
- **Calendar** — grid displaying features by end date
- **List** — tasks grouped by status, ranked by priority
- **Table** — tabular data display
- **Status** — status badge primitive (maps well to your status field)

Install:
```bash
npx kibo-ui add kanban
npx kibo-ui add gantt
```

GitHub: `github.com/shadcnblocks/kibo` (3,600+ stars as of Feb 2026)

Since Kibo UI is a shadcn-style registry (code is copied into your project), it integrates perfectly with your existing Tailwind 4 + shadcn/ui setup with zero style conflicts.

#### @hello-pangea/dnd (Recommended for Custom DnD)

Community-maintained successor to `react-beautiful-dnd` after Atlassian deprecated it. Achieved React 19 compatibility as of April 2025. Best-in-class for list/Kanban drag-and-drop patterns.

- Pros: Beautiful native animations, accessibility built-in, well-documented, React 19 certified.
- Cons: List-oriented (columns of cards), not a canvas/2D DnD library.
- Use when: building a custom Kanban or MoSCoW grid without Kibo UI.

#### dnd-kit (Alternative)

More flexible and lower-level than `@hello-pangea/dnd`. Better for 2D grids and complex interaction patterns. Community support continues actively but React 19 certification lagged behind `@hello-pangea/dnd` as of early 2025.

#### SVAR React Gantt (If Custom Gantt is Needed)

- MIT licensed, React 19 compatible (v2.3).
- Install: `npm install @svar-ui/react-gantt`
- Prefer Kibo UI's Gantt first — if it lacks features, fall back to SVAR.

#### shadcn/ui Official Blocks

The official shadcn/ui site now includes a "Roadmap" block at `/blocks/roadmap`. This uses a horizontal timeline with event markers — suitable for milestone-style roadmaps, not full Kanban/Gantt.

---

### 5. REST API Design

#### Resource: `/api/roadmap/items`

```
GET    /api/roadmap/items          # List all items (with filter/sort query params)
POST   /api/roadmap/items          # Create item
GET    /api/roadmap/items/:id      # Get single item
PATCH  /api/roadmap/items/:id      # Update item fields
DELETE /api/roadmap/items/:id      # Delete item
```

#### Filtering & Sorting (Query Parameters)

Server-side filtering is recommended for larger datasets, but for a JSON-file backend with hundreds of items, client-side filtering via TanStack Query + a selector function is simpler and avoids unnecessary API complexity.

If you implement server-side:
```
GET /api/roadmap/items?status=in-progress&priority=must&sort=-createdAt
```

Convention: prefix field name with `-` for descending sort. Multiple sort fields: `?sort=-priority,title`.

#### Bulk Operations

```
PATCH /api/roadmap/items/bulk
Body: { ids: string[], patch: Partial<RoadmapItem> }
# Example: batch status update, batch priority change
```

For reorder (drag-and-drop persistence):
```
PATCH /api/roadmap/items/reorder
Body: { orderedIds: string[] }
```

Reordering approach: store a numeric `order` field on each item. On reorder, update only the affected items' `order` values (or re-index the full array — acceptable for small datasets).

#### Zod Validation Pattern (Aligned with DorkOS Patterns)

```ts
const RoadmapItemPatchSchema = RoadmapItemSchema.partial().omit({ id: true, createdAt: true });

router.patch('/items/:id', async (req, res) => {
  const parsed = RoadmapItemPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.format() });
  }
  // ...apply patch
});
```

---

### 6. Real-Time Updates Strategy

For a **single-user tool**, the recommendation is: **no WebSocket/SSE needed**.

**TanStack Query with `refetchOnWindowFocus: true` (Default)**

TanStack Query's default behavior: when the browser tab regains focus and the cached data is stale (past `staleTime`), it automatically re-fetches. This is sufficient for a roadmap tool where you switch tabs to do other work, come back, and see fresh data.

Configuration:
```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,        // 30 seconds — data considered fresh
      refetchOnWindowFocus: true, // re-fetch on tab focus (default)
    },
  },
});
```

**When to add SSE/polling**: If you ever add a CLI tool or webhook that modifies `roadmap.json` outside the browser, add a simple SSE endpoint that uses `chokidar` to watch the file (exactly the same pattern as DorkOS's `session-broadcaster.ts`). The client subscribes and calls `queryClient.invalidateQueries` on the event.

**Polling**: `refetchInterval: 10_000` in TanStack Query is a reasonable middle ground if external mutation is common but SSE feels overkill. This adds a 10-second polling cycle.

**Verdict**: Ship with `refetchOnWindowFocus` only. Add file-watch SSE if/when external mutations become a use case.

---

## Recommended Stack

| Concern | Recommendation | Rationale |
|---|---|---|
| Data storage | `lowdb` (JSON adapter) | Zero deps, git-diffable, atomic writes, lodash API |
| API layer | Express CRUD routes with Zod validation | Consistent with DorkOS patterns |
| Filtering/sorting | Client-side via TanStack Query selectors | Simpler for small datasets |
| Kanban view | Kibo UI `kanban` component | shadcn-compatible, MIT, React 19 |
| Gantt view | Kibo UI `gantt` component | Same ecosystem |
| MoSCoW grid view | Custom CSS Grid + `@hello-pangea/dnd` | No off-the-shelf match for this exact pattern |
| Table view | shadcn/ui `Table` + TanStack Table | Already in DorkOS design system |
| Real-time | TanStack Query `refetchOnWindowFocus` | Single-user, no overhead |
| Drag-and-drop (custom) | `@hello-pangea/dnd` | React 19 certified, accessible |

### Data Schema Additions to Consider

If your current `roadmap.json` lacks these, add them for full view support:

```ts
interface RoadmapItem {
  id: string;
  title: string;
  description?: string;
  priority: 'must' | 'should' | 'could' | 'wont';
  status: 'not-started' | 'in-progress' | 'completed' | 'at-risk' | 'on-hold';
  order: number;           // for drag-and-drop persistence
  startDate?: string;      // ISO 8601 — enables Gantt view
  endDate?: string;        // ISO 8601 — enables Gantt view
  tags?: string[];         // enables tag-based filtering
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}
```

### FSD Module Placement (DorkOS Convention)

Since this is a new standalone app within the Turborepo, the roadmap app would be its own `apps/roadmap` workspace. If it shares the client app, the FSD placement would be:

```
apps/client/src/layers/
├── entities/roadmap/         # useRoadmapItems, useRoadmapItem hooks (TanStack Query)
├── features/roadmap-kanban/  # KanbanBoard component + drag logic
├── features/roadmap-table/   # TableView with filtering UI
├── features/roadmap-gantt/   # GanttView (Kibo UI wrapper)
├── features/roadmap-moscow/  # MoSCoWGrid component
└── features/roadmap-editor/  # Item create/edit form
```

---

## Detailed Analysis

### Data Layer: JSON File vs SQLite Trade-offs

The core question for a roadmap tool is: **do you need queries, or just a list?**

A roadmap typically has a flat or minimally nested structure. The operations are: list all items (with optional client-side filter), create one item, update one item, delete one item, reorder items. None of these require JOIN operations or complex SQL. This strongly favors keeping the JSON file.

SQLite's main advantages (transactions, concurrent write safety, efficient partial reads) are less relevant when:
- There is one writer (the Express server process)
- The dataset is small (<10,000 items for a personal roadmap)
- You want the data to be human-readable and git-tracked

The `node:sqlite` built-in is worth watching for future projects on Node.js 22+, but it's experimental and lacks the ecosystem (migration tools, type helpers) that makes SQLite adoption smooth.

**Atomic write implementation with lowdb:**

lowdb's `JSONFile` adapter calls `write-file-atomic` internally, so you get safe writes for free. The pattern is:

```ts
// services/roadmap-db.ts
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import type { RoadmapData } from '@dorkos/shared/types';

const file = process.env.ROADMAP_PATH ?? path.join(process.cwd(), 'roadmap.json');
const adapter = new JSONFile<RoadmapData>(file);
export const db = new Low(adapter, { items: [], version: 1 });

// Call once at server startup
export async function initDb() {
  await db.read();
}
```

This single export is a singleton — all route handlers share the same in-memory state, and `db.write()` flushes atomically. No locking needed for a single-process server.

### Visualization: Kanban vs MoSCoW Matrix Dual-Axis

The most insightful view for a developer roadmap is a **dual-axis board**: columns = MoSCoW priority (Must/Should/Could/Won't), swimlanes = status groups (Not Started / In Progress / Done). This combines both dimensions without requiring a separate Gantt view.

However, this is a custom layout that no off-the-shelf component provides. It would be built with:
- CSS Grid (4 columns × n rows)
- `@hello-pangea/dnd` `Droppable` per cell
- Cards moving both horizontally (priority change) and vertically (status change)

A simpler path: start with two separate views — Kanban by status, and a MoSCoW 4-column board by priority — then add a combined view if users demand it.

### API Design: Client-side vs Server-side Filtering

For a JSON-file backend with `lowdb`, server-side filtering means filtering the in-memory JS array before returning JSON. This is trivial to implement and essentially free (no I/O). However, it ties the API to the frontend's filter needs.

The recommended pattern for a tool of this scale:

1. `GET /api/roadmap/items` always returns all items (no query params needed initially).
2. TanStack Query's `select` option filters/sorts client-side:
   ```ts
   useQuery({
     queryKey: ['roadmap-items'],
     queryFn: () => fetch('/api/roadmap/items').then(r => r.json()),
     select: (data) => data
       .filter(item => item.status !== 'completed')
       .sort((a, b) => a.order - b.order),
   });
   ```
3. Add server-side filtering only if the dataset grows large enough that network payload becomes a concern.

This keeps the API surface minimal and avoids premature optimization.

---

## Research Gaps & Limitations

- Kibo UI's Kanban/Gantt component API details were not fully examined — the component code is copied into your project via the CLI, so API details require running `npx kibo-ui add kanban` and inspecting the output.
- The shadcn/ui official `/blocks/roadmap` block was not fetched in detail — it appears to be a milestone-style horizontal timeline, not a full Kanban board.
- Performance benchmarks for `lowdb` vs `better-sqlite3` at scale were not found in the current search results. The 1MB / ~5,000 item threshold is an estimate based on general Node.js file I/O characteristics.
- `node:sqlite` stability status for Node.js 22 LTS was not specifically verified in these searches.

---

## Contradictions & Disputes

- **`dnd-kit` vs `@hello-pangea/dnd`**: Some sources favor `dnd-kit` for its flexibility and lower-level control, while others favor `@hello-pangea/dnd` for its opinionated but polished Kanban-specific behavior and React 19 certification. For a Kanban board, `@hello-pangea/dnd` is the safer choice; for a 2D MoSCoW grid with complex drag semantics, `dnd-kit` may be more appropriate.
- **Kibo UI ownership**: Kibo UI was originally created by Hayden Bleasel and acquired by Shadcnblocks in October 2025. The MIT license remains, but community trust in long-term maintenance should be monitored given the recent acquisition.

---

## Search Methodology

- Searches performed: 10
- Most productive search terms: "kibo-ui kanban gantt shadcn", "React 19 drag and drop Kanban 2025 2026", "single user app polling vs SSE TanStack Query", "atomic JSON file writes Node.js concurrent"
- Primary information sources: kibo-ui.com, marmelab.com, tanstack.com, svar.dev, github.com, npmtrends.com, puckeditor.com

---

## Sources & Evidence

- [Top 5 Drag-and-Drop Libraries for React in 2026 | Puck](https://puckeditor.com/blog/top-5-drag-and-drop-libraries-for-react)
- [Build a Kanban Board With Drag-and-Drop in React with Shadcn | Marmelab](https://marmelab.com/blog/2026/01/15/building-a-kanban-board-with-shadcn.html)
- [Kibo UI — Advanced shadcn/ui components](https://www.kibo-ui.com/)
- [SVAR React Gantt v2.3: Modern Project Timelines for React 19](https://javascript.plainenglish.io/svar-react-gantt-v2-3-modern-project-timelines-for-react-19-338b31ac433f)
- [Top 5 React Gantt Chart Libraries Compared (2026) | SVAR Blog](https://svar.dev/blog/top-react-gantt-charts/)
- [Window Focus Refetching | TanStack Query Docs](https://tanstack.com/query/v4/docs/react/guides/window-focus-refetching)
- [TanStack Query and WebSockets: Real-time React data fetching | LogRocket](https://blog.logrocket.com/tanstack-query-websockets-real-time-react-data-fetching/)
- [write-file-atomic | npm](https://www.npmjs.com/package/write-file-atomic)
- [Getting Started with Native SQLite in Node.js | Better Stack](https://betterstack.com/community/guides/scaling-nodejs/nodejs-sqlite/)
- [lowdb — Simple and fast JSON database | GitHub](https://github.com/typicode/lowdb)
- [better-sqlite3 vs lowdb vs node-json-db | npm trends](https://npmtrends.com/better-sqlite3-vs-lowdb-vs-node-json-db)
- [Getting Started with Kibo UI and shadcn/ui Components | OpenReplay](https://blog.openreplay.com/getting-started-kibo-ui-shadcn-components/)
- [Building a Kanban Board with Drag and Drop in React | Surajon](https://www.surajon.dev/building-a-kanban-board-with-drag-and-drop-in-react)
- [REST API Design Best Practices | freeCodeCamp](https://www.freecodecamp.org/news/rest-api-design-best-practices-build-a-rest-api/)
- [When JSON Sucks or The Road To SQLite Enlightenment](https://pl-rants.net/posts/when-not-json/)
