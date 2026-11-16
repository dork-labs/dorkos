---
slug: agents-first-class-entity
number: 66
created: 2026-02-26
status: specified
---

# Specification: Agents as First-Class Entity

**Spec Number:** 66
**Author:** Claude Code
**Date:** 2026-02-26
**Ideation:** `specs/agents-first-class-entity/01-ideation.md`

---

## 1. Overview

Elevate the Agent concept from a Mesh-only abstraction to a first-class entity across all of DorkOS. Today, agents exist as `.dork/agent.json` files read exclusively by the Mesh subsystem. After this work, agents become the primary identity users see in the sidebar, directory picker, Pulse schedules, and tab title — regardless of whether Mesh is enabled. A dedicated Agent Settings Dialog provides a world-class configuration experience covering identity, persona, capabilities, and cross-subsystem connections.

## 2. Background / Problem Statement

Agents currently live in `.dork/agent.json` (ADR-0024, ADR-0043) but are invisible outside the Mesh panel. Users see raw directory paths everywhere — sidebar, Pulse schedules, directory picker recents — even when a named agent exists. This creates a disconnect: the user thinks in terms of agents ("my backend bot", "my docs agent") but the UI speaks in paths (`/Users/me/projects/api`).

Key gaps:

- **No agent identity in the sidebar** — the most-visible surface shows only a folder icon + path
- **No persona injection** — agents have no way to influence Claude's behavior per-project
- **No visual identity** — agents lack color/emoji, making multi-agent workflows visually indistinct
- **Agent config requires editing JSON** — no UI for viewing or modifying `.dork/agent.json`
- **Mesh dependency** — agent identity requires `DORKOS_MESH_ENABLED=true`, even though the manifest file is pure filesystem I/O

## 3. Goals

- Agent name, color dot, and emoji visible in the sidebar when CWD has `.dork/agent.json`
- Dedicated Agent Settings Dialog with 4 tabs (Identity, Persona, Capabilities, Connections)
- DirectoryPicker recents show agent names for registered directories
- Pulse schedule rows display agent identity instead of raw paths
- Persona text injected into Claude's system prompt when enabled
- Tab title and favicon reflect agent overrides
- All agent identity features work WITHOUT Mesh enabled
- Unregistered directories work exactly as today with zero degradation
- Quick agent creation via "+ Agent" button in sidebar

## 4. Non-Goals

- Replacing `?dir=` URL params with `?agent=` (navigation remains directory-based)
- Agent capability enforcement (connecting `capabilities[]` to MCP tool access)
- A2A interop via `toAgentCard()` conversion
- Multi-agent sessions (one session, multiple agents)
- Agent-to-agent communication (handled by Relay)
- Agent marketplace or sharing mechanisms

## 5. Technical Dependencies

| Dependency                                           | Version  | Purpose                                   |
| ---------------------------------------------------- | -------- | ----------------------------------------- |
| `zod`                                                | existing | Schema extensions for new manifest fields |
| `@tanstack/react-query`                              | existing | Entity hooks for agent data fetching      |
| `zustand`                                            | existing | Agent dialog open/close state             |
| `motion`                                             | existing | Dialog animations                         |
| `lucide-react`                                       | existing | Icons (Settings, Plus, Palette, etc.)     |
| shadcn `Tabs`, `Dialog`, `Select`, `Switch`, `Badge` | existing | Agent Dialog UI primitives                |

No new external dependencies required.

## 6. Detailed Design

### 6.1 Schema Extensions

**File:** `packages/shared/src/mesh-schemas.ts`

Add four new optional fields to `AgentManifestSchema`:

```typescript
export const AgentManifestSchema = z.object({
  // ... existing fields (id, name, description, runtime, capabilities, behavior, budget, namespace, registeredAt, registeredBy)
  persona: z.string().max(4000).optional().openapi({
    description: 'System prompt persona text injected into Claude sessions',
    example: 'You are backend-bot, an expert in REST API design...',
  }),
  personaEnabled: z.boolean().default(true).openapi({
    description: 'Whether persona text is injected into system prompt',
  }),
  color: z.string().optional().openapi({
    description: 'CSS color override for visual identity (e.g., "#6366f1")',
    example: '#6366f1',
  }),
  icon: z.string().optional().openapi({
    description: 'Emoji override for visual identity',
    example: '\u{1F916}',
  }),
});
```

Add same fields to `UpdateAgentRequestSchema`:

```typescript
export const UpdateAgentRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  // New fields:
  persona: z.string().max(4000).optional(),
  personaEnabled: z.boolean().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
});
```

Add new request/response schemas for the agent identity endpoints:

```typescript
export const ResolveAgentsRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(20),
});

export const ResolveAgentsResponseSchema = z.object({
  agents: z.record(z.string(), AgentManifestSchema.nullable()),
});

export const CreateAgentRequestSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  runtime: AgentRuntimeSchema.optional().default('claude-code'),
});
```

### 6.2 Extract Manifest I/O to `packages/shared/`

**Current location:** `packages/mesh/src/manifest.ts` (71 lines)
**New location:** `packages/shared/src/manifest.ts`

Move `readManifest()`, `writeManifest()`, `removeManifest()` and constants (`MANIFEST_DIR = '.dork'`, `MANIFEST_FILE = 'agent.json'`) to `packages/shared/src/manifest.ts`. This module has zero dependencies on Mesh/Drizzle/SQLite — it is pure filesystem I/O using `node:fs/promises` and Zod validation.

**Re-export from Mesh:** Update `packages/mesh/src/manifest.ts` to re-export:

```typescript
export { readManifest, writeManifest, removeManifest } from '@dorkos/shared/manifest';
```

This preserves all existing Mesh imports while enabling the server to import manifest I/O without depending on `@dorkos/mesh`.

**New export in `packages/shared/package.json`:**

```json
{
  "exports": {
    "./manifest": "./src/manifest.ts"
  }
}
```

### 6.3 Database Schema Updates

**File:** `packages/db/src/schema/mesh.ts`

Add columns to the `agents` table for the new fields:

```typescript
export const agents = sqliteTable('agents', {
  // ... existing columns
  persona: text('persona'),
  personaEnabled: integer('persona_enabled', { mode: 'boolean' }).notNull().default(true),
  color: text('color'),
  icon: text('icon'),
});
```

Create a new Drizzle migration (`0004_*.sql`) to add these columns to the existing table. The migration uses `ALTER TABLE ADD COLUMN` with defaults so existing rows are unaffected.

Update `AgentRegistry` methods (`upsert`, `update`, `get`, `list`) in `packages/mesh/src/agent-registry.ts` to handle the new fields. The reconciler already reads from `.dork/agent.json` and upserts — it will naturally pick up the new fields.

### 6.4 New API Routes: `/api/agents`

**File:** `apps/server/src/routes/agents.ts` (NEW)

A lightweight route file that operates independently of Mesh. Not behind any feature flag — always mounted.

```typescript
import { Router } from 'express';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import {
  ResolveAgentsRequestSchema,
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
} from '@dorkos/shared/mesh-schemas';
import { validateBoundary } from '../lib/boundary.js';

export function createAgentsRouter(): Router {
  const router = Router();

  // Get agent for a working directory
  // GET /api/agents/current?path=/path/to/project
  router.get('/current', async (req, res) => {
    const path = req.query.path as string;
    if (!path) return res.status(400).json({ error: 'path query parameter required' });
    validateBoundary(path, res);
    const manifest = await readManifest(path);
    if (!manifest) return res.status(404).json({ error: 'No agent registered at this path' });
    return res.json(manifest);
  });

  // Batch resolve agents for multiple paths (avoids N+1 in DirectoryPicker)
  // POST /api/agents/resolve
  router.post('/resolve', async (req, res) => {
    const result = ResolveAgentsRequestSchema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    const agents: Record<string, AgentManifest | null> = {};
    await Promise.all(
      result.data.paths.map(async (p) => {
        agents[p] = await readManifest(p);
      })
    );
    return res.json({ agents });
  });

  // Create a new agent (writes .dork/agent.json)
  // POST /api/agents
  router.post('/', async (req, res) => {
    const result = CreateAgentRequestSchema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    // Generate ULID, populate defaults, write manifest
    // Return created manifest
  });

  // Update agent by path
  // PATCH /api/agents/current?path=/path/to/project
  router.patch('/current', async (req, res) => {
    const path = req.query.path as string;
    if (!path) return res.status(400).json({ error: 'path query parameter required' });
    const result = UpdateAgentRequestSchema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    // Read existing manifest, merge updates, write back
    // Return updated manifest
  });

  return router;
}
```

**Mount in `apps/server/src/index.ts`:**

```typescript
// Always mounted — not behind any feature flag
app.use('/api/agents', createAgentsRouter());
```

**Boundary enforcement:** All path parameters go through `validateBoundary()` to prevent accessing agents outside the configured directory boundary.

### 6.5 Transport Interface Extensions

**File:** `packages/shared/src/transport.ts`

Add agent identity methods to the `Transport` interface:

```typescript
export interface Transport {
  // ... existing methods

  // Agent identity (always available, no feature flag)
  getAgentByPath(path: string): Promise<AgentManifest | null>;
  resolveAgents(paths: string[]): Promise<Record<string, AgentManifest | null>>;
  createAgent(
    path: string,
    name?: string,
    description?: string,
    runtime?: string
  ): Promise<AgentManifest>;
  updateAgentByPath(path: string, updates: Partial<AgentManifest>): Promise<AgentManifest>;
}
```

Implement in both `HttpTransport` (HTTP calls to `/api/agents/*`) and `DirectTransport` (direct `readManifest`/`writeManifest` calls).

### 6.6 New FSD Entity Layer: `entities/agent/`

**Directory:** `apps/client/src/layers/entities/agent/`

```
entities/agent/
├── model/
│   ├── use-current-agent.ts
│   ├── use-create-agent.ts
│   ├── use-update-agent.ts
│   └── use-agent-visual.ts
├── api/
│   └── queries.ts
└── index.ts
```

#### `api/queries.ts`

Transport call wrappers with TanStack Query keys:

```typescript
export const agentKeys = {
  all: ['agents'] as const,
  byPath: (path: string) => ['agents', 'byPath', path] as const,
  resolved: (paths: string[]) => ['agents', 'resolved', ...paths] as const,
};
```

#### `model/use-current-agent.ts`

```typescript
export function useCurrentAgent(cwd: string | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: agentKeys.byPath(cwd ?? ''),
    queryFn: () => transport.getAgentByPath(cwd!),
    enabled: !!cwd,
    staleTime: 60_000, // Agent config changes infrequently
    gcTime: 5 * 60_000,
  });
}
```

Returns `{ data: AgentManifest | null, isLoading, ... }`.

#### `model/use-create-agent.ts`

TanStack Query mutation that calls `transport.createAgent()` and invalidates the `agentKeys.byPath` query on success.

#### `model/use-update-agent.ts`

TanStack Query mutation that calls `transport.updateAgentByPath()` with optimistic update on the `agentKeys.byPath` query.

#### `model/use-agent-visual.ts`

Single source of truth for all visual identity rendering:

```typescript
interface AgentVisual {
  color: string; // HSL color string
  emoji: string; // Single emoji character
}

export function useAgentVisual(agent: AgentManifest | null | undefined, cwd: string): AgentVisual {
  return useMemo(() => {
    if (agent) {
      // Priority: user override > hash from agent.id
      const hashSource = agent.id;
      return {
        color: agent.color ?? hashToHslColor(hashSource),
        emoji: agent.icon ?? hashToEmoji(hashSource),
      };
    }
    // No agent: hash from CWD (current behavior)
    return {
      color: hashToHslColor(cwd),
      emoji: hashToEmoji(cwd),
    };
  }, [agent, cwd]);
}
```

#### `index.ts`

```typescript
/**
 * Agent entity — domain hooks for agent identity, visual identity, and CRUD.
 * Works independently of Mesh — reads .dork/agent.json directly.
 *
 * @module entities/agent
 */
export { useCurrentAgent } from './model/use-current-agent';
export { useCreateAgent } from './model/use-create-agent';
export { useUpdateAgent } from './model/use-update-agent';
export { useAgentVisual } from './model/use-agent-visual';
```

### 6.7 Sidebar AgentHeader Component

**File:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

Replace the current directory breadcrumb area (lines 167-186) with a new `AgentHeader` component. Extract it to a separate file to keep the sidebar manageable.

**File:** `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx` (NEW)

```typescript
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';

interface AgentHeaderProps {
  cwd: string;
  onOpenPicker: () => void;
  onOpenAgentDialog: () => void;
}

export function AgentHeader({ cwd, onOpenPicker, onOpenAgentDialog }: AgentHeaderProps) {
  const { data: agent, isLoading } = useCurrentAgent(cwd);
  const visual = useAgentVisual(agent ?? null, cwd);

  if (isLoading) {
    return <Skeleton className="h-10 w-full" />;
  }

  if (agent) {
    return (
      <div className="flex min-w-0 items-start gap-2 px-2 py-1.5">
        {/* Colored dot */}
        <span
          className="mt-1 size-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: visual.color }}
        />
        {/* Agent info — clickable to open dialog */}
        <button
          onClick={onOpenAgentDialog}
          className="hover:bg-accent min-w-0 flex-1 rounded-md px-1 py-0.5 text-left"
        >
          <div className="flex items-center gap-1">
            <span className="text-sm">{visual.emoji}</span>
            <span className="truncate text-sm font-semibold">{agent.name}</span>
          </div>
          {agent.description && (
            <p className="text-muted-foreground truncate text-xs">{agent.description}</p>
          )}
        </button>
        {/* Settings gear */}
        <Button variant="ghost" size="icon-sm" onClick={onOpenAgentDialog} aria-label="Agent settings">
          <Settings className="size-(--size-icon-sm)" />
        </Button>
      </div>
    );
  }

  // Unregistered directory: current behavior + subtle CTA
  return (
    <div className="flex min-w-0 items-center gap-1 px-2 py-1.5">
      <button
        onClick={onOpenPicker}
        className="hover:bg-accent flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5"
        title={cwd}
      >
        <FolderOpen className="size-(--size-icon-sm) flex-shrink-0" />
        <PathBreadcrumb path={cwd} maxSegments={3} size="sm" />
      </button>
      <button
        onClick={handleQuickCreate}
        className="text-muted-foreground hover:text-foreground text-xs whitespace-nowrap"
      >
        + Agent
      </button>
    </div>
  );
}
```

**Quick create flow** (`handleQuickCreate`):

1. Call `createAgent` mutation with path=cwd, name derived from directory basename
2. On success, open the Agent Dialog for further customization

Below the AgentHeader, show the path in a smaller secondary line when an agent is present:

```typescript
{agent && (
  <button
    onClick={onOpenPicker}
    className="text-muted-foreground hover:text-foreground truncate px-2 text-xs"
    title={cwd}
  >
    <PathBreadcrumb path={cwd} maxSegments={2} size="xs" />
  </button>
)}
```

### 6.8 Agent Settings Dialog

**Directory:** `apps/client/src/layers/features/agent-settings/`

```
features/agent-settings/
├── ui/
│   ├── AgentDialog.tsx          # Main dialog shell with tabs
│   ├── IdentityTab.tsx          # Tab 1: Name, description, color, emoji, runtime
│   ├── PersonaTab.tsx           # Tab 2: Persona text, toggle, preview
│   ├── CapabilitiesTab.tsx      # Tab 3: Capabilities, namespace, behavior, budget
│   └── ConnectionsTab.tsx       # Tab 4: Linked Pulse/Relay/Mesh info
├── model/
│   └── use-agent-dialog.ts      # Dialog open/close state (Zustand slice or local)
└── index.ts
```

#### `AgentDialog.tsx`

Uses `ResponsiveDialog` + `Tabs` from shared/ui. Follows the same pattern as `SettingsDialog.tsx`:

```typescript
export function AgentDialog({ agentPath, open, onOpenChange }: Props) {
  const { data: agent } = useCurrentAgent(agentPath);
  const updateAgent = useUpdateAgent();
  const [activeTab, setActiveTab] = useState('identity');

  if (!agent) return null;

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-[540px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{agent.name}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>Agent configuration</ResponsiveDialogDescription>
          <ResponsiveDialogFullscreenToggle />
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="identity">Identity</TabsTrigger>
              <TabsTrigger value="persona">Persona</TabsTrigger>
              <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
              <TabsTrigger value="connections">Connections</TabsTrigger>
            </TabsList>

            <TabsContent value="identity">
              <IdentityTab agent={agent} onUpdate={handleUpdate} />
            </TabsContent>
            <TabsContent value="persona">
              <PersonaTab agent={agent} onUpdate={handleUpdate} />
            </TabsContent>
            <TabsContent value="capabilities">
              <CapabilitiesTab agent={agent} onUpdate={handleUpdate} />
            </TabsContent>
            <TabsContent value="connections">
              <ConnectionsTab agent={agent} />
            </TabsContent>
          </Tabs>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
```

#### Tab 1: Identity

| Field             | Type                                          | Maps to                                                           |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Name              | Text input                                    | `agent.name`                                                      |
| Description       | Textarea (2-3 rows)                           | `agent.description`                                               |
| Color             | Color input or preset palette                 | `agent.color` (null = deterministic)                              |
| Emoji             | Emoji picker (30-emoji grid from `EMOJI_SET`) | `agent.icon` (null = deterministic)                               |
| Runtime           | Select dropdown                               | `agent.runtime` ('claude-code' \| 'cursor' \| 'codex' \| 'other') |
| Working Directory | Read-only text with copy button               | Derived from CWD, not editable                                    |

Color and emoji show "Reset to default" option that clears the override (sets to null), reverting to deterministic hash behavior.

#### Tab 2: Persona

| Field          | Type                            | Maps to                                  |
| -------------- | ------------------------------- | ---------------------------------------- |
| Persona text   | Textarea (8-10 rows, monospace) | `agent.persona`                          |
| Enabled toggle | Switch                          | `agent.personaEnabled`                   |
| Preview        | Read-only code block            | Rendered XML preview of injected context |

Guidance text above the textarea: "This text is appended to Claude Code's system prompt for every session in this directory. Use it to define the agent's expertise, constraints, and personality."

The preview section shows a live rendering of the `<agent_identity>` and `<agent_persona>` XML blocks that will be injected (see Section 6.10).

#### Tab 3: Capabilities

| Field          | Type                             | Maps to                          |
| -------------- | -------------------------------- | -------------------------------- |
| Capabilities   | Tag/chip input (comma-separated) | `agent.capabilities[]`           |
| Namespace      | Text input                       | `agent.namespace`                |
| Response Mode  | Select dropdown                  | `agent.behavior.responseMode`    |
| Max Hops       | Number input                     | `agent.budget.maxHopsPerMessage` |
| Max Calls/Hour | Number input                     | `agent.budget.maxCallsPerHour`   |

This tab surfaces Mesh-related configuration in agent-centric language. No "Mesh" branding — it uses terms like "capabilities" and "behavior" that make sense even without Mesh context.

#### Tab 4: Connections

Read-mostly view linking to other subsystems:

- **Pulse schedules:** List of schedules whose CWD matches this agent's path, with links to open Pulse panel
- **Relay endpoints:** List of Relay endpoints registered for this agent (if Relay enabled)
- **Mesh health:** Status badge (active/inactive/stale), last seen timestamp, heartbeat info (if Mesh enabled)

Each section gracefully hides when its subsystem is disabled. Empty states show helpful text explaining the subsystem.

**Data fetching:** Connections tab uses existing entity hooks (`useSchedules`, `useRelayEndpoints`, `useMeshAgentHealth`) with filters. These hooks already exist — no new queries needed, just filtered views.

### 6.9 DirectoryPicker Enhancements

**File:** `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`

#### Recent View Enhancement

The recent view currently shows (lines 191-207):

```typescript
{recentCwds.slice(0, 10).map((recent) => (
  <button onClick={() => handleRecentSelect(recent.path)}>
    <FolderOpen className="..." />
    {shortenHomePath(recent.path)}
    <span className="text-xs">{formatRelativeTime(recent.accessedAt)}</span>
  </button>
))}
```

**Enhancement:** Batch-resolve agents for all recent paths when the picker opens, then display agent identity for registered dirs.

Since DirectoryPicker is in `shared/ui/`, it cannot import from `entities/agent/` (FSD layer violation). Instead, the parent component (feature layer) resolves agents and passes them as a prop:

```typescript
// DirectoryPicker accepts optional resolved agents map
interface DirectoryPickerProps {
  // ... existing props
  resolvedAgents?: Record<string, AgentManifest | null>;
}
```

The calling feature component fetches agents via `useResolvedAgents(recentPaths)` (a new hook in `entities/agent/`) and passes the result down.

**Recent item rendering with agent:**

```typescript
{recentCwds.slice(0, 10).map((recent) => {
  const agent = resolvedAgents?.[recent.path];
  return (
    <button onClick={() => handleRecentSelect(recent.path)}>
      {agent ? (
        <>
          <span className="size-2 rounded-full" style={{ backgroundColor: agentColor }} />
          <span className="text-sm">{agentEmoji}</span>
          <span className="font-medium">{agent.name}</span>
          <span className="text-muted-foreground text-xs">{shortenHomePath(recent.path)}</span>
        </>
      ) : (
        <>
          <FolderOpen className="..." />
          {shortenHomePath(recent.path)}
        </>
      )}
      <span className="text-xs">{formatRelativeTime(recent.accessedAt)}</span>
    </button>
  );
})}
```

**Batch resolution:** Uses `POST /api/agents/resolve` to resolve all recent paths in a single request. The `useResolvedAgents` hook:

```typescript
export function useResolvedAgents(paths: string[]) {
  const transport = useTransport();
  return useQuery({
    queryKey: agentKeys.resolved(paths),
    queryFn: () => transport.resolveAgents(paths),
    enabled: paths.length > 0,
    staleTime: 60_000,
  });
}
```

### 6.10 Context Builder — Persona Injection

**File:** `apps/server/src/services/core/context-builder.ts`

Add a new `buildAgentBlock(cwd)` function alongside existing `buildEnvBlock` and `buildGitBlock`:

```typescript
import { readManifest } from '@dorkos/shared/manifest';

export async function buildSystemPromptAppend(cwd: string): Promise<string> {
  const [envResult, gitResult, agentResult] = await Promise.allSettled([
    buildEnvBlock(cwd),
    buildGitBlock(cwd),
    buildAgentBlock(cwd), // NEW
  ]);

  return [
    envResult.status === 'fulfilled' ? envResult.value : '',
    gitResult.status === 'fulfilled' ? gitResult.value : '',
    agentResult.status === 'fulfilled' ? agentResult.value : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function buildAgentBlock(cwd: string): Promise<string> {
  const manifest = await readManifest(cwd);
  if (!manifest) return '';

  const identityLines = [
    `Name: ${manifest.name}`,
    `ID: ${manifest.id}`,
    manifest.description && `Description: ${manifest.description}`,
    manifest.capabilities.length > 0 && `Capabilities: ${manifest.capabilities.join(', ')}`,
  ].filter(Boolean);

  const blocks = [`<agent_identity>\n${identityLines.join('\n')}\n</agent_identity>`];

  if (manifest.personaEnabled !== false && manifest.persona) {
    blocks.push(`<agent_persona>\n${manifest.persona}\n</agent_persona>`);
  }

  return blocks.join('\n\n');
}
```

**Key behavior:**

- `<agent_identity>` is always included when a manifest exists (informational, not behavioral)
- `<agent_persona>` is only included when `personaEnabled` is true (default) AND `persona` is non-empty
- Uses `readManifest` from `@dorkos/shared/manifest` — no Mesh dependency
- Never throws (consistent with existing context-builder pattern)

### 6.11 Favicon / Tab Title Integration

**File:** `apps/client/src/layers/shared/lib/favicon-utils.ts`

The existing functions `hashToHslColor(cwd)` and `hashToEmoji(cwd)` hash from the CWD string. With agents, the visual identity priority is:

1. Agent has `color`/`icon` override → use override
2. Agent exists (no override) → hash from `agent.id` (stable across CWD renames)
3. No agent → hash from CWD (current behavior, unchanged)

The `useAgentVisual` hook (Section 6.6) already implements this priority logic. The favicon/title system consumes it via the existing `App.tsx` or a shared effect hook.

**No changes to `favicon-utils.ts` functions themselves** — they remain pure hash utilities. The agent-aware logic lives in `useAgentVisual`, which is consumed by whatever component manages the favicon (currently in `App.tsx` or a dedicated hook).

**Tab title update:** Currently `updateTabBadge()` sets title to `(N) DorkOS`. With an agent, the title becomes `[emoji] AgentName — DorkOS` (or `(N) [emoji] AgentName — DorkOS` with badge). The component managing document title reads from `useAgentVisual` and `useCurrentAgent`.

### 6.12 Pulse Integration

#### ScheduleRow Enhancement

**File:** `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx`

When a schedule's CWD has a registered agent, show agent identity:

```typescript
// ScheduleRow receives agent data from parent (resolved in PulsePanel)
interface ScheduleRowProps {
  schedule: PulseSchedule;
  agent?: AgentManifest | null;
}

// In the row display:
{agent ? (
  <div className="flex items-center gap-1">
    <span className="size-2 rounded-full" style={{ backgroundColor: visual.color }} />
    <span className="text-xs">{visual.emoji}</span>
    <span className="text-sm font-medium">{agent.name}</span>
  </div>
) : (
  <span className="text-muted-foreground text-xs">{shortenHomePath(schedule.cwd)}</span>
)}
```

#### CreateScheduleDialog Enhancement

**File:** `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`

After the user selects a CWD via DirectoryPicker, if that CWD has a registered agent, show the agent name prominently in the form above the path:

```typescript
{selectedAgent && (
  <div className="flex items-center gap-2 rounded-md bg-accent/50 px-3 py-2">
    <span className="size-2.5 rounded-full" style={{ backgroundColor: visual.color }} />
    <span>{visual.emoji}</span>
    <span className="font-medium">{selectedAgent.name}</span>
  </div>
)}
```

### 6.13 MCP Tool Enhancement

**File:** `apps/server/src/services/core/mcp-tool-server.ts`

Add a new MCP tool so Claude sessions can query their own agent identity:

```typescript
tool('agent_get_current', {
  description: 'Get the agent identity for the current working directory',
  parameters: z.object({}),
  execute: async () => {
    const manifest = await readManifest(deps.defaultCwd);
    if (!manifest) {
      return jsonContent({ agent: null, message: 'No agent registered for current directory' });
    }
    return jsonContent({ agent: manifest });
  },
});
```

This tool is always available (not guarded by `requireMesh`), enabling Claude to know its own identity even without Mesh.

## 7. User Experience

### Agent-Registered Directory

1. User opens DorkOS and navigates to a directory with `.dork/agent.json`
2. Sidebar shows: colored dot + emoji + agent name + description
3. Tab title shows: `[emoji] Agent Name — DorkOS`
4. Favicon shows agent's color (override or deterministic from ID)
5. Claude sessions in this directory receive `<agent_identity>` and `<agent_persona>` blocks

### Unregistered Directory

1. User opens DorkOS and navigates to a directory without `.dork/agent.json`
2. Sidebar shows: folder icon + path breadcrumb + subtle "+ Agent" button (identical to current behavior plus CTA)
3. Tab title and favicon work as today (hash from CWD)
4. No `<agent_identity>` block in system prompt

### Agent Creation Flow

1. User clicks "+ Agent" in sidebar
2. System creates `.dork/agent.json` with defaults: name from directory basename, ULID id, runtime 'claude-code'
3. Agent Dialog opens to the Identity tab for immediate customization
4. User edits name, description, picks a color/emoji
5. Changes save automatically via PATCH

### Agent Settings Flow

1. User clicks agent name in sidebar (or gear icon)
2. Agent Dialog opens with 4 tabs
3. User edits fields — each change triggers a PATCH to `.dork/agent.json`
4. Optimistic UI updates immediately; reverts on error
5. Persona preview shows live XML that will be injected

### Directory Picker with Agents

1. User opens directory picker (change working directory)
2. Recent view shows agent names + colored dots for registered dirs
3. Plain directories show folder icon + path as today
4. User can visually distinguish "agents" from plain folders at a glance

## 8. Testing Strategy

### Unit Tests

**Schema tests** (`packages/shared/src/__tests__/mesh-schemas.test.ts`):

- Validate that new fields (persona, personaEnabled, color, icon) parse correctly
- Validate defaults (personaEnabled defaults to true)
- Validate max length enforcement (persona max 4000 chars)
- Validate UpdateAgentRequestSchema accepts partial updates

**Manifest I/O tests** (`packages/shared/src/__tests__/manifest.test.ts`):

- Moved from `packages/mesh/` — same tests, new location
- Test readManifest returns null for missing file
- Test writeManifest creates .dork directory if needed
- Test round-trip: write then read returns same data
- Test new fields (persona, color, icon) persist correctly

**Context builder tests** (`apps/server/src/services/core/__tests__/context-builder.test.ts`):

- Test buildAgentBlock returns empty string when no manifest
- Test buildAgentBlock includes identity block when manifest exists
- Test persona block only included when personaEnabled is true AND persona is non-empty
- Test persona block excluded when personaEnabled is false
- Test buildSystemPromptAppend includes agent block alongside env/git blocks
- Mock `readManifest` to avoid filesystem dependency

**Agent routes tests** (`apps/server/src/routes/__tests__/agents.test.ts`):

- Test GET /current returns 404 for unregistered path
- Test GET /current returns manifest for registered path
- Test POST /resolve returns agents for mixed registered/unregistered paths
- Test POST / creates agent with defaults
- Test PATCH /current updates existing agent
- Test boundary validation rejects out-of-bounds paths

### Component Tests

**AgentHeader tests** (`apps/client/src/layers/features/session-list/ui/__tests__/AgentHeader.test.tsx`):

- Test renders agent name when agent exists
- Test renders folder icon + path when no agent
- Test renders "+ Agent" button for unregistered dirs
- Test clicking agent name triggers dialog open callback
- Test loading state shows skeleton

**AgentDialog tests** (`apps/client/src/layers/features/agent-settings/ui/__tests__/AgentDialog.test.tsx`):

- Test all 4 tabs render and switch correctly
- Test Identity tab fields are populated from agent data
- Test Persona tab toggle controls injection preview
- Test form submission triggers update mutation

**DirectoryPicker tests** (`apps/client/src/layers/shared/ui/__tests__/DirectoryPicker.test.tsx`):

- Test recent items show agent name when resolvedAgents provided
- Test recent items show folder icon when no agent
- Test mixed list (some agents, some plain dirs) renders correctly

### Integration Tests

**Agent lifecycle** (server-side):

- Create agent → read back → update → verify changes in file
- Verify boundary enforcement prevents accessing agents outside boundary
- Verify resolve endpoint handles concurrent requests

**Persona injection** (server-side):

- Verify full system prompt includes agent identity when manifest exists
- Verify persona toggle controls inclusion
- Verify graceful handling when manifest file is corrupt

## 9. Performance Considerations

**Agent resolution latency:** `readManifest()` performs a single filesystem read + Zod parse. Expected latency: <5ms per call. The batch resolve endpoint reads up to 20 paths in parallel.

**TanStack Query caching:** `useCurrentAgent` uses `staleTime: 60_000` (1 minute). Agent config changes infrequently, so most renders hit the cache. The query is keyed by CWD path — switching directories triggers a fresh fetch.

**Batch resolve for DirectoryPicker:** The `POST /api/agents/resolve` endpoint resolves up to 20 recent paths in a single request, avoiding N+1 queries. Paths are resolved in parallel via `Promise.all`.

**Context builder:** `buildAgentBlock` adds one filesystem read to session creation. This runs in parallel with env and git blocks via `Promise.allSettled`, so it adds negligible latency to the overall prompt construction.

**No impact on unregistered directories:** When no `.dork/agent.json` exists, `readManifest` returns null immediately after a failed `stat` — no parsing overhead.

## 10. Security Considerations

**Directory boundary enforcement:** All agent API endpoints validate paths via `validateBoundary()`. This prevents reading/writing agent manifests outside the configured boundary directory (default: home directory).

**Persona injection safety:** The persona text is injected as a system prompt append, not as user content. It undergoes Zod validation (max 4000 chars) before being written. The XML block format (`<agent_persona>`) is consistent with existing context builder patterns.

**No credential storage:** Agent manifests do not contain secrets or credentials. The schema explicitly does not include API keys, tokens, or authentication data.

**File write atomicity:** `writeManifest()` uses atomic write (temp file + rename) to prevent corruption from concurrent writes or crashes.

## 11. Documentation

**Files to update:**

| Document                        | Update                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| `contributing/architecture.md`  | Add Agent entity layer to FSD layer table; document `/api/agents` endpoints |
| `contributing/data-fetching.md` | Add agent query key patterns                                                |
| `docs/guides/agents.mdx`        | NEW: User-facing guide for agent configuration                              |
| `docs/guides/persona.mdx`       | NEW: Guide for persona injection                                            |

## 12. Implementation Phases

### Phase 1: Foundation

Schema extensions, manifest I/O extraction, agent API routes, Transport methods, context-builder persona injection.

**Deliverables:**

- Extended `AgentManifestSchema` with persona, personaEnabled, color, icon
- `@dorkos/shared/manifest` module (extracted from mesh)
- `GET/POST/PATCH /api/agents/*` endpoints (always available)
- `POST /api/agents/resolve` batch endpoint
- Transport interface extensions + adapter implementations
- DB migration for new columns
- `buildAgentBlock()` in context-builder
- `agent_get_current` MCP tool
- Unit tests for all of the above

### Phase 2: Entity Layer + Sidebar

New FSD entity layer and sidebar integration.

**Deliverables:**

- `entities/agent/` — useCurrentAgent, useCreateAgent, useUpdateAgent, useAgentVisual
- `AgentHeader` component in session-list feature
- Quick create flow ("+ Agent" → create manifest → open dialog)
- Favicon/tab title integration via useAgentVisual
- Component tests

### Phase 3: Agent Dialog

The dedicated 4-tab Agent Settings Dialog.

**Deliverables:**

- `features/agent-settings/` — AgentDialog, IdentityTab, PersonaTab, CapabilitiesTab, ConnectionsTab
- Persona preview rendering
- Color picker and emoji picker (30-emoji grid from EMOJI_SET)
- Runtime dropdown
- Capabilities tag editor
- Connections tab with Pulse/Relay/Mesh cross-references
- Component tests

### Phase 4: Surface Integration

DirectoryPicker enhancements, Pulse integration, polish.

**Deliverables:**

- DirectoryPicker agent display in recents
- useResolvedAgents hook for batch fetching
- ScheduleRow agent display
- CreateScheduleDialog agent display
- Documentation updates

## 13. Open Questions

No unresolved questions — all decisions have been made during ideation and Step 2 clarification.

## 14. Related ADRs

| ADR                                                                                                                     | Relevance                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [ADR-0024: DorkOS-Native Agent Manifest Format](../../decisions/0024-dorkos-native-agent-manifest-format.md)            | Establishes `.dork/agent.json` format that this spec extends            |
| [ADR-0043: File as Canonical Source of Truth](../../decisions/0043-file-canonical-source-of-truth-for-mesh-registry.md) | File-first architecture that this spec depends on for Mesh independence |

## 15. References

- Ideation document: `specs/agents-first-class-entity/01-ideation.md`
- Research report: `research/20260226_agents_first_class_entity.md`
- Existing manifest I/O: `packages/mesh/src/manifest.ts`
- Context builder: `apps/server/src/services/core/context-builder.ts`
- Favicon utilities: `apps/client/src/layers/shared/lib/favicon-utils.ts`
- ResponsiveDialog pattern: `apps/client/src/layers/shared/ui/responsive-dialog.tsx`
- RegisterAgentDialog (reference): `apps/client/src/layers/features/mesh/ui/RegisterAgentDialog.tsx`
