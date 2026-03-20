import { useState } from 'react';
import type { Session } from '@dorkos/shared/types';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  SessionItem,
  SessionsView,
  SidebarTabRow,
  SidebarFooterBar,
} from '@/layers/features/session-list';
import { SidebarGroup, SidebarMenu, SidebarMenuItem, TooltipProvider } from '@/layers/shared/ui';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const now = new Date();

function hoursAgo(hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

const MOCK_SESSIONS: Session[] = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    title: 'Refactor auth middleware to use JWT validation',
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
    permissionMode: 'default',
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    title: 'Debug failing E2E tests in CI pipeline',
    createdAt: hoursAgo(3),
    updatedAt: hoursAgo(2),
    permissionMode: 'default',
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    title: 'Add dark mode support to settings panel',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    permissionMode: 'acceptEdits',
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    title: 'Migrate database schema to Drizzle ORM',
    createdAt: daysAgo(2),
    updatedAt: daysAgo(1),
    permissionMode: 'bypassPermissions',
  },
  {
    id: '00000000-0000-0000-0000-000000000005',
    title: 'Implement WebSocket relay for agent messaging',
    createdAt: daysAgo(5),
    updatedAt: daysAgo(4),
    permissionMode: 'default',
  },
  {
    id: '00000000-0000-0000-0000-000000000006',
    title: 'Optimize bundle size with tree-shaking analysis',
    createdAt: daysAgo(8),
    updatedAt: daysAgo(7),
    permissionMode: 'plan',
  },
];

const GROUPED_SESSIONS = [
  { label: 'Today', sessions: MOCK_SESSIONS.slice(0, 2) },
  { label: 'Yesterday', sessions: MOCK_SESSIONS.slice(2, 4) },
  { label: 'Previous 7 Days', sessions: MOCK_SESSIONS.slice(4) },
];

// ---------------------------------------------------------------------------
// Showcases
// ---------------------------------------------------------------------------

/** Sidebar component showcases: SessionItem, SessionsView, SidebarTabRow, SidebarFooterBar. */
export function SidebarShowcases() {
  return (
    <>
      <SessionItemShowcase />
      <SessionsViewShowcase />
      <SidebarTabRowShowcase />
      <SidebarFooterBarShowcase />
    </>
  );
}

// ---------------------------------------------------------------------------
// SessionItem
// ---------------------------------------------------------------------------

function SessionItemShowcase() {
  const [showNew, setShowNew] = useState(false);

  return (
    <PlaygroundSection
      title="SessionItem"
      description="Sidebar row for a single session with expandable details, permission badge, and entrance animation."
    >
      <ShowcaseLabel>Default (inactive)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionItem session={MOCK_SESSIONS[0]} isActive={false} onClick={() => {}} />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>Active</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionItem session={MOCK_SESSIONS[0]} isActive={true} onClick={() => {}} />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>Bypass permissions</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionItem session={MOCK_SESSIONS[3]} isActive={false} onClick={() => {}} />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>New session entrance</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-2">
          <button
            onClick={() => {
              setShowNew(false);
              requestAnimationFrame(() => setShowNew(true));
            }}
            className="text-muted-foreground hover:text-foreground rounded-md border px-2 py-1 text-xs transition-colors"
          >
            Replay entrance
          </button>
          {showNew && (
            <SidebarItemWrapper>
              <SessionItem session={MOCK_SESSIONS[0]} isActive={false} onClick={() => {}} isNew />
            </SidebarItemWrapper>
          )}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Wraps a SessionItem in sidebar menu markup for correct styling context. */
function SidebarItemWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-64">
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>{children}</SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionsView
// ---------------------------------------------------------------------------

function SessionsViewShowcase() {
  const [activeId, setActiveId] = useState<string | null>(MOCK_SESSIONS[0].id);

  return (
    <PlaygroundSection
      title="SessionsView"
      description="Grouped session list with time-based buckets and empty state."
    >
      <ShowcaseLabel>Grouped list</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border h-80 w-64 overflow-hidden rounded-lg border">
          <SessionsView
            activeSessionId={activeId}
            groupedSessions={GROUPED_SESSIONS}
            onSessionClick={setActiveId}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Empty state</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border h-40 w-64 overflow-hidden rounded-lg border">
          <SessionsView activeSessionId={null} groupedSessions={[]} onSessionClick={() => {}} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// SidebarTabRow
// ---------------------------------------------------------------------------

function SidebarTabRowShowcase() {
  const [tab1, setTab1] = useState<'sessions' | 'schedules' | 'connections'>('sessions');
  const [tab2, setTab2] = useState<'sessions' | 'schedules' | 'connections'>('sessions');
  const [tab3, setTab3] = useState<'sessions' | 'schedules' | 'connections'>('sessions');

  return (
    <PlaygroundSection
      title="SidebarTabRow"
      description="Horizontal icon tab row with sliding indicator, badges, and connection status dots."
    >
      <TooltipProvider>
        <ShowcaseLabel>All tabs visible</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="w-64">
            <SidebarTabRow
              activeTab={tab1}
              onTabChange={setTab1}
              schedulesBadge={0}
              connectionsStatus="none"
              visibleTabs={['sessions', 'schedules', 'connections']}
            />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>With badges</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="w-64">
            <SidebarTabRow
              activeTab={tab2}
              onTabChange={setTab2}
              schedulesBadge={3}
              connectionsStatus="partial"
              visibleTabs={['sessions', 'schedules', 'connections']}
            />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Error status</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="w-64">
            <SidebarTabRow
              activeTab={tab3}
              onTabChange={setTab3}
              schedulesBadge={0}
              connectionsStatus="error"
              visibleTabs={['sessions', 'schedules', 'connections']}
            />
          </div>
        </ShowcaseDemo>
      </TooltipProvider>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// SidebarFooterBar
// ---------------------------------------------------------------------------

function SidebarFooterBarShowcase() {
  return (
    <PlaygroundSection
      title="SidebarFooterBar"
      description="Bottom bar with branding, settings, edit agent, and theme cycle toggle. Settings and Edit Agent buttons open app dialogs (non-functional in playground context)."
    >
      <ShowcaseLabel>Default</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-64">
          <SidebarFooterBar />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
