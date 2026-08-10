import { useState, useCallback } from 'react';
import {
  SectionHeader,
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuSurface,
} from '@/layers/shared/ui';
import { Bot, Hash } from 'lucide-react';
import { SessionRow, type SessionBorderKind } from '@/layers/entities/session';
import { resolveAgentVisual } from '@/layers/entities/agent';
import type { Session } from '@dorkos/shared/types';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  AgentActivityBadge,
  AgentListItem,
  AgentOnboardingCard,
  GroupCreateInput,
  buildAgentsHeaderMenuNodes,
  buildChannelsHeaderMenuNodes,
  useAgentRowMenuNodes,
} from '@/layers/features/dashboard-sidebar';

// ── Mock data ──

const MOCK_AGENTS = [
  {
    path: '/home/user/.dork/agents/code-reviewer',
    agent: { id: 'code-reviewer', name: 'code-reviewer', color: '#6366f1', icon: '🔍' },
    displayName: 'code-reviewer',
  },
  {
    path: '/home/user/.dork/agents/deploy-bot',
    agent: { id: 'deploy-bot', name: 'deploy-bot', color: '#f59e0b', icon: '🚀' },
    displayName: 'deploy-bot',
  },
  {
    path: '/home/user/.dork/agents/test-runner',
    agent: { id: 'test-runner', name: 'test-runner', color: '#10b981', icon: '🧪' },
    displayName: 'test-runner',
  },
] as const;

const now = new Date();

function minutesAgo(n: number): string {
  return new Date(now.getTime() - n * 60_000).toISOString();
}

const MOCK_SESSIONS: Session[] = [
  {
    id: 'sess-1',
    title: 'Refactor auth middleware',
    createdAt: minutesAgo(120),
    updatedAt: minutesAgo(3),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
  {
    id: 'sess-2',
    title: 'Add pagination to /api/agents',
    createdAt: minutesAgo(90),
    updatedAt: minutesAgo(15),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
  {
    id: 'sess-3',
    title: 'Fix CORS headers for relay',
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(45),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
];

const ALL_STATUSES: { status: SessionBorderKind; label: string }[] = [
  { status: 'streaming', label: 'Working' },
  { status: 'pendingApproval', label: 'Awaiting your approval' },
  { status: 'error', label: 'Error — check session' },
  { status: 'unseen', label: 'New activity' },
  { status: 'idle', label: 'Idle' },
];

/**
 * Thin sidebar shell for showcasing components that need SidebarMenu context.
 * Renders a narrow sidebar-like container without full app chrome.
 */
function SidebarShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar variant="inset" className="relative h-auto min-h-0 w-64 shrink-0 border-none">
        <SidebarContent className="p-2">
          <SidebarMenu>{children}</SidebarMenu>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  );
}

/** Dashboard sidebar agent component showcases. */
export function AgentSidebarShowcases() {
  return (
    <>
      <AgentActivityBadgeShowcase />
      <SessionRowCompactShowcase />
      <AgentListItemShowcase />
      <RowMenuSurfaceShowcase />
      <SectionHeaderShowcase />
      <GroupCreateInputShowcase />
      <AgentOnboardingCardShowcase />
    </>
  );
}

// ── GroupCreateInput ──

function GroupCreateInputShowcase() {
  const [lastCommitted, setLastCommitted] = useState<string | null>(null);

  return (
    <PlaygroundSection
      title="GroupCreateInput"
      description="Inline 'new group' row (DOR-329). Type a name — Enter commits (1–40 chars, trimmed), Esc or blur cancels. Used by the '+' menu, the row 'Move to group ▸ New group…' item, and the groups hint card."
    >
      <ShowcaseLabel>Interactive demo</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarShell>
          <GroupCreateInput onCommit={setLastCommitted} onCancel={() => {}} />
        </SidebarShell>
        {lastCommitted !== null && (
          <p className="text-muted-foreground mt-2 text-xs">
            Committed: <span className="text-foreground font-medium">{lastCommitted}</span>
          </p>
        )}
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ── AgentActivityBadge ──

function AgentActivityBadgeShowcase() {
  return (
    <PlaygroundSection
      title="AgentActivityBadge"
      description="Compact 6px dot badge showing aggregate agent status. Returns null when idle (no dot rendered)."
    >
      <ShowcaseLabel>All statuses</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-center gap-6">
          {ALL_STATUSES.map(({ status, label }) => (
            <div key={status} className="flex flex-col items-center gap-2">
              <div className="bg-muted flex size-8 items-center justify-center rounded-md">
                <AgentActivityBadge status={status} label={label} />
              </div>
              <span className="text-muted-foreground text-[10px]">{status}</span>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Inline context</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col gap-2">
          {ALL_STATUSES.filter((s) => s.status !== 'idle').map(({ status, label }) => (
            <div key={status} className="flex items-center gap-2 text-xs">
              <AgentActivityBadge status={status} label={label} />
              <span className="text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ── AgentSessionPreview ──

function SessionRowCompactShowcase() {
  const [activeId, setActiveId] = useState('sess-1');

  return (
    <PlaygroundSection
      title="SessionRow (compact)"
      description="Compact session row with dot indicator for the expanded agent view. Shows title, relative time, and status dot. Border state reads from the session store (idle in playground)."
    >
      <ShowcaseLabel>Active and inactive</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs space-y-1">
          {MOCK_SESSIONS.map((session) => (
            <SessionRow
              key={session.id}
              variant="compact"
              session={session}
              isActive={session.id === activeId}
              onClick={() => setActiveId(session.id)}
            />
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Long title truncation</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs">
          <SessionRow
            variant="compact"
            session={{
              ...MOCK_SESSIONS[0],
              id: 'sess-long',
              title:
                'Extremely long session title that should truncate gracefully in the compact preview row',
            }}
            isActive={false}
            onClick={() => {}}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ── AgentListItem ──

function AgentListItemShowcase() {
  const [activePath, setActivePath] = useState<string>(MOCK_AGENTS[0].path);
  const [expandedPath, setExpandedPath] = useState<string | null>(MOCK_AGENTS[0].path);
  const [activeSessionId, setActiveSessionId] = useState('sess-1');

  const handleSelect = useCallback((path: string) => {
    setActivePath(path);
    setExpandedPath(path);
  }, []);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPath((prev) => (prev === path ? null : path));
  }, []);

  return (
    <PlaygroundSection
      title="AgentListItem"
      description="Expandable agent row in the dashboard sidebar. Click to select, click again to expand/collapse. Includes context menu, dropdown menu, session previews, and status border."
    >
      <ShowcaseLabel>Interactive demo</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarShell>
          {MOCK_AGENTS.map(({ path, agent, displayName }) => {
            const isActive = activePath === path;
            return (
              <AgentListItem
                key={path}
                path={path}
                agent={agent as never}
                visual={resolveAgentVisual({ id: path })}
                displayName={displayName}
                isActive={isActive}
                isExpanded={expandedPath === path}
                onSelect={() => handleSelect(path)}
                onToggleExpand={() => handleToggleExpand(path)}
                onOpenProfile={() => {}}
                onRequestNewGroup={() => {}}
                sessions={isActive ? MOCK_SESSIONS : []}
                isLoadingSessions={false}
                activeSessionId={isActive ? activeSessionId : null}
                onSessionClick={setActiveSessionId}
                onNewSession={() => {}}
              />
            );
          })}
        </SidebarShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Pinned agent (active + expanded)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarShell>
          <AgentListItem
            path={MOCK_AGENTS[0].path}
            agent={MOCK_AGENTS[0].agent as never}
            visual={resolveAgentVisual({ id: MOCK_AGENTS[0].path })}
            displayName={MOCK_AGENTS[0].displayName}
            isActive
            isExpanded
            onSelect={() => {}}
            onToggleExpand={() => {}}
            onOpenProfile={() => {}}
            onRequestNewGroup={() => {}}
            sessions={MOCK_SESSIONS}
            isLoadingSessions={false}
            activeSessionId="sess-1"
            onSessionClick={() => {}}
            onNewSession={() => {}}
          />
        </SidebarShell>
      </ShowcaseDemo>

      <ShowcaseLabel>No sessions (empty expanded state)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarShell>
          <AgentListItem
            path={MOCK_AGENTS[1].path}
            agent={MOCK_AGENTS[1].agent as never}
            visual={resolveAgentVisual({ id: MOCK_AGENTS[1].path })}
            displayName={MOCK_AGENTS[1].displayName}
            isActive
            isExpanded
            onSelect={() => {}}
            onToggleExpand={() => {}}
            onOpenProfile={() => {}}
            onRequestNewGroup={() => {}}
            sessions={[]}
            isLoadingSessions={false}
            activeSessionId={null}
            onSessionClick={() => {}}
            onNewSession={() => {}}
          />
        </SidebarShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Collapsed (inactive)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarShell>
          {MOCK_AGENTS.map(({ path, agent, displayName }) => (
            <AgentListItem
              key={path}
              path={path}
              agent={agent as never}
              visual={resolveAgentVisual({ id: path })}
              displayName={displayName}
              isActive={false}
              isExpanded={false}
              onSelect={() => {}}
              onToggleExpand={() => {}}
              onOpenProfile={() => {}}
              onRequestNewGroup={() => {}}
              sessions={[]}
              isLoadingSessions={false}
              activeSessionId={null}
              onSessionClick={() => {}}
              onNewSession={() => {}}
            />
          ))}
        </SidebarShell>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ── SidebarMenuSurface ──

function RowMenuSurfaceShowcase() {
  const nodes = useAgentRowMenuNodes({
    path: MOCK_AGENTS[0].path,
    onOpenProfile: () => {},
    onNewSession: () => {},
    onRequestNewGroup: () => {},
  });

  return (
    <PlaygroundSection
      title="SidebarMenuSurface"
      description="The sidebar's ONE menu surface: right-click anywhere on the target, or press the vertical kebab that appears on hover and on keyboard focus. Both render the same node list, so they can never drift."
    >
      <ShowcaseLabel>Right-click target, with its hover-revealed ⋮</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarMenuSurface nodes={nodes} actionsLabel="Agent actions" className="w-64">
          <div className="border-sidebar-border text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground flex w-full cursor-context-menu items-center justify-center rounded-lg border border-dashed px-4 py-3 text-xs transition-colors">
            Right-click me, or hover for the ⋮
          </div>
        </SidebarMenuSurface>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ── SectionHeader ──

function SectionHeaderShowcase() {
  const [collapsed, setCollapsed] = useState(false);
  const [sortMode, setSortMode] = useState<'name' | 'recent'>('name');

  return (
    <PlaygroundSection
      title="SectionHeader"
      description="Every sidebar section header carries its own menu — right-click the header, or use the ⋮ that appears on hover and on focus. Both render ONE node list, so they can never drift. The section's identity icon morphs into the collapse chevron the moment you reach for it. Channels collapses and can clear its unread; Agents has no collapse and exposes the section's own Show and Sort by settings."
    >
      <ShowcaseLabel>Channels — collapsible, with unread to clear</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-64">
          <SectionHeader
            label="Channels"
            icon={Hash}
            collapsed={collapsed}
            onToggle={() => setCollapsed((prev) => !prev)}
            nodes={buildChannelsHeaderMenuNodes({
              collapsed,
              hasUnread: true,
              onNewChannel: () => {},
              onMarkAllRead: () => {},
              onToggleCollapsed: () => setCollapsed((prev) => !prev),
            })}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Agents — a label rather than a toggle, with the section settings
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-64">
          <SectionHeader
            label="Agents"
            icon={Bot}
            nodes={buildAgentsHeaderMenuNodes({
              sortMode,
              displayFilter: 'all',
              onNewAgent: () => {},
              onNewGroup: () => {},
              onSortModeChange: setSortMode,
              onDisplayFilterChange: () => {},
            })}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ── AgentOnboardingCard ──

function AgentOnboardingCardShowcase() {
  return (
    <PlaygroundSection
      title="AgentOnboardingCard"
      description="Dashed-border onboarding card shown below the agent list when fewer than 3 agents exist. Encourages adding more agents."
    >
      <ShowcaseLabel>Default</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs">
          <AgentOnboardingCard onAddAgent={() => {}} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
