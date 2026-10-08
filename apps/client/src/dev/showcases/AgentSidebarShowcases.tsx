import { useState } from 'react';
import {
  SectionHeader,
  SidebarProvider,
  SidebarMenu,
  SidebarMenuSurface,
} from '@/layers/shared/ui';
import { Bot, Hash } from 'lucide-react';
import type { SessionBorderKind } from '@/layers/entities/session';
import { resolveAgentVisual } from '@/layers/entities/agent';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_AGENTS, minutesAgo } from './agent-sidebar-fixtures';
import {
  LIVE_BY_PATH,
  ChatListShowcase,
  SessionSwitcherShowcase,
  useSwitcherFixture,
} from './SessionSwitcherShowcases';
import {
  AgentActivityBadge,
  AgentListItem,
  GroupCreateInput,
  buildAgentsHeaderMenuNodes,
  buildChannelsHeaderMenuNodes,
  useAgentRowMenuNodes,
} from '@/layers/features/dashboard-sidebar';

// ── Mock data ──

const ALL_STATUSES: { status: SessionBorderKind; label: string }[] = [
  { status: 'streaming', label: 'Working' },
  { status: 'pendingApproval', label: 'Awaiting your approval' },
  { status: 'error', label: 'Error: check session' },
  { status: 'unseen', label: 'New activity' },
  { status: 'idle', label: 'Idle' },
];

/**
 * Thin sidebar shell for showcasing components that need SidebarMenu context.
 * Renders a narrow sidebar-like container without full app chrome.
 */
function SidebarShell({ children }: { children: React.ReactNode }) {
  // A sidebar-shaped BOX, not a `<Sidebar>`. The real component turns into an
  // off-canvas Sheet below 768px and renders nothing until something opens it —
  // so every row in this file simply vanished at phone width, and a showcase
  // that disappears on the surface it is meant to demonstrate cannot be used to
  // check anything there. `SidebarProvider` stays because the rows read its
  // context; the chrome around it was never what these showcases are about.
  return (
    <SidebarProvider defaultOpen>
      <div className="bg-sidebar text-sidebar-foreground w-64 max-w-full rounded-lg p-2">
        <SidebarMenu>{children}</SidebarMenu>
      </div>
    </SidebarProvider>
  );
}

/** Dashboard sidebar agent component showcases. */
export function AgentSidebarShowcases() {
  return (
    <>
      <AgentActivityBadgeShowcase />
      <AgentListItemShowcase />
      <ChatListShowcase />
      <SessionSwitcherShowcase />
      <RowMenuSurfaceShowcase />
      <SectionHeaderShowcase />
      <GroupCreateInputShowcase />
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
              <span className="text-muted-foreground text-3xs">{status}</span>
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

// ── AgentListItem ──

function AgentListItemShowcase() {
  const [activePath, setActivePath] = useState<string>(MOCK_AGENTS[0].path);
  useSwitcherFixture();

  return (
    <PlaygroundSection
      title="AgentListItem"
      description="One agent in the roster. Clicking it opens the conversation you were having — it never unfolds (BC-34). When two or more of its sessions are live, a 'N live' chip appears and opens the session switcher."
    >
      <ShowcaseLabel>Interactive demo — the first agent has three live sessions</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarShell>
          {MOCK_AGENTS.map(({ path, agent, displayName }) => (
            <AgentListItem
              key={path}
              path={path}
              agent={agent as never}
              visual={resolveAgentVisual({ id: path })}
              displayName={displayName}
              isActive={activePath === path}
              // The model decides the chip (`SidebarRowModel.liveCount`, omitted
              // below two), so the bench states the count the same way the real
              // panel does rather than seeding a store the row does not read.
              // Keyed by path, never by position: the long-named agent is the
              // row whose title actually reaches the chip, and an index literal
              // is how it silently lost one.
              {...(LIVE_BY_PATH[path] === undefined ? {} : { liveCount: LIVE_BY_PATH[path] })}
              onSelect={() => setActivePath(path)}
              onRequestNewGroup={() => {}}
              onSessionClick={() => {}}
              onNewSession={() => {}}
            />
          ))}
        </SidebarShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Active</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarShell>
          <AgentListItem
            path={MOCK_AGENTS[1].path}
            agent={MOCK_AGENTS[1].agent as never}
            visual={resolveAgentVisual({ id: MOCK_AGENTS[1].path })}
            displayName={MOCK_AGENTS[1].displayName}
            isActive
            onSelect={() => {}}
            onRequestNewGroup={() => {}}
            onSessionClick={() => {}}
            onNewSession={() => {}}
          />
        </SidebarShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Muted — no chip, no badge</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarShell>
          <AgentListItem
            path={MOCK_AGENTS[0].path}
            agent={MOCK_AGENTS[0].agent as never}
            visual={resolveAgentVisual({ id: MOCK_AGENTS[0].path })}
            displayName={MOCK_AGENTS[0].displayName}
            isActive={false}
            isMuted
            liveCount={LIVE_BY_PATH[MOCK_AGENTS[0].path]}
            onSelect={() => {}}
            onRequestNewGroup={() => {}}
            onSessionClick={() => {}}
            onNewSession={() => {}}
          />
        </SidebarShell>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ── SidebarMenuSurface ──

function RowMenuSurfaceShowcase() {
  const nodes = useAgentRowMenuNodes({
    path: MOCK_AGENTS[0].path,
    onOpenSessions: () => {},
    onViewProfile: () => {},
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
      description="One header style for the whole panel: 11px medium at --sidebar-header-x, no icon, nothing drawn at rest but the label. Hover or focus reveals the fold chevron at the right, beside the ⋮ and the section's +. Every header carries its own menu — right-click it, or use the ⋮ — and both render ONE node list, so they can never drift. Channels folds, can clear its unread and offers its own Sort by (DOR-906); Agents exposes the section's own Show and Sort by settings. Neither makes anything: creating moved to the one New menu, and a section's + deep-links into it."
    >
      <ShowcaseLabel>Channels — collapsible, with unread to clear</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-64">
          <SectionHeader
            label="Channels"
            collapsed={collapsed}
            onToggle={() => setCollapsed((prev) => !prev)}
            nodes={buildChannelsHeaderMenuNodes({
              collapsed,
              hasUnread: true,
              onMarkAllRead: () => {},
              sortMode: 'name',
              onSortModeChange: () => {},
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
            nodes={buildAgentsHeaderMenuNodes({
              sortMode,
              displayFilter: 'all',
              onSortModeChange: setSortMode,
              onDisplayFilterChange: () => {},
            })}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
