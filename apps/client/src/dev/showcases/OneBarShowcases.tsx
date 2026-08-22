import { Plus } from 'lucide-react';
import { Badge, BarTabStrip, Button, type BarTab } from '@/layers/shared/ui';
import {
  OneBar,
  BarTitle,
  TitleBar,
  OneBarProvider,
  BarFixedCluster,
  TeamHeader,
  TEAM_VIEW_TABS,
} from '@/layers/widgets/one-bar';
import type { TeamViewMode } from '@/layers/shared/lib';
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

/**
 * The five team views, which is enough labels to overflow a phone — the REAL
 * tabs `/team` ships, not a copy of them, so a view added to the bar shows up
 * here without anyone remembering to mirror it.
 */
const TEAM_TABS: readonly BarTab[] = TEAM_VIEW_TABS;

/** Every view, so the strip can be seen with each one marked in turn. */
const TEAM_VIEW_MODES: TeamViewMode[] = ['cards', 'table', 'topology', 'denied', 'access'];

/** The width a phone gives the bar. */
const PHONE_WIDTH = 390;

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
  roomTitle: null,
  teamViewMode: 'cards',
} as const;

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

      <PlaygroundSection
        title="Team Bar"
        description="The real /team bar: a title, the five views as one scrolling strip, and the way to add an agent. The pill row and the phone's Select collapse are gone — every view is reachable at every width, by scrolling rather than by being conditionally re-offered."
      >
        <ShowcaseLabel>
          Desktop — three ways to read the roster, a rule, then the two rules surfaces
        </ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame>
            {/* Every TeamHeader on this page needs its OWN indicator id: a
                `layoutId` is global to `motion`, so a shared one makes all eight
                underlines the same element and animates them onto one box. */}
            <TeamHeader indicatorLayoutId="playground-team-desktop" />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>
          At 390px — the strip scrolls, and the end fade says the rules surfaces are still back
          there
        </ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame width={PHONE_WIDTH}>
            <TeamHeader indicatorLayoutId="playground-team-phone" />
          </BarFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Each view marked in turn — the strip reads its active tab off the URL, so this is what
          `?view=` looks like from the bar
        </ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-col gap-2">
            {TEAM_VIEW_MODES.map((mode) => (
              <OneBarProvider key={mode} value={{ ...QUIET_BAR_STATE, teamViewMode: mode }}>
                <BarFrame>
                  <TeamHeader indicatorLayoutId={`playground-team-${mode}`} />
                </BarFrame>
              </OneBarProvider>
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          The phone's action — `New Agent` becomes a labelled `+`. This one is composed by hand
          because the collapse follows the VIEWPORT (`useIsMobile`), not the frame: narrow the
          browser to see the bar above do it for real.
        </ShowcaseLabel>
        <ShowcaseDemo>
          <BarFrame width={PHONE_WIDTH}>
            <OneBar
              identity={<BarTitle>Team</BarTitle>}
              fill={
                <BarTabStrip
                  tabs={TEAM_TABS}
                  activeTabId="cards"
                  label="Team views, phone"
                  indicatorLayoutId="playground-team-tabs-phone"
                />
              }
              actions={
                <Button variant="outline" size="xs" aria-label="New Agent">
                  <Plus />
                </Button>
              }
            />
          </BarFrame>
        </ShowcaseDemo>
      </PlaygroundSection>
    </OneBarProvider>
  );
}
