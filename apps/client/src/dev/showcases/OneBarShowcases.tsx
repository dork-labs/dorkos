import { useEffect } from 'react';
import { Plus } from 'lucide-react';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { BarTabStrip, Button, type BarTab } from '@/layers/shared/ui';
import { useRoomWorkingStore } from '@/layers/entities/room';
import { SystemHealthDot } from '@/layers/features/top-nav';
import {
  OneBar,
  BarTitle,
  BarMembersChip,
  ChannelsBar,
  TitleBar,
  OneBarProvider,
  BarFixedCluster,
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
      <header className="relative flex h-9 items-center gap-2 border-b px-2">
        {children}
        <BarFixedCluster />
      </header>
    </div>
  );
}

/** Nothing open, nothing running — showcases override only what they demonstrate. */
const QUIET_BAR_STATE = {
  agentName: undefined,
  origin: undefined,
  originLabel: undefined,
  room: null,
  teamViewMode: 'cards',
} as const;

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
 * real way. Keyed by room id, so the quiet bars above stay quiet.
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
    useRoomWorkingStore.getState().observe({ roomId: room.id, working });
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
          <ChannelBarFrame room={CHANNEL_ROOM} working={3} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          A long name and a long topic at 420px — the topic goes first, then the name ellipsizes,
          and the cluster never shrinks (I2)
        </ShowcaseLabel>
        <ShowcaseDemo>
          <ChannelBarFrame room={WORDY_ROOM} width={420} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          The channel bar at 390px — the topic is gone entirely and Stop keeps only its icon
        </ShowcaseLabel>
        <ShowcaseDemo>
          <ChannelBarFrame room={CHANNEL_ROOM} working={2} width={390} />
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
