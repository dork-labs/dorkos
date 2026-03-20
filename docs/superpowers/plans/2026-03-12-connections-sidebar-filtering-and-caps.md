---
title: Connections Sidebar — Agent Filtering and List Caps Implementation Plan
---

# Connections Sidebar: Agent Filtering and List Caps Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter the Connections tab agents list to only show agents reachable by the current agent, and cap agents at 3 and MCP servers at 4 with overflow links.

**Architecture:** All changes land in a single file (`ConnectionsView.tsx`). Agent filtering uses the existing `useAgentAccess` hook; caps are implemented as slice + conditional overflow button. TDD throughout — tests added to the existing `ConnectionsView.test.tsx`.

**Tech Stack:** React 19, TanStack Query, Vitest, React Testing Library

**Spec:** `docs/superpowers/specs/2026-03-12-connections-sidebar-filtering-and-caps-design.md`

---

## File Map

| File                                                                              | Change                                                                           |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx`             | Add `useAgentAccess` import + filtering logic + cap constants + overflow buttons |
| `apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx` | Add mock for `useAgentAccess` + new test cases                                   |

---

## Chunk 1: Agent Filtering via `useAgentAccess`

### Task 1: Add `useAgentAccess` mock and failing tests for agent filtering

**Files:**

- Modify: `apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx`

- [ ] **Step 1: Add the `useAgentAccess` mock at the top of the test file**

Open `apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx`.

After the existing `useRegisteredAgents` mock block (around line 23), add:

```typescript
// Mock useAgentAccess
const mockAgentAccess = vi.fn<
  () => { data: { agents: AgentManifest[] } | undefined; isLoading: boolean }
>(() => ({
  data: undefined,
  isLoading: false,
}));
vi.mock('@/layers/entities/mesh/model/use-mesh-access', () => ({
  useAgentAccess: () => mockAgentAccess(),
  useUpdateAccessRule: vi.fn(),
}));
```

Also add `mockAgentAccess.mockReturnValue({ data: undefined, isLoading: false })` to the `beforeEach` block alongside the other mock resets.

- [ ] **Step 2: Add failing tests for agent filtering**

At the end of the `describe('ConnectionsView')` block, before the closing `}`, add:

```typescript
describe('agent filtering via useAgentAccess', () => {
  it('shows all agents when no agentId is provided', () => {
    mockRegisteredAgents.mockReturnValue({
      data: { agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag2', 'Beta')] },
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('shows only reachable agents when agentId is set and access data is resolved', () => {
    mockRegisteredAgents.mockReturnValue({
      data: { agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag2', 'Beta'), makeAgent('ag3', 'Gamma')] },
    });
    // Only ag1 and ag3 are reachable
    mockAgentAccess.mockReturnValue({
      data: { agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag3', 'Gamma')] },
      isLoading: false,
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
  });

  it('shows all agents while access query is loading (avoids flicker)', () => {
    mockRegisteredAgents.mockReturnValue({
      data: { agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag2', 'Beta')] },
    });
    mockAgentAccess.mockReturnValue({ data: undefined, isLoading: true });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('shows all agents when access query returns an error (fail open)', () => {
    mockRegisteredAgents.mockReturnValue({
      data: { agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag2', 'Beta')] },
    });
    // Error state: data is undefined, isLoading is false
    mockAgentAccess.mockReturnValue({ data: undefined, isLoading: false });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run new tests to verify they fail**

```bash
pnpm vitest run apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx
```

Expected: the 4 new tests inside `agent filtering via useAgentAccess` FAIL. The first 3 pass (no filtering exists yet so all agents show), but the second test ("shows only reachable agents") should fail because filtering is not implemented.

Note: If the second test passes coincidentally (empty mock), add a third agent to make the distinction clearer.

- [ ] **Step 4: Implement agent filtering in `ConnectionsView.tsx`**

Open `apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx`.

**a) Update the import on line 3** — add `useAgentAccess`:

```typescript
import { useRegisteredAgents, useAgentAccess } from '@/layers/entities/mesh';
```

**b) After line 57** (`const agents = agentsData?.agents ?? [];`), add:

```typescript
const { data: accessData, isLoading: accessLoading } = useAgentAccess(
  agentId ?? '',
  meshEnabled && !!agentId
);
```

**c) Replace the existing `agents` usage in the render with a `visibleAgents` memo.** Add this `useMemo` after the `accessData` lines:

```typescript
const visibleAgents = useMemo(() => {
  if (!agentId || accessLoading || !accessData) return agents;
  const reachableIds = new Set(accessData.agents.map((a) => a.id));
  return agents.filter((a) => reachableIds.has(a.id));
}, [agents, agentId, accessData, accessLoading]);
```

**d) In the JSX**, replace every reference to `agents` in the Agents section with `visibleAgents`:

- Line 141: `agents.length === 0` → `visibleAgents.length === 0`
- Line 147: `agents.map(` → `visibleAgents.map(`

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm vitest run apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx
```

Expected: All tests pass (12 existing + 4 new = 16 total).

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx \
        apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx
git commit -m "feat(connections): filter agents to reachable-only via useAgentAccess"
```

---

## Chunk 2: Agents Cap and Overflow Button

### Task 2: Add failing tests for agents cap

**Files:**

- Modify: `apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx`

- [ ] **Step 1: Add failing tests for agents cap**

At the end of the `describe('ConnectionsView')` block, add:

```typescript
describe('agents cap (AGENT_CAP = 3)', () => {
  it('shows all agents when count is at or below cap', () => {
    mockRegisteredAgents.mockReturnValue({
      data: {
        agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag2', 'Beta'), makeAgent('ag3', 'Gamma')],
      },
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    expect(screen.queryByText(/more agent/)).not.toBeInTheDocument();
  });

  it('shows only the first 3 agents and an overflow button when count exceeds cap', () => {
    mockRegisteredAgents.mockReturnValue({
      data: {
        agents: [
          makeAgent('ag1', 'Alpha'),
          makeAgent('ag2', 'Beta'),
          makeAgent('ag3', 'Gamma'),
          makeAgent('ag4', 'Delta'),
          makeAgent('ag5', 'Epsilon'),
        ],
      },
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    expect(screen.queryByText('Delta')).not.toBeInTheDocument();
    expect(screen.queryByText('Epsilon')).not.toBeInTheDocument();
    expect(screen.getByText('+ 2 more agents reachable →')).toBeInTheDocument();
  });

  it('overflow button opens Mesh panel', () => {
    mockRegisteredAgents.mockReturnValue({
      data: {
        agents: [
          makeAgent('ag1', 'Alpha'),
          makeAgent('ag2', 'Beta'),
          makeAgent('ag3', 'Gamma'),
          makeAgent('ag4', 'Delta'),
        ],
      },
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('+ 1 more agent reachable →'));
    expect(mockSetMeshOpen).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 2: Run new tests to verify they fail**

```bash
pnpm vitest run apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx
```

Expected: The two tests asserting overflow buttons FAIL (no overflow buttons exist yet). The first test (≤ cap) should pass.

### Task 3: Implement agents cap and overflow button

**Files:**

- Modify: `apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx`

- [ ] **Step 1: Add cap constants and slicing logic**

Open `ConnectionsView.tsx`. After the `visibleAgents` useMemo, add:

```typescript
const AGENT_CAP = 3;
const MCP_CAP = 4;

const cappedAgents = visibleAgents.slice(0, AGENT_CAP);
const agentOverflow = visibleAgents.length - AGENT_CAP;
```

- [ ] **Step 2: Update the agents list render to use cappedAgents**

In the JSX Agents section, replace:

- `visibleAgents.length === 0` → `visibleAgents.length === 0` (no change to empty check — keep checking full list)
- `visibleAgents.map(` → `cappedAgents.map(`

- [ ] **Step 3: Add the overflow button after the SidebarMenu closing tag in the agents section**

The agents section currently ends with a `</SidebarMenu>` followed by the "Open Mesh →" `<div>`. Insert the overflow button between them:

```tsx
{
  agentOverflow > 0 && (
    <div className="px-3 py-1">
      <button
        onClick={() => setMeshOpen(true)}
        className="text-muted-foreground hover:text-foreground text-xs transition-colors"
      >
        + {agentOverflow} more {agentOverflow === 1 ? 'agent' : 'agents'} reachable →
      </button>
    </div>
  );
}
```

So the structure becomes:

```tsx
<SidebarMenu>
  {cappedAgents.map(...)}
</SidebarMenu>
{agentOverflow > 0 && (
  <div className="px-3 py-1">
    <button ...>+ {agentOverflow} more {agentOverflow === 1 ? 'agent' : 'agents'} reachable →</button>
  </div>
)}
<div className="px-3 py-2">
  <button onClick={() => setMeshOpen(true)} ...>Open Mesh →</button>
</div>
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx \
        apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx
git commit -m "feat(connections): cap agents list at 3 with overflow link to Mesh"
```

---

## Chunk 3: MCP Servers Cap and Overflow Button

### Task 4: Add failing tests for MCP servers cap

**Files:**

- Modify: `apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx`

- [ ] **Step 1: Add a `makeMcpServer` helper and update the `mockMcpConfig` type**

**a) Update the `mockMcpConfig` mock type** (around line 32 of the test file) to include the optional `status` field:

```typescript
const mockMcpConfig = vi.fn<
  () => { data: { servers: { name: string; type: string; status?: string }[] } | undefined }
>(() => ({
  data: { servers: [] },
}));
```

**b) Near the existing `makeAgent` helper**, add:

```typescript
/** Build a minimal MCP server entry for testing. */
function makeMcpServer(
  name: string,
  status = 'connected'
): { name: string; type: string; status?: string } {
  return { name, type: 'sse', status };
}
```

- [ ] **Step 2: Add failing tests for MCP servers cap**

At the end of the `describe('ConnectionsView')` block, add:

```typescript
describe('MCP servers cap (MCP_CAP = 4)', () => {
  it('shows all MCP servers when count is at or below cap', () => {
    mockMcpConfig.mockReturnValue({
      data: {
        servers: [
          makeMcpServer('context7'),
          makeMcpServer('playwright'),
          makeMcpServer('github'),
          makeMcpServer('linear'),
        ],
      },
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('context7')).toBeInTheDocument();
    expect(screen.getByText('playwright')).toBeInTheDocument();
    expect(screen.getByText('github')).toBeInTheDocument();
    expect(screen.getByText('linear')).toBeInTheDocument();
    expect(screen.queryByText(/more server/)).not.toBeInTheDocument();
  });

  it('shows only the first 4 MCP servers and an overflow button when count exceeds cap', () => {
    mockMcpConfig.mockReturnValue({
      data: {
        servers: [
          makeMcpServer('context7'),
          makeMcpServer('playwright'),
          makeMcpServer('github'),
          makeMcpServer('linear'),
          makeMcpServer('slack'),
          makeMcpServer('jira'),
        ],
      },
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('context7')).toBeInTheDocument();
    expect(screen.getByText('playwright')).toBeInTheDocument();
    expect(screen.getByText('github')).toBeInTheDocument();
    expect(screen.getByText('linear')).toBeInTheDocument();
    expect(screen.queryByText('slack')).not.toBeInTheDocument();
    expect(screen.queryByText('jira')).not.toBeInTheDocument();
    expect(screen.getByText('+ 2 more servers →')).toBeInTheDocument();
  });

  it('overflow button opens agent settings dialog', () => {
    mockMcpConfig.mockReturnValue({
      data: {
        servers: [
          makeMcpServer('context7'),
          makeMcpServer('playwright'),
          makeMcpServer('github'),
          makeMcpServer('linear'),
          makeMcpServer('slack'),
        ],
      },
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('+ 1 more server →'));
    expect(mockSetAgentDialogOpen).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 3: Run new tests to verify they fail**

```bash
pnpm vitest run apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx
```

Expected: The two tests asserting MCP overflow buttons FAIL. The ≤ cap test passes.

### Task 5: Implement MCP servers cap and overflow button

**Files:**

- Modify: `apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx`

- [ ] **Step 1: Add MCP slicing using the existing MCP_CAP constant**

`MCP_CAP` is already defined from Task 3. After the `agentOverflow` line, add:

```typescript
const cappedMcpServers = mcpServers.slice(0, MCP_CAP);
const mcpOverflow = mcpServers.length - MCP_CAP;
```

- [ ] **Step 2: Update the MCP servers render to use cappedMcpServers**

In the Tools section JSX, replace `mcpServers.map(` with `cappedMcpServers.map(`. Note: this map call is **inside the `<SidebarMenu>` block, after `DORKOS_TOOLS.map(...)`** — both share the same menu parent.

- [ ] **Step 3: Add the MCP overflow button after the MCP servers list**

The Tools section currently has `mcpServers.map(...)` followed by the "Edit capabilities →" `<div>`. Insert the overflow button between them:

```tsx
{
  mcpOverflow > 0 && (
    <div className="px-3 py-1">
      <button
        onClick={() => setAgentDialogOpen(true)}
        className="text-muted-foreground hover:text-foreground text-xs transition-colors"
      >
        + {mcpOverflow} more {mcpOverflow === 1 ? 'server' : 'servers'} →
      </button>
    </div>
  );
}
```

So the structure of the Tools section becomes:

```tsx
<SidebarMenu>
  {DORKOS_TOOLS.map(...)}   {/* always rendered, no cap */}
  {cappedMcpServers.map(...)}
</SidebarMenu>
{mcpOverflow > 0 && (
  <div className="px-3 py-1">
    <button ...>+ {mcpOverflow} more {mcpOverflow === 1 ? 'server' : 'servers'} →</button>
  </div>
)}
<div className="px-3 py-2">
  <button onClick={() => setAgentDialogOpen(true)} ...>Edit capabilities →</button>
</div>
```

- [ ] **Step 4: Run the full test suite to verify everything passes**

```bash
pnpm vitest run apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx
```

Expected: All tests pass (12 existing + 4 filtering + 3 agent cap + 3 MCP cap = 22 total).

- [ ] **Step 5: Typecheck the client**

```bash
pnpm --filter @dorkos/client exec tsc --noEmit
```

Expected: No new errors in ConnectionsView or related files.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx \
        apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx
git commit -m "feat(connections): cap MCP servers list at 4 with overflow link to agent settings"
```
