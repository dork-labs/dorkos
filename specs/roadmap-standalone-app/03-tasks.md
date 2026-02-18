# Task Breakdown: Roadmap Standalone App
Generated: 2026-02-18
Source: specs/roadmap-standalone-app/02-specification.md
Last Decompose: 2026-02-18

## Overview

Build a standalone roadmap visualization and management app at `apps/roadmap/` within the DorkOS Turborepo monorepo. The app provides a React 19 SPA with 4 views (Table, Kanban, MoSCoW Grid, Gantt), backed by an Express server with lowdb persistence to `roadmap/roadmap.json`. Includes drag-and-drop management, item editing, health dashboard, and spec viewing.

---

## Phase 1: Foundation

### Task 1.1: Scaffold `apps/roadmap/` Workspace
**Description**: Create the workspace directory structure, package.json, TypeScript configs, and Vite config for the roadmap app.
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Technical Requirements**:
- Create `apps/roadmap/` directory with full structure
- Register as Turborepo workspace
- Use `@dorkos/typescript-config` presets
- Vite 6 with React plugin, Tailwind CSS 4 plugin, path aliases

**Implementation Steps**:

1. Create `apps/roadmap/package.json`:
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
    "concurrently": "^9.0.0",
    "lucide-react": "latest",
    "motion": "^12.33.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-markdown": "^9.0.0",
    "tailwindcss": "^4.0.0",
    "tsx": "^4.0.0",
    "vite": "^6.0.0",
    "zustand": "^5.0.0"
  }
}
```

2. Create `apps/roadmap/tsconfig.json` extending `@dorkos/typescript-config/react`:
```json
{
  "extends": "@dorkos/typescript-config/react",
  "compilerOptions": {
    "paths": { "@/*": ["./src/client/*"] }
  },
  "include": ["src/client/**/*"]
}
```

3. Create `apps/roadmap/tsconfig.server.json` extending `@dorkos/typescript-config/node`:
```json
{
  "extends": "@dorkos/typescript-config/node",
  "compilerOptions": {
    "outDir": "dist/server",
    "rootDir": "src/server"
  },
  "include": ["src/server/**/*"]
}
```

4. Create `apps/roadmap/vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/client',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/client'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:4243',
    },
  },
});
```

5. Create directory structure:
```
apps/roadmap/src/
├── server/
│   ├── index.ts
│   ├── app.ts
│   ├── routes/
│   ├── services/
│   └── lib/
└── client/
    ├── App.tsx
    ├── main.tsx
    ├── index.css
    ├── index.html
    └── layers/
        ├── shared/
        ├── entities/
        ├── features/
        └── widgets/
```

6. Create `src/client/index.html` (Vite entry):
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DorkOS Roadmap</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/main.tsx"></script>
</body>
</html>
```

7. Create `src/client/index.css` with Tailwind directives:
```css
@import "tailwindcss";
```

8. Create `src/client/main.tsx`:
```typescript
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

9. Run `npm install` from the monorepo root.

**Acceptance Criteria**:
- [ ] `apps/roadmap/` exists with complete directory structure
- [ ] `npm install` succeeds with no workspace resolution errors
- [ ] `npx turbo typecheck --filter=@dorkos/roadmap` passes
- [ ] `npx turbo build --filter=@dorkos/roadmap` produces dist/client and dist/server
- [ ] Vite dev server starts on port 5174

---

### Task 1.2: Add Roadmap Zod Schemas to Shared Package
**Description**: Create `packages/shared/src/roadmap-schemas.ts` with all Zod schemas for the roadmap data model, and register the export in package.json.
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:
- All schemas must have `.openapi()` metadata for future OpenAPI generation
- Schemas must match the existing `roadmap/schema.json` structure
- Export inferred TypeScript types alongside schemas
- Register in `packages/shared/package.json` exports map

**Implementation Steps**:

1. Create `packages/shared/src/roadmap-schemas.ts` with the complete schema definitions:

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

export const TimeHorizonSchema = z
  .enum(['now', 'next', 'later'])
  .openapi('TimeHorizon');

// === Item Schema ===

export const LinkedArtifactsSchema = z.object({
  specSlug: z.string().optional(),
  ideationPath: z.string().optional(),
  specPath: z.string().optional(),
  tasksPath: z.string().optional(),
  implementationPath: z.string().optional(),
}).openapi('LinkedArtifacts');

export const IdeationContextSchema = z.object({
  targetUsers: z.array(z.string()).optional(),
  painPoints: z.array(z.string()).optional(),
  successCriteria: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
}).openapi('IdeationContext');

export const WorkflowStateSchema = z.object({
  phase: z.enum([
    'not-started', 'ideating', 'specifying', 'decomposing',
    'implementing', 'testing', 'committing', 'releasing', 'completed',
  ]).optional(),
  specSlug: z.string().optional(),
  tasksTotal: z.number().int().min(0).optional(),
  tasksCompleted: z.number().int().min(0).optional(),
  lastSession: z.string().datetime().optional(),
  attempts: z.number().int().min(0).optional(),
  blockers: z.array(z.string()).optional(),
}).openapi('WorkflowState');

export const RoadmapItemSchema = z.object({
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
}).openapi('RoadmapItem');

export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;

// === Request Schemas ===

export const CreateItemRequestSchema = RoadmapItemSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .openapi('CreateItemRequest');

export const UpdateItemRequestSchema = RoadmapItemSchema
  .partial()
  .omit({ id: true, createdAt: true })
  .openapi('UpdateItemRequest');

export const ReorderRequestSchema = z.object({
  orderedIds: z.array(z.string().uuid()),
}).openapi('ReorderRequest');

// === Meta Schema ===

export const TimeHorizonConfigSchema = z.object({
  label: z.string(),
  description: z.string(),
});

export const RoadmapMetaSchema = z.object({
  projectName: z.string().min(1).max(100),
  projectSummary: z.string().max(500),
  lastUpdated: z.string().datetime(),
  timeHorizons: z.object({
    now: TimeHorizonConfigSchema,
    next: TimeHorizonConfigSchema,
    later: TimeHorizonConfigSchema,
  }),
}).openapi('RoadmapMeta');

export type RoadmapMeta = z.infer<typeof RoadmapMetaSchema>;

// === Health Stats ===

export const HealthStatsSchema = z.object({
  totalItems: z.number(),
  mustHavePercent: z.number(),
  inProgressCount: z.number(),
  atRiskCount: z.number(),
  blockedCount: z.number(),
  completedCount: z.number(),
}).openapi('HealthStats');

export type HealthStats = z.infer<typeof HealthStatsSchema>;
```

2. Add export to `packages/shared/package.json` exports map:
```json
"./roadmap-schemas": { "types": "./src/roadmap-schemas.ts", "default": "./dist/roadmap-schemas.js" }
```

**Acceptance Criteria**:
- [ ] `packages/shared/src/roadmap-schemas.ts` exists with all schemas
- [ ] Types are importable: `import { RoadmapItem } from '@dorkos/shared/roadmap-schemas'`
- [ ] `npx turbo typecheck --filter=@dorkos/shared` passes
- [ ] Schema validation works: `RoadmapItemSchema.safeParse(validItem).success === true`
- [ ] Invalid data is rejected: `CreateItemRequestSchema.safeParse({}).success === false`

---

### Task 1.3: Implement RoadmapStore Service with lowdb
**Description**: Create the data layer service that wraps lowdb for atomic JSON persistence of roadmap items.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None (depends on 1.1 + 1.2)

**Technical Requirements**:
- lowdb v7 with JSONFile adapter for atomic writes
- All CRUD operations: list, get, create, update, delete, reorder
- Health stats computation from items array
- Meta data access (project name, summary, time horizons)
- UUID v4 generation for new items via `uuid` package

**Implementation Steps**:

1. Create `apps/roadmap/src/server/services/roadmap-store.ts`:

```typescript
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { v4 as uuidv4 } from 'uuid';
import type { RoadmapItem, RoadmapMeta, HealthStats } from '@dorkos/shared/roadmap-schemas';

interface HorizonConfig {
  label: string;
  description: string;
}

interface RoadmapData {
  projectName: string;
  projectSummary: string;
  lastUpdated: string;
  timeHorizons: { now: HorizonConfig; next: HorizonConfig; later: HorizonConfig };
  items: RoadmapItem[];
}

type CreateItemInput = Omit<RoadmapItem, 'id' | 'createdAt' | 'updatedAt'>;

export class RoadmapStore {
  private db: Low<RoadmapData>;

  constructor(filePath: string) {
    const adapter = new JSONFile<RoadmapData>(filePath);
    this.db = new Low(adapter, {
      projectName: '',
      projectSummary: '',
      lastUpdated: '',
      timeHorizons: {
        now: { label: '', description: '' },
        next: { label: '', description: '' },
        later: { label: '', description: '' },
      },
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
    return this.db.data.items.find(item => item.id === id);
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
    const idx = this.db.data.items.findIndex(item => item.id === id);
    if (idx === -1) return null;

    const now = new Date().toISOString();
    this.db.data.items[idx] = { ...this.db.data.items[idx], ...patch, updatedAt: now };
    this.db.data.lastUpdated = now;
    await this.db.write();
    return this.db.data.items[idx];
  }

  async deleteItem(id: string): Promise<boolean> {
    const idx = this.db.data.items.findIndex(item => item.id === id);
    if (idx === -1) return false;

    this.db.data.items.splice(idx, 1);
    this.db.data.lastUpdated = new Date().toISOString();
    await this.db.write();
    return true;
  }

  async reorder(orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, index) => {
      const item = this.db.data.items.find(i => i.id === id);
      if (item) item.order = index;
    });
    this.db.data.lastUpdated = new Date().toISOString();
    await this.db.write();
  }

  getMeta(): RoadmapMeta & { health: HealthStats } {
    const items = this.db.data.items;
    const mustHaves = items.filter(i => i.moscow === 'must-have');
    return {
      projectName: this.db.data.projectName,
      projectSummary: this.db.data.projectSummary,
      lastUpdated: this.db.data.lastUpdated,
      timeHorizons: this.db.data.timeHorizons,
      health: {
        totalItems: items.length,
        mustHavePercent: items.length > 0 ? Math.round((mustHaves.length / items.length) * 100) : 0,
        inProgressCount: items.filter(i => i.status === 'in-progress').length,
        atRiskCount: items.filter(i => i.health === 'at-risk').length,
        blockedCount: items.filter(i => i.health === 'blocked').length,
        completedCount: items.filter(i => i.status === 'completed').length,
      },
    };
  }
}
```

2. Create `apps/roadmap/src/server/services/__tests__/roadmap-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { RoadmapStore } from '../roadmap-store';

// Test with in-memory lowdb (mock JSONFile adapter)
// Use vi.mock('lowdb/node') to provide a Memory adapter
// Test all CRUD operations and health stats

describe('RoadmapStore', () => {
  let store: RoadmapStore;

  beforeEach(async () => {
    // Initialize with in-memory adapter for deterministic tests
    store = new RoadmapStore(':memory:'); // or mock
    await store.init();
  });

  it('creates an item with generated id and timestamps', async () => {
    const item = await store.createItem({
      title: 'Test Feature',
      type: 'feature',
      moscow: 'must-have',
      status: 'not-started',
      health: 'on-track',
      timeHorizon: 'now',
    });
    expect(item.id).toBeDefined();
    expect(item.createdAt).toBeDefined();
    expect(item.updatedAt).toBeDefined();
    expect(item.title).toBe('Test Feature');
  });

  it('lists all items', () => {
    const items = store.listItems();
    expect(Array.isArray(items)).toBe(true);
  });

  it('gets item by id', async () => {
    const created = await store.createItem({ title: 'Find Me', type: 'feature', moscow: 'must-have', status: 'not-started', health: 'on-track', timeHorizon: 'now' });
    const found = store.getItem(created.id);
    expect(found?.title).toBe('Find Me');
  });

  it('returns undefined for missing item', () => {
    expect(store.getItem('nonexistent')).toBeUndefined();
  });

  it('updates an item', async () => {
    const created = await store.createItem({ title: 'Original', type: 'feature', moscow: 'must-have', status: 'not-started', health: 'on-track', timeHorizon: 'now' });
    const updated = await store.updateItem(created.id, { title: 'Updated' });
    expect(updated?.title).toBe('Updated');
    expect(updated?.updatedAt).not.toBe(created.updatedAt);
  });

  it('returns null when updating nonexistent item', async () => {
    const result = await store.updateItem('nonexistent', { title: 'X' });
    expect(result).toBeNull();
  });

  it('deletes an item', async () => {
    const created = await store.createItem({ title: 'Delete Me', type: 'feature', moscow: 'must-have', status: 'not-started', health: 'on-track', timeHorizon: 'now' });
    const deleted = await store.deleteItem(created.id);
    expect(deleted).toBe(true);
    expect(store.getItem(created.id)).toBeUndefined();
  });

  it('returns false when deleting nonexistent item', async () => {
    expect(await store.deleteItem('nonexistent')).toBe(false);
  });

  it('reorders items by setting order field', async () => {
    const a = await store.createItem({ title: 'A', type: 'feature', moscow: 'must-have', status: 'not-started', health: 'on-track', timeHorizon: 'now' });
    const b = await store.createItem({ title: 'B', type: 'feature', moscow: 'must-have', status: 'not-started', health: 'on-track', timeHorizon: 'now' });
    await store.reorder([b.id, a.id]);
    expect(store.getItem(b.id)?.order).toBe(0);
    expect(store.getItem(a.id)?.order).toBe(1);
  });

  it('computes health stats correctly', async () => {
    await store.createItem({ title: 'Must', type: 'feature', moscow: 'must-have', status: 'in-progress', health: 'at-risk', timeHorizon: 'now' });
    await store.createItem({ title: 'Should', type: 'feature', moscow: 'should-have', status: 'completed', health: 'on-track', timeHorizon: 'next' });
    const meta = store.getMeta();
    expect(meta.health.totalItems).toBe(2);
    expect(meta.health.mustHavePercent).toBe(50);
    expect(meta.health.inProgressCount).toBe(1);
    expect(meta.health.atRiskCount).toBe(1);
    expect(meta.health.completedCount).toBe(1);
  });
});
```

**Acceptance Criteria**:
- [ ] `RoadmapStore` class implements all CRUD operations (list, get, create, update, delete, reorder)
- [ ] `getMeta()` returns project metadata with computed health stats
- [ ] `createItem()` generates UUID v4 id and ISO timestamps
- [ ] `updateItem()` updates `updatedAt` timestamp on every mutation
- [ ] `deleteItem()` returns true on success, false on not-found
- [ ] `reorder()` sets `order` field on each item by position in the provided array
- [ ] Unit tests pass with mocked lowdb adapter
- [ ] Health stats: mustHavePercent is 0 when no items exist (no division by zero)

---

### Task 1.4: Implement Express API Routes
**Description**: Create the Express app factory and all route handlers for items CRUD, meta, files, and health check.
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 1.5 (after 1.1 + 1.2 are done)

**Technical Requirements**:
- Express app factory pattern matching DorkOS `apps/server/src/app.ts`
- Zod validation on all mutation endpoints (POST, PATCH)
- Proper HTTP status codes: 201 for create, 204 for delete, 400 for validation, 404 for not found
- Path traversal prevention on file reader endpoint
- Health check endpoint at `/api/health`
- SPA fallback in production mode

**Implementation Steps**:

1. Create `apps/roadmap/src/server/app.ts`:

```typescript
import express from 'express';
import cors from 'cors';
import path from 'path';
import { createItemRoutes } from './routes/items';
import { createMetaRoutes } from './routes/meta';
import { createFileRoutes } from './routes/files';
import type { RoadmapStore } from './services/roadmap-store';

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
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Production: serve React SPA
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, '../../dist/client');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  return app;
}
```

2. Create `apps/roadmap/src/server/index.ts`:

```typescript
import { createApp } from './app';
import { RoadmapStore } from './services/roadmap-store';

const port = parseInt(process.env.ROADMAP_PORT || '4243', 10);
const roadmapPath = process.env.ROADMAP_PATH || './roadmap/roadmap.json';

async function main() {
  const store = new RoadmapStore(roadmapPath);
  await store.init();

  const app = createApp(store);

  app.listen(port, () => {
    console.log(`Roadmap server listening on http://localhost:${port}`);
  });
}

main().catch(console.error);
```

3. Create `apps/roadmap/src/server/routes/items.ts`:

```typescript
import { Router } from 'express';
import { CreateItemRequestSchema, UpdateItemRequestSchema, ReorderRequestSchema } from '@dorkos/shared/roadmap-schemas';
import type { RoadmapStore } from '../services/roadmap-store';

export function createItemRoutes(store: RoadmapStore): Router {
  const router = Router();

  // GET /api/roadmap/items — List all items
  router.get('/', (_req, res) => {
    res.json(store.listItems());
  });

  // POST /api/roadmap/items — Create item
  router.post('/', async (req, res) => {
    const parsed = CreateItemRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
    }
    const item = await store.createItem(parsed.data);
    res.status(201).json(item);
  });

  // PATCH /api/roadmap/items/reorder — Reorder items (must be before :id route)
  router.patch('/reorder', async (req, res) => {
    const parsed = ReorderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
    }
    await store.reorder(parsed.data.orderedIds);
    res.json({ ok: true });
  });

  // GET /api/roadmap/items/:id — Get single item
  router.get('/:id', (req, res) => {
    const item = store.getItem(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(item);
  });

  // PATCH /api/roadmap/items/:id — Update item
  router.patch('/:id', async (req, res) => {
    const parsed = UpdateItemRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
    }
    const item = await store.updateItem(req.params.id, parsed.data);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(item);
  });

  // DELETE /api/roadmap/items/:id — Delete item
  router.delete('/:id', async (req, res) => {
    const deleted = await store.deleteItem(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.status(204).send();
  });

  return router;
}
```

4. Create `apps/roadmap/src/server/routes/meta.ts`:

```typescript
import { Router } from 'express';
import type { RoadmapStore } from '../services/roadmap-store';

export function createMetaRoutes(store: RoadmapStore): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(store.getMeta());
  });

  return router;
}
```

5. Create `apps/roadmap/src/server/routes/files.ts`:

```typescript
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';

export function createFileRoutes(): Router {
  const router = Router();

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

  return router;
}
```

6. Create `apps/roadmap/src/server/lib/logger.ts`:

```typescript
export const logger = {
  info: (...args: unknown[]) => console.log('[roadmap]', ...args),
  error: (...args: unknown[]) => console.error('[roadmap]', ...args),
  warn: (...args: unknown[]) => console.warn('[roadmap]', ...args),
};
```

7. Write route tests at `apps/roadmap/src/server/routes/__tests__/items-routes.test.ts`:
- Test GET /items returns array
- Test POST /items with valid body returns 201
- Test POST /items with invalid body returns 400
- Test GET /items/:id with valid id returns item
- Test GET /items/:id with invalid id returns 404
- Test PATCH /items/:id with valid body returns updated item
- Test PATCH /items/:id with nonexistent id returns 404
- Test DELETE /items/:id returns 204
- Test DELETE /items/:id with nonexistent id returns 404
- Test PATCH /items/reorder with valid body returns 200

8. Write `apps/roadmap/src/server/routes/__tests__/files-routes.test.ts`:
- Test GET /files/specs/valid-path returns content
- Test GET /files/etc/passwd returns 403 (not in specs/)
- Test GET /files/specs/../../../etc/passwd returns 403 (traversal)
- Test GET /files/specs/nonexistent returns 404

**Acceptance Criteria**:
- [ ] All 8 API endpoints respond with correct status codes
- [ ] POST /items validates request body with Zod, returns 400 on invalid input
- [ ] PATCH /items/:id validates body and returns 404 for unknown IDs
- [ ] DELETE /items/:id returns 204 on success, 404 on not found
- [ ] PATCH /items/reorder accepts array of UUIDs and sets order
- [ ] GET /meta returns project metadata + health stats
- [ ] GET /files/* prevents path traversal (403 for non-specs/ paths)
- [ ] GET /health returns `{ status: 'ok' }`
- [ ] Route tests pass for all endpoints

---

### Task 1.5: React App Shell with TanStack Query and Zustand
**Description**: Create the basic React app structure with TanStack Query client, Zustand store, shared utilities, and entity hooks for data fetching.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 1.4

**Technical Requirements**:
- TanStack Query v5 with 30s staleTime and refetchOnWindowFocus
- Zustand store for UI state (viewMode, editingItemId, viewingSpecPath, theme)
- API client utility wrapping fetch for `/api/roadmap/*` endpoints
- Entity hooks for all CRUD operations using TanStack Query
- FSD layer structure

**Implementation Steps**:

1. Create `apps/roadmap/src/client/layers/shared/lib/cn.ts`:
```typescript
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

2. Create `apps/roadmap/src/client/layers/shared/lib/constants.ts`:
```typescript
export const API_BASE = '/api/roadmap';
```

3. Create `apps/roadmap/src/client/layers/shared/lib/api-client.ts`:
```typescript
import { API_BASE } from './constants';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path: string) => request<void>(path, { method: 'DELETE' }),
};
```

4. Create `apps/roadmap/src/client/layers/shared/model/app-store.ts`:
```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ViewMode = 'table' | 'kanban' | 'moscow' | 'gantt';

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

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      viewMode: 'table',
      setViewMode: (mode) => set({ viewMode: mode }),
      editingItemId: null,
      setEditingItemId: (id) => set({ editingItemId: id }),
      viewingSpecPath: null,
      setViewingSpecPath: (path) => set({ viewingSpecPath: path }),
      theme: 'system',
      setTheme: (theme) => set({ theme }),
    }),
    { name: 'roadmap-app-store' }
  )
);
```

5. Create entity hooks at `apps/roadmap/src/client/layers/entities/roadmap-item/model/`:

- `use-roadmap-items.ts`:
```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '@/layers/shared/lib/api-client';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

export function useRoadmapItems() {
  return useQuery({
    queryKey: ['roadmap-items'],
    queryFn: () => api.get<RoadmapItem[]>('/items'),
  });
}
```

- `use-roadmap-meta.ts`:
```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '@/layers/shared/lib/api-client';
import type { RoadmapMeta, HealthStats } from '@dorkos/shared/roadmap-schemas';

export function useRoadmapMeta() {
  return useQuery({
    queryKey: ['roadmap-meta'],
    queryFn: () => api.get<RoadmapMeta & { health: HealthStats }>('/meta'),
  });
}
```

- `use-create-item.ts`:
```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/layers/shared/lib/api-client';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

export function useCreateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<RoadmapItem, 'id' | 'createdAt' | 'updatedAt'>) =>
      api.post<RoadmapItem>('/items', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roadmap-items'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap-meta'] });
    },
  });
}
```

- `use-update-item.ts`:
```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/layers/shared/lib/api-client';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

export function useUpdateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<RoadmapItem> & { id: string }) =>
      api.patch<RoadmapItem>(`/items/${id}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roadmap-items'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap-meta'] });
    },
  });
}
```

- `use-delete-item.ts`:
```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/layers/shared/lib/api-client';

export function useDeleteItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/items/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roadmap-items'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap-meta'] });
    },
  });
}
```

- `use-reorder-items.ts`:
```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/layers/shared/lib/api-client';

export function useReorderItems() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) =>
      api.patch<void>('/items/reorder', { orderedIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roadmap-items'] });
    },
  });
}
```

- `index.ts` barrel:
```typescript
export { useRoadmapItems } from './model/use-roadmap-items';
export { useRoadmapMeta } from './model/use-roadmap-meta';
export { useCreateItem } from './model/use-create-item';
export { useUpdateItem } from './model/use-update-item';
export { useDeleteItem } from './model/use-delete-item';
export { useReorderItems } from './model/use-reorder-items';
```

6. Create `apps/roadmap/src/client/App.tsx`:
```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <div className="bg-background text-foreground flex h-dvh flex-col">
          <h1 className="p-4 text-xl font-bold">DorkOS Roadmap</h1>
          <p className="px-4 text-sm text-muted-foreground">App shell loaded. Views coming soon.</p>
        </div>
      </MotionConfig>
    </QueryClientProvider>
  );
}
```

**Acceptance Criteria**:
- [ ] App renders in browser with TanStack Query provider
- [ ] Zustand store persists viewMode across refreshes (localStorage)
- [ ] API client correctly fetches from `/api/roadmap/*` endpoints
- [ ] All 6 entity hooks (useRoadmapItems, useRoadmapMeta, useCreateItem, useUpdateItem, useDeleteItem, useReorderItems) are implemented
- [ ] Barrel exports work: `import { useRoadmapItems } from '@/layers/entities/roadmap-item'`
- [ ] `npx turbo typecheck --filter=@dorkos/roadmap` passes

---

### Task 1.6: Health Bar and Table View
**Description**: Implement the HealthBar header component and the TableView with TanStack Table for sorting and filtering.
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.5
**Can run parallel with**: None

**Technical Requirements**:
- HealthBar: persistent header showing total items, must-have %, in-progress, at-risk+blocked, completed
- Must-have % shows warning indicator if > 60%
- TableView: TanStack Table v8 with sortable columns
- Columns: title, type, moscow, status, health, timeHorizon, effort, updatedAt
- Click row to open editor (sets editingItemId in Zustand)
- "New Item" button in header area

**Implementation Steps**:

1. Create `apps/roadmap/src/client/layers/features/health-bar/ui/HealthBar.tsx`:

```typescript
import { useRoadmapMeta } from '@/layers/entities/roadmap-item';
import { AlertTriangle } from 'lucide-react';

export function HealthBar() {
  const { data, isLoading } = useRoadmapMeta();

  if (isLoading || !data) {
    return <div className="border-b bg-muted/50 px-4 py-3 text-sm">Loading...</div>;
  }

  const { health } = data;

  return (
    <header className="flex items-center gap-6 border-b bg-muted/50 px-4 py-3">
      <h1 className="text-lg font-semibold">{data.projectName || 'Roadmap'}</h1>
      <div className="flex items-center gap-4 text-sm">
        <span>{health.totalItems} items</span>
        <span className="flex items-center gap-1">
          Must-Have: {health.mustHavePercent}%
          {health.mustHavePercent > 60 && (
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          )}
        </span>
        <span className="text-blue-500">{health.inProgressCount} in progress</span>
        <span className="text-amber-500">{health.atRiskCount} at risk</span>
        <span className="text-red-500">{health.blockedCount} blocked</span>
        <span className="text-green-500">{health.completedCount} completed</span>
      </div>
    </header>
  );
}
```

2. Create `apps/roadmap/src/client/layers/features/table-view/ui/TableColumns.tsx`:

Define column definitions for TanStack Table:
- title (sortable, clickable to edit)
- type (badge, sortable)
- moscow (badge with color coding, sortable)
- status (badge, sortable)
- health (badge with color coding, sortable)
- timeHorizon (sortable)
- effort (numeric, sortable)
- updatedAt (date formatted, sortable)

3. Create `apps/roadmap/src/client/layers/features/table-view/ui/TableView.tsx`:

```typescript
import { useReactTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel, flexRender } from '@tanstack/react-table';
import { useRoadmapItems } from '@/layers/entities/roadmap-item';
import { useAppStore } from '@/layers/shared/model/app-store';
import { columns } from './TableColumns';

export function TableView() {
  const { data: items = [], isLoading } = useRoadmapItems();
  const setEditingItemId = useAppStore((s) => s.setEditingItemId);

  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  if (isLoading) return <div className="p-4">Loading...</div>;

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          {table.getHeaderGroups().map(headerGroup => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map(header => (
                <th
                  key={header.id}
                  className="cursor-pointer px-3 py-2 text-left font-medium"
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {{ asc: ' ↑', desc: ' ↓' }[header.column.getIsSorted() as string] ?? ''}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr
              key={row.id}
              className="cursor-pointer border-t hover:bg-muted/50"
              onClick={() => setEditingItemId(row.original.id)}
            >
              {row.getVisibleCells().map(cell => (
                <td key={cell.id} className="px-3 py-2">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

4. Create ViewTabs component for switching between views.

5. Update `App.tsx` to include HealthBar and TableView as the initial view.

6. Write tests:
- `HealthBar.test.tsx`: renders metrics from mock data, shows warning when must-have > 60%
- `TableView.test.tsx`: renders rows, sorting interactions work

**Acceptance Criteria**:
- [ ] HealthBar displays total items, must-have %, in-progress, at-risk, blocked, completed counts
- [ ] HealthBar shows warning icon when must-have % exceeds 60%
- [ ] TableView renders all items as table rows with correct columns
- [ ] Columns are sortable (click header to toggle asc/desc)
- [ ] Clicking a table row sets editingItemId in Zustand store
- [ ] ViewTabs component renders and switches between views
- [ ] "New Item" button is visible and sets editingItemId to 'new'
- [ ] Component tests pass

---

## Phase 2: Board Views

### Task 2.1: Kanban View with Drag-and-Drop
**Description**: Implement the Kanban board view using `@hello-pangea/dnd` with 4 columns (one per status). Drag between columns changes item status via API.
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.5
**Can run parallel with**: Task 2.2

**Technical Requirements**:
- 4 columns: Not Started, In Progress, Completed, On Hold
- Items appear as cards in their status column
- Drag card between columns triggers PATCH to update status
- Optimistic update: move card immediately, rollback on API error
- Cards show: title, type badge, moscow badge, health indicator

**Implementation Steps**:

1. Create `apps/roadmap/src/client/layers/features/kanban-view/ui/KanbanCard.tsx`:

```typescript
import { Draggable } from '@hello-pangea/dnd';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';
import { useAppStore } from '@/layers/shared/model/app-store';

interface KanbanCardProps {
  item: RoadmapItem;
  index: number;
}

export function KanbanCard({ item, index }: KanbanCardProps) {
  const setEditingItemId = useAppStore((s) => s.setEditingItemId);

  return (
    <Draggable draggableId={item.id} index={index}>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className="rounded-lg border bg-card p-3 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => setEditingItemId(item.id)}
        >
          <p className="font-medium text-sm">{item.title}</p>
          <div className="mt-2 flex gap-1.5 flex-wrap">
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{item.type}</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{item.moscow}</span>
          </div>
        </div>
      )}
    </Draggable>
  );
}
```

2. Create `apps/roadmap/src/client/layers/features/kanban-view/ui/KanbanColumn.tsx`:

```typescript
import { Droppable } from '@hello-pangea/dnd';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';
import { KanbanCard } from './KanbanCard';

interface KanbanColumnProps {
  status: string;
  label: string;
  items: RoadmapItem[];
}

export function KanbanColumn({ status, label, items }: KanbanColumnProps) {
  return (
    <div className="flex flex-col min-w-[280px] w-[280px]">
      <h3 className="mb-2 px-2 text-sm font-semibold text-muted-foreground">
        {label} ({items.length})
      </h3>
      <Droppable droppableId={status}>
        {(provided) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className="flex flex-col gap-2 rounded-lg bg-muted/30 p-2 min-h-[200px]"
          >
            {items.map((item, index) => (
              <KanbanCard key={item.id} item={item} index={index} />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}
```

3. Create `apps/roadmap/src/client/layers/features/kanban-view/ui/KanbanView.tsx`:

```typescript
import { DragDropContext, type DropResult } from '@hello-pangea/dnd';
import { useRoadmapItems, useUpdateItem } from '@/layers/entities/roadmap-item';
import { KanbanColumn } from './KanbanColumn';

const STATUS_COLUMNS = [
  { status: 'not-started', label: 'Not Started' },
  { status: 'in-progress', label: 'In Progress' },
  { status: 'completed', label: 'Completed' },
  { status: 'on-hold', label: 'On Hold' },
] as const;

export function KanbanView() {
  const { data: items = [] } = useRoadmapItems();
  const updateItem = useUpdateItem();

  function handleDragEnd(result: DropResult) {
    if (!result.destination) return;
    const { draggableId, destination } = result;
    const newStatus = destination.droppableId;

    updateItem.mutate({
      id: draggableId,
      status: newStatus as RoadmapItem['status'],
    });
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex gap-4 overflow-x-auto p-4">
        {STATUS_COLUMNS.map(({ status, label }) => (
          <KanbanColumn
            key={status}
            status={status}
            label={label}
            items={items.filter(i => i.status === status)}
          />
        ))}
      </div>
    </DragDropContext>
  );
}
```

4. Create barrel `apps/roadmap/src/client/layers/features/kanban-view/index.ts`:
```typescript
export { KanbanView } from './ui/KanbanView';
```

5. Write `KanbanView.test.tsx`:
- Renders 4 columns with correct status labels
- Items appear in correct columns based on status
- Mock DnD context for rendering tests

**Acceptance Criteria**:
- [ ] 4 status columns render: Not Started, In Progress, Completed, On Hold
- [ ] Items appear in correct column based on their status
- [ ] Dragging a card to a different column triggers PATCH with new status
- [ ] Cards show title, type badge, and moscow badge
- [ ] Clicking a card opens the item editor (sets editingItemId)
- [ ] Column shows item count in header
- [ ] Horizontal scroll works when columns overflow viewport
- [ ] Component test passes

---

### Task 2.2: MoSCoW Grid View with Drag-and-Drop
**Description**: Implement the MoSCoW priority grid view with 4 columns (Must/Should/Could/Won't) and drag-and-drop to change priority.
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.5
**Can run parallel with**: Task 2.1

**Technical Requirements**:
- 4-column CSS Grid layout: Must Have, Should Have, Could Have, Won't Have
- Cards show: title, status badge, health indicator, type
- Drag between columns triggers PATCH to update moscow field
- Same DnD library as Kanban (`@hello-pangea/dnd`)
- Color-coded column headers (green/blue/amber/gray)

**Implementation Steps**:

1. Create `apps/roadmap/src/client/layers/features/moscow-view/ui/MoscowCard.tsx`:

Similar to KanbanCard but shows status instead of moscow (since moscow is already implied by column):
```typescript
import { Draggable } from '@hello-pangea/dnd';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';
import { useAppStore } from '@/layers/shared/model/app-store';

interface MoscowCardProps {
  item: RoadmapItem;
  index: number;
}

export function MoscowCard({ item, index }: MoscowCardProps) {
  const setEditingItemId = useAppStore((s) => s.setEditingItemId);

  return (
    <Draggable draggableId={item.id} index={index}>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className="rounded-lg border bg-card p-3 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => setEditingItemId(item.id)}
        >
          <p className="font-medium text-sm">{item.title}</p>
          <div className="mt-2 flex gap-1.5 flex-wrap">
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{item.status}</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{item.type}</span>
          </div>
        </div>
      )}
    </Draggable>
  );
}
```

2. Create `apps/roadmap/src/client/layers/features/moscow-view/ui/MoscowColumn.tsx`:

```typescript
import { Droppable } from '@hello-pangea/dnd';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';
import { MoscowCard } from './MoscowCard';

interface MoscowColumnProps {
  moscow: string;
  label: string;
  colorClass: string;
  items: RoadmapItem[];
}

export function MoscowColumn({ moscow, label, colorClass, items }: MoscowColumnProps) {
  return (
    <div className="flex flex-col min-h-0">
      <h3 className={`mb-2 px-2 text-sm font-semibold ${colorClass}`}>
        {label} ({items.length})
      </h3>
      <Droppable droppableId={moscow}>
        {(provided) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className="flex flex-col gap-2 rounded-lg bg-muted/30 p-2 min-h-[200px] overflow-y-auto"
          >
            {items.map((item, index) => (
              <MoscowCard key={item.id} item={item} index={index} />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}
```

3. Create `apps/roadmap/src/client/layers/features/moscow-view/ui/MoscowView.tsx`:

```typescript
import { DragDropContext, type DropResult } from '@hello-pangea/dnd';
import { useRoadmapItems, useUpdateItem } from '@/layers/entities/roadmap-item';
import { MoscowColumn } from './MoscowColumn';

const MOSCOW_COLUMNS = [
  { moscow: 'must-have', label: 'Must Have', colorClass: 'text-green-600' },
  { moscow: 'should-have', label: 'Should Have', colorClass: 'text-blue-600' },
  { moscow: 'could-have', label: 'Could Have', colorClass: 'text-amber-600' },
  { moscow: 'wont-have', label: "Won't Have", colorClass: 'text-gray-500' },
] as const;

export function MoscowView() {
  const { data: items = [] } = useRoadmapItems();
  const updateItem = useUpdateItem();

  function handleDragEnd(result: DropResult) {
    if (!result.destination) return;
    const { draggableId, destination } = result;
    const newMoscow = destination.droppableId;

    updateItem.mutate({
      id: draggableId,
      moscow: newMoscow as RoadmapItem['moscow'],
    });
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="grid grid-cols-4 gap-4 p-4 h-full">
        {MOSCOW_COLUMNS.map(({ moscow, label, colorClass }) => (
          <MoscowColumn
            key={moscow}
            moscow={moscow}
            label={label}
            colorClass={colorClass}
            items={items.filter(i => i.moscow === moscow)}
          />
        ))}
      </div>
    </DragDropContext>
  );
}
```

4. Create barrel `apps/roadmap/src/client/layers/features/moscow-view/index.ts`.

5. Write `MoscowView.test.tsx`: renders 4 columns, items sorted into correct columns.

**Acceptance Criteria**:
- [ ] 4 priority columns render: Must Have, Should Have, Could Have, Won't Have
- [ ] Items appear in correct column based on their moscow value
- [ ] Dragging a card to a different column triggers PATCH with new moscow value
- [ ] Column headers have distinct color coding (green/blue/amber/gray)
- [ ] Cards show title, status badge, and type
- [ ] CSS Grid layout fills available height
- [ ] Component test passes

---

### Task 2.3: Item Editor Dialog
**Description**: Implement the ItemEditorDialog for creating and editing roadmap items, with form validation and all fields.
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.5
**Can run parallel with**: Task 2.1, Task 2.2

**Technical Requirements**:
- shadcn Dialog component wrapping a form
- Supports both create mode (editingItemId === 'new') and edit mode (editingItemId === uuid)
- Required fields: title, type, moscow, status, health, timeHorizon
- Optional fields: description, effort, labels (comma-separated), startDate, endDate
- Form validation before submit
- Uses useCreateItem or useUpdateItem mutation
- Closes dialog and resets editingItemId on success
- Delete button in edit mode

**Implementation Steps**:

1. Add shadcn primitives needed: Dialog, Button, Input, Textarea, Select, Label. These can be copied from the existing `apps/client/src/layers/shared/ui/` components or generated fresh via the shadcn CLI.

2. Create `apps/roadmap/src/client/layers/features/item-editor/ui/ItemForm.tsx`:

```typescript
import { useState, useEffect } from 'react';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

interface ItemFormProps {
  initialData?: RoadmapItem;
  onSubmit: (data: Partial<RoadmapItem>) => void;
  onDelete?: () => void;
  isSubmitting: boolean;
}

export function ItemForm({ initialData, onSubmit, onDelete, isSubmitting }: ItemFormProps) {
  const [title, setTitle] = useState(initialData?.title || '');
  const [type, setType] = useState(initialData?.type || 'feature');
  const [moscow, setMoscow] = useState(initialData?.moscow || 'should-have');
  const [status, setStatus] = useState(initialData?.status || 'not-started');
  const [health, setHealth] = useState(initialData?.health || 'on-track');
  const [timeHorizon, setTimeHorizon] = useState(initialData?.timeHorizon || 'now');
  const [description, setDescription] = useState(initialData?.description || '');
  const [effort, setEffort] = useState<number | ''>(initialData?.effort ?? '');
  const [labels, setLabels] = useState(initialData?.labels?.join(', ') || '');
  const [startDate, setStartDate] = useState(initialData?.startDate || '');
  const [endDate, setEndDate] = useState(initialData?.endDate || '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({
      title,
      type,
      moscow,
      status,
      health,
      timeHorizon,
      description: description || undefined,
      effort: effort !== '' ? Number(effort) : undefined,
      labels: labels ? labels.split(',').map(l => l.trim()).filter(Boolean) : undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    });
  }

  // Form with all fields using Select for enum fields, Input for text/number, Textarea for description
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* title (required, Input) */}
      {/* type (required, Select: feature/bugfix/technical-debt/research/epic) */}
      {/* moscow (required, Select: must-have/should-have/could-have/wont-have) */}
      {/* status (required, Select: not-started/in-progress/completed/on-hold) */}
      {/* health (required, Select: on-track/at-risk/off-track/blocked) */}
      {/* timeHorizon (required, Select: now/next/later) */}
      {/* description (optional, Textarea) */}
      {/* effort (optional, number Input) */}
      {/* labels (optional, comma-separated Input) */}
      {/* startDate (optional, date Input) */}
      {/* endDate (optional, date Input) */}
      <div className="flex justify-between pt-4">
        {onDelete && (
          <button type="button" onClick={onDelete} className="text-red-500 text-sm">
            Delete
          </button>
        )}
        <button type="submit" disabled={isSubmitting || !title.trim()} className="ml-auto rounded bg-primary px-4 py-2 text-sm text-primary-foreground">
          {isSubmitting ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
}
```

3. Create `apps/roadmap/src/client/layers/features/item-editor/ui/ItemEditorDialog.tsx`:

```typescript
import { useAppStore } from '@/layers/shared/model/app-store';
import { useRoadmapItems, useCreateItem, useUpdateItem, useDeleteItem } from '@/layers/entities/roadmap-item';
import { ItemForm } from './ItemForm';

export function ItemEditorDialog() {
  const editingItemId = useAppStore((s) => s.editingItemId);
  const setEditingItemId = useAppStore((s) => s.setEditingItemId);
  const { data: items = [] } = useRoadmapItems();
  const createItem = useCreateItem();
  const updateItem = useUpdateItem();
  const deleteItem = useDeleteItem();

  if (!editingItemId) return null;

  const isNew = editingItemId === 'new';
  const existingItem = isNew ? undefined : items.find(i => i.id === editingItemId);

  function handleSubmit(data: Partial<RoadmapItem>) {
    if (isNew) {
      createItem.mutate(data as any, { onSuccess: () => setEditingItemId(null) });
    } else {
      updateItem.mutate({ id: editingItemId, ...data }, { onSuccess: () => setEditingItemId(null) });
    }
  }

  function handleDelete() {
    if (!isNew) {
      deleteItem.mutate(editingItemId, { onSuccess: () => setEditingItemId(null) });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingItemId(null)}>
      <div className="w-full max-w-lg rounded-lg border bg-background p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">{isNew ? 'New Item' : 'Edit Item'}</h2>
        <ItemForm
          initialData={existingItem}
          onSubmit={handleSubmit}
          onDelete={isNew ? undefined : handleDelete}
          isSubmitting={createItem.isPending || updateItem.isPending}
        />
      </div>
    </div>
  );
}
```

4. Create barrel and integrate into App.tsx.

5. Write `ItemEditorDialog.test.tsx`:
- Renders form when editingItemId is set
- Shows "New Item" title for new items
- Shows "Edit Item" title for existing items
- Submit calls createItem for new, updateItem for existing
- Delete button only shown in edit mode

**Acceptance Criteria**:
- [ ] Dialog opens when editingItemId is set in Zustand store
- [ ] Create mode: empty form, "New Item" title, POST on submit
- [ ] Edit mode: pre-filled form, "Edit Item" title, PATCH on submit
- [ ] All required fields present: title, type, moscow, status, health, timeHorizon
- [ ] All optional fields present: description, effort, labels, startDate, endDate
- [ ] Submit is disabled when title is empty
- [ ] Dialog closes on successful save
- [ ] Delete button appears in edit mode, calls DELETE endpoint
- [ ] Clicking backdrop closes dialog
- [ ] Component test passes

---

### Task 2.4: Dark/Light Theme Toggle
**Description**: Implement dark/light mode toggle following the Calm Tech design system, with system preference detection.
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.5
**Can run parallel with**: Task 2.1, Task 2.2, Task 2.3

**Technical Requirements**:
- Toggle button in the top-right corner of the HealthBar
- Three modes: light, dark, system (follows OS preference)
- Persisted in Zustand store (localStorage via persist middleware)
- CSS variables for colors following Calm Tech neutral gray + blue accent palette
- `<html>` class toggling for Tailwind dark mode

**Implementation Steps**:

1. Create `apps/roadmap/src/client/layers/shared/model/use-theme.ts`:

```typescript
import { useEffect } from 'react';
import { useAppStore } from './app-store';

export function useTheme() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', prefersDark);
    } else {
      root.classList.toggle('dark', theme === 'dark');
    }
  }, [theme]);

  return { theme, setTheme };
}
```

2. Add theme toggle button (Sun/Moon/Monitor icons from lucide-react) to the HealthBar header.

3. Add CSS variables to `index.css` for light and dark themes following the Calm Tech palette (neutral grays + blue accent), matching the existing DorkOS client `index.css` pattern.

**Acceptance Criteria**:
- [ ] Theme toggle button is visible in the header area
- [ ] Clicking cycles through light, dark, system modes
- [ ] Dark mode applies dark background and light text
- [ ] System mode follows OS preference
- [ ] Theme persists across page refreshes
- [ ] Color palette uses neutral grays with blue accent (Calm Tech)

---

## Phase 3: Rich Features

### Task 3.1: Gantt View with Kibo UI
**Description**: Implement the Gantt chart view using Kibo UI's gantt component, displaying items that have start and end dates.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.5
**Can run parallel with**: Task 3.2

**Technical Requirements**:
- Use Kibo UI `gantt` component (source-copied via registry, not npm)
- Filter items to only those with both `startDate` and `endDate`
- Items without dates show a prompt to add dates
- Color bars by status or moscow priority
- Click bar to open item editor

**Implementation Steps**:

1. Install Kibo UI gantt component via their registry/CLI (source copy into the project).

2. Create `apps/roadmap/src/client/layers/features/gantt-view/ui/GanttView.tsx`:

```typescript
import { useRoadmapItems } from '@/layers/entities/roadmap-item';
import { useAppStore } from '@/layers/shared/model/app-store';
// Import Kibo UI Gantt component (source-copied)

export function GanttView() {
  const { data: items = [] } = useRoadmapItems();
  const setEditingItemId = useAppStore((s) => s.setEditingItemId);

  const ganttItems = items.filter(i => i.startDate && i.endDate);
  const itemsWithoutDates = items.filter(i => !i.startDate || !i.endDate);

  if (ganttItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <p className="text-lg">No items with date ranges</p>
        <p className="text-sm mt-2">Add startDate and endDate to items to see them on the Gantt chart.</p>
      </div>
    );
  }

  // Transform items into Kibo UI Gantt format
  const features = ganttItems.map(item => ({
    id: item.id,
    name: item.title,
    startAt: new Date(item.startDate!),
    endAt: new Date(item.endDate!),
    status: { id: item.status, name: item.status, color: statusToColor(item.status) },
  }));

  return (
    <div className="p-4 h-full overflow-auto">
      {/* Render Kibo UI Gantt with features */}
      {/* onClick handler calls setEditingItemId(feature.id) */}
      {itemsWithoutDates.length > 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          {itemsWithoutDates.length} items hidden (no date range set)
        </p>
      )}
    </div>
  );
}

function statusToColor(status: string): string {
  switch (status) {
    case 'in-progress': return '#3b82f6';
    case 'completed': return '#22c55e';
    case 'on-hold': return '#f59e0b';
    default: return '#94a3b8';
  }
}
```

3. Create barrel export and integrate into App.tsx view switching.

**Acceptance Criteria**:
- [ ] Gantt chart renders items with startDate and endDate as horizontal bars
- [ ] Items without dates are excluded with a count message
- [ ] Empty state shows prompt when no items have dates
- [ ] Bars are color-coded by status
- [ ] Clicking a bar opens the item editor
- [ ] Chart is horizontally scrollable for long timelines

---

### Task 3.2: Spec Viewer Dialog
**Description**: Implement a dialog that fetches and renders markdown content from linked spec files.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.4 (files endpoint), Task 1.5
**Can run parallel with**: Task 3.1

**Technical Requirements**:
- Dialog triggered by `viewingSpecPath` in Zustand store
- Fetches markdown content via `GET /api/roadmap/files/{path}`
- Renders markdown using `react-markdown`
- Scrollable content area
- Close button and backdrop click to close

**Implementation Steps**:

1. Create `apps/roadmap/src/client/layers/features/spec-viewer/ui/SpecViewerDialog.tsx`:

```typescript
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '@/layers/shared/model/app-store';
import { api } from '@/layers/shared/lib/api-client';

export function SpecViewerDialog() {
  const viewingSpecPath = useAppStore((s) => s.viewingSpecPath);
  const setViewingSpecPath = useAppStore((s) => s.setViewingSpecPath);
  const [content, setContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewingSpecPath) return;
    setIsLoading(true);
    setError(null);
    api.get<{ content: string }>(`/files/${viewingSpecPath}`)
      .then(data => setContent(data.content))
      .catch(err => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [viewingSpecPath]);

  if (!viewingSpecPath) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setViewingSpecPath(null)}>
      <div className="w-full max-w-3xl max-h-[80vh] rounded-lg border bg-background p-6 shadow-xl overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{viewingSpecPath}</h2>
          <button onClick={() => setViewingSpecPath(null)} className="text-muted-foreground hover:text-foreground">
            Close
          </button>
        </div>
        <div className="overflow-y-auto flex-1 prose prose-sm dark:prose-invert">
          {isLoading && <p>Loading...</p>}
          {error && <p className="text-red-500">Error: {error}</p>}
          {!isLoading && !error && <ReactMarkdown>{content}</ReactMarkdown>}
        </div>
      </div>
    </div>
  );
}
```

2. Add spec link icons to KanbanCard, MoscowCard, and table rows. When an item has `linkedArtifacts`, show clickable icons (FileText from lucide-react) that call `setViewingSpecPath(item.linkedArtifacts.specPath)`.

3. Create barrel export and add to App.tsx.

**Acceptance Criteria**:
- [ ] Dialog opens when viewingSpecPath is set in Zustand store
- [ ] Fetches markdown content from /api/roadmap/files/ endpoint
- [ ] Renders markdown with proper formatting (headings, lists, code blocks)
- [ ] Shows loading state while fetching
- [ ] Shows error message if file not found
- [ ] Dialog is scrollable for long documents
- [ ] Close button and backdrop click close the dialog
- [ ] Spec link icons appear on items with linkedArtifacts

---

### Task 3.3: Drag-and-Drop Reorder Persistence
**Description**: Add reorder persistence so that drag-and-drop within the same column persists item order, and ensure the `order` field is used for sorting.
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: Task 3.1, Task 3.2

**Technical Requirements**:
- When dragging within same column (same status/moscow), reorder items
- Call PATCH /items/reorder with new ordered IDs for that column
- Sort items by `order` field when displaying in columns
- Table view also uses `order` for default sort

**Implementation Steps**:

1. Update `KanbanView.tsx` `handleDragEnd`:
- If source.droppableId === destination.droppableId, reorder within column
- Extract items for that column, splice the moved item, and call `useReorderItems` with the new order

2. Update `MoscowView.tsx` `handleDragEnd` similarly for within-column reorder.

3. Sort items by `order` field (fallback to `createdAt`) in both views and table view.

**Acceptance Criteria**:
- [ ] Dragging within the same column reorders items
- [ ] Reorder is persisted via PATCH /items/reorder endpoint
- [ ] Items display in order field sequence
- [ ] New items without order field appear at the end
- [ ] Table view default sort respects order field

---

## Phase 4: Migration & Polish

### Task 4.1: Replace Python Scripts with Shell API Wrappers
**Description**: Create shell script wrappers that call the Express API, replacing the 7 Python scripts.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.4
**Can run parallel with**: Task 4.2, Task 4.3, Task 4.4

**Technical Requirements**:
- Shell scripts at `roadmap/scripts/` (`.sh` files replacing `.py`)
- Each script checks server health before proceeding
- Uses curl for API calls and jq for JSON processing
- Executable permissions set

**Implementation Steps**:

Create the following shell scripts:

1. `roadmap/scripts/update_status.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

API="http://localhost:4243/api/roadmap"

if ! curl -sf "$API/../health" > /dev/null 2>&1; then
  echo "Error: Roadmap server is not running. Start it with: npm run dev --filter=@dorkos/roadmap"
  exit 1
fi

if [ $# -ne 2 ]; then
  echo "Usage: $0 <item-id> <status>"
  echo "Statuses: not-started, in-progress, completed, on-hold"
  exit 1
fi

curl -sf -X PATCH "$API/items/$1" \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"$2\"}" | jq .
```

2. `roadmap/scripts/update_workflow_state.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

API="http://localhost:4243/api/roadmap"

if ! curl -sf "$API/../health" > /dev/null 2>&1; then
  echo "Error: Roadmap server is not running."
  exit 1
fi

if [ $# -ne 2 ]; then
  echo "Usage: $0 <item-id> <workflow-state-json>"
  exit 1
fi

curl -sf -X PATCH "$API/items/$1" \
  -H "Content-Type: application/json" \
  -d "{\"workflowState\":$2}" | jq .
```

3. `roadmap/scripts/link_spec.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

API="http://localhost:4243/api/roadmap"

if ! curl -sf "$API/../health" > /dev/null 2>&1; then
  echo "Error: Roadmap server is not running."
  exit 1
fi

if [ $# -ne 2 ]; then
  echo "Usage: $0 <item-id> <spec-slug>"
  exit 1
fi

curl -sf -X PATCH "$API/items/$1" \
  -H "Content-Type: application/json" \
  -d "{\"linkedArtifacts\":{\"specSlug\":\"$2\",\"ideationPath\":\"specs/$2/01-ideation.md\",\"specPath\":\"specs/$2/02-specification.md\",\"tasksPath\":\"specs/$2/03-tasks.md\"}}" | jq .
```

4. `roadmap/scripts/find_by_title.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

API="http://localhost:4243/api/roadmap"

if ! curl -sf "$API/../health" > /dev/null 2>&1; then
  echo "Error: Roadmap server is not running."
  exit 1
fi

if [ $# -ne 1 ]; then
  echo "Usage: $0 <search-query>"
  exit 1
fi

curl -sf "$API/items" | jq --arg q "$1" '.[] | select(.title | test($q; "i"))'
```

5. `roadmap/scripts/slugify.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <title>"
  exit 1
fi

echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//'
```

6. `roadmap/scripts/clear_roadmap.sh` and `roadmap/scripts/link_all_specs.sh` (similar patterns).

7. Set executable permissions: `chmod +x roadmap/scripts/*.sh`

**Acceptance Criteria**:
- [ ] All 7 shell scripts created in `roadmap/scripts/`
- [ ] Each script checks server health and prints error if not running
- [ ] `update_status.sh` updates item status via PATCH
- [ ] `find_by_title.sh` searches items by title pattern
- [ ] `slugify.sh` works without server (pure bash)
- [ ] Scripts have executable permissions
- [ ] Scripts validate argument count and print usage

---

### Task 4.2: Server and Client Test Suite
**Description**: Write comprehensive test suites for server services/routes and client components/hooks.
**Size**: Large
**Priority**: High
**Dependencies**: All Phase 1-3 tasks
**Can run parallel with**: Task 4.1, Task 4.3

**Technical Requirements**:
- Server tests: mock lowdb with in-memory adapter
- Client tests: mock fetch, React Testing Library with jsdom
- Add mock factories to `packages/test-utils/`

**Implementation Steps**:

1. Add to `packages/test-utils/src/index.ts`:

```typescript
import type { RoadmapItem, RoadmapMeta, HealthStats } from '@dorkos/shared/roadmap-schemas';

export function createMockRoadmapItem(overrides?: Partial<RoadmapItem>): RoadmapItem {
  return {
    id: crypto.randomUUID(),
    title: 'Test Item',
    type: 'feature',
    moscow: 'should-have',
    status: 'not-started',
    health: 'on-track',
    timeHorizon: 'now',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createMockRoadmapMeta(overrides?: Partial<RoadmapMeta & { health: HealthStats }>): RoadmapMeta & { health: HealthStats } {
  return {
    projectName: 'Test Project',
    projectSummary: 'A test project',
    lastUpdated: new Date().toISOString(),
    timeHorizons: {
      now: { label: 'Now', description: 'Current sprint' },
      next: { label: 'Next', description: 'Next sprint' },
      later: { label: 'Later', description: 'Backlog' },
    },
    health: {
      totalItems: 10,
      mustHavePercent: 40,
      inProgressCount: 3,
      atRiskCount: 1,
      blockedCount: 0,
      completedCount: 4,
    },
    ...overrides,
  };
}
```

2. Server test files:
- `apps/roadmap/src/server/services/__tests__/roadmap-store.test.ts` (from Task 1.3)
- `apps/roadmap/src/server/routes/__tests__/items-routes.test.ts` (from Task 1.4)
- `apps/roadmap/src/server/routes/__tests__/meta-routes.test.ts`
- `apps/roadmap/src/server/routes/__tests__/files-routes.test.ts`

3. Client test files:
- `apps/roadmap/src/client/__tests__/HealthBar.test.tsx`
- `apps/roadmap/src/client/__tests__/TableView.test.tsx`
- `apps/roadmap/src/client/__tests__/KanbanView.test.tsx`
- `apps/roadmap/src/client/__tests__/ItemEditorDialog.test.tsx`
- `apps/roadmap/src/client/__tests__/useRoadmapItems.test.ts`

All client tests should use jsdom environment directive:
```typescript
/**
 * @vitest-environment jsdom
 */
```

Mock fetch for API calls, wrap components in QueryClientProvider with a fresh QueryClient per test.

**Acceptance Criteria**:
- [ ] Mock factories added to `packages/test-utils/`
- [ ] Server store tests cover all CRUD + health stats
- [ ] Route tests cover all endpoints with status codes
- [ ] Client component tests render correctly with mock data
- [ ] Client hook tests verify query/mutation behavior
- [ ] All tests pass: `npx vitest run --filter=@dorkos/roadmap`

---

### Task 4.3: Documentation Updates
**Description**: Update project documentation to reflect the new roadmap app.
**Size**: Small
**Priority**: Medium
**Dependencies**: All Phase 1-3 tasks
**Can run parallel with**: Task 4.1, Task 4.2, Task 4.4

**Technical Requirements**:
- Update `CLAUDE.md` monorepo structure and commands
- Update `roadmap/CLAUDE.md` to reflect API-based architecture
- Update `contributing/architecture.md` with roadmap app section

**Implementation Steps**:

1. In `CLAUDE.md`:
- Add `apps/roadmap/` to the monorepo structure tree
- Add commands: `dotenv -- turbo dev --filter=@dorkos/roadmap` (roadmap dev server)
- Add port info: roadmap server on port 4243
- Add environment variables: `ROADMAP_PORT`, `ROADMAP_PATH`
- Add to `vitest.workspace.ts` listing

2. In `roadmap/CLAUDE.md`:
- Replace vanilla HTML/JS references with Express + React app description
- Document API endpoints
- Note that Python scripts are replaced by shell wrappers calling the API
- Document the `apps/roadmap/` workspace path

3. In `contributing/architecture.md`:
- Add "Roadmap App" section describing the standalone Express + React architecture
- Note it does NOT use the Transport interface (standalone HTTP only)
- Document FSD layer structure for the roadmap client

**Acceptance Criteria**:
- [ ] `CLAUDE.md` updated with roadmap app info
- [ ] `roadmap/CLAUDE.md` reflects new API-based architecture
- [ ] `contributing/architecture.md` includes roadmap app section
- [ ] All documentation references are accurate

---

### Task 4.4: Vitest Workspace and Monorepo Integration
**Description**: Register the roadmap app in vitest.workspace.ts, turbo.json pipeline, and verify all monorepo commands work.
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 4.1, Task 4.3

**Technical Requirements**:
- Add `'apps/roadmap'` to `vitest.workspace.ts`
- Verify `turbo.json` pipeline picks up new app (dev, build, test, typecheck, lint)
- Verify `npm run dev` starts roadmap alongside other apps (if desired) or independently

**Implementation Steps**:

1. Update `vitest.workspace.ts`:
```typescript
export default defineWorkspace([
  'apps/client',
  'apps/server',
  'apps/roadmap',    // Add this
  'packages/cli',
  'packages/shared',
]);
```

2. Verify `turbo.json` already handles `apps/roadmap` via workspace detection (Turborepo auto-discovers workspaces with matching scripts).

3. Test all commands:
- `npm test` includes roadmap tests
- `npm run build` builds roadmap app
- `npm run typecheck` type-checks roadmap
- `dotenv -- turbo dev --filter=@dorkos/roadmap` starts roadmap dev server

4. Add roadmap to root `package.json` workspace patterns if not already captured by `apps/*`.

**Acceptance Criteria**:
- [ ] `vitest.workspace.ts` includes `'apps/roadmap'`
- [ ] `npm test` runs roadmap tests alongside other apps
- [ ] `npm run build` builds roadmap (server tsc + client vite)
- [ ] `npm run typecheck` includes roadmap
- [ ] `dotenv -- turbo dev --filter=@dorkos/roadmap` starts dev server on port 4243 + Vite on 5174
- [ ] No workspace resolution errors

---

## Dependency Graph

```
Task 1.1 (Scaffold) ──────┐
                           ├─── Task 1.3 (Store) ──── Task 1.4 (Routes) ──┐
Task 1.2 (Schemas) ───────┤                                                │
                           ├─── Task 1.5 (React Shell) ──── Task 1.6 (Health+Table)
                           │         │
                           │         ├─── Task 2.1 (Kanban) ──────────┐
                           │         ├─── Task 2.2 (MoSCoW) ──────────┤
                           │         ├─── Task 2.3 (Editor) ──────────┤── Task 3.3 (Reorder)
                           │         └─── Task 2.4 (Theme)            │
                           │                                           │
                           │         Task 3.1 (Gantt) ◄───────────────┤
                           │         Task 3.2 (Spec Viewer) ◄─── Task 1.4
                           │
Task 4.4 (Vitest) ◄───────┘
Task 4.1 (Scripts) ◄──── Task 1.4
Task 4.2 (Tests) ◄──── All Phase 1-3
Task 4.3 (Docs) ◄──── All Phase 1-3
```

## Parallel Execution Opportunities

- **Task 1.1 + Task 1.2**: Scaffold workspace and schemas can be done simultaneously
- **Task 1.4 + Task 1.5**: Server routes and React shell can be built in parallel (both depend on 1.1+1.2)
- **Task 2.1 + Task 2.2 + Task 2.3 + Task 2.4**: All Phase 2 tasks can run in parallel
- **Task 3.1 + Task 3.2**: Gantt and Spec Viewer can run in parallel
- **Task 4.1 + Task 4.2 + Task 4.3 + Task 4.4**: All Phase 4 tasks can run in parallel

## Critical Path

1.1/1.2 (parallel) -> 1.3 -> 1.4 -> 1.5 -> 1.6 -> 2.1 -> 3.3 -> 4.2
