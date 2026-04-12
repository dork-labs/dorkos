import { lazy, Suspense } from 'react';
import { useAgentHubStore } from '../model/agent-hub-store';

const ProfileTab = lazy(() => import('./tabs/ProfileTab').then((m) => ({ default: m.ProfileTab })));
const SessionsTab = lazy(() =>
  import('./tabs/SessionsTab').then((m) => ({ default: m.SessionsTab }))
);
const ConfigTab = lazy(() => import('./tabs/ConfigTab').then((m) => ({ default: m.ConfigTab })));

/**
 * Scrollable content area for the Agent Hub panel.
 *
 * Reads the active tab from the hub store and renders the corresponding
 * lazy-loaded tab component inside a Suspense boundary.
 */
export function AgentHubTabContent() {
  const activeTab = useAgentHubStore((s) => s.activeTab);

  const ActiveTab = {
    profile: ProfileTab,
    sessions: SessionsTab,
    config: ConfigTab,
  }[activeTab];

  return (
    <div data-slot="agent-hub-tab-content" className="flex-1 overflow-auto">
      <Suspense fallback={null}>
        <ActiveTab />
      </Suspense>
    </div>
  );
}
