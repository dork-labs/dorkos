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
import { buildSidebarModel } from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import { SIDEBAR_FIXTURES } from '@/layers/features/dashboard-sidebar/model/fixtures';
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
