import { motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { useAgentHubStore, type AgentHubTab } from '../model/agent-hub-store';

interface TabDef {
  id: AgentHubTab;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'config', label: 'Config' },
  { id: 'toolkit', label: 'Toolkit' },
];

const INDICATOR_SPRING = { type: 'spring', stiffness: 500, damping: 32 } as const;

/**
 * Horizontal tab bar for the Agent Hub panel.
 *
 * Renders 3 tab buttons with a spring-animated sliding underline indicator.
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
            'relative flex-1 py-2 text-xs font-medium transition-colors',
            activeTab === tab.id
              ? 'text-foreground font-semibold'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {tab.label}
          {activeTab === tab.id && (
            <motion.div
              layoutId="agent-hub-tab-indicator"
              className="bg-primary absolute right-0 bottom-0 left-0 h-0.5"
              transition={INDICATOR_SPRING}
            />
          )}
        </button>
      ))}
    </div>
  );
}
