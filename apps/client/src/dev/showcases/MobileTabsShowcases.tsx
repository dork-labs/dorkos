/**
 * The phone cockpit's bottom bar, and the long-press menu.
 *
 * The bar is the one piece of the mobile layout that is pure — a list of
 * destinations and one number — so it can be looked at in both themes with no
 * server, no router and no clock, which is exactly what a showcase is for
 * (spec §9, P4).
 *
 * **What this page proves at a glance.** Home is the only destination that ever
 * carries a count, and the count is how many things are waiting on you —
 * approvals and questions — never how many rows are unread.
 *
 * @module dev/showcases/MobileTabsShowcases
 */
import { useState } from 'react';
import { BellOff, FolderInput, FolderPlus, ListFilter, Trash2 } from 'lucide-react';
import { SidebarMenuNodes, type SidebarMenuNode } from '@/layers/shared/ui';
import { MobileTabBar, type MobileTabId } from '@/layers/widgets/mobile-tabs';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';

/** The phone this is drawn at — the width every mobile assertion uses. */
const PHONE_WIDTH = 390;

/**
 * One bar, live: pressing a destination moves it, exactly as a thumb would.
 *
 * @param props - What the sample is called, and how many things wait on you.
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
          // One page, several bars: each names its own landmark after its
          // sample, so a screen-reader user hopping landmarks can tell them
          // apart — and so the page's axe gate stays green on
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

/** The samples the bar is drawn at: nothing waiting, one thing, several. */
const BAR_SAMPLES = [
  { name: 'nothing waiting', needsYouCount: 0 },
  { name: 'one question', needsYouCount: 1 },
  { name: 'three waiting', needsYouCount: 3 },
] as const;

/** The bottom bar at the counts a phone actually shows. */
export function MobileTabBarShowcase() {
  return (
    <PlaygroundSection
      title="Mobile Tabs"
      description="The phone cockpit's three destinations — Home, DorkBot, You — at 390px. Home is the whole sidebar list with what is waiting on you answered at its top, and it is the only destination that ever carries a count: approvals and questions waiting, never unread rows."
    >
      <div className="flex flex-col gap-4">
        {BAR_SAMPLES.map(({ name, needsYouCount }) => (
          <BarSample key={name} name={name} needsYouCount={needsYouCount} />
        ))}
      </div>
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
        flattening honest: the sheet offers exactly the leaves the “⋮” hides.
      </p>
    </PlaygroundSection>
  );
}
