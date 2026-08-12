/**
 * The phone cockpit's bottom bar, over the four journey fixtures.
 *
 * The bar is the one piece of the mobile layout that is pure — a list of
 * destinations and one number — so it can be looked at in both themes with no
 * server, no router and no clock, which is exactly what a showcase is for. The
 * number beside each bar is the count the REAL `buildSidebarModel` produced
 * from that journey's snapshot, so what a reviewer reads here is what a phone
 * would draw (spec `sidebar-now-today-library` §9, P4).
 *
 * **What this page proves at a glance.** Home is the only destination that ever
 * carries a count, and the count is the needs-you number rather than Now's row
 * count — which differ, visibly, in two of the four journeys: `busy` puts four
 * rows in Now and needs you three times, `power` caps Now at five rows while
 * seven things need you. A bar that counted rows would read 4 and 5 here.
 *
 * **Deep imports on purpose**, the same as `SidebarModelShowcases`: the model
 * and its fixtures are consumed by the model's own tests and by this page, not
 * by the app, and keeping them off the feature barrel is deliberate.
 *
 * @module dev/showcases/MobileTabsShowcases
 */
import { useState } from 'react';
import { BellOff, FolderInput, FolderPlus, ListFilter, Trash2 } from 'lucide-react';
import { SidebarMenuNodes, type SidebarMenuNode } from '@/layers/shared/ui';
import { buildSidebarModel } from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import { SIDEBAR_FIXTURES } from '@/layers/features/dashboard-sidebar/model/fixtures';
import { CatchUpButton } from '@/layers/features/dashboard-sidebar/ui/TodayZone';
import { MobileTabBar, type MobileTabId } from '@/layers/widgets/mobile-tabs';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';

/** The phone this is drawn at — the width every mobile assertion uses. */
const PHONE_WIDTH = 390;

/**
 * One journey's bar, live: pressing a destination moves it, exactly as a thumb
 * would.
 *
 * @param props - The journey's name and the needs-you count its model produced.
 */
function BarSample({ name, needsYouCount }: { name: string; needsYouCount: number }) {
  const [current, setCurrent] = useState<MobileTabId | null>('home');
  return (
    <div className="space-y-1">
      <ShowcaseLabel>{`${name} — ${needsYouCount} need you`}</ShowcaseLabel>
      <div
        className="border-border/50 overflow-hidden rounded-xl border"
        // Capped at the phone width, not fixed to it: the playground itself is
        // read at every width, and a 390px box inside a padded column at 390px
        // is a page that scrolls sideways.
        style={{ maxWidth: PHONE_WIDTH }}
      >
        <MobileTabBar
          // One page, four bars: each names its own landmark after the journey
          // it is drawn from, so a screen-reader user hopping landmarks can
          // tell them apart — and so the page's axe gate stays green on
          // `landmark-unique`, which is what caught this.
          label={`Mobile tabs — ${name}`}
          current={current}
          needsYouCount={needsYouCount}
          // The showcase has no roster behind it, so DorkBot is shown in the
          // state the product spends almost all of its time in: ready.
          dorkBotReady
          onSelect={setCurrent}
        />
      </div>
    </div>
  );
}

/** The bottom bar over every journey the sidebar is designed against. */
export function MobileTabBarShowcase() {
  return (
    <PlaygroundSection
      title="Mobile Tabs"
      description="The phone cockpit's four destinations — Home, Library, DorkBot, You — over all four journey fixtures at 390px. Home is the only one that ever carries a count, and the count is the needs-you number BC-11 announces, not Now's row count. Library is deliberately calm: it never asks for anything."
    >
      <div className="flex flex-col gap-4">
        {SIDEBAR_FIXTURES.map(({ name, state }) => {
          const model = buildSidebarModel(state);
          const now = model.zones.find((zone) => zone.id === 'now');
          return <BarSample key={name} name={name} needsYouCount={now?.needsYouCount ?? 0} />;
        })}
      </div>
      <p className="text-muted-foreground max-w-prose text-sm">
        In <b>busy</b> the Now zone holds four rows and three of them need you — the fourth is the
        &ldquo;N working&rdquo; rollup, which reports rather than asks. In <b>power</b> Now is
        capped at five rows while seven things need you. Both numbers come off the model, so the
        badge and the screen reader can never disagree.
      </p>
    </PlaygroundSection>
  );
}

/**
 * The list the long-press sheet is drawn from — one of every node kind it has
 * to walk.
 *
 * The same shape a room row hands the surface: a couple of verbs, a submenu the
 * "⋮" would hide behind a hover, a radio over a setting, and one destructive
 * item. Flattened here, because a sheet has no second level and putting one
 * over a 390px screen would be a surface to dismiss before the first one is
 * usable.
 */
const SHEET_NODES: SidebarMenuNode[] = [
  { kind: 'action', id: 'mute', label: 'Mute channel', icon: BellOff, run: () => {} },
  {
    kind: 'submenu',
    id: 'move-to-group',
    label: 'Move to group',
    icon: FolderInput,
    items: [
      { kind: 'choice', id: 'group-a', label: 'Clients', checked: true, run: () => {} },
      { kind: 'choice', id: 'group-b', label: 'Experiments', checked: false, run: () => {} },
      { kind: 'separator', id: 'move-sep' },
      {
        kind: 'action',
        id: 'new-group',
        label: 'New group',
        icon: FolderPlus,
        opensInput: true,
        run: () => {},
      },
    ],
  },
  {
    kind: 'radio',
    id: 'sort',
    label: 'Sort by',
    icon: ListFilter,
    value: 'recent',
    options: [
      { value: 'name', label: 'Name' },
      { value: 'recent', label: 'Recently used' },
    ],
    onChange: () => {},
  },
  { kind: 'separator', id: 'sep' },
  {
    kind: 'action',
    id: 'archive',
    label: 'Archive channel',
    icon: Trash2,
    destructive: true,
    opensInput: true,
    run: () => {},
  },
];

/**
 * The third menu renderer, drawn flat so both themes can be read at once (P4.2).
 *
 * The sheet itself is a `Drawer`, and a drawer in a playground column would
 * cover the page it is meant to be compared against — so this draws its
 * CONTENTS, which is the part that has a design. The gesture that opens it, and
 * the sheet's own frame, are covered where only a browser can see them
 * (`apps/e2e/tests/dashboard-sidebar/mobile-touch.spec.ts`).
 */
export function MobileLongPressSheetShowcase() {
  return (
    <PlaygroundSection
      title="Mobile Long-press Menu"
      description="Hover does not exist on a phone, so a press held for half a second opens the row's menu as a sheet. It walks the SAME node list the right-click menu and the ⋮ walk — one model, three renderers — so the three can never offer different things. A submenu is flattened into a labelled run of rows: a sheet has no second level, and every row is 44px."
    >
      <div
        className="border-border/50 bg-background overflow-hidden rounded-xl border py-2"
        style={{ maxWidth: PHONE_WIDTH }}
      >
        <div
          id="showcase-sheet-title"
          className="text-sidebar-foreground/70 px-4 pt-2 pb-1 text-xs font-medium"
        >
          #general actions
        </div>
        {/* The `menu` the real sheet's `DrawerContent` provides. Rendered here
            too, because its rows are `menuitem`s and a `menuitem` outside a
            menu is what axe calls `aria-required-parent`. */}
        <div role="menu" aria-labelledby="showcase-sheet-title">
          <SidebarMenuNodes variant="sheet" nodes={SHEET_NODES} />
        </div>
      </div>
      <p className="text-muted-foreground max-w-prose text-sm">
        Every row here is 44px tall. The <b>Move to group</b> and <b>Sort by</b> headings are
        labels, not controls — their contents are already on screen, which is what makes the
        flattening honest: the sheet offers exactly the leaves the &ldquo;⋮&rdquo; hides.
      </p>
    </PlaygroundSection>
  );
}

/**
 * Catch up, over the journeys that have something to clear (P4 AC-4).
 *
 * Drawn from the real model: the count is the number of DISTINCT rooms Today is
 * holding, which is not the number of unread rows — a thread and its channel
 * share one read cursor and are therefore one write.
 */
export function MobileCatchUpShowcase() {
  return (
    <PlaygroundSection
      title="Mobile Catch Up"
      description="One action at the top of Today that marks everything read, on a phone only — per-item triage is a desktop behaviour. It writes through the read cursors the sidebar otherwise only reads, and keeps no watermark of its own."
    >
      <div className="flex flex-col gap-3">
        {SIDEBAR_FIXTURES.map(({ name, state }) => {
          const rows =
            buildSidebarModel(state)
              .zones.find((zone) => zone.id === 'today')
              ?.sections.find((section) => section.id === 'today')?.rows ?? [];
          const count = new Set(
            rows
              .filter((row) => row.unread.tier !== 'none' && row.target.kind === 'room')
              .map((row) => (row.target.kind === 'room' ? row.target.roomId : ''))
          ).size;
          // **The BUTTON, not the gate.** `CatchUpAction` asks `useIsMobile()`,
          // which is a question about the window — this page is read at 1600px,
          // so the gate would answer "no" and draw nothing at all, and the axe
          // run would have no colours here to judge. The count each fixture
          // would really offer is still the model's.
          return (
            <div key={name} className="space-y-1">
              <ShowcaseLabel>{`${name} — ${count} to clear`}</ShowcaseLabel>
              <div
                className="border-border/50 bg-sidebar overflow-hidden rounded-xl border py-1"
                style={{ maxWidth: PHONE_WIDTH }}
              >
                <CatchUpButton count={count} onCatchUp={() => {}} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground max-w-prose text-sm">
        In the product this is drawn only on a phone, and only when Today is holding something —
        chrome appears by data volume, never by a setting. A journey whose Today is already read
        offers <b>0 to clear</b> and draws nothing at all there.
      </p>
    </PlaygroundSection>
  );
}
