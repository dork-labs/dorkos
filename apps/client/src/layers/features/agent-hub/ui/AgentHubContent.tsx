import { lazy, Suspense } from 'react';
import { useAgentHubStore } from '../model/agent-hub-store';

// Lazy-load each tab to avoid bloating the initial bundle.
const OverviewTab = lazy(() =>
  import('./tabs/OverviewTab').then((m) => ({ default: m.OverviewTab }))
);
const PersonalityTab = lazy(() =>
  import('./tabs/PersonalityTab').then((m) => ({ default: m.PersonalityTab }))
);
const SessionsTab = lazy(() =>
  import('./tabs/SessionsTab').then((m) => ({ default: m.SessionsTab }))
);
const ChannelsTab = lazy(() =>
  import('./tabs/ChannelsTab').then((m) => ({ default: m.ChannelsTab }))
);
const TasksTab = lazy(() => import('./tabs/TasksTab').then((m) => ({ default: m.TasksTab })));
const ToolsTab = lazy(() => import('./tabs/ToolsTab').then((m) => ({ default: m.ToolsTab })));

/**
 * Content area for the Agent Hub panel.
 *
 * Reads the active tab from the hub store and renders the corresponding
 * tab component inside a Suspense boundary. Each tab is lazy-loaded.
 */
export function AgentHubContent() {
  const activeTab = useAgentHubStore((s) => s.activeTab);

  const ActiveTab = {
    overview: OverviewTab,
    personality: PersonalityTab,
    sessions: SessionsTab,
    channels: ChannelsTab,
    tasks: TasksTab,
    tools: ToolsTab,
  }[activeTab];

  return (
    <div data-slot="agent-hub-content" className="flex-1 overflow-auto">
      <Suspense fallback={null}>
        <ActiveTab />
      </Suspense>
    </div>
  );
}
