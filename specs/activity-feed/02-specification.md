---
slug: activity-feed
number: 210
created: 2026-03-29
status: specified
---

# Activity Feed — Specification

**Slug:** activity-feed
**Spec Number:** 210
**Author:** Claude Code
**Date:** 2026-03-29
**Ideation:** `specs/activity-feed/01-ideation.md`
**Research:** `research/20260329_activity_feed_architecture_ui_patterns.md`

---

## Overview

A consolidated activity feed at `/activity` that shows what happened across the DorkOS instance — Pulse runs, Relay events, agent registry changes, config mutations, and system events. Each row attributes the action to an actor (user, agent, or system) and links to the relevant detail view.

The primary use case is Kai opening DorkOS after 8 hours away and scanning "what did my agents do while I slept?" in 20 seconds. Secondary use case is Priya auditing config changes across clients.

Session events are excluded from v1 (sessions live in SDK-managed JSONL files, not SQLite).

---

## Technical Design

### Architecture

All activity-producing code paths write a lightweight summary row to a single `activity_events` SQLite table at point of mutation. The activity feed queries this one table with standard cursor-based pagination. No multi-source merge, no hybrid derivation.

```
Mutation occurs (pulse run completes, adapter added, etc.)
  → Primary operation completes
  → Fire-and-forget: activityService.emit({ ... })
  → INSERT INTO activity_events

GET /api/activity?limit=50&before=<cursor>
  → SELECT FROM activity_events WHERE occurred_at < cursor ORDER BY occurred_at DESC LIMIT 51
  → Return { items, nextCursor }
```

The `activityService.emit()` call is fire-and-forget — it logs warnings on failure but never blocks or fails the primary operation.

### Data Model

#### `activity_events` Table

```typescript
// packages/db/src/schema/activity.ts

import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

/**
 * Append-only activity event log.
 * Stores lightweight summary rows for all trackable events.
 * Never update rows — only insert and prune old rows.
 */
export const activityEvents = sqliteTable(
  'activity_events',
  {
    /** ULID — lexicographically sortable, unique. */
    id: text('id').primaryKey(),

    /** When the event occurred. ISO 8601 UTC. Primary sort key. */
    occurredAt: text('occurred_at').notNull(),

    /** Actor type: who triggered this event. */
    actorType: text('actor_type', {
      enum: ['user', 'agent', 'system', 'pulse'],
    }).notNull(),

    /** Actor identifier. Agent ID, schedule ID, or null for user/system. */
    actorId: text('actor_id'),

    /** Human-readable actor name. "You", agent name, "Pulse", "System". */
    actorLabel: text('actor_label').notNull(),

    /** Event category for filtering. */
    category: text('category', {
      enum: ['pulse', 'relay', 'agent', 'config', 'system'],
    }).notNull(),

    /**
     * Dot-notation event type.
     * Format: `{resource}.{verb}` — e.g., "adapter.added", "pulse.ran_success".
     */
    eventType: text('event_type').notNull(),

    /** Resource type for linking: "adapter", "extension", "schedule", "agent". */
    resourceType: text('resource_type'),

    /** Stable resource ID for detail view linking. */
    resourceId: text('resource_id'),

    /** Human-readable resource name. Adapter name, schedule name, etc. */
    resourceLabel: text('resource_label'),

    /** One-line summary. "daily-digest ran successfully (2m 14s)". */
    summary: text('summary').notNull(),

    /** Client-side route path for "Open →" link. e.g., "/agents". */
    linkPath: text('link_path'),

    /** JSON blob for event-specific metadata. Never stores secrets or message content. */
    metadata: text('metadata'),

    /** Row insert time. ISO 8601 UTC. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_activity_occurred_at').on(table.occurredAt),
    index('idx_activity_category').on(table.category),
    index('idx_activity_actor_type').on(table.actorType),
  ]
);
```

Export from `packages/db/src/schema/index.ts`:

```typescript
export * from './activity.js';
```

Generate migration via `drizzle-kit generate` (produces the next numbered SQL file in `packages/db/drizzle/`).

#### `ActivityItem` — Shared Response Type

```typescript
// packages/shared/src/activity-schemas.ts

import { z } from 'zod';

export const ActivityCategorySchema = z.enum(['pulse', 'relay', 'agent', 'config', 'system']);
export type ActivityCategory = z.infer<typeof ActivityCategorySchema>;

export const ActorTypeSchema = z.enum(['user', 'agent', 'system', 'pulse']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const ActivityItemSchema = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    actorType: ActorTypeSchema,
    actorId: z.string().nullable(),
    actorLabel: z.string(),
    category: ActivityCategorySchema,
    eventType: z.string(),
    resourceType: z.string().nullable(),
    resourceId: z.string().nullable(),
    resourceLabel: z.string().nullable(),
    summary: z.string(),
    linkPath: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable(),
  })
  .openapi('ActivityItem');

export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const ListActivityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    before: z.string().optional(),
    categories: z.string().optional(), // comma-separated
    actorType: ActorTypeSchema.optional(),
    actorId: z.string().optional(),
    since: z.string().optional(),
  })
  .openapi('ListActivityQuery');

export type ListActivityQuery = z.infer<typeof ListActivityQuerySchema>;

export const ListActivityResponseSchema = z
  .object({
    items: z.array(ActivityItemSchema),
    nextCursor: z.string().nullable(),
  })
  .openapi('ListActivityResponse');

export type ListActivityResponse = z.infer<typeof ListActivityResponseSchema>;
```

Export from `packages/shared/src/index.ts` via subpath or direct export.

### Event Taxonomy

| Category | Event Type                   | Summary Template                           | Actor              | Link        |
| -------- | ---------------------------- | ------------------------------------------ | ------------------ | ----------- |
| `pulse`  | `pulse.ran_success`          | "{schedule} ran successfully ({duration})" | `pulse` / `agent`  | Pulse panel |
| `pulse`  | `pulse.ran_failed`           | "{schedule} failed: {error}"               | `pulse` / `agent`  | Pulse panel |
| `pulse`  | `pulse.ran_cancelled`        | "{schedule} was cancelled"                 | `user`             | Pulse panel |
| `pulse`  | `pulse.schedule_created`     | "Created schedule {name}"                  | `user`             | Pulse panel |
| `pulse`  | `pulse.schedule_deleted`     | "Deleted schedule {name}"                  | `user`             | —           |
| `pulse`  | `pulse.schedule_paused`      | "Paused schedule {name}"                   | `user`             | Pulse panel |
| `relay`  | `relay.adapter_added`        | "Added {name} adapter"                     | `user`             | Relay panel |
| `relay`  | `relay.adapter_removed`      | "Removed {name} adapter"                   | `user`             | —           |
| `relay`  | `relay.adapter_connected`    | "{name} adapter connected"                 | `system`           | Relay panel |
| `relay`  | `relay.adapter_disconnected` | "{name} adapter disconnected"              | `system`           | Relay panel |
| `relay`  | `relay.message_delivered`    | "Delivered message via {adapter}"          | `agent` / `system` | Relay panel |
| `relay`  | `relay.message_failed`       | "Failed to deliver via {adapter}: {error}" | `agent` / `system` | Relay panel |
| `agent`  | `agent.registered`           | "Registered agent {name}"                  | `user`             | `/agents`   |
| `agent`  | `agent.removed`              | "Removed agent {name}"                     | `user`             | —           |
| `agent`  | `agent.status_changed`       | "{name} is now {status}"                   | `system`           | `/agents`   |
| `config` | `config.extension_installed` | "Installed extension {name}"               | `user`             | Settings    |
| `config` | `config.extension_removed`   | "Removed extension {name}"                 | `user`             | —           |
| `config` | `config.extension_updated`   | "Updated extension {name}"                 | `user`             | Settings    |
| `config` | `config.binding_created`     | "Created binding: {subject} → {adapter}"   | `user`             | Relay panel |
| `config` | `config.binding_deleted`     | "Deleted binding: {subject} → {adapter}"   | `user`             | —           |
| `config` | `config.binding_updated`     | "Updated binding: {subject} → {adapter}"   | `user`             | Relay panel |
| `system` | `system.started`             | "DorkOS started"                           | `system`           | —           |
| `system` | `system.config_reloaded`     | "Configuration reloaded"                   | `system`           | —           |

### Server

#### Activity Service

```typescript
// apps/server/src/services/activity/activity-service.ts

import { ulid } from 'ulid';
import { desc, lt, and, eq, inArray, type SQL } from 'drizzle-orm';
import { activityEvents } from '@dorkos/db';
import type {
  ActivityItem,
  ListActivityQuery,
  ListActivityResponse,
  ActorType,
  ActivityCategory,
} from '@dorkos/shared';
import { logger } from '@/lib/logger.js';

export class ActivityService {
  constructor(private db: ReturnType<typeof import('@dorkos/db').createDb>) {}

  /**
   * Fire-and-forget event emission. Never throws.
   * Call this after the primary operation succeeds.
   */
  async emit(event: {
    occurredAt?: string;
    actorType: ActorType;
    actorId?: string | null;
    actorLabel: string;
    category: ActivityCategory;
    eventType: string;
    resourceType?: string | null;
    resourceId?: string | null;
    resourceLabel?: string | null;
    summary: string;
    linkPath?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      const now = new Date().toISOString();
      await this.db.insert(activityEvents).values({
        id: ulid(),
        occurredAt: event.occurredAt ?? now,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        actorLabel: event.actorLabel,
        category: event.category,
        eventType: event.eventType,
        resourceType: event.resourceType ?? null,
        resourceId: event.resourceId ?? null,
        resourceLabel: event.resourceLabel ?? null,
        summary: event.summary,
        linkPath: event.linkPath ?? null,
        metadata: event.metadata ? JSON.stringify(event.metadata) : null,
        createdAt: now,
      });
    } catch (err) {
      logger.warn('[Activity] Failed to emit activity event', { err, event: event.eventType });
    }
  }

  /**
   * Query activity events with cursor-based pagination and filtering.
   */
  async list(query: ListActivityQuery): Promise<ListActivityResponse> {
    const { limit, before, categories, actorType, actorId, since } = query;
    const conditions: SQL[] = [];

    if (before) {
      conditions.push(lt(activityEvents.occurredAt, before));
    }
    if (categories) {
      const cats = categories.split(',').map((c) => c.trim()) as ActivityCategory[];
      conditions.push(inArray(activityEvents.category, cats));
    }
    if (actorType) {
      conditions.push(eq(activityEvents.actorType, actorType));
    }
    if (actorId) {
      conditions.push(eq(activityEvents.actorId, actorId));
    }
    if (since) {
      conditions.push(lt(since, activityEvents.occurredAt));
    }

    // Fetch limit + 1 to detect if there are more pages
    const rows = await this.db
      .select()
      .from(activityEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(activityEvents.occurredAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);

    const mapped: ActivityItem[] = items.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      actorType: row.actorType as ActorType,
      actorId: row.actorId,
      actorLabel: row.actorLabel,
      category: row.category as ActivityCategory,
      eventType: row.eventType,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      resourceLabel: row.resourceLabel,
      summary: row.summary,
      linkPath: row.linkPath,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));

    return {
      items: mapped,
      nextCursor: hasMore && items.length > 0 ? items[items.length - 1].occurredAt : null,
    };
  }

  /**
   * Prune events older than the retention period.
   * Called at server startup and optionally by a Pulse schedule.
   */
  async prune(retentionDays: number = 30): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const result = await this.db
      .delete(activityEvents)
      .where(lt(activityEvents.occurredAt, cutoff.toISOString()));

    return result.changes;
  }
}
```

#### Activity Route

```typescript
// apps/server/src/routes/activity.ts

import { Router } from 'express';
import { ListActivityQuerySchema } from '@dorkos/shared';
import { parseBody } from '@/lib/parse-body.js';
import type { ActivityService } from '@/services/activity/activity-service.js';

export function createActivityRouter(activityService: ActivityService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = parseBody(ListActivityQuerySchema, req.query, res);
    if (!query) return;

    const result = await activityService.list(query);
    return res.json(result);
  });

  return router;
}
```

Mount at `/api/activity` in the Express app setup.

#### Instrumentation Points

Each subsystem adds a single `activityService.emit()` call after its primary operation.

**A route never states its own actor.** It spreads `readActivityActor(req, res)`
(`apps/server/src/services/activity/activity-actor.ts`), which turns the request into
the right one of the three: `user` / `'You'` for a person in the app, `agent` plus the
agent's path for a caller that identified itself, and `system` /
`'Unidentified caller'` for a token DorkOS cannot resolve. The examples below said
`actorType: 'user', actorLabel: 'You'` outright until DOR-1829, and that template was
copied into eleven routes that an agent can reach — so the operator's own feed reported
machines' writes as their own actions. A hand-written actor is now refused by
`routes/__tests__/route-activity-actor.test.ts`; only `system` / `'System'` may still be
stated outright, for events DorkOS raises that nobody asked for.

Examples:

**Pulse runs** — in `routes/pulse.ts`, after run completion callback:

```typescript
await activityService.emit({
  actorType: run.trigger === 'scheduled' ? 'pulse' : run.trigger === 'agent' ? 'agent' : 'user',
  actorId: run.trigger === 'scheduled' ? run.scheduleId : null,
  actorLabel: run.trigger === 'scheduled' ? 'Pulse' : run.trigger === 'agent' ? agentName : 'You',
  category: 'pulse',
  eventType: run.status === 'completed' ? 'pulse.ran_success' : 'pulse.ran_failed',
  resourceType: 'schedule',
  resourceId: run.scheduleId,
  resourceLabel: schedule.name,
  summary: `${schedule.name} ${run.status === 'completed' ? 'ran successfully' : 'failed'}${run.durationMs ? ` (${formatDuration(run.durationMs)})` : ''}`,
  linkPath: '/', // Pulse panel on dashboard
  metadata: run.status === 'failed' ? { error: run.error } : null,
});
```

**Relay adapters** — in `routes/relay.ts`, after adapter CRUD:

```typescript
await activityService.emit({
  ...readActivityActor(req, res),
  category: 'relay',
  eventType: 'relay.adapter_added',
  resourceType: 'adapter',
  resourceId: adapter.id,
  resourceLabel: adapter.name,
  summary: `Added ${adapter.name} adapter`,
  linkPath: '/', // Relay panel
});
```

**Extensions** — in `routes/extensions.ts`, after install/remove/update:

```typescript
await activityService.emit({
  ...readActivityActor(req, res),
  category: 'config',
  eventType: 'config.extension_installed',
  resourceType: 'extension',
  resourceId: extension.id,
  resourceLabel: extension.name,
  summary: `Installed extension ${extension.name}`,
});
```

**Agent registry** — in mesh registration path:

```typescript
await activityService.emit({
  ...readActivityActor(req, res),
  category: 'agent',
  eventType: 'agent.registered',
  resourceType: 'agent',
  resourceId: agent.id,
  resourceLabel: agent.name,
  summary: `Registered agent ${agent.name}`,
  linkPath: '/agents',
});
```

**System startup** — in `apps/server/src/index.ts`, after init:

```typescript
await activityService.emit({
  actorType: 'system',
  actorLabel: 'System',
  category: 'system',
  eventType: 'system.started',
  summary: 'DorkOS started',
});
```

#### Retention Pruning

At server startup, after `ActivityService` is created:

```typescript
const pruned = await activityService.prune(
  Number(process.env.DORKOS_ACTIVITY_RETENTION_DAYS ?? 30)
);
if (pruned > 0) {
  logger.info(`[Activity] Pruned ${pruned} events older than retention period`);
}
```

### Transport Interface

Add to `packages/shared/src/transport.ts`:

```typescript
listActivityEvents(query?: Partial<ListActivityQuery>): Promise<ListActivityResponse>;
```

Implement in `HttpTransport` as `GET /api/activity` with query params. Implement in `DirectTransport` as a direct call to `activityService.list()`.

### Client

#### Route

Add to `apps/client/src/router.tsx`:

```typescript
import { z } from 'zod';

const activitySearchSchema = z.object({
  categories: z.string().optional(),
  actorType: z.string().optional(),
  actorId: z.string().optional(),
  since: z.string().optional(),
});

export type ActivitySearch = z.infer<typeof activitySearchSchema>;

const activityRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/activity',
  validateSearch: zodValidator(activitySearchSchema),
  component: ActivityPage,
});
```

Add to `routeTree.addChildren([..., activityRoute])`.

#### Sidebar Navigation

Update `DashboardSidebar.tsx` to add Activity between Dashboard and Agents:

```typescript
import { Activity } from 'lucide-react';

// In navigation items array, between Dashboard and Agents:
{
  label: 'Activity',
  icon: Activity,
  path: '/activity',
}
```

Uses `isActive` comparison from existing `useRouterState()` pattern.

#### Dashboard "View All" Link

Update `RecentActivityFeed.tsx`:

```typescript
// Change from:
onClick={() => navigate({ to: '/session' })}
// To:
onClick={() => navigate({ to: '/activity' })}
```

#### FSD Layer Structure

```
apps/client/src/layers/
  entities/
    activity/
      index.ts                          ← barrel export
      model/
        activity-types.ts               ← re-export shared types + client helpers
      ui/
        ActorBadge.tsx                  ← actor pill: colored dot + label
        CategoryBadge.tsx               ← category pill with color
  features/
    activity-feed-page/
      index.ts                          ← barrel export
      model/
        use-full-activity-feed.ts       ← useInfiniteQuery hook
        use-activity-filters.ts         ← filter state from URL search params
        use-last-visited-activity.ts    ← localStorage timestamp tracking
        time-grouping.ts                ← group items by Today/Yesterday/This Week/Older
      ui/
        ActivityRow.tsx                 ← single compact row
        ActivityGroupHeader.tsx         ← sticky time group label
        ActivityFilterBar.tsx           ← category chips + actor filter
        ActivitySinceLastVisit.tsx      ← digest banner
        ActivityEmptyState.tsx          ← empty/filtered-empty states
  widgets/
    activity/
      index.ts                          ← barrel export (ActivityPage)
      ActivityPage.tsx                  ← page orchestrator
      ui/
        ActivityHeader.tsx              ← page title + filter bar
        ActivityTimeline.tsx            ← time-grouped list + load more
```

#### Data Fetching Hook

```typescript
// features/activity-feed-page/model/use-full-activity-feed.ts

import { useInfiniteQuery } from '@tanstack/react-query';
import { useTransport } from '@/contexts/TransportContext';
import type { ListActivityQuery, ListActivityResponse } from '@dorkos/shared';

const ACTIVITY_KEY = ['activity'] as const;

export function useFullActivityFeed(filters: Partial<ListActivityQuery> = {}) {
  const transport = useTransport();

  return useInfiniteQuery<ListActivityResponse>({
    queryKey: [...ACTIVITY_KEY, filters],
    queryFn: ({ pageParam }) =>
      transport.listActivityEvents({
        ...filters,
        limit: 50,
        before: pageParam as string | undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
```

#### Time Grouping

```typescript
// features/activity-feed-page/model/time-grouping.ts

import type { ActivityItem } from '@dorkos/shared';

export interface ActivityGroup {
  label: string;
  items: ActivityItem[];
}

export function groupByTime(items: ActivityItem[], now: Date): ActivityGroup[] {
  const groups: Map<string, ActivityItem[]> = new Map();

  for (const item of items) {
    const label = getTimeGroupLabel(new Date(item.occurredAt), now);
    const group = groups.get(label) ?? [];
    group.push(item);
    groups.set(label, group);
  }

  // Preserve insertion order (chronological group order)
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

function getTimeGroupLabel(date: Date, now: Date): string {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  if (date >= startOfToday) return 'Today';
  if (date >= startOfYesterday) return 'Yesterday';
  if (date >= startOfWeek) return 'This Week';
  return 'Earlier';
}
```

#### "Since Last Visit" Banner

Track last visited timestamp in localStorage (`dorkos:lastVisitedActivity`). On mount, compute count of events since that timestamp from the first page of data. Display digest banner:

```
┌─ Since your last visit (8h ago) ──────────────────┐
│ 3 Pulse runs · 1 adapter change · 2 agent updates  │
└────────────────────────────────────────────────────┘
```

Category counts derived by filtering `items` where `occurredAt > lastVisited`. Banner uses `motion` for enter animation (fade + slide down). After the user scrolls past the "since last visit" boundary, update the localStorage timestamp.

Follows the existing `use-last-visited.ts` pattern from the dashboard activity feature.

#### Row Anatomy

Every row is a single line:

```
[time]  [actor badge]  [summary]                    [link]
2:14 AM  ● researcher   daily-digest ran OK          Open →
9:02 AM  ◆ Pulse        weekly-report completed (3m)
3 days   ⚙ You          Added Telegram adapter       View →
```

**Time display:**

- Today: `h:mm a` (e.g., "2:14 AM")
- Yesterday: "Yesterday 2:14 AM"
- This week: "Monday 2:14 AM"
- Older: "Mar 25"

**Actor badge:**

- `user` → neutral ghost pill "You"
- `agent` → colored dot (uses agent's `color` from registry) + agent name
- `system` → `Settings` icon (lucide), muted `text-neutral-500`
- `pulse` → `Clock` icon (lucide), muted `text-purple-500`

**Category color tokens (consistent with dashboard):**

| Category | Text               | Background          |
| -------- | ------------------ | ------------------- |
| `pulse`  | `text-purple-500`  | `bg-purple-500/10`  |
| `relay`  | `text-teal-500`    | `bg-teal-500/10`    |
| `agent`  | `text-indigo-500`  | `bg-indigo-500/10`  |
| `config` | `text-amber-500`   | `bg-amber-500/10`   |
| `system` | `text-neutral-500` | `bg-neutral-500/10` |

**Link:** Right-aligned, subtle ghost button "Open →" or "View →". Uses TanStack Router `navigate()`.

#### Filter Bar

Horizontal chip bar above the timeline:

```
[All] [Pulse] [Relay] [Agents] [Config] [System]    [Actor ▾]
```

- Category chips: toggle-style. Multiple can be active. Default: "All" (no filter).
- Actor dropdown: populated from distinct `actorLabel` values in the current data.
- Filter state stored in URL search params via `activitySearchSchema` — supports sharing filtered views.
- Active filters shown as dismissible chips below the bar.

#### Empty States

| Condition            | Content                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| No events ever       | Icon + "No activity yet. Events will appear here as your agents work." |
| Filtered, no results | "No {category} events found." + "Clear filters" link                   |
| Loading              | 5-row skeleton shimmer (same row anatomy as real rows)                 |

#### Page Layout

`ActivityPage.tsx` composes:

```
ActivityHeader (title "Activity" + filter bar)
ActivitySinceLastVisit (conditional digest banner)
ActivityTimeline (time-grouped rows)
  ActivityGroupHeader ("Today")
  ActivityRow × N
  ActivityGroupHeader ("Yesterday")
  ActivityRow × N
  ...
ActivityLoadMore ("Load 50 more events" button)
```

The page uses the same layout shell as Dashboard and Agents — `AppShell` with `DashboardSidebar`.

---

## Implementation Phases

### Phase 1: Data Layer (Server)

1. Create `packages/db/src/schema/activity.ts` with `activityEvents` table
2. Export from `packages/db/src/schema/index.ts`
3. Generate Drizzle migration (`drizzle-kit generate`)
4. Create `apps/server/src/services/activity/activity-service.ts` with `emit()`, `list()`, `prune()`
5. Create `apps/server/src/routes/activity.ts` with `GET /` endpoint
6. Mount at `/api/activity` in Express app
7. Wire `ActivityService` into server startup (construct with db, prune on init)
8. Add `listActivityEvents` to `Transport` interface and implement in `HttpTransport` + `DirectTransport`
9. Add Zod schemas to `packages/shared/src/activity-schemas.ts`

### Phase 2: Instrumentation (Server)

Instrument each subsystem's routes/services to call `activityService.emit()`:

1. Pulse: run completion, schedule CRUD
2. Relay: adapter CRUD, adapter connect/disconnect, message delivery/failure
3. Mesh: agent register/remove/status change
4. Extensions: install/remove/update
5. Bindings: create/delete/update
6. System: server startup

### Phase 3: Client UI

1. Create `entities/activity/` — types, `ActorBadge`, `CategoryBadge`
2. Create `features/activity-feed-page/` — hooks (`useFullActivityFeed`, `useActivityFilters`, `useLastVisitedActivity`), time grouping, UI components (`ActivityRow`, `ActivityGroupHeader`, `ActivityFilterBar`, `ActivitySinceLastVisit`, `ActivityEmptyState`)
3. Create `widgets/activity/` — `ActivityPage`, `ActivityHeader`, `ActivityTimeline`, `ActivityLoadMore`
4. Add `/activity` route to `router.tsx`
5. Add Activity to `DashboardSidebar.tsx` navigation
6. Update `RecentActivityFeed.tsx` "View all" link to navigate to `/activity`

### Phase 4: Polish

1. Motion animations: list item enter, banner slide-in, filter chip transitions
2. Skeleton loading states
3. Empty states (no events, filtered-no-results)
4. Keyboard navigation support

---

## Testing Strategy

### Server Tests

- `services/activity/__tests__/activity-service.test.ts`:
  - `emit()` inserts rows, handles errors gracefully (no throw)
  - `list()` returns paginated results, applies filters, cursor pagination works
  - `prune()` removes old events, respects retention days
- `routes/__tests__/activity.test.ts`:
  - `GET /api/activity` returns 200 with items and nextCursor
  - Query param filtering (categories, actorType, before, since)
  - Validation rejects invalid params

### Client Tests

- `entities/activity/__tests__/ActorBadge.test.tsx`: Renders correct icon/color per actor type
- `features/activity-feed-page/__tests__/use-full-activity-feed.test.ts`: Hook calls transport with correct params, handles pagination
- `features/activity-feed-page/__tests__/time-grouping.test.ts`: Groups items correctly by Today/Yesterday/This Week/Older
- `features/activity-feed-page/__tests__/ActivityFilterBar.test.tsx`: Filter chips toggle, URL params update
- `widgets/activity/__tests__/ActivityPage.test.tsx`: Page renders with mock data, shows empty state when no events

---

## Privacy & Security

- **Never store message content** in `activity_events`. Summary says "delivered message via Telegram" — not what the message contained.
- **Never store secrets or credentials** in `metadata`. Store resource names and types, not API keys or tokens.
- **Config change metadata**: If storing before/after diffs, strip credential fields before persisting.
- Activity data is local to the DorkOS instance — no external transmission.

---

## Acceptance Criteria

1. `/activity` route renders a paginated, time-grouped activity feed
2. Activity feed shows events from Pulse, Relay, Mesh, Config, and System categories
3. Each event row displays: timestamp, actor badge, summary text, and optional link
4. Filter bar filters by category and actor; filter state persists in URL search params
5. "Load more" button loads the next page of events (cursor-based)
6. "Since your last visit" banner shows a digest of events since the user's previous visit
7. Activity link appears in sidebar navigation between Dashboard and Agents
8. Dashboard's "View all" link navigates to `/activity`
9. Events older than 30 days (configurable) are pruned at server startup
10. `activityService.emit()` never blocks or fails the primary operation
11. All event types from the taxonomy are instrumented across server routes
