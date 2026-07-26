import { useRef } from 'react';
import { Plus } from 'lucide-react';
import { cn, formatShortcutKey, SHORTCUTS } from '@/layers/shared/lib';
import type { AppTab } from '@/layers/shared/model';
import { useRovingTabList, type TabActivationSource } from '@/layers/shared/ui';
import { AppTabItem } from './AppTabItem';

interface AppTabStripProps {
  /** Open tabs, in strip order. */
  tabs: AppTab[];
  /** Id of the tab currently on screen. */
  activeId: string | null;
  /** Bring a tab to the front. */
  onActivate: (id: string, source: TabActivationSource) => void;
  /** Close a tab. Never called for the last remaining tab. */
  onClose: (id: string, source: TabActivationSource) => void;
  /** Open another tab. */
  onCreate: () => void;
  /** Extra classes for the strip container (drag region, traffic-light inset). */
  className?: string;
}

/**
 * The window's tab strip — presentational, so the Dev Playground renders the
 * real thing rather than a lookalike. {@link AppTabBar} is the wired version.
 *
 * Keyboard-accessible per the WAI-ARIA Tabs pattern via
 * {@link useRovingTabList}: the whole strip is one Tab stop, arrow keys move
 * and switch as they go, Home/End jump to the ends, and Delete closes the
 * focused tab. That matters more here than in the terminal strip — the browser
 * claims Cmd/Ctrl+T and Cmd/Ctrl+1-9 for its own tabs before the page sees
 * them, so on the web cockpit these keys and the "+" button are the whole
 * keyboard story.
 *
 * The last tab keeps no close control: a window with nothing in it has nothing
 * to show, and on desktop closing the last tab is the window's job.
 *
 * @module features/app-tabs/ui/AppTabStrip
 */
export function AppTabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onCreate,
  className,
}: AppTabStripProps) {
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const canClose = tabs.length > 1;

  const { getTabProps } = useRovingTabList({
    orderedIds: tabs.map((tab) => tab.id),
    activeId,
    onActivate,
    // Delete is only wired while there is something to close, so the last tab
    // does not advertise a shortcut that does nothing.
    onClose: canClose ? onClose : undefined,
    getFallbackFocus: () => createButtonRef.current,
  });

  return (
    <div
      className={cn(
        'bg-muted/40 flex shrink-0 items-stretch gap-1 border-b px-2 py-1',
        // Horizontal overflow scrolls inside the strip; the shell never does.
        'overflow-x-auto',
        className
      )}
    >
      <div role="tablist" aria-label="Open tabs" className="flex items-stretch gap-1">
        {tabs.map((tab) => (
          <AppTabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeId}
            canClose={canClose}
            tabProps={getTabProps(tab.id)}
            onClose={onClose}
          />
        ))}
      </div>
      <button
        ref={createButtonRef}
        type="button"
        onClick={onCreate}
        aria-label="New tab"
        title={`New tab (${formatShortcutKey(SHORTCUTS.NEW_TAB)})`}
        className="focus-ring text-muted-foreground hover:bg-background/60 hover:text-foreground ml-0.5 flex shrink-0 items-center rounded-md px-1.5 transition-colors"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
