import { cn } from '@/layers/shared/lib';
import { useAgentHubStore, type AgentHubTab } from '../model/agent-hub-store';

interface TabDef {
  id: AgentHubTab;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'config', label: 'Config' },
];

/**
 * Horizontal tab bar for the Agent Hub panel.
 *
 * Renders 3 tab buttons in a flex row with underline-style active indicator.
 * Replaces the former AgentHubNav left sidebar.
 */
export function AgentHubTabBar() {
  const activeTab = useAgentHubStore((s) => s.activeTab);
  const setActiveTab = useAgentHubStore((s) => s.setActiveTab);

  return (
    <div
      data-slot="agent-hub-tab-bar"
      role="tablist"
      aria-label="Agent hub tabs"
      className="flex border-b"
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={cn(
            'flex-1 border-b-2 py-2 text-xs font-medium transition-colors',
            activeTab === tab.id
              ? 'text-foreground border-primary font-semibold'
              : 'text-muted-foreground hover:text-foreground border-transparent'
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
