import { User, Sparkles, MessageSquare, Radio, Clock, Wrench } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useAgentHubStore, type AgentHubTab } from '../model/agent-hub-store';

interface NavItem {
  tab: AgentHubTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { tab: 'overview', label: 'Overview', icon: User },
  { tab: 'personality', label: 'Personality', icon: Sparkles },
  { tab: 'sessions', label: 'Sessions', icon: MessageSquare },
  { tab: 'channels', label: 'Channels', icon: Radio },
  { tab: 'tasks', label: 'Tasks', icon: Clock },
  { tab: 'tools', label: 'Tools', icon: Wrench },
];

/**
 * Left-nav sidebar for the Agent Hub panel.
 *
 * Renders 6 tab buttons with icons and labels. The active tab is highlighted
 * and marked with `aria-current="page"` for accessibility.
 */
export function AgentHubNav() {
  const activeTab = useAgentHubStore((s) => s.activeTab);
  const setActiveTab = useAgentHubStore((s) => s.setActiveTab);

  return (
    <nav
      data-slot="agent-hub-nav"
      aria-label="Agent hub navigation"
      className="flex flex-col gap-0.5 border-r p-1.5"
    >
      {NAV_ITEMS.map(({ tab, label, icon: Icon }) => {
        const isActive = tab === activeTab;
        return (
          <button
            key={tab}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
