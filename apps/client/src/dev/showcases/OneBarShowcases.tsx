import { Plus } from 'lucide-react';
import { Badge, BarTabStrip, Button, type BarTab } from '@/layers/shared/ui';
import {
  OneBar,
  BarTitle,
  TitleBar,
  OneBarProvider,
  BarFixedCluster,
  SessionHeader,
  type OneBarRouteState,
} from '@/layers/widgets/one-bar';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** The four home surfaces, as the bar will carry them from phase H1 on. */
const HOME_TABS: BarTab[] = [
  { id: 'home', label: 'Home', to: '/' },
  { id: 'activity', label: 'Activity', to: '/activity' },
  { id: 'scheduled', label: 'Scheduled', to: '/tasks' },
  { id: 'workspaces', label: 'Workspaces', to: '/workspaces' },
];

/** The five team views, which is enough labels to overflow a phone. */
const TEAM_TABS: BarTab[] = [
  { id: 'cards', label: 'Cards', to: '/team' },
  { id: 'table', label: 'Table', to: '/team' },
  { id: 'topology', label: 'Topology', to: '/team' },
  { id: 'denied', label: 'Denied', to: '/team' },
  { id: 'access', label: 'Access', to: '/team' },
];

const LONG_ROOM_NAME = 'Priya, Kai, Ikechi and 47 others about the quarterly migration plan';

/**
 * The 36px row a bar actually lives in, composed the way `AppShell` composes it.
 *
 * The shell's `<header>` supplies the height, the hairline and the gutters, so a
 * bar shown without them reads nothing like the real thing — the truncation demo
 * in particular only means something inside a box that can run out of room.
 *
 * **`BarFixedCluster` is rendered here, after `children`, exactly as the shell
 * renders it after the route's bar.** Showing the identity half on its own would
 * be showing a bar the app never draws, and it would quietly drop the real
 * `InboxBell` out of the mount gate's reach — which is how `/dev/one-bar` came
 * to be 100% error cards with every test green.
 */
function BarFrame({ children, width }: { children: React.ReactNode; width?: number }) {
  return (
    <div
      className="bg-background overflow-hidden rounded-md border"
      style={width ? { maxWidth: width } : undefined}
    >
      {/* `@container/bar` exactly as the shell spells it — the frame is only
          honest if a bar measures the same thing here that it measures live. */}
      <header className="@container/bar relative flex h-9 items-center gap-2 border-b px-2">
        {children}
        <BarFixedCluster />
      </header>
    </div>
  );
}

/** Nothing open, nothing running — showcases override only what they demonstrate. */
const QUIET_BAR_STATE: OneBarRouteState = {
  sessionId: undefined,
  agentName: undefined,
  agentVisual: undefined,
  origin: undefined,
  originLabel: undefined,
  sessionTitle: undefined,
  sessionDirectoryName: undefined,
  roomTitle: null,
  teamViewMode: 'cards',
};

/** A stand-in face — the real one comes from `resolveAgentVisual`. */
const DEMO_AGENT_VISUAL = { color: 'hsl(210 70% 55%)', emoji: '🤖' };

/**
 * An origin label nobody on this team chose the length of.
 *
 * `originLabel` is whatever the bridged room calls itself, so it arrives from
 * Telegram or Slack at whatever length someone there typed. This is the case
 * that made the chip paint over the identity when it could not shrink.
 */
const LONG_ORIGIN_LABEL = 'Deploys, incidents and the Tuesday migration standup';

const LONG_SESSION_TITLE =
  'Investigate why the nightly deploy pipeline stalls on the migration step and propose a fix';

/**
 * One session bar, framed and fed the state the shell would give it.
 *
 * @param props.width - Optional frame cap, for the narrow demos.
 * @param props.state - Bar state overrides for this variant.
 */
function SessionBarDemo({ width, state }: { width?: number; state: Partial<OneBarRouteState> }) {
  return (
    <OneBarProvider value={{ ...QUIET_BAR_STATE, ...state }}>
      <BarFrame {...(width === undefined ? {} : { width })}>
        <SessionHeader />
      </BarFrame>
    </OneBarProvider>
  );
}

/**
 * The One Bar primitive and the tab strip that fills its identity zone.
 *
 * Both render the REAL components — the same `OneBar` every route mounts, cluster
 * included. What is stubbed is only the frame around them.
 */
export function OneBarShowcases() {
  return (
    <OneBarProvider value={{ ...QUIET_BAR_STATE }}>
      <PlaygroundSection
        title="One Bar"
        description="One row per page: identity · chips · flex space · page actions · search, inbox, right-panel toggle. The shell mounts the last three after the bar and outside its cross-fade, so they never blink on navigation and no page can wedge a control between them (I1)."
      >
        <ShowcaseLabel>Title only — what most routes are</ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame>
            <TitleBar title="Workspaces" />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>Title plus a page action</ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame>
            <TitleBar
              title="Scheduled"
              actions={
                <Button variant="outline" size="xs">
                  <Plus />
                  New Task
                </Button>
              }
            />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>Tabs in the identity zone — the home surfaces (phase H1)</ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame>
            <OneBar
              identity={
                <BarTabStrip
                  tabs={HOME_TABS}
                  activeTabId="home"
                  label="Home sections"
                  indicatorLayoutId="playground-home-tabs"
                />
              }
            />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>Chips and actions — a room bar's shape (phase R1)</ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame>
            <OneBar
              identity={<BarTitle>#general</BarTitle>}
              chips={
                <>
                  <Badge variant="secondary">Archived</Badge>
                  <Badge variant="outline">2 working</Badge>
                </>
              }
              actions={
                <Button variant="outline" size="xs">
                  <Plus />
                  New Agent
                </Button>
              }
            />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Long title at 420px — the name ellipsizes, the cluster never shrinks (I2)
        </ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame width={420}>
            <OneBar identity={<BarTitle>{LONG_ROOM_NAME}</BarTitle>} />
          </BarFrame>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Session Bar"
        description="Who you are talking to, and which conversation: the agent's face and name, then the session's own title (D1). The title is the same string the sidebar rows show, and it yields its width first — the agent's name is the fact worth keeping on a narrow bar (I2)."
      >
        <ShowcaseLabel>A named session with a registered agent</ShowcaseLabel>
        <ShowcaseDemo>
          <SessionBarDemo
            state={{
              agentName: 'DorkBot',
              agentVisual: DEMO_AGENT_VISUAL,
              sessionTitle: 'Fix the flaky session-lock test',
            }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Before the first turn — the title has not been written yet</ShowcaseLabel>
        <ShowcaseDemo>
          <SessionBarDemo state={{ agentName: 'DorkBot', agentVisual: DEMO_AGENT_VISUAL }} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          A long title at 560px — the title ellipsizes, the agent name does not
        </ShowcaseLabel>
        <ShowcaseDemo>
          <SessionBarDemo
            width={560}
            state={{
              agentName: 'DorkBot',
              agentVisual: DEMO_AGENT_VISUAL,
              sessionTitle: LONG_SESSION_TITLE,
            }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>
          No agent — a bare directory shows its own name and a generic mark, never an empty face
        </ShowcaseLabel>
        <ShowcaseDemo>
          <SessionBarDemo
            state={{ sessionDirectoryName: 'dork-os', sessionTitle: 'Read the release notes' }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>A session a scheduled task started — the origin chip stays</ShowcaseLabel>
        <ShowcaseDemo>
          <SessionBarDemo
            state={{
              agentName: 'DorkBot',
              agentVisual: DEMO_AGENT_VISUAL,
              sessionTitle: 'Nightly dependency audit',
              origin: 'task',
            }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>An origin that names itself — a message from Telegram</ShowcaseLabel>
        <ShowcaseDemo>
          <SessionBarDemo
            state={{
              agentName: 'DorkBot',
              agentVisual: DEMO_AGENT_VISUAL,
              sessionTitle: 'Ship the changelog',
              origin: 'channel',
              originLabel: 'Telegram',
            }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>
          A long origin label — a bridged room names itself, and the name is as long as whoever made
          it decided
        </ShowcaseLabel>
        <ShowcaseDemo>
          <SessionBarDemo
            width={620}
            state={{
              agentName: 'DorkBot',
              agentVisual: DEMO_AGENT_VISUAL,
              sessionTitle: LONG_SESSION_TITLE,
              origin: 'channel',
              originLabel: LONG_ORIGIN_LABEL,
            }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>
          The same label at 390px — the chip is down to its icon, and the tooltip still says which
          room it was
        </ShowcaseLabel>
        <ShowcaseDemo>
          <SessionBarDemo
            width={390}
            state={{
              agentName: 'DorkBot',
              agentVisual: DEMO_AGENT_VISUAL,
              sessionTitle: LONG_SESSION_TITLE,
              origin: 'channel',
              originLabel: LONG_ORIGIN_LABEL,
            }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>At 390px — a phone, with an origin chip competing for the row</ShowcaseLabel>
        <ShowcaseDemo>
          <SessionBarDemo
            width={390}
            state={{
              agentName: 'DorkBot',
              agentVisual: DEMO_AGENT_VISUAL,
              sessionTitle: LONG_SESSION_TITLE,
              origin: 'task',
            }}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Bar Tab Strip"
        description="Links dressed as tabs. Scrolls sideways when the labels outgrow the width, fades whichever edge still has tabs behind it, and brings the active tab into view on a cold load."
      >
        <ShowcaseLabel>In the bar, room to spare</ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame>
            <OneBar
              identity={
                <BarTabStrip
                  tabs={TEAM_TABS}
                  activeTabId="cards"
                  label="Team views"
                  indicatorLayoutId="playground-team-tabs"
                />
              }
            />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Narrowed to 320px — the strip scrolls and the end fade says there is more
        </ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame width={320}>
            <OneBar
              identity={
                <BarTabStrip
                  tabs={TEAM_TABS}
                  activeTabId="cards"
                  label="Team views, narrow"
                  indicatorLayoutId="playground-team-tabs-narrow"
                />
              }
            />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Standalone row (`density="row"`) — 44px touch targets and its own hairline, which is how
          the home surface wears it today
        </ShowcaseLabel>
        <ShowcaseDemo>
          <div className="bg-background overflow-hidden rounded-md border">
            <BarTabStrip
              tabs={HOME_TABS}
              activeTabId="workspaces"
              label="Home sections, standalone"
              indicatorLayoutId="playground-home-tabs-row"
              density="row"
            />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </OneBarProvider>
  );
}
