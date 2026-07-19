import { useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { Plus, Puzzle } from 'lucide-react';
import { cn, isMac } from '@/layers/shared/lib';
import { useAgentCreationStore, type SidebarTabContribution } from '@/layers/shared/model';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { BUILTIN_SIDEBAR_TAB_IDS } from '../model/sidebar-contributions';

interface SidebarTabRowProps {
  /** Visible tabs (built-ins + extension contributions), in strip order. */
  tabs: SidebarTabContribution[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  schedulesBadge: number;
  connectionsStatus: 'ok' | 'partial' | 'error' | 'none';
}

const STATUS_DOT_COLORS: Record<string, string> = {
  ok: 'bg-green-500',
  partial: 'bg-amber-500',
  error: 'bg-red-500',
};

/** Cmd/Ctrl+N hint for a built-in tab, or null for extension-contributed tabs. */
function builtinShortcut(tabId: string): number | null {
  const index = BUILTIN_SIDEBAR_TAB_IDS.indexOf(tabId);
  return index === -1 ? null : index + 1;
}

/**
 * Horizontal tab row for the agent sidebar. Renders icon tabs — built-in and
 * extension-contributed — from the passed contributions with ARIA tablist
 * semantics and a motion-animated sliding indicator below the active tab.
 * Extension tabs that carry no icon fall back to a puzzle-piece.
 */
export function SidebarTabRow({
  tabs,
  activeTab,
  onTabChange,
  schedulesBadge,
  connectionsStatus,
}: SidebarTabRowProps) {
  const tabListRef = useRef<HTMLDivElement>(null);
  const modKey = isMac ? '⌘' : 'Ctrl+';
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = tabs.findIndex((t) => t.id === activeTab);
      if (currentIndex === -1 || tabs.length === 0) return;
      let nextIndex = currentIndex;

      if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % tabs.length;
        e.preventDefault();
      } else if (e.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        e.preventDefault();
      }

      if (nextIndex !== currentIndex) {
        onTabChange(tabs[nextIndex].id);
        // Focus the newly active tab button
        const buttons = tabListRef.current?.querySelectorAll('[role="tab"]');
        (buttons?.[nextIndex] as HTMLElement)?.focus();
      }
    },
    [activeTab, onTabChange, tabs]
  );

  return (
    <div
      ref={tabListRef}
      role="tablist"
      aria-label="Sidebar views"
      // tabIndex makes the tablist itself focusable, satisfying jsx-a11y/interactive-supports-focus.
      // Individual tab buttons manage their own tabIndex via roving tabindex pattern.
      tabIndex={-1}
      className="border-border relative flex items-center gap-1 border-b px-2 py-1.5"
      onKeyDown={handleKeyDown}
    >
      {/* Tab buttons */}
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const Icon = tab.icon ?? Puzzle;
        const shortcut = builtinShortcut(tab.id);

        return (
          <Tooltip key={tab.id}>
            <TooltipTrigger asChild>
              <button
                role="tab"
                id={`sidebar-tab-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`sidebar-tabpanel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                className={cn(
                  'relative rounded-md p-2 transition-colors duration-150',
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground/50 hover:text-muted-foreground'
                )}
              >
                <Icon className="size-(--size-icon-sm)" />

                {/* Schedules numeric badge */}
                {tab.id === 'schedules' && schedulesBadge > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-green-500 text-[10px] font-medium text-white">
                    {schedulesBadge > 9 ? '9+' : schedulesBadge}
                    <span className="animate-tasks absolute inset-0 rounded-full bg-green-500/30" />
                  </span>
                )}

                {/* Connections status dot */}
                {tab.id === 'connections' && connectionsStatus !== 'none' && (
                  <span
                    className={cn(
                      'absolute -top-0.5 -right-0.5 size-1.5 rounded-full',
                      STATUS_DOT_COLORS[connectionsStatus]
                    )}
                  />
                )}

                {/* Sliding indicator */}
                {isActive && (
                  <motion.div
                    layoutId="sidebar-tab-indicator"
                    className="bg-brand absolute right-0 bottom-[-7px] left-0 h-0.5 rounded-full"
                    transition={{ type: 'spring', stiffness: 280, damping: 32 }}
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {tab.label}
              {shortcut !== null && ` ${modKey}${shortcut}`}
            </TooltipContent>
          </Tooltip>
        );
      })}

      {/* Spacer + new agent button */}
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => useAgentCreationStore.getState().open()}
            className="text-muted-foreground/50 hover:text-muted-foreground rounded-md p-2 transition-colors duration-150"
            aria-label="New Agent"
          >
            <Plus className="size-(--size-icon-sm)" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">New Agent</TooltipContent>
      </Tooltip>
    </div>
  );
}
