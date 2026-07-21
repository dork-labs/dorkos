import { useState, useEffect } from 'react';
import type { Session } from '@dorkos/shared/types';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { SessionsView, SidebarFooterBar } from '@/layers/features/session-list';
import { useSessionChatStore, useSessionListStore, SessionRow } from '@/layers/entities/session';
import { SidebarGroup, SidebarMenu, SidebarMenuItem } from '@/layers/shared/ui';

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

// Session IDs used to seed specific activity indicator states in the store
const INDICATOR_SESSION_IDS = {
  streaming: 'dev-indicator-streaming',
  pendingApproval: 'dev-indicator-pending-approval',
  error: 'dev-indicator-error',
  unseenActivity: 'dev-indicator-unseen-activity',
} as const;

function makeIndicatorSession(id: string, title: string): Session {
  return {
    id,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissionMode: 'default',
    runtime: 'claude-code',
  };
}

const INDICATOR_SESSIONS: Record<keyof typeof INDICATOR_SESSION_IDS, Session> = {
  streaming: makeIndicatorSession(INDICATOR_SESSION_IDS.streaming, 'Running agent task...'),
  pendingApproval: makeIndicatorSession(
    INDICATOR_SESSION_IDS.pendingApproval,
    'Waiting for tool approval'
  ),
  error: makeIndicatorSession(INDICATOR_SESSION_IDS.error, 'Session encountered an error'),
  unseenActivity: makeIndicatorSession(
    INDICATOR_SESSION_IDS.unseenActivity,
    'New messages since last visit'
  ),
};

const MOCK_SESSIONS: Session[] = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    title: 'Refactor auth middleware to use JWT validation',
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    title: 'Debug failing E2E tests in CI pipeline',
    createdAt: hoursAgo(3),
    updatedAt: hoursAgo(2),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    title: 'Add dark mode support to settings panel',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    permissionMode: 'acceptEdits',
    runtime: 'claude-code',
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    title: 'Migrate database schema to Drizzle ORM',
    createdAt: daysAgo(2),
    updatedAt: daysAgo(1),
    permissionMode: 'bypassPermissions',
    runtime: 'claude-code',
  },
  {
    id: '00000000-0000-0000-0000-000000000005',
    title: 'Implement WebSocket relay for agent messaging',
    createdAt: daysAgo(5),
    updatedAt: daysAgo(4),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
  {
    id: '00000000-0000-0000-0000-000000000006',
    title: 'Optimize bundle size with tree-shaking analysis',
    createdAt: daysAgo(8),
    updatedAt: daysAgo(7),
    permissionMode: 'plan',
    runtime: 'claude-code',
  },
];

// Origin-varied sessions (session-origin-legibility) — makes OriginMark
// visually discoverable in the playground alongside the plain-user rows above.
const CHANNEL_ORIGIN_SESSION: Session = {
  ...MOCK_SESSIONS[0],
  id: '00000000-0000-0000-0000-000000000007',
  origin: 'channel',
  originLabel: 'Telegram',
};

const TASK_ORIGIN_SESSION: Session = {
  ...MOCK_SESSIONS[1],
  id: '00000000-0000-0000-0000-000000000008',
  origin: 'task',
  originLabel: 'Scheduled task · daily-digest',
};

const GROUPED_SESSIONS = [
  { label: 'Today', sessions: MOCK_SESSIONS.slice(0, 2) },
  { label: 'Yesterday', sessions: MOCK_SESSIONS.slice(2, 4) },
  { label: 'Previous 7 Days', sessions: MOCK_SESSIONS.slice(4) },
];

// ---------------------------------------------------------------------------
// Showcases
// ---------------------------------------------------------------------------

/** Sidebar component showcases: SessionItem, SessionsView, SidebarFooterBar. */
export function SidebarShowcases() {
  return (
    <>
      <SessionItemShowcase />
      <SessionsViewShowcase />
      <SidebarFooterBarShowcase />
    </>
  );
}

// ---------------------------------------------------------------------------
// SessionItem
// ---------------------------------------------------------------------------

function SessionItemShowcase() {
  const [showNew, setShowNew] = useState(false);
  const updateSession = useSessionChatStore((s) => s.updateSession);

  useEffect(() => {
    updateSession(INDICATOR_SESSION_IDS.streaming, { sdkState: 'running' });
    updateSession(INDICATOR_SESSION_IDS.pendingApproval, { sdkState: 'requires_action' });
    updateSession(INDICATOR_SESSION_IDS.error, { status: 'error' });
    useSessionListStore.getState().markUnseen(INDICATOR_SESSION_IDS.unseenActivity);
  }, [updateSession]);

  return (
    <PlaygroundSection
      title="SessionItem"
      description="Sidebar row for a single session with expandable details, permission badge, and entrance animation."
    >
      <ShowcaseLabel>Default (inactive)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionRow
            variant="full"
            session={MOCK_SESSIONS[0]}
            isActive={false}
            onClick={() => {}}
          />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>Active</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionRow
            variant="full"
            session={MOCK_SESSIONS[0]}
            isActive={true}
            onClick={() => {}}
          />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>Bypass permissions</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionRow
            variant="full"
            session={MOCK_SESSIONS[3]}
            isActive={false}
            onClick={() => {}}
          />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>Origin — channel (Telegram)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionRow
            variant="full"
            session={CHANNEL_ORIGIN_SESSION}
            isActive={false}
            onClick={() => {}}
          />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>Origin — task (Scheduled task)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionRow
            variant="full"
            session={TASK_ORIGIN_SESSION}
            isActive={false}
            onClick={() => {}}
          />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>Activity indicator — streaming (green pulse)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionRow
            variant="full"
            session={INDICATOR_SESSIONS.streaming}
            isActive={false}
            onClick={() => {}}
          />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>Activity indicator — pending approval (amber pulse)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionRow
            variant="full"
            session={INDICATOR_SESSIONS.pendingApproval}
            isActive={false}
            onClick={() => {}}
          />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>Activity indicator — error (red)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionRow
            variant="full"
            session={INDICATOR_SESSIONS.error}
            isActive={false}
            onClick={() => {}}
          />
        </SidebarItemWrapper>
      </ShowcaseDemo>

      <ShowcaseLabel>Activity indicator — unseen activity (blue)</ShowcaseLabel>
      <ShowcaseDemo>
        <SidebarItemWrapper>
          <SessionRow
            variant="full"
            session={INDICATOR_SESSIONS.unseenActivity}
            isActive={false}
            onClick={() => {}}
          />
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
              <SessionRow
                variant="full"
                session={MOCK_SESSIONS[0]}
                isActive={false}
                onClick={() => {}}
                isNew
              />
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
