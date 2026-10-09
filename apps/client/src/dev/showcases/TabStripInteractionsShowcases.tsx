import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AppTabStrip, type AppTabMenuActions } from '@/layers/features/app-tabs';
import type { AppTab } from '@/layers/shared/model';
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

/** Pinned tabs first, each side in order — the store's invariant, for the demo. */
function pinnedFirst(tabs: AppTab[]): AppTab[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

/**
 * The real strip over local state. The rules mirror the tab store's (pinning
 * moves a tab to the pinned line, a reorder stays on its own side); the store's
 * own tests are what pin them.
 */
function InteractiveStrip({ initial }: { initial: AppTab[] }) {
  const [tabs, setTabs] = useState(initial);
  const [activeId, setActiveId] = useState(initial[initial.length - 1].id);
  const [spawned, setSpawned] = useState(0);

  const menu = useMemo<AppTabMenuActions>(
    () => ({
      togglePin: (id) =>
        setTabs((current) => {
          const tab = current.find((t) => t.id === id);
          if (!tab) return current;
          const rest = current.filter((t) => t.id !== id);
          const pinnedCount = rest.filter((t) => t.pinned).length;
          const next = [...rest];
          next.splice(pinnedCount, 0, { ...tab, pinned: !tab.pinned });
          return pinnedFirst(next);
        }),
      duplicate: (id) => {
        const copyId = `tsi-copy-${Date.now()}`;
        setTabs((current) => {
          const index = current.findIndex((t) => t.id === id);
          const next = [...current];
          next.splice(index + 1, 0, { ...current[index], id: copyId });
          return next;
        });
        setActiveId(copyId);
      },
      copyLink: (id) => {
        const tab = tabs.find((t) => t.id === id);
        toast.success(`Would copy ${window.location.origin}${tab?.href ?? '/'}`);
      },
      closeOthers: (id) => {
        setTabs((current) => current.filter((t) => t.id === id || t.pinned));
        setActiveId(id);
      },
      close: (id) =>
        setTabs((current) => {
          const index = current.findIndex((t) => t.id === id);
          const next = current.filter((t) => t.id !== id);
          if (id === activeId) setActiveId((next[index] ?? next[index - 1]).id);
          return next;
        }),
    }),
    [tabs, activeId]
  );

  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <AppTabStrip
        tabs={tabs}
        activeId={activeId}
        onActivate={setActiveId}
        onClose={(id) => menu.close(id)}
        onCreate={() => {
          const tab = sampleTab(`tsi-new-${spawned}`, '/');
          setSpawned((count) => count + 1);
          setTabs((current) => [...current, tab]);
          setActiveId(tab.id);
        }}
        menu={menu}
        onReorder={(from, to) =>
          setTabs((current) => {
            const next = [...current];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return pinnedFirst(next);
          })
        }
      />
      <div className="text-muted-foreground bg-background p-6 text-center text-xs">
        Content of the active tab
      </div>
    </div>
  );
}
