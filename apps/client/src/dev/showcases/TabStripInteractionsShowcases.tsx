import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AppTabStrip, type AppTabMenuActions } from '@/layers/features/app-tabs';
import {
  closeOtherTabsIn,
  closeTabIn,
  duplicateTabIn,
  moveTabIn,
  openTabIn,
  pinTabIn,
  type AppTab,
  type AppTabsLayout,
} from '@/layers/shared/model';
import { sessionHref } from '@/layers/shared/lib';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** Tab strip interactions (DOR-2820): pinned tabs, the tab menu, drag to reorder. */
export function TabStripInteractionsShowcases() {
  return (
    <PlaygroundSection
      title="Tab strip interactions"
      description="Pinned tabs sit at the left as an icon and status dot. Right-click a tab (or Shift+F10) for Pin, Duplicate, Copy link, Close others and Close. Drag a tab, or press Space then the arrow keys, to move it; a tab never crosses the pinned line."
    >
      <ShowcaseLabel>Two pinned tabs, then the rest</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <InteractiveStrip initial={SAMPLES} />
      </ShowcaseDemo>

      <ShowcaseLabel>Everything pinned</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <InteractiveStrip initial={SAMPLES.slice(0, 4).map((tab) => ({ ...tab, pinned: true }))} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** A sample tab at `href`. */
function sampleTab(id: string, href: string, pinned = false): AppTab {
  return { id, href, history: [href], cursor: 0, ...(pinned && { pinned }) };
}

const SAMPLES: AppTab[] = [
  sampleTab('tsi-home', '/', true),
  sampleTab('tsi-general', '/channels?id=room-general', true),
  sampleTab('tsi-api', sessionHref({ session: 's-api', dir: '/Users/kai/code/api' })),
  sampleTab('tsi-web', sessionHref({ session: 's-web', dir: '/Users/kai/code/web-app' })),
  sampleTab('tsi-activity', '/activity'),
  sampleTab('tsi-tasks', '/tasks'),
];

/**
 * The real strip over local state, arranged by the tab store's own pure
 * transitions — so the rules shown here are the rules the app runs.
 */
function InteractiveStrip({ initial }: { initial: AppTab[] }) {
  const [layout, setLayout] = useState<AppTabsLayout>(() => ({
    tabs: initial,
    activeTabId: initial[initial.length - 1].id,
  }));

  const menu = useMemo<AppTabMenuActions>(
    () => ({
      togglePin: (id) =>
        setLayout((current) => {
          const tab = current.tabs.find((t) => t.id === id);
          return tab ? pinTabIn(current, id, !tab.pinned) : current;
        }),
      duplicate: (id) => setLayout((current) => duplicateTabIn(current, id)),
      copyLink: (id) => {
        const tab = layout.tabs.find((t) => t.id === id);
        toast.success(`Would copy ${window.location.origin}${tab?.href ?? '/'}`);
      },
      closeOthers: (id) => setLayout((current) => closeOtherTabsIn(current, id)),
      close: (id) => setLayout((current) => closeTabIn(current, id)),
    }),
    [layout.tabs]
  );

  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <AppTabStrip
        tabs={layout.tabs}
        activeId={layout.activeTabId}
        onActivate={(id) => setLayout((current) => ({ ...current, activeTabId: id }))}
        onClose={(id) => menu.close(id)}
        onCreate={() => setLayout((current) => openTabIn(current, '/'))}
        menu={menu}
        onReorder={(from, to) => setLayout((current) => moveTabIn(current, from, to))}
      />
      <div className="text-muted-foreground bg-background p-6 text-center text-xs">
        Content of the active tab
      </div>
    </div>
  );
}
