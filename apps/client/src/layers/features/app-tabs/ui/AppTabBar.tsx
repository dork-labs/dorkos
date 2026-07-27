import { useAppTabs, useAppTabsStore } from '@/layers/shared/model';
import { useAppTabActions } from '../model/use-app-tab-actions';
import { AppTabStrip } from './AppTabStrip';

interface AppTabBarProps {
  /** Extra classes for the strip (drag region, traffic-light inset). */
  className?: string;
}

/**
 * The live tab strip: {@link AppTabStrip} wired to the tab store and the
 * router. Rendered by the app shell above the page header, in the desktop app
 * only — the shell owns that gate (DOR-568), so this component can assume it is
 * where tabs belong.
 *
 * Once mounted it always renders, empty tab list included. The store seeds its
 * first tab synchronously at module scope, so there is no cold-start frame to
 * guard against — and on macOS this strip is the band that holds the window's
 * drag region and the traffic-light clearance, so returning `null` would drop
 * that chrome and slide the header under the window buttons. Rendering an empty
 * strip is both honest and the safe failure.
 *
 * @module features/app-tabs/ui/AppTabBar
 */
export function AppTabBar({ className }: AppTabBarProps) {
  const tabs = useAppTabs();
  const activeTabId = useAppTabsStore((s) => s.activeTabId);
  const { activate, close, create } = useAppTabActions();

  return (
    <AppTabStrip
      tabs={tabs}
      activeId={activeTabId}
      onActivate={activate}
      onClose={close}
      onCreate={create}
      className={className}
    />
  );
}
