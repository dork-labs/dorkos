import { useState, useEffect } from 'react';
import { Hash, Pin } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import {
  CHANNEL_ORIGIN_SESSION,
  GROUPED_SESSIONS,
  MOCK_SESSIONS,
  TASK_ORIGIN_SESSION,
} from './session-list-fixtures';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionsView } from '@/layers/features/session-list';
import { EmbedSessionListShowcase } from './EmbedSessionListShowcase';
import { SidebarFooterStrip } from '@/layers/features/dashboard-sidebar';
import { configKeys } from '@/layers/entities/config';
import { useSessionChatStore, useSessionListStore, SessionRow } from '@/layers/entities/session';
import { RoomAvatar } from '@/layers/entities/room';
import {
  SectionHeader,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRow,
  type RowDragBindings,
} from '@/layers/shared/ui';
import { useRovingFocus } from '@/layers/shared/model';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Showcases
// ---------------------------------------------------------------------------

/**
 * Sidebar component showcases: SidebarRow, SessionRow, SessionsView,
 * EmbedSessionList, SidebarFooterStrip.
 */
export function SidebarShowcases() {
  return (
    <>
      <SidebarRowShowcase />
      <SessionRowShowcase />
      <SessionsViewShowcase />
      <EmbedSessionListShowcase />
      <SidebarFooterStripShowcase />
    </>
  );
}

// ---------------------------------------------------------------------------
// SidebarRow — the gutter and the trailing action
// ---------------------------------------------------------------------------

/** The real cockpit sidebar's width (`SIDEBAR_WIDTH` is `16rem`). */
const COCKPIT_SIDEBAR_WIDTH = 256;

/** A sidebar narrowed about as far as anyone drags it before giving up. */
const NARROWED_SIDEBAR_WIDTH = 200;

/** Long enough to run out of room at either width, so the ellipsis is on show. */
const LONG_TITLE = 'Refactor the session transport and its reconnect ladder';

const ROW_MENU = [{ kind: 'action' as const, id: 'pin', label: 'Pin', icon: Pin, run: () => {} }];

/** The chip a trailing action draws — presentational, because the row draws it twice. */
function LiveChip() {
  return (
    <span className="bg-brand/15 text-brand text-3xs rounded-full px-1.5 py-0.5 font-medium tabular-nums">
      3 live
    </span>
  );
}

/**
 * `SidebarRow`'s right gutter and the control that lives in it.
 *
 * Two things are on show here that no unit test can see, and both are why the
 * section exists rather than being a screenshot in a PR:
 *
 * - The gutter is REAL. It was written as `pr-7` and merged away by a later
 *   `px-2` for long enough to ship, and only computed style can tell the
 *   difference (DOR-1115). A long title truncating short of the chip is that
 *   gutter, visible.
 * - The trailing control moves WITH the row. "Simulate drag" applies the
 *   transform dnd-kit applies during a real drag; a satellite mounted outside
 *   the dragged element stays behind (DOR-1111).
 */
function SidebarRowShowcase() {
  const [dragging, setDragging] = useState(false);
  const drag: RowDragBindings = {
    setNodeRef: () => {},
    rootProps: {},
    activatorProps: { ref: () => {} },
    style: dragging ? { transform: 'translate3d(0px, 40px, 0px)' } : {},
    isDragging: false,
    isOver: false,
  };

  return (
    <PlaygroundSection
      title="SidebarRow"
      description="The sidebar's one row: its reserved right gutter, and the trailing action that parks in it."
    >
      <ShowcaseLabel>Long title at the cockpit width (256px)</ShowcaseLabel>
      <ShowcaseDemo>
        <RowFrame width={COCKPIT_SIDEBAR_WIDTH} testId="cockpit">
          <SidebarRow
            glyph={<Hash className="text-sidebar-foreground/60 size-3.5" aria-hidden />}
            title={LONG_TITLE}
            dataSlot="sidebar-row-demo"
            menuNodes={ROW_MENU}
            actionsLabel="Demo row actions"
            trailingAction={{
              content: <LiveChip />,
              onClick: () => {},
              label: '3 live sessions',
            }}
          />
        </RowFrame>
      </ShowcaseDemo>

      <ShowcaseLabel>
        The two levels together — header at --sidebar-header-x (12), glyph at --sidebar-row-x (20),
        label at 46. Every row in the panel, a section&rsquo;s members included, is on that one x.
      </ShowcaseLabel>
      <ShowcaseDemo>
        {/* The whole geometry, in one frame a browser can measure. `px-2` is the
            panel's own padding, exactly as `DashboardSidebar` pays it, so the
            numbers here are the numbers the product has. */}
        <div
          data-slot="sidebar-geometry-frame"
          className="bg-sidebar group/section rounded-md px-2 py-1"
          style={{ width: COCKPIT_SIDEBAR_WIDTH }}
        >
          <SectionHeader label="Channels" collapsed={false} onToggle={() => {}} />
          <SidebarMenu className="gap-0">
            <SidebarRow
              glyph={<Hash className="text-sidebar-foreground/60 size-3.5" aria-hidden />}
              title="general"
              dataSlot="sidebar-geometry-row"
            />
            {/* The widest mark the slot ever holds, beside the narrowest one.
                A two-face stack measures 22px in an 18px slot, so a slot that
                CENTRED its glyph would start this row's first face 2px left of
                the `#` above it — which is exactly how a group conversation
                came to hang outside the gutter every other row starts on.
                `justify-start` is what puts them on one line, and the browser
                spec measures the two against each other. */}
            <SidebarRow
              glyph={
                <RoomAvatar
                  room={{ id: 'dm-demo', kind: 'dm', title: 'Ana and Kai' }}
                  visuals={[
                    { color: '#7c3aed', emoji: '🐙' },
                    { color: '#3ca078', emoji: '🔔' },
                  ]}
                />
              }
              title="Ana, Kai"
              dataSlot="sidebar-geometry-stack-row"
            />
          </SidebarMenu>
          {/* A hand-made section, flush with everything above it: it is a peer
              of Channels rather than a child of anything (D3), so its header
              sits on the header x and its rows on the row x. */}
          <SectionHeader label="Clients" collapsed={false} onToggle={() => {}} />
          <SidebarMenu className="gap-0">
            <SidebarRow
              glyph={<Hash className="text-sidebar-foreground/60 size-3.5" aria-hidden />}
              title="acme"
              dataSlot="sidebar-geometry-section-row"
            />
          </SidebarMenu>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Folded headers, with the roll-ups that survive the fold</ShowcaseLabel>
      <ShowcaseDemo>
        {/* Every header folds now, Heads up and Today included — so the state
            worth looking at is the one where a fold has to say what it hid.
            Heads up counts what NEEDS answering rather than its rows. */}
        <div
          data-slot="sidebar-folded-frame"
          className="bg-sidebar group/section space-y-1 rounded-md px-2 py-1"
          style={{ width: COCKPIT_SIDEBAR_WIDTH }}
        >
          <SectionHeader label="Heads up" collapsed onToggle={() => {}} trailing="2 need you" />
          <SectionHeader label="Today" collapsed onToggle={() => {}} trailing="6 · 1 unread" />
          <SectionHeader
            label="Channels"
            collapsed
            onToggle={() => {}}
            emphasized
            trailing="12 · 3 unread · 1 working"
          />
          <SectionHeader label="Agents" collapsed onToggle={() => {}} trailing="31" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>The same row in a narrowed sidebar (200px)</ShowcaseLabel>
      <ShowcaseDemo>
        <RowFrame width={NARROWED_SIDEBAR_WIDTH} testId="narrow">
          <SidebarRow
            glyph={<Hash className="text-sidebar-foreground/60 size-3.5" aria-hidden />}
            title={LONG_TITLE}
            dataSlot="sidebar-row-demo"
            menuNodes={ROW_MENU}
            actionsLabel="Demo row actions"
            trailingAction={{
              content: <LiveChip />,
              onClick: () => {},
              label: '3 live sessions',
            }}
          />
        </RowFrame>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Keyboard — the arrows walk the row&rsquo;s lane: face, row, chip, then the ⋮
      </ShowcaseLabel>
      <ShowcaseDemo>
        <RowFrame width={COCKPIT_SIDEBAR_WIDTH} testId="keyboard">
          <SidebarRow
            glyph={<Hash className="text-sidebar-foreground/60 size-3.5" aria-hidden />}
            glyphAction={{ onClick: () => {}, label: 'Open the demo profile' }}
            title={LONG_TITLE}
            dataSlot="sidebar-row-demo"
            menuNodes={ROW_MENU}
            actionsLabel="Demo row actions"
            trailingAction={{
              content: <LiveChip />,
              onClick: () => {},
              label: '3 live sessions',
            }}
          />
        </RowFrame>
      </ShowcaseDemo>

      <ShowcaseLabel>
        A caller passing its own padding — the gutter still wins (DOR-1115)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <RowFrame width={COCKPIT_SIDEBAR_WIDTH} testId="override">
          <SidebarRow
            glyph={<Hash className="text-sidebar-foreground/60 size-3.5" aria-hidden />}
            title={LONG_TITLE}
            dataSlot="sidebar-row-demo"
            menuNodes={ROW_MENU}
            actionsLabel="Demo row actions"
            // Deliberately hostile: `px-6` lands after every other padding class
            // the row writes, and tailwind-merge would let it swallow the gutter
            // outright. The gutter is applied last for exactly this reason, and
            // a browser test measures that it survives.
            className="px-6"
          />
        </RowFrame>
      </ShowcaseDemo>

      <ShowcaseLabel>No trailing action — the gutter is still kept clear for the ⋮</ShowcaseLabel>
      <ShowcaseDemo>
        <RowFrame width={COCKPIT_SIDEBAR_WIDTH} testId="bare">
          <SidebarRow
            glyph={<Hash className="text-sidebar-foreground/60 size-3.5" aria-hidden />}
            title={LONG_TITLE}
            dataSlot="sidebar-row-demo"
            menuNodes={ROW_MENU}
            actionsLabel="Demo row actions"
          />
        </RowFrame>
      </ShowcaseDemo>

      <ShowcaseLabel>Dragged — the control travels with the row</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setDragging((previous) => !previous)}
            className="text-muted-foreground hover:text-foreground rounded-md border px-2 py-1 text-xs transition-colors"
          >
            {dragging ? 'Drop the row' : 'Simulate drag'}
          </button>
          <div className="h-24">
            <RowFrame width={COCKPIT_SIDEBAR_WIDTH} testId="dragged">
              <SidebarRow
                glyph={<Hash className="text-sidebar-foreground/60 size-3.5" aria-hidden />}
                title={LONG_TITLE}
                dataSlot="sidebar-row-demo"
                menuNodes={ROW_MENU}
                actionsLabel="Demo row actions"
                drag={drag}
                trailingAction={{
                  content: <LiveChip />,
                  onClick: () => {},
                  label: '3 live sessions',
                }}
              />
            </RowFrame>
          </div>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * One row at a fixed width, on the sidebar's own background, inside a real
 * roving-focus container.
 *
 * The container is not decoration. In production every row lives in one, and it
 * is what makes the arrow keys move along a row's lane at all — a frame without
 * it would draw a row whose keyboard behaviour no browser test could reach.
 */
function RowFrame({
  width,
  testId,
  children,
}: {
  width: number;
  testId: string;
  children: React.ReactNode;
}) {
  const roving = useRovingFocus();
  return (
    <div
      data-slot="sidebar-row-frame"
      data-frame={testId}
      // **`px-2` is the real panel's own padding**, and the frame pays it for the
      // same reason the panel does: the row's inset is `--sidebar-row-x` MINUS
      // that 8px, so a frame without it would draw the glyph at 12 instead of 20
      // and `sidebar-row-gutter.spec.ts` would be measuring a geometry the
      // product does not have.
      className="bg-sidebar rounded-md px-2 py-1"
      style={{ width }}
      {...roving}
    >
      <SidebarMenu className="gap-0">{children}</SidebarMenu>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionRow
// ---------------------------------------------------------------------------

function SessionRowShowcase() {
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
      title="SessionRow"
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

      <ShowcaseLabel>Full power — green bolt, not a red shield</ShowcaseLabel>
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

/** Wraps a SessionRow in sidebar menu markup for correct styling context. */
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
// SidebarFooterStrip
// ---------------------------------------------------------------------------

/** A server config the real `useConfig` would return, without asking a server. */
function configFixture(latestVersion: string | null) {
  return {
    version: '0.58.0',
    latestVersion,
    isDevMode: false,
    dismissedUpgradeVersions: [] as string[],
  };
}

/**
 * Render the strip against a fabricated server config.
 *
 * Its own `QueryClient`, seeded and never fetching, so the update-ready state is
 * a state a reviewer can LOOK at rather than one they have to wait for a release
 * to see. Nested inside the app's provider, so the real client — and the real
 * config the cockpit is running on — is untouched.
 */
function StripWithConfig({ latestVersion }: { latestVersion: string | null }) {
  const [client] = useState(() => {
    const created = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    });
    created.setQueryData(configKeys.current(), configFixture(latestVersion));
    return created;
  });

  return (
    <QueryClientProvider client={client}>
      <div className="bg-sidebar w-[272px] rounded-lg p-2">
        <SidebarFooterStrip />
      </div>
    </QueryClientProvider>
  );
}

function SidebarFooterStripShowcase() {
  return (
    <PlaygroundSection
      title="SidebarFooterStrip"
      description="One slim tinted strip: Home, Team, Marketplace, Connections, and the permanent Ask DorkBot affordance. No logo, no version line, no border — separation is a step up the --sidebar-accent ramp, which moves the same way in both themes (spec BC-47, R1). Flip the playground theme to check the pair."
    >
      <ShowcaseLabel>Idle — no update waiting</ShowcaseLabel>
      <ShowcaseDemo>
        <StripWithConfig latestVersion={null} />
      </ShowcaseDemo>

      <ShowcaseLabel>Update ready — the transient pill (BC-44)</ShowcaseLabel>
      <ShowcaseDemo>
        <StripWithConfig latestVersion="0.59.0" />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
