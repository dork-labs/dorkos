---
slug: roadmap-standalone-app
number: 45
created: 2026-02-18
status: specified
---

# Specification: Roadmap Standalone App

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-18
**Ideation:** [01-ideation.md](./01-ideation.md)
**Research:** [research/20260218_roadmap-app-best-practices.md](../../research/20260218_roadmap-app-best-practices.md)

---

## Overview

Build a fully standalone roadmap visualization and management app within the DorkOS Turborepo monorepo at `apps/roadmap/`. The app provides a modern React UI for managing MoSCoW-prioritized project roadmaps, replacing the deprecated vanilla HTML visualization at `roadmap/`. It has its own Express server and React 19 SPA, using identical frameworks to the existing DorkOS apps.

## Background / Problem Statement

The current roadmap system consists of:

- A vanilla HTML/CSS/JS visualization (`roadmap/roadmap.html`, 1139 lines of JS) that is deprecated
- 7 Python scripts for CLI-based data manipulation
- A JSON file (`roadmap/roadmap.json`) as the data store with a JSON Schema v7 for validation

This works but has limitations: the HTML visualization is static and disconnected from the rest of the toolchain, the Python scripts write directly to JSON with no validation layer, and there's no modern UI for drag-and-drop management. A standalone Express + React app provides a proper API layer, rich interactivity (Kanban DnD, Gantt charts), and follows established DorkOS patterns.

## Goals

- Standalone Express server with REST API for all roadmap CRUD operations
- React 19 SPA with 4 views: Table, Kanban, MoSCoW Grid, Gantt
- `lowdb` data layer for atomic JSON persistence (keeps `roadmap.json` as canonical, git-tracked artifact)
- Drag-and-drop on Kanban (status change) and MoSCoW Grid (priority change)
- Item editing via modal/dialog with all fields
- Health dashboard header bar with key metrics
- Spec/artifact content rendered in markdown viewer modal
- Dark/light theme following Calm Tech design system
- Migrate Python scripts to Express API calls (API becomes sole writer)
- Full integration with Turborepo (dev, build, test, typecheck, lint)

## Non-Goals

- Authentication or multi-user support
- Obsidian plugin integration
- CLI bundling (the `dorkos` npm package does not include this app)
- Mobile-native views (responsive web only)
- Changes to MoSCoW methodology or JSON schema semantics
- SSE/WebSocket real-time sync (TanStack Query `refetchOnWindowFocus` is sufficient)

## Technical Dependencies

| Library                          | Version      | Purpose                                  |
| -------------------------------- | ------------ | ---------------------------------------- |
| `express`                        | ^4.21        | HTTP server                              |
| `lowdb`                          | ^7           | JSON file persistence with atomic writes |
| `zod`                            | ^4.3         | Request/response validation              |
| `@asteasolutions/zod-to-openapi` | ^8.4         | OpenAPI spec generation                  |
| `uuid`                           | ^10          | UUID v4 generation for new items         |
| `cors`                           | ^2.8         | CORS middleware                          |
| `react`                          | ^19          | UI framework                             |
| `react-dom`                      | ^19          | React DOM renderer                       |
| `@tanstack/react-query`          | ^5.62        | Server state management                  |
| `@tanstack/react-table`          | ^8           | Table view with sorting/filtering        |
| `@hello-pangea/dnd`              | ^17          | Drag-and-drop for Kanban and MoSCoW Grid |
| `zustand`                        | ^5           | UI state (view mode, filters, theme)     |
| `tailwindcss`                    | ^4           | Styling                                  |
| `motion`                         | ^12          | Animations                               |
| `lucide-react`                   | latest       | Icons                                    |
| `vite`                           | ^6           | Dev server and bundler                   |
| `marked` or `react-markdown`     | latest       | Markdown rendering for spec viewer       |
| `@dorkos/shared`                 | workspace:\* | Shared Zod schemas and types             |
| `@dorkos/typescript-config`      | workspace:\* | Shared tsconfig presets                  |
| `@dorkos/test-utils`             | workspace:\* | Mock factories                           |

**Kibo UI components** (copied via registry, not npm dependency):

- `kanban` — Kanban board component
- `gantt` — Gantt chart component

## Detailed Design

### Architecture

```
┌──────────────────────────────────────────────────┐
│                   Browser                         │
│  ┌────────────────────────────────────────────┐  │
│  │          React 19 SPA (Vite 6)             │  │
│  │                                             │  │
│  │  ┌─────────┐ ┌───────┐ ┌──────┐ ┌───────┐ │  │
│  │  │  Table  │ │Kanban │ │MoSCoW│ │ Gantt │ │  │
│  │  └────┬────┘ └───┬───┘ └──┬───┘ └───┬───┘ │  │
│  │       └──────┬────┘───────┘──────────┘     │  │
│  │         TanStack Query (fetch/mutate)       │  │
│  └────────────────────┬───────────────────────┘  │
│                       │ HTTP (fetch)              │
├───────────────────────┼──────────────────────────┤
│                       ▼                           │
│  ┌────────────────────────────────────────────┐  │
│  │        Express Server (port 4243)           │  │
│  │                                             │  │
│  │  routes/items.ts    →  RoadmapStore         │  │
│  │  routes/meta.ts     →  (lowdb singleton)    │  │
│  │  routes/files.ts    →  fs/promises          │  │
│  │                                             │  │
│  │        lowdb (JSONFile adapter)             │  │
│  └────────────────────┬───────────────────────┘  │
│                       │ atomic write              │
│                       ▼                           │
│              roadmap/roadmap.json                 │
└──────────────────────────────────────────────────┘
```

### Data Model

#### Schema Additions

Add to the existing `roadmap/schema.json` (backward-compatible optional fields):

```typescript
// New optional fields on roadmapItem
startDate?: string;   // ISO 8601 date — enables Gantt view
endDate?: string;     // ISO 8601 date — enables Gantt view
order?: number;       // Numeric sort order for drag-and-drop persistence
```

#### Zod Schemas (`packages/shared/src/roadmap-schemas.ts`)

New file exporting roadmap-specific schemas:

```typescript
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// === Enums ===

export const RoadmapItemTypeSchema = z
  .enum(['feature', 'bugfix', 'technical-debt', 'research', 'epic'])
  .openapi('RoadmapItemType');

export const MoscowSchema = z
  .enum(['must-have', 'should-have', 'could-have', 'wont-have'])
  .openapi('Moscow');

export const RoadmapStatusSchema = z
  .enum(['not-started', 'in-progress', 'completed', 'on-hold'])
  .openapi('RoadmapStatus');

export const HealthSchema = z
  .enum(['on-track', 'at-risk', 'off-track', 'blocked'])
  .openapi('Health');

export const TimeHorizonSchema = z.enum(['now', 'next', 'later']).openapi('TimeHorizon');

// === Item Schema ===

export const LinkedArtifactsSchema = z
  .object({
    specSlug: z.string().optional(),
    ideationPath: z.string().optional(),
    specPath: z.string().optional(),
    tasksPath: z.string().optional(),
    implementationPath: z.string().optional(),
  })
  .openapi('LinkedArtifacts');

export const IdeationContextSchema = z
  .object({
    targetUsers: z.array(z.string()).optional(),
    painPoints: z.array(z.string()).optional(),
    successCriteria: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
  })
  .openapi('IdeationContext');

export const WorkflowStateSchema = z
  .object({
    phase: z
      .enum([
        'not-started',
        'ideating',
        'specifying',
        'decomposing',
        'implementing',
        'testing',
        'committing',
        'releasing',
        'completed',
      ])
      .optional(),
    specSlug: z.string().optional(),
    tasksTotal: z.number().int().min(0).optional(),
    tasksCompleted: z.number().int().min(0).optional(),
    lastSession: z.string().datetime().optional(),
    attempts: z.number().int().min(0).optional(),
    blockers: z.array(z.string()).optional(),
  })
  .openapi('WorkflowState');

export const RoadmapItemSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(3).max(200),
    description: z.string().max(2000).optional(),
    type: RoadmapItemTypeSchema,
    moscow: MoscowSchema,
    status: RoadmapStatusSchema,
    health: HealthSchema,
    timeHorizon: TimeHorizonSchema,
    effort: z.number().min(0).optional(),
    dependencies: z.array(z.string().uuid()).optional(),
    labels: z.array(z.string()).optional(),
    order: z.number().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    linkedArtifacts: LinkedArtifactsSchema.optional(),
    ideationContext: IdeationContextSchema.optional(),
    workflowState: WorkflowStateSchema.optional(),
  })
  .openapi('RoadmapItem');

export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;

// === Request Schemas ===

export const CreateItemRequestSchema = RoadmapItemSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).openapi('CreateItemRequest');

export const UpdateItemRequestSchema = RoadmapItemSchema.partial()
  .omit({ id: true, createdAt: true })
  .openapi('UpdateItemRequest');

export const ReorderRequestSchema = z
  .object({
    orderedIds: z.array(z.string().uuid()),
  })
  .openapi('ReorderRequest');

// === Meta Schema ===

export const TimeHorizonConfigSchema = z.object({
  label: z.string(),
  description: z.string(),
});

export const RoadmapMetaSchema = z
  .object({
    projectName: z.string().min(1).max(100),
    projectSummary: z.string().max(500),
    lastUpdated: z.string().datetime(),
    timeHorizons: z.object({
      now: TimeHorizonConfigSchema,
      next: TimeHorizonConfigSchema,
      later: TimeHorizonConfigSchema,
    }),
  })
  .openapi('RoadmapMeta');

export type RoadmapMeta = z.infer<typeof RoadmapMetaSchema>;

// === Health Stats ===

export const HealthStatsSchema = z
  .object({
    totalItems: z.number(),
    mustHavePercent: z.number(),
    inProgressCount: z.number(),
    atRiskCount: z.number(),
    blockedCount: z.number(),
    completedCount: z.number(),
  })
  .openapi('HealthStats');

export type HealthStats = z.infer<typeof HealthStatsSchema>;
```

Register in `packages/shared/package.json` exports:

```json
"./roadmap-schemas": { "types": "./src/roadmap-schemas.ts", "default": "./dist/roadmap-schemas.js" }
```

### Server Implementation

#### File Structure

```
apps/roadmap/
├── src/
│   ├── server/
│   │   ├── index.ts           # Server bootstrap (port, lowdb init, Express)
│   │   ├── app.ts             # Express factory (CORS, JSON, routes, error handler, SPA fallback)
│   │   ├── routes/
│   │   │   ├── items.ts       # CRUD for /api/roadmap/items
│   │   │   ├── meta.ts        # GET /api/roadmap/meta
│   │   │   └── files.ts       # GET /api/roadmap/files/:path (spec content)
│   │   ├── services/
│   │   │   └── roadmap-store.ts  # lowdb singleton, CRUD operations, health stats
│   │   └── lib/
│   │       └── logger.ts      # Lightweight logger
│   └── client/
│       └── ... (see Frontend section)
├── package.json
├── tsconfig.json
└── vite.config.ts
```

#### Express App Factory (`src/server/app.ts`)

Following the DorkOS `apps/server/src/app.ts` pattern:

```typescript
export function createApp(store: RoadmapStore) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api/roadmap/items', createItemRoutes(store));
  app.use('/api/roadmap/meta', createMetaRoutes(store));
  app.use('/api/roadmap/files', createFileRoutes());

  // Health check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // Error handler
  app.use(errorHandler);

  // Production: serve React SPA
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, '../../dist/client');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  return app;
}
```

#### API Endpoints (`src/server/routes/items.ts`)

| Method   | Path                         | Description                         | Request Body        | Response                                |
| -------- | ---------------------------- | ----------------------------------- | ------------------- | --------------------------------------- |
| `GET`    | `/api/roadmap/items`         | List all items                      | —                   | `RoadmapItem[]`                         |
| `POST`   | `/api/roadmap/items`         | Create item                         | `CreateItemRequest` | `RoadmapItem` (201)                     |
| `GET`    | `/api/roadmap/items/:id`     | Get single item                     | —                   | `RoadmapItem` or 404                    |
| `PATCH`  | `/api/roadmap/items/:id`     | Update item                         | `UpdateItemRequest` | `RoadmapItem` or 404                    |
| `DELETE` | `/api/roadmap/items/:id`     | Delete item                         | —                   | 204 or 404                              |
| `PATCH`  | `/api/roadmap/items/reorder` | Reorder items                       | `ReorderRequest`    | 200                                     |
| `GET`    | `/api/roadmap/meta`          | Get project metadata + health stats | —                   | `RoadmapMeta & { health: HealthStats }` |
| `GET`    | `/api/roadmap/files/*`       | Read spec file content              | —                   | `{ content: string }` or 404            |

Route handler pattern (matching DorkOS):

```typescript
router.patch('/:id', async (req, res) => {
  const parsed = UpdateItemRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
  }

  const item = store.updateItem(req.params.id, parsed.data);
  if (!item) {
    return res.status(404).json({ error: 'Item not found' });
  }

  res.json(item);
});
```

#### Data Layer (`src/server/services/roadmap-store.ts`)

```typescript
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { v4 as uuidv4 } from 'uuid';

interface RoadmapData {
  projectName: string;
  projectSummary: string;
  lastUpdated: string;
  timeHorizons: { now: HorizonConfig; next: HorizonConfig; later: HorizonConfig };
  items: RoadmapItem[];
}

export class RoadmapStore {
  private db: Low<RoadmapData>;

  constructor(filePath: string) {
    const adapter = new JSONFile<RoadmapData>(filePath);
    this.db = new Low(adapter, {
      projectName: '',
      projectSummary: '',
      lastUpdated: '',
      timeHorizons: {},
      items: [],
    });
  }

  async init(): Promise<void> {
    await this.db.read();
  }

  listItems(): RoadmapItem[] {
    return this.db.data.items;
  }

  getItem(id: string): RoadmapItem | undefined {
    return this.db.data.items.find((item) => item.id === id);
  }

  async createItem(input: CreateItemInput): Promise<RoadmapItem> {
    const now = new Date().toISOString();
    const item: RoadmapItem = {
      ...input,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };
    this.db.data.items.push(item);
    this.db.data.lastUpdated = now;
    await this.db.write();
    return item;
  }

  async updateItem(id: string, patch: Partial<RoadmapItem>): Promise<RoadmapItem | null> {
    const idx = this.db.data.items.findIndex((item) => item.id === id);
    if (idx === -1) return null;

    const now = new Date().toISOString();
    this.db.data.items[idx] = { ...this.db.data.items[idx], ...patch, updatedAt: now };
    this.db.data.lastUpdated = now;
    await this.db.write();
    return this.db.data.items[idx];
  }

  async deleteItem(id: string): Promise<boolean> {
    const idx = this.db.data.items.findIndex((item) => item.id === id);
    if (idx === -1) return false;

    this.db.data.items.splice(idx, 1);
    this.db.data.lastUpdated = new Date().toISOString();
    await this.db.write();
    return true;
  }

  async reorder(orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, index) => {
      const item = this.db.data.items.find((i) => i.id === id);
      if (item) item.order = index;
    });
    this.db.data.lastUpdated = new Date().toISOString();
    await this.db.write();
  }

  getMeta(): RoadmapMeta & { health: HealthStats } {
    const items = this.db.data.items;
    const mustHaves = items.filter((i) => i.moscow === 'must-have');
    return {
      projectName: this.db.data.projectName,
      projectSummary: this.db.data.projectSummary,
      lastUpdated: this.db.data.lastUpdated,
      timeHorizons: this.db.data.timeHorizons,
      health: {
        totalItems: items.length,
        mustHavePercent: items.length > 0 ? Math.round((mustHaves.length / items.length) * 100) : 0,
        inProgressCount: items.filter((i) => i.status === 'in-progress').length,
        atRiskCount: items.filter((i) => i.health === 'at-risk').length,
        blockedCount: items.filter((i) => i.health === 'blocked').length,
        completedCount: items.filter((i) => i.status === 'completed').length,
      },
    };
  }
}
```

#### File Reader (`src/server/routes/files.ts`)

Reads spec markdown files relative to the repo root. Path validation prevents directory traversal:

```typescript
router.get('/*', async (req, res) => {
  const relativePath = req.params[0];
  // Only allow reading from specs/ directory
  if (!relativePath.startsWith('specs/')) {
    return res.status(403).json({ error: 'Access denied: only specs/ is readable' });
  }
  const fullPath = path.resolve(process.cwd(), relativePath);
  // Prevent traversal
  if (!fullPath.startsWith(path.resolve(process.cwd(), 'specs'))) {
    return res.status(403).json({ error: 'Path traversal detected' });
  }
  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ content, path: relativePath });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});
```

### Frontend Implementation

#### File Structure (FSD Architecture)

```
apps/roadmap/src/client/
├── App.tsx                          # Root component
├── main.tsx                         # Vite entry point
├── index.css                        # Tailwind directives + Calm Tech vars
├── layers/
│   ├── shared/
│   │   ├── ui/                      # shadcn primitives (Button, Dialog, Tabs, Badge, Select, Table, etc.)
│   │   ├── model/
│   │   │   ├── app-store.ts         # Zustand: viewMode, filters, theme, sidebarOpen
│   │   │   ├── use-theme.ts         # Dark/light toggle
│   │   │   └── use-is-mobile.ts     # Responsive hook
│   │   └── lib/
│   │       ├── cn.ts                # clsx + tailwind-merge utility
│   │       ├── api-client.ts        # fetch wrapper for /api/roadmap/*
│   │       └── constants.ts         # Default port, API base URL
│   ├── entities/
│   │   └── roadmap-item/
│   │       ├── model/
│   │       │   ├── use-roadmap-items.ts    # useQuery for GET /items
│   │       │   ├── use-roadmap-item.ts     # useQuery for GET /items/:id
│   │       │   ├── use-roadmap-meta.ts     # useQuery for GET /meta
│   │       │   ├── use-create-item.ts      # useMutation for POST /items
│   │       │   ├── use-update-item.ts      # useMutation for PATCH /items/:id
│   │       │   ├── use-delete-item.ts      # useMutation for DELETE /items/:id
│   │       │   └── use-reorder-items.ts    # useMutation for PATCH /items/reorder
│   │       └── index.ts                    # Barrel exports
│   ├── features/
│   │   ├── table-view/
│   │   │   ├── ui/
│   │   │   │   ├── TableView.tsx           # TanStack Table with columns, sorting, filtering
│   │   │   │   └── TableColumns.tsx        # Column definitions
│   │   │   └── index.ts
│   │   ├── kanban-view/
│   │   │   ├── ui/
│   │   │   │   ├── KanbanView.tsx          # @hello-pangea/dnd board
│   │   │   │   ├── KanbanColumn.tsx        # Droppable column (by status)
│   │   │   │   └── KanbanCard.tsx          # Draggable item card
│   │   │   └── index.ts
│   │   ├── moscow-view/
│   │   │   ├── ui/
│   │   │   │   ├── MoscowView.tsx          # 4-column CSS grid with DnD
│   │   │   │   ├── MoscowColumn.tsx        # Must/Should/Could/Won't column
│   │   │   │   └── MoscowCard.tsx          # Draggable item card
│   │   │   └── index.ts
│   │   ├── gantt-view/
│   │   │   ├── ui/
│   │   │   │   └── GanttView.tsx           # Kibo UI gantt wrapper
│   │   │   └── index.ts
│   │   ├── item-editor/
│   │   │   ├── ui/
│   │   │   │   ├── ItemEditorDialog.tsx    # shadcn Dialog with form fields
│   │   │   │   └── ItemForm.tsx            # Form with all item fields
│   │   │   └── index.ts
│   │   ├── spec-viewer/
│   │   │   ├── ui/
│   │   │   │   └── SpecViewerDialog.tsx    # Dialog rendering markdown content
│   │   │   └── index.ts
│   │   └── health-bar/
│   │       ├── ui/
│   │       │   └── HealthBar.tsx           # Persistent header with metric badges
│   │       └── index.ts
│   └── widgets/
│       └── app-layout/
│           ├── ui/
│           │   └── AppLayout.tsx           # Shell: HealthBar + Tabs + active view
│           └── index.ts
└── __tests__/
    └── ...
```

#### App Entry (`App.tsx`)

```typescript
export function App() {
  const { viewMode } = useAppStore();

  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <div className="bg-background text-foreground flex h-dvh flex-col">
          <HealthBar />
          <ViewTabs />
          <main className="flex-1 overflow-hidden">
            {viewMode === 'table' && <TableView />}
            {viewMode === 'kanban' && <KanbanView />}
            {viewMode === 'moscow' && <MoscowView />}
            {viewMode === 'gantt' && <GanttView />}
          </main>
        </div>
        <ItemEditorDialog />
        <SpecViewerDialog />
      </MotionConfig>
    </QueryClientProvider>
  );
}
```

#### Zustand Store (`app-store.ts`)

```typescript
type ViewMode = 'table' | 'kanban' | 'moscow' | 'gantt';

interface AppState {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  editingItemId: string | null;
  setEditingItemId: (id: string | null) => void;
  viewingSpecPath: string | null;
  setViewingSpecPath: (path: string | null) => void;
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
}
```

#### TanStack Query Configuration

```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // 30s — data considered fresh
      refetchOnWindowFocus: true, // Re-fetch when tab regains focus
    },
  },
});
```

#### Kanban View (Key Component)

Uses `@hello-pangea/dnd` with 4 columns (one per status). On drag end, calls `useUpdateItem` mutation to change the item's status, then invalidates the query cache for optimistic feel.

#### MoSCoW Grid View

4-column CSS Grid layout (Must/Should/Could/Won't). Uses `@hello-pangea/dnd` with horizontal drag between columns. On drag end, calls `useUpdateItem` to change the item's `moscow` field.

#### Gantt View

Wraps Kibo UI's `gantt` component. Filters items to those with `startDate` and `endDate` set. Items without dates show a prompt to add dates.

#### Health Bar Component

Persistent header bar showing:

- Total items count
- Must-Have % (with warning indicator if > 60%)
- In-progress count
- At-risk + Blocked count (combined with distinct colors)
- Completed count

Uses `useRoadmapMeta()` hook which fetches `GET /api/roadmap/meta`.

### Monorepo Integration

#### `apps/roadmap/package.json`

```json
{
  "name": "@dorkos/roadmap",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently \"tsx watch src/server/index.ts\" \"vite\"",
    "build": "tsc -p tsconfig.server.json && vite build",
    "test": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  },
  "dependencies": {
    "@dorkos/shared": "*",
    "cors": "^2.8.5",
    "express": "^4.21.0",
    "lowdb": "^7.0.0",
    "uuid": "^10.0.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@dorkos/typescript-config": "*",
    "@dorkos/test-utils": "*",
    "@hello-pangea/dnd": "^17.0.0",
    "@tanstack/react-query": "^5.62.0",
    "@tanstack/react-table": "^8.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "lucide-react": "latest",
    "motion": "^12.33.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-markdown": "^9.0.0",
    "tailwindcss": "^4.0.0",
    "vite": "^6.0.0",
    "zustand": "^5.0.0"
  }
}
```

#### `vitest.workspace.ts` Addition

```typescript
export default defineWorkspace([
  'apps/client',
  'apps/server',
  'apps/roadmap', // ← Add this
  'packages/cli',
  'packages/shared',
]);
```

#### Environment Variables

| Variable       | Default                  | Description               |
| -------------- | ------------------------ | ------------------------- |
| `ROADMAP_PORT` | `4243`                   | Express server port       |
| `ROADMAP_PATH` | `./roadmap/roadmap.json` | Path to roadmap data file |

### Python Script Migration

Replace each Python script with a shell script wrapper that calls the Express API. Scripts live at `roadmap/scripts/` (same location, `.sh` instead of `.py`).

| Original                               | Replacement                | API Call                                                                       |
| -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `update_status.py <id> <status>`       | `update_status.sh`         | `curl -X PATCH /api/roadmap/items/<id> -d '{"status":"<status>"}'`             |
| `update_workflow_state.py <id> <json>` | `update_workflow_state.sh` | `curl -X PATCH /api/roadmap/items/<id> -d '{"workflowState":<json>}'`          |
| `link_spec.py <id> <slug>`             | `link_spec.sh`             | `curl -X PATCH /api/roadmap/items/<id> -d '{"linkedArtifacts":{...}}'`         |
| `link_all_specs.py`                    | `link_all_specs.sh`        | Loop: GET all items, PATCH each with missing artifacts                         |
| `find_by_title.py <query>`             | `find_by_title.sh`         | `curl /api/roadmap/items \| jq '.[] \| select(.title \| test("<query>";"i"))'` |
| `slugify.py <title>`                   | `slugify.sh`               | Pure bash: `echo "$1" \| tr '[:upper:]' '[:lower:]' \| sed 's/[^a-z0-9]/-/g'`  |
| `clear_roadmap.py <name> <summary>`    | `clear_roadmap.sh`         | DELETE all items + PATCH meta                                                  |

Each shell script checks if the server is running (`curl -s /api/health`) and prints a helpful message if not.

## User Experience

### Navigation

The app opens to the Table view by default. A tab bar below the health dashboard switches between Table, Kanban, MoSCoW, and Gantt views. The active view persists in Zustand (survives page refresh via local storage).

### Creating Items

Click "New Item" button (top-right). ItemEditorDialog opens with empty form. Required fields: title, type, moscow, status, health, timeHorizon. Optional: description, effort, labels, dates. Submit calls POST to create.

### Editing Items

Click any card (Kanban/MoSCoW) or table row. ItemEditorDialog opens pre-filled. Edit fields and save. Cancel discards changes.

### Drag-and-Drop

- **Kanban view**: Drag cards between status columns (Not Started → In Progress → Completed → On Hold). Drop triggers PATCH with new status.
- **MoSCoW view**: Drag cards between priority columns (Must → Should → Could → Won't). Drop triggers PATCH with new moscow value.
- Both use optimistic updates for instant feedback, with rollback on API error.

### Viewing Specs

Items with `linkedArtifacts` show spec links (icons for ideation, spec, tasks). Clicking a link opens SpecViewerDialog which fetches the markdown via `/api/roadmap/files/specs/...` and renders it.

### Theme

Toggle between light and dark mode via a button in the top-right corner. Follows the Calm Tech color palette (neutral grays + blue accent).

## Testing Strategy

### Server Tests

| Test                    | What It Validates                                                 |
| ----------------------- | ----------------------------------------------------------------- |
| `roadmap-store.test.ts` | CRUD operations on lowdb, health stats calculation, reorder logic |
| `items-routes.test.ts`  | HTTP status codes, Zod validation errors, 404 handling            |
| `meta-routes.test.ts`   | Meta endpoint returns correct stats                               |
| `files-routes.test.ts`  | Path traversal prevention, 404 for missing files                  |

Mock `lowdb` with an in-memory adapter for deterministic tests.

### Client Tests

| Test                        | What It Validates                                |
| --------------------------- | ------------------------------------------------ |
| `HealthBar.test.tsx`        | Renders correct metrics from mock data           |
| `TableView.test.tsx`        | Renders table rows, sorting interactions         |
| `KanbanView.test.tsx`       | Renders columns with correct items per status    |
| `ItemEditorDialog.test.tsx` | Form validation, submit calls mutation           |
| `useRoadmapItems.test.ts`   | TanStack Query hook returns data, handles errors |

Mock `fetch` for API calls. Use React Testing Library with jsdom environment.

### Test Utilities

Add to `packages/test-utils/`:

- `createMockRoadmapItem(overrides?)` — Factory for test items
- `createMockRoadmapMeta(overrides?)` — Factory for meta + health stats

## Performance Considerations

- **Data size**: `lowdb` reads entire JSON into memory. At ~1KB per item, 1000 items = ~1MB — well within limits for a single-user tool.
- **Writes**: Atomic via `write-file-atomic` (lowdb's default). Single-process server means no write contention.
- **Client rendering**: TanStack Table virtualizes rows for large datasets. Kanban/MoSCoW views render all items (acceptable up to ~200 items per column).
- **Bundle size**: Kibo UI components are source-copied (tree-shaken). `@hello-pangea/dnd` is ~45KB gzipped.

## Security Considerations

- **Path traversal**: File reader endpoint validates paths start with `specs/` and resolves to within the project root.
- **Input validation**: All mutations validated with Zod before processing.
- **No auth**: Single-user tool running on localhost. No sensitive data exposure.
- **CORS**: Restricted to localhost origins in development.

## Documentation

- Update `AGENTS.md` with the new `apps/roadmap/` section (commands, ports, env vars)
- Update `roadmap/AGENTS.md` to reflect API-based architecture (replacing vanilla JS notes)
- Add `apps/roadmap/README.md` with setup and development instructions
- Update `contributing/architecture.md` with roadmap app section

## Implementation Phases

### Phase 1: Foundation

- Create `apps/roadmap/` workspace with package.json, tsconfig, vite.config
- Add Zod schemas to `packages/shared/src/roadmap-schemas.ts`
- Implement `RoadmapStore` service with lowdb
- Implement Express API (all CRUD endpoints)
- Basic React app shell with TanStack Query setup
- Health bar component
- Table view (TanStack Table)

### Phase 2: Board Views

- Kanban view with `@hello-pangea/dnd` drag-and-drop
- MoSCoW grid view with DnD
- ItemEditorDialog (create + edit modal)
- Dark/light theme toggle

### Phase 3: Rich Features

- Gantt view with Kibo UI component
- SpecViewerDialog (markdown rendering)
- Drag-and-drop reorder persistence
- Add `startDate`/`endDate`/`order` fields to schema

### Phase 4: Migration & Polish

- Replace Python scripts with shell API wrappers
- Update Claude Code slash commands to work with API
- Update documentation (AGENTS.md, README, contributing)
- Add tests for server and client
- Add to `vitest.workspace.ts`

## Open Questions

None — all clarification questions were resolved during ideation.

## Related ADRs

- **ADR 0001 — Hexagonal Architecture with Transport Interface**: Roadmap app is standalone HTTP-only, no Transport abstraction needed.
- **ADR 0002 — Adopt Feature-Sliced Design (FSD)**: Client follows FSD layers (shared → entities → features → widgets).
- **ADR 0005 — Zustand for UI State, TanStack Query for Server State**: Roadmap app uses both per this pattern.

## References

- [Ideation Document](./01-ideation.md)
- [Research: Roadmap App Best Practices](../../research/20260218_roadmap-app-best-practices.md)
- [Kibo UI — Kanban & Gantt Components](https://www.kibo-ui.com/)
- [@hello-pangea/dnd — React DnD Library](https://github.com/hello-pangea/dnd)
- [lowdb — Simple JSON Database](https://github.com/typicode/lowdb)
- [TanStack Table Documentation](https://tanstack.com/table/latest)
- [DorkOS Design System](../../contributing/design-system.md)
- [DorkOS Architecture](../../contributing/architecture.md)
