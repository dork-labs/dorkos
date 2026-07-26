import { useAppTabs, useAppTabsStore } from '@/layers/shared/model';
import { useAppTabActions } from '../model/use-app-tab-actions';
import { AppTabStrip } from './AppTabStrip';

interface AppTabBarProps {
  /** Extra classes for the strip (drag region, traffic-light inset). */
  className?: string;
}

/**
 * The live tab strip: {@link AppTabStrip} wired to the tab store and the
 * router. Rendered by the app shell, above the page header.
 *
 * Renders nothing until the first location sync has minted a tab — one frame at
 * cold start, and the honest empty state if storage is unavailable and the
 * router has not settled yet. An empty strip would just be a stray border.
 *
 * @module features/app-tabs/ui/AppTabBar
 */
export function AppTabBar({ className }: AppTabBarProps) {
  const tabs = useAppTabs();
  const activeTabId = useAppTabsStore((s) => s.activeTabId);
  const { activate, close, create } = useAppTabActions();

  if (tabs.length === 0) return null;

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
