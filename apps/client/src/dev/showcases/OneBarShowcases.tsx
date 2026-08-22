import { useEffect } from 'react';
import { Plus } from 'lucide-react';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { BarTabStrip, Button, type BarTab } from '@/layers/shared/ui';
import { PRESENCE_TTL_MS, useRoomWorkingStore } from '@/layers/entities/room';
import { SystemHealthDot } from '@/layers/features/top-nav';
import {
  OneBar,
  BarTitle,
  BarMembersChip,
  ChannelsBar,
  TitleBar,
  OneBarProvider,
  BarFixedCluster,
  SessionHeader,
  type OneBarRouteState,
} from '@/layers/widgets/one-bar';
import { ARCHIVED_ROOM, BRIDGED_CHANNEL_ROOM, CHANNEL_ROOM, DM_ROOM } from './rooms-showcase-data';
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
  room: null,
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
 * The mid-run rooms, each with an id of its own.
 *
 * **Separate rooms, not a `working` prop on the shared one.** The working count
 * lives in a store keyed by ROOM ID, exactly as the live fan-out keys it — so a
 * showcase that seeded a count for `CHANNEL_ROOM` lit every other bar built from
 * `CHANNEL_ROOM` on the page too, and the quiet bars above stopped being quiet.
 * Distinct ids keep each demo's state its own.
 */
const BUSY_ROOM: RoomWithRoster = { ...CHANNEL_ROOM, id: 'room-busy' };
const BUSY_PHONE_ROOM: RoomWithRoster = { ...CHANNEL_ROOM, id: 'room-busy-phone' };

/** A room whose name and topic are both longer than any bar can hold. */
const WORDY_ROOM: RoomWithRoster = {
  ...CHANNEL_ROOM,
  id: 'room-wordy',
  slug: 'quarterly-migration-planning-and-rollout',
  title: 'quarterly-migration-planning-and-rollout',
  topic: 'Everything about moving the last three services off the old cluster before the freeze',
};

/**
 * One real {@link ChannelsBar}, for one room, at one width.
 *
 * The bar reads its room from `OneBarProvider` exactly as the shell supplies it,
 * so what renders here is the component the route mounts rather than a mock of
 * its shape.
 *
 * **`working` seeds the live presence store**, which is the only honest way to
 * show the mid-run state: the count comes from the same store the real fan-out
 * writes to, so the chip and the Stop beside it are the real ones behaving the
 * real way. The store is keyed by ROOM ID, so a busy demo must use a room id no
 * quiet demo shares — see {@link BUSY_ROOM}.
 */
function ChannelBarFrame({
  room,
  working = 0,
  width,
}: {
  room: RoomWithRoster;
  working?: number;
  width?: number;
}) {
  useEffect(() => {
    if (working === 0) {
      useRoomWorkingStore.getState().observe({ roomId: room.id, working: 0 });
      return;
    }
    // **Restated on a timer, because a count nobody restates is treated as a
    // crashed server.** A working count above zero ages out after
    // `PRESENCE_TTL_MS` and becomes a zero — that is the real fan-out's crash
    // story, and this store is the real store. Seeding once meant the mid-run
    // showcases quietly went idle thirty seconds after the page loaded, so
    // anyone who left `/dev/one-bar` open and came back was looking at a demo
    // that contradicted its own label. Re-observing inside the TTL is exactly
    // what a live server does, so the showcase stays lit for the same reason a
    // real busy room does.
    const restate = () => useRoomWorkingStore.getState().observe({ roomId: room.id, working });
    restate();
    const timer = setInterval(restate, PRESENCE_TTL_MS / 3);
    return () => clearInterval(timer);
  }, [room.id, working]);

  return (
    <OneBarProvider value={{ ...QUIET_BAR_STATE, room }}>
      <BarFrame width={width}>
        <ChannelsBar />
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

        <ShowcaseLabel>
          The home surface bar — tabs are the identity, and the health dot is the last chip on all
          four surfaces so it never moves as you switch tabs
        </ShowcaseLabel>
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
              chips={
                <>
                  <BarMembersChip count={12} roomName="#team" onClick={() => {}} />
                  <SystemHealthDot state="healthy" />
                </>
              }
            />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>
          The same bar on Scheduled — no members chip (that is Home&apos;s room), a page action
          instead, and the dot stays exactly where it was
        </ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame>
            <OneBar
              identity={
                <BarTabStrip
                  tabs={HOME_TABS}
                  activeTabId="scheduled"
                  label="Home sections, Scheduled"
                  indicatorLayoutId="playground-home-tabs-scheduled"
                />
              }
              chips={<SystemHealthDot state="degraded" />}
              actions={
                <Button variant="outline" size="xs">
                  <Plus />
                  New Task
                </Button>
              }
            />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>
          The home surface bar at 390px — the strip scrolls, the chips do not
        </ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame width={390}>
            <OneBar
              identity={
                <BarTabStrip
                  tabs={HOME_TABS}
                  activeTabId="home"
                  label="Home sections, phone"
                  indicatorLayoutId="playground-home-tabs-phone"
                />
              }
              chips={
                <>
                  <BarMembersChip count={46} roomName="#team" onClick={() => {}} />
                  <SystemHealthDot state="error" />
                </>
              }
            />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>
          The channel bar — the room&apos;s only masthead now. Name, topic, and the chips that say
          what is true of it
        </ShowcaseLabel>
        <ShowcaseDemo>
          <ChannelBarFrame room={CHANNEL_ROOM} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          A direct message — no `#`, and the name is whatever the conversation was opened as
        </ShowcaseLabel>
        <ShowcaseDemo>
          <ChannelBarFrame room={DM_ROOM} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          An archived room says so, and a bridged one says what it can see
        </ShowcaseLabel>
        <ShowcaseDemo>
          <ChannelBarFrame room={ARCHIVED_ROOM} />
        </ShowcaseDemo>
        <ShowcaseDemo>
          <ChannelBarFrame room={BRIDGED_CHANNEL_ROOM} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          Mid-run: the working count and Stop light up in space that was already theirs, so nothing
          beside them moves (I3). Compare the room name&apos;s position with the quiet bar above
        </ShowcaseLabel>
        <ShowcaseDemo>
          <ChannelBarFrame room={BUSY_ROOM} working={3} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          A long name and a long topic at 420px — the topic goes first, then the name ellipsizes,
          and the cluster never shrinks (I2)
        </ShowcaseLabel>
        <ShowcaseDemo>
          <ChannelBarFrame room={WORDY_ROOM} width={420} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          The channel bar in a 390px-wide frame. Note what this CANNOT show: hiding the topic and
          dropping Stop&apos;s label are `sm:` rules, which answer to the VIEWPORT, not to this box
          — so on a real phone this row is narrower still. Resize the window to see it
        </ShowcaseLabel>
        <ShowcaseDemo>
          <ChannelBarFrame room={BUSY_PHONE_ROOM} working={2} width={390} />
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
          Standalone row (`density=&quot;row&quot;`) — 44px touch targets and its own hairline. No
          route wears this today: the home surface wore it until its tabs moved into the bar (phase
          H1), and it is kept for a strip that owns a row of its own inside a page
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
